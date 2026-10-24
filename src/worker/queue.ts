// Queue consumer logic, one function for both queues the Worker consumes:
//   openlocalseo-scans      job messages; transient errors retry with backoff,
//                           permanent ones fail the scan/snapshot right away.
//   openlocalseo-scans-dlq  messages that exhausted their retries; the scan or
//                           snapshot is failed, credits refunded, alert raised.
import { FAILED_AFTER_RETRIES, DLQ_QUEUE, classifyJobError, failJob, permanentFailureReason, retryDelaySeconds } from "./scans/failed";
import type { ScanJob } from "./scans/jobs";
import { handleScanJob, type ProcessDeps } from "./scans/process";

/** The slice of a Queues Message this uses; tests pass plain objects. */
export type QueueMessage = {
  body: ScanJob;
  /** Delivery count, starting at 1. */
  attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
};

const DLQ_RETRY_SECONDS = 30;

export async function handleQueueBatch(deps: ProcessDeps, batch: { queue: string; messages: readonly QueueMessage[] }): Promise<void> {
  const dead = batch.queue === DLQ_QUEUE;
  for (const message of batch.messages) {
    const job = message.body;
    try {
      if (dead) {
        const failed = await failJob(deps, job, FAILED_AFTER_RETRIES);
        console.error("scan.job-dead", { job: job.type, failed });
        message.ack();
        continue;
      }
      await handleScanJob(deps, job);
      message.ack();
    } catch (error) {
      const text = error instanceof Error ? error.message : "unknown error";
      if (dead) {
        console.error("scan.dlq-failed", { job: job.type, error: text });
        message.retry({ delaySeconds: DLQ_RETRY_SECONDS });
      } else if (classifyJobError(error) === "permanent") {
        await failPermanently(deps, message, error);
      } else {
        console.error("scan.job-failed", { job: job.type, attempts: message.attempts, error: text });
        message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
      }
    }
  }
}

/** Retrying cannot help: fail the scan/snapshot now instead of burning the retries. */
async function failPermanently(deps: ProcessDeps, message: QueueMessage, error: unknown) {
  console.error("scan.job-permanent-failure", { job: message.body.type, error: error instanceof Error ? error.message : "unknown error" });
  try {
    await failJob(deps, message.body, permanentFailureReason(error));
    message.ack();
  } catch (failError) {
    // Could not even record the failure (D1 down?): let the queue redeliver.
    console.error("scan.job-fail-error", { job: message.body.type, error: failError instanceof Error ? failError.message : "unknown error" });
    message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
  }
}
