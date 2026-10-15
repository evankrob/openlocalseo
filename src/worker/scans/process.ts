// Scan pipeline, run by the queue consumer. A scan moves
//   queued -> posting -> polling -> completed | failed
// "post" submits every grid point (or fans out live searches), "collect" /
// "live" jobs fetch results for a chunk of points, and whichever job
// finishes the last point finalizes the scan (metrics, credit settlement).
// Every step is idempotent: queue messages can be delivered twice.
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { computeMetrics, normalizeRank } from "@/shared/metrics";
import { creditsForProviderUsd, roundUsd } from "@/shared/pricing";
import { chargeOverage, refundCredits } from "../billing/credits";
import type { Db } from "../db";
import { apiCalls, businesses, scanPoints, scanResults, scans, trackers } from "../db/schema";
import type { DataForSeoProvider, LiveSearchInput, MapResult, MockHints } from "../dataforseo/types";
import { MAX_TASKS_PER_POST } from "../dataforseo/types";
import { chunk, newId, nowIso } from "../lib";
import { COLLECT_CHUNK, LIVE_CHUNK, type ScanJob } from "./jobs";
import { businessKey, isTargetBusiness } from "./match";
import { pointCoordinate, type ScanDeps } from "./service";
import { insertResults, updatePoints, type PointUpdate, type ResultInsert } from "./sql";

export interface RawStore {
  put(key: string, body: string): Promise<void>;
}

export type ProcessDeps = ScanDeps & {
  provider: DataForSeoProvider;
  raw?: RawStore;
  now?: () => Date;
};

type ScanRow = typeof scans.$inferSelect;
type PointRow = typeof scanPoints.$inferSelect;
type BusinessRow = typeof businesses.$inferSelect;

export async function handleScanJob(deps: ProcessDeps, job: ScanJob): Promise<void> {
  switch (job.type) {
    case "post":
      return handlePost(deps, job.scanId);
    case "collect":
      return handleCollect(deps, job.scanId, job.pointIds);
    case "live":
      return handleLive(deps, job.scanId, job.pointIds);
  }
}

async function loadScan(db: Db, scanId: string) {
  const [scan] = await db.select().from(scans).where(eq(scans.id, scanId));
  return scan;
}

// A job can run just before the post step flips the scan to "polling".
const isActive = (scan: ScanRow) => scan.status === "posting" || scan.status === "polling";

async function loadTarget(db: Db, trackerId: string): Promise<BusinessRow | undefined> {
  const [row] = await db
    .select({ business: businesses })
    .from(trackers)
    .innerJoin(businesses, eq(businesses.id, trackers.businessId))
    .where(eq(trackers.id, trackerId));
  return row?.business;
}

function mockHints(provider: DataForSeoProvider, business: BusinessRow): MockHints | undefined {
  if (provider.mode !== "mock") return undefined;
  return {
    target: {
      name: business.name,
      placeId: business.placeId,
      domain: business.domain,
      lat: business.lat,
      lng: business.lng,
    },
  };
}

async function recordApiCall(
  deps: ProcessDeps,
  scan: ScanRow,
  path: string[],
  costUsd: number,
  taskCount: number,
) {
  if (costUsd <= 0 && taskCount === 0) return;
  await deps.db.insert(apiCalls).values({
    id: newId(),
    workspaceId: scan.workspaceId,
    scanId: scan.id,
    provider: "dataforseo",
    mode: deps.provider.mode,
    path: path.join("/"),
    taskCount,
    costUsd,
  });
  await deps.db
    .update(scans)
    .set({ costUsd: sql`round(${scans.costUsd} + ${costUsd}, 6)` })
    .where(eq(scans.id, scan.id));
}

// ---- post ------------------------------------------------------------------

async function handlePost(deps: ProcessDeps, scanId: string) {
  const { db, queue, provider } = deps;
  // Claim the scan; a redelivered message finds it already claimed.
  const claimed = await db
    .update(scans)
    .set({ status: "posting" })
    .where(and(eq(scans.id, scanId), eq(scans.status, "queued")))
    .returning({ id: scans.id });
  if (claimed.length === 0) {
    // Redelivered after the tasks were posted but before collection was
    // queued: finish that step. Never re-post (it would bill twice).
    const existing = await loadScan(db, scanId);
    if (existing?.status === "posting") await resumeAfterPost(deps, existing);
    return;
  }

  const scan = (await loadScan(db, scanId))!;
  const points = await db
    .select()
    .from(scanPoints)
    .where(eq(scanPoints.scanId, scanId))
    .orderBy(scanPoints.row, scanPoints.col);

  if (scan.queueMode === "live") {
    await queue.sendBatch(
      chunk(points, LIVE_CHUNK).map((c) => ({
        body: { type: "live" as const, scanId, pointIds: c.map((p) => p.id) },
      })),
    );
    await db.update(scans).set({ status: "polling" }).where(and(eq(scans.id, scanId), eq(scans.status, "posting")));
    return;
  }

  const business = await loadTarget(db, scan.trackerId);
  const hints = business ? mockHints(provider, business) : undefined;
  const failures: PointUpdate[] = [];
  const posted: PointUpdate[] = [];

  for (const group of chunk(points, MAX_TASKS_PER_POST)) {
    try {
      const result = await provider.postTasks({
        keyword: scan.keyword,
        searchType: scan.searchType,
        coordinates: group.map((p) => pointCoordinate(p, scan.zoom)),
        languageCode: scan.languageCode,
        device: scan.device,
        depth: scan.depth,
        queue: scan.queueMode as "standard" | "priority",
        mockHints: hints,
      });
      await recordApiCall(deps, scan, result.billing.path, result.billing.costUsd, group.length);
      group.forEach((point, i) => {
        const taskId = result.taskIds[i];
        if (taskId) posted.push({ id: point.id, status: "posted", taskId });
        else failures.push({ id: point.id, status: "failed", error: "Rejected by DataForSEO" });
      });
    } catch (error) {
      // Never replayed: a failed post may still have been billed upstream.
      const message = error instanceof Error ? error.message : "Submitting tasks failed";
      console.warn("scan.post-failed", { scanId, message });
      for (const point of group) failures.push({ id: point.id, status: "failed", error: message });
    }
  }

  await updatePoints(db, [...posted, ...failures]);
  await startCollecting(deps, scan, posted.map((p) => p.id));
}

async function startCollecting(deps: ProcessDeps, scan: ScanRow, postedIds: string[]) {
  const { db, queue, config } = deps;
  if (postedIds.length > 0) {
    const delay = config.pollDelaySeconds[scan.queueMode as "standard" | "priority"];
    await queue.sendBatch(
      chunk(postedIds, COLLECT_CHUNK).map((ids) => ({
        body: { type: "collect" as const, scanId: scan.id, pointIds: ids },
        delaySeconds: delay,
      })),
    );
  }
  await db.update(scans).set({ status: "polling" }).where(eq(scans.id, scan.id));
  await finalizeIfDone(deps, scan.id);
}

async function resumeAfterPost(deps: ProcessDeps, scan: ScanRow) {
  const points = await deps.db.select().from(scanPoints).where(eq(scanPoints.scanId, scan.id));
  // Still-pending points mean the post itself is unfinished: leave it to the reaper.
  if (points.some((p) => p.status === "pending")) return;
  await startCollecting(deps, scan, points.filter((p) => p.status === "posted").map((p) => p.id));
}

// ---- collect ----------------------------------------------------------------

async function handleCollect(deps: ProcessDeps, scanId: string, pointIds: string[]) {
  const { db, queue, provider, config } = deps;
  const scan = await loadScan(db, scanId);
  if (!scan || !isActive(scan)) return;

  const points = await db
    .select()
    .from(scanPoints)
    .where(and(eq(scanPoints.scanId, scanId), inArray(scanPoints.id, pointIds), eq(scanPoints.status, "posted")));
  if (points.length === 0) return;
  const business = (await loadTarget(db, scan.trackerId))!;

  const outcomes = await Promise.all(
    points.map(async (point) => {
      try {
        return { point, outcome: await provider.getTask(scan.searchType, point.taskId!) };
      } catch (error) {
        // Transient (rate limit, upstream 5xx): leave pending, try next round.
        console.warn("scan.collect-error", { scanId, message: (error as Error).message });
        return { point, outcome: { status: "pending" as const } };
      }
    }),
  );

  const updates: PointUpdate[] = [];
  const results: ResultInsert[] = [];
  const rawPoints: unknown[] = [];
  const pending: PointRow[] = [];
  for (const { point, outcome } of outcomes) {
    if (outcome.status === "pending") pending.push(point);
    else if (outcome.status === "failed") updates.push({ id: point.id, status: "failed", error: outcome.message });
    else {
      const { rank, rows } = interpretResults(point, outcome.items, business);
      updates.push({ id: point.id, status: "completed", rank });
      results.push(...rows);
      rawPoints.push({ pointId: point.id, lat: point.lat, lng: point.lng, result: outcome.raw ?? null });
    }
  }

  await persistPointResults(deps, scan, updates, results, rawPoints);

  if (pending.length > 0) {
    const waitedSeconds = ((deps.now?.() ?? new Date()).getTime() - new Date(scan.createdAt).getTime()) / 1000;
    if (waitedSeconds > config.maxScanSeconds[scan.queueMode]) {
      await updatePoints(
        db,
        pending.map((p) => ({ id: p.id, status: "failed" as const, error: "Timed out waiting for DataForSEO" })),
      );
    } else {
      await queue.send(
        { type: "collect", scanId, pointIds: pending.map((p) => p.id) },
        { delaySeconds: config.pollDelaySeconds[scan.queueMode as "standard" | "priority"] },
      );
    }
  }
  await finalizeIfDone(deps, scanId);
}

// ---- live -------------------------------------------------------------------

async function handleLive(deps: ProcessDeps, scanId: string, pointIds: string[]) {
  const { db, provider } = deps;
  const scan = await loadScan(db, scanId);
  if (!scan || !isActive(scan)) return;
  const points = await db
    .select()
    .from(scanPoints)
    .where(and(eq(scanPoints.scanId, scanId), inArray(scanPoints.id, pointIds), eq(scanPoints.status, "pending")));
  if (points.length === 0) return;
  const business = (await loadTarget(db, scan.trackerId))!;
  const hints = mockHints(provider, business);

  let costUsd = 0;
  let billed = 0;
  const updates: PointUpdate[] = [];
  const results: ResultInsert[] = [];
  await Promise.all(
    points.map(async (point) => {
      const input: LiveSearchInput = {
        keyword: scan.keyword,
        searchType: scan.searchType,
        coordinate: pointCoordinate(point, scan.zoom),
        languageCode: scan.languageCode,
        device: scan.device,
        depth: scan.depth,
        mockHints: hints,
      };
      try {
        const result = await provider.liveSearch(input);
        costUsd += result.billing.costUsd;
        billed++;
        const { rank, rows } = interpretResults(point, result.items, business);
        updates.push({ id: point.id, status: "completed", rank });
        results.push(...rows);
      } catch (error) {
        // A charged-but-failed task still carries its cost.
        const charged = (error as { billing?: { costUsd: number } }).billing;
        if (charged) costUsd += charged.costUsd;
        updates.push({ id: point.id, status: "failed", error: error instanceof Error ? error.message : "Search failed" });
      }
    }),
  );
  if (billed > 0 || costUsd > 0) {
    await recordApiCall(deps, scan, ["v3", "serp", "google", scan.searchType, "live", "advanced"], roundUsd(costUsd), billed);
  }
  await persistPointResults(deps, scan, updates, results, []);
  await finalizeIfDone(deps, scanId);
}

// ---- shared -----------------------------------------------------------------

function interpretResults(point: PointRow, items: MapResult[], business: BusinessRow) {
  const rows: ResultInsert[] = [];
  let rank: number | null = null;
  for (const item of items) {
    const isTarget = isTargetBusiness(item, business);
    if (isTarget && (rank === null || item.rank < rank)) rank = item.rank;
    rows.push({
      id: newId(),
      pointId: point.id,
      rank: item.rank,
      businessKey: businessKey(item),
      name: item.name,
      placeId: item.placeId,
      cid: item.cid,
      domain: item.domain,
      rating: item.rating,
      ratingCount: item.ratingCount,
      category: item.category,
      address: item.address,
      isTarget,
    });
  }
  return { rank: normalizeRank(rank), rows };
}

async function persistPointResults(
  deps: ProcessDeps,
  scan: ScanRow,
  updates: PointUpdate[],
  results: ResultInsert[],
  rawPoints: unknown[],
) {
  // Results first, then the status flip. A retry after a crash in between sees
  // the points still unfinished, so clear any rows written by the first attempt.
  const touched = [...new Set(results.map((r) => r.pointId))];
  for (const ids of chunk(touched, 50)) await deps.db.delete(scanResults).where(inArray(scanResults.pointId, ids));
  for (const group of chunk(results, 200)) await insertResults(deps.db, scan.id, group);
  await updatePoints(deps.db, updates);
  if (rawPoints.length > 0 && deps.raw) {
    const key = `raw/${scan.workspaceId}/${scan.id}/${newId()}.json`;
    try {
      await deps.raw.put(key, JSON.stringify({ scanId: scan.id, keyword: scan.keyword, points: rawPoints }));
      await deps.db.update(scans).set({ rawR2Key: `raw/${scan.workspaceId}/${scan.id}/` }).where(eq(scans.id, scan.id));
    } catch (error) {
      // The archive is best-effort; the scan's data is already in D1.
      console.warn("scan.raw-archive-failed", { scanId: scan.id, message: (error as Error).message });
    }
  }
}

/** Finishes the scan once no point is still waiting. Safe to call repeatedly. */
async function finalizeIfDone(deps: ProcessDeps, scanId: string) {
  const { db } = deps;
  const points = await db.select().from(scanPoints).where(eq(scanPoints.scanId, scanId));
  if (points.some((p) => p.status === "pending" || p.status === "posted")) return;

  const completed = points.filter((p) => p.status === "completed");
  const failedCount = points.length - completed.length;
  const firstError = points.find((p) => p.status === "failed")?.error ?? null;
  const metrics = computeMetrics(completed.map((p) => p.rank));

  const [scan] = await db.select().from(scans).where(eq(scans.id, scanId));
  if (!scan) return;
  const succeeded = completed.length > 0;
  const error = !succeeded
    ? (firstError ?? "No points completed")
    : failedCount > 0
      ? `${failedCount} of ${points.length} points failed (${firstError ?? "unknown error"}); metrics cover the ${completed.length} that completed`
      : null;

  // Only one finalizer wins this transition and settles the credits.
  const won = await db
    .update(scans)
    .set({
      status: succeeded ? "completed" : "failed",
      completedAt: nowIso(deps.now?.()),
      error,
      arp: metrics.arp,
      atrp: metrics.atrp,
      solv: metrics.solv,
      foundPoints: metrics.foundPoints,
      top3Points: metrics.top3Points,
    })
    .where(and(eq(scans.id, scanId), inArray(scans.status, ["posting", "polling"])))
    .returning({ id: scans.id, costUsd: scans.costUsd });
  if (won.length === 0) return;
  await settleCredits(deps, scan, won[0].costUsd);
}

/** Bills the real cost against the hold: refund the unused part, or charge the overage. */
async function settleCredits(deps: ProcessDeps, scan: ScanRow, costUsd: number) {
  if (deps.config.billingMode !== "hosted" || scan.reservedCredits === 0) return;
  const billed = creditsForProviderUsd(costUsd, deps.config.markup);
  await deps.db.update(scans).set({ billedCredits: billed }).where(eq(scans.id, scan.id));
  if (billed < scan.reservedCredits) await refundCredits(deps.db, scan.workspaceId, scan.reservedCredits - billed, scan.id);
  else if (billed > scan.reservedCredits) await chargeOverage(deps.db, scan.workspaceId, billed - scan.reservedCredits, scan.id);
}

/**
 * Cron safety net: fails scans stuck in an active state (a crashed consumer,
 * a message that exhausted its retries) and returns unspent credits.
 */
export async function reapStaleScans(deps: ProcessDeps, olderThanSeconds = 6 * 3600): Promise<number> {
  const cutoff = new Date((deps.now?.() ?? new Date()).getTime() - olderThanSeconds * 1000).toISOString();
  const stale = await deps.db
    .select()
    .from(scans)
    .where(and(inArray(scans.status, ["queued", "posting", "polling"]), lt(scans.createdAt, cutoff)));
  let reaped = 0;
  for (const scan of stale) {
    const won = await deps.db
      .update(scans)
      .set({ status: "failed", error: "Scan timed out and was stopped", completedAt: nowIso(deps.now?.()) })
      .where(and(eq(scans.id, scan.id), inArray(scans.status, ["queued", "posting", "polling"])))
      .returning({ costUsd: scans.costUsd });
    if (won.length === 0) continue;
    await deps.db
      .update(scanPoints)
      .set({ status: "failed", error: "Scan timed out" })
      .where(and(eq(scanPoints.scanId, scan.id), inArray(scanPoints.status, ["pending", "posted"])));
    await settleCredits(deps, scan, won[0].costUsd);
    reaped++;
  }
  return reaped;
}

