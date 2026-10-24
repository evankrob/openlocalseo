// Data retention, run from the daily Cron after the schedules. Only the bulk
// tables are pruned:
//   scan_results  per-point competitor lists (the bulk of storage), plus the
//                 raw R2 archive, for scans older than RETENTION_SCAN_RESULTS_DAYS
//   api_calls     older than RETENTION_API_CALLS_DAYS
//   rate_limits   old windows, older than RETENTION_RATE_LIMIT_ROWS days
// scans and scan_points (the rank grid and metrics) are kept forever, as are
// credit_ledger, gbp_snapshots and reviews. Work is bounded per run (batches of
// BATCH_ROWS, at most MAX_LOOPS per step); a backlog drains over the next days.
import { and, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { apiCalls, rateLimits, scanResults, scans } from "./db/schema";
import { nowIso } from "./lib";
import type { ProcessDeps } from "./scans/process";

export const BATCH_ROWS = 5000;
export const MAX_LOOPS = 20;
const DAY_MS = 86_400_000;
/** Objects per R2 list/delete call (the R2 maximum). */
const R2_BATCH = 1000;
/** R2 calls per run; each is a subrequest and Workers cap those per invocation. */
const MAX_R2_CALLS = 100;

export type RetentionSummary = {
  scanResultsDeleted: number;
  scansMarkedPruned: number;
  rawArchivesDeleted: number;
  apiCallsDeleted: number;
  rateLimitRowsDeleted: number;
  /** A step stopped at its loop cap: more is left for the next run. */
  truncated: boolean;
};

export type RetentionOptions = { batchRows?: number; maxLoops?: number };

type Drain = { total: number; truncated: boolean };

/** Runs a batch step until it handles less than a full batch or the loop cap is hit. */
async function drain(batchRows: number, maxLoops: number, step: () => Promise<number>): Promise<Drain> {
  let total = 0;
  for (let loop = 0; loop < maxLoops; loop++) {
    const n = await step();
    total += n;
    if (n < batchRows) return { total, truncated: false };
  }
  return { total, truncated: true };
}

export async function runRetention(deps: ProcessDeps, options: RetentionOptions = {}): Promise<RetentionSummary> {
  const { db, config } = deps;
  const batchRows = options.batchRows ?? BATCH_ROWS;
  const maxLoops = options.maxLoops ?? MAX_LOOPS;
  const now = deps.now?.() ?? new Date();
  const before = (days: number) => new Date(now.getTime() - days * DAY_MS);
  const { scanResultsDays, apiCallsDays, rateLimitDays } = config.retention;

  const summary: RetentionSummary = {
    scanResultsDeleted: 0,
    scansMarkedPruned: 0,
    rawArchivesDeleted: 0,
    apiCallsDeleted: 0,
    rateLimitRowsDeleted: 0,
    truncated: false,
  };
  const note = (d: Drain) => {
    summary.truncated ||= d.truncated;
    return d.total;
  };

  if (scanResultsDays > 0) {
    const cutoff = before(scanResultsDays).toISOString();
    // Only finished scans: an in-flight scan is still writing its results.
    const finished = and(lt(scans.createdAt, cutoff), inArray(scans.status, ["completed", "failed"]));

    // Mark first so readers show "expired" the moment rows start to disappear.
    summary.scansMarkedPruned = note(
      await drain(batchRows, maxLoops, async () => {
        const marked = await db
          .update(scans)
          .set({ resultsPrunedAt: nowIso(now) })
          .where(
            inArray(
              scans.id,
              db.select({ id: scans.id }).from(scans).where(and(finished, eq(scans.status, "completed"), isNull(scans.resultsPrunedAt))).limit(batchRows),
            ),
          )
          .returning({ id: scans.id });
        return marked.length;
      }),
    );

    summary.scanResultsDeleted = note(
      await drain(batchRows, maxLoops, async () => {
        const gone = await db
          .delete(scanResults)
          .where(
            inArray(
              scanResults.id,
              db
                .select({ id: scanResults.id })
                .from(scanResults)
                .where(inArray(scanResults.scanId, db.select({ id: scans.id }).from(scans).where(finished)))
                .limit(batchRows),
            ),
          )
          .returning({ id: scanResults.id });
        return gone.length;
      }),
    );

    summary.rawArchivesDeleted = await pruneRawArchives(deps, cutoff, () => (summary.truncated = true));
  }

  if (apiCallsDays > 0) {
    const cutoff = before(apiCallsDays).toISOString();
    summary.apiCallsDeleted = note(
      await drain(batchRows, maxLoops, async () => {
        const gone = await db
          .delete(apiCalls)
          .where(inArray(apiCalls.id, db.select({ id: apiCalls.id }).from(apiCalls).where(lt(apiCalls.createdAt, cutoff)).limit(batchRows)))
          .returning({ id: apiCalls.id });
        return gone.length;
      }),
    );
  }

  if (rateLimitDays > 0) {
    const cutoffSeconds = Math.floor(before(rateLimitDays).getTime() / 1000);
    summary.rateLimitRowsDeleted = note(
      await drain(batchRows, maxLoops, async () => {
        const gone = await db
          .delete(rateLimits)
          .where(sql`rowid IN (SELECT rowid FROM rate_limits WHERE window_start < ${cutoffSeconds} LIMIT ${batchRows})`)
          .returning({ key: rateLimits.key });
        return gone.length;
      }),
    );
  }

  return summary;
}

/**
 * Deletes the raw R2 archive of scans past the cutoff and nulls their
 * raw_r2_key. A scan whose archive is not fully deleted keeps its key, so the
 * next run picks it up. Resolves to the number of archives cleared.
 */
async function pruneRawArchives(deps: ProcessDeps, cutoff: string, markTruncated: () => void): Promise<number> {
  const { db, raw } = deps;
  if (!raw?.deletePrefix) return 0;
  let calls = 0;
  let cleared = 0;
  for (let loop = 0; loop < MAX_LOOPS; loop++) {
    const batch = await db
      .select({ id: scans.id, key: scans.rawR2Key })
      .from(scans)
      .where(and(lt(scans.createdAt, cutoff), isNotNull(scans.rawR2Key), inArray(scans.status, ["completed", "failed"])))
      .limit(50);
    if (batch.length === 0) return cleared;
    for (const scan of batch) {
      for (;;) {
        if (calls++ >= MAX_R2_CALLS) {
          markTruncated();
          return cleared;
        }
        const deleted = await raw.deletePrefix(scan.key!, R2_BATCH);
        if (deleted < R2_BATCH) break;
      }
      await db.update(scans).set({ rawR2Key: null }).where(eq(scans.id, scan.id));
      cleared++;
    }
  }
  markTruncated();
  return cleared;
}
