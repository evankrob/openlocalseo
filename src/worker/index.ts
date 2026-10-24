import { createApp, defaultResolveDeps } from "./app";
import type { Env } from "./env";
import { reapStaleGbpSnapshots } from "./gbp/process";
import { runDueGbpSnapshots } from "./gbp/service";
import { handleScanJob } from "./scans/process";
import type { ScanJob } from "./scans/jobs";
import { runDueSchedules } from "./scans/schedule";

const app = createApp();

export default {
  fetch: app.fetch,

  // Queue consumer: one message per scan step (see scans/process.ts).
  async queue(batch: MessageBatch<ScanJob>, env: Env, ctx: ExecutionContext): Promise<void> {
    const deps = defaultResolveDeps(env, ctx);
    for (const message of batch.messages) {
      try {
        await handleScanJob(deps, message.body);
        message.ack();
      } catch (error) {
        console.error("scan.job-failed", { job: message.body.type, error: (error as Error).message });
        // Exponential backoff; after max_retries the message goes to the DLQ
        // and the daily reaper fails the scan and returns held credits.
        message.retry({ delaySeconds: Math.min(300, 5 * 2 ** message.attempts) });
      }
    }
  },

  // Daily Cron: start due monthly scans and profile snapshots, reap stuck ones.
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const deps = defaultResolveDeps(env);
    const summary = await runDueSchedules(deps);
    console.log("schedule.tick", summary);
    const gbp = await runDueGbpSnapshots(deps);
    console.log("schedule.gbp-tick", { ...gbp, reaped: await reapStaleGbpSnapshots(deps) });
  },
} satisfies ExportedHandler<Env, ScanJob>;
