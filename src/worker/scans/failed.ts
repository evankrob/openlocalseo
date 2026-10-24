// Failing a job for good: used by the dead-letter consumer (retries exhausted)
// and for permanent errors (retrying cannot help). Both mark the scan or GBP
// snapshot failed, return the unspent credits and raise one job_failed alert.
// Idempotent: only the caller that wins the active -> failed transition settles
// credits and raises the alert, so a redelivered message does nothing. Never
// posts to DataForSEO: a billed task_post is not replayed.
import { and, eq, inArray } from "drizzle-orm";
import { ZodError } from "zod";
import { AppError, type ErrorCode } from "@/shared/errors";
import { createJobFailedAlertSafely } from "../alerts";
import { scanPoints, scans } from "../db/schema";
import { failSnapshot } from "../gbp/process";
import { nowIso } from "../lib";
import type { ScanJob } from "./jobs";
import { settleCredits, type ProcessDeps } from "./process";

export const DLQ_QUEUE = "openlocalseo-scans-dlq";
export const FAILED_AFTER_RETRIES = "Processing failed after retries";

const ACTIVE = ["queued", "posting", "polling"] as const;

/** Fails the scan or snapshot a job belongs to. Resolves to true when this call did the failing. */
export async function failJob(deps: ProcessDeps, job: ScanJob, reason: string): Promise<boolean> {
  if (job.type === "gbp_snapshot" || job.type === "gbp_reviews_collect") {
    const failed = await failSnapshot(deps, job.snapshotId, reason);
    if (failed) await createJobFailedAlertSafely(deps, { type: "gbp", snapshotId: job.snapshotId }, reason);
    return failed;
  }

  const [scan] = await deps.db.select().from(scans).where(eq(scans.id, job.scanId));
  if (!scan) return false;
  const won = await deps.db
    .update(scans)
    .set({ status: "failed", error: reason, completedAt: nowIso(deps.now?.()) })
    .where(and(eq(scans.id, scan.id), inArray(scans.status, [...ACTIVE])))
    .returning({ costUsd: scans.costUsd });
  if (won.length === 0) return false;
  await deps.db
    .update(scanPoints)
    .set({ status: "failed", error: reason })
    .where(and(eq(scanPoints.scanId, scan.id), inArray(scanPoints.status, ["pending", "posted"])));
  // Settles on the real cost: nothing spent = the whole hold comes back.
  await settleCredits(deps, scan, won[0].costUsd);
  await createJobFailedAlertSafely(deps, { type: "scan", scanId: scan.id }, reason);
  return true;
}

// ---- retry policy -------------------------------------------------------------------

export type ErrorClass = "transient" | "permanent";

// Errors where running the same job again cannot succeed.
const PERMANENT_CODES: ReadonlySet<ErrorCode> = new Set([
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "VALIDATION_ERROR",
  "INSUFFICIENT_CREDITS",
  "SCAN_IN_PROGRESS",
  "COST_CEILING_EXCEEDED",
  "DATAFORSEO_AUTH_FAILED",
]);

const TRANSIENT_MESSAGE = /network|fetch failed|connection|timed? ?out|busy|locked|overloaded|temporar|reset|D1_ERROR|too many requests/i;

/**
 * Transient: DataForSEO 5xx / timeout (UPSTREAM_UNAVAILABLE), rate limits, D1
 * busy or overloaded, and anything unrecognised (bounded by max_retries, then
 * the DLQ). Permanent: validation, NOT_FOUND, insufficient credits, bad API
 * key, and programming errors (TypeError and friends).
 */
export function classifyJobError(error: unknown): ErrorClass {
  if (error instanceof AppError) return PERMANENT_CODES.has(error.code) ? "permanent" : "transient";
  if (error instanceof ZodError) return "permanent";
  // Workers surface network drops as TypeError ("Network connection lost"), so look at the message first.
  if (TRANSIENT_MESSAGE.test(error instanceof Error ? error.message : String(error))) return "transient";
  if (error instanceof TypeError || error instanceof RangeError || error instanceof SyntaxError) return "permanent";
  return "transient";
}

/** Exponential backoff for a message's nth delivery (attempts starts at 1): 10s, 20s, 40s ... capped at 5 minutes. */
export function retryDelaySeconds(attempts: number): number {
  return Math.min(300, 5 * 2 ** Math.max(1, attempts));
}

/** What a user may read about a permanent failure; internal errors stay in the logs. */
export function permanentFailureReason(error: unknown): string {
  return error instanceof AppError ? `Processing failed: ${error.message}` : "Processing failed: unexpected error";
}
