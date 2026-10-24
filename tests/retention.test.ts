import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { DEFAULT_RETENTION, loadConfig } from "@/worker/config";
import { apiCalls, rateLimits, scanPoints, scanResults, scans } from "@/worker/db/schema";
import { runRetention } from "@/worker/retention";
import { createScan } from "@/worker/scans/service";
import { createHarness, getScan, seedTracker, seedWorkspace, type Harness } from "./helpers/harness";
import { business, client } from "./helpers/http";
import type { TrackerId, WorkspaceId } from "@/shared/ids";

const DAY = 86_400_000;

let h: Harness;
let ws: WorkspaceId;
let trackerId: TrackerId;

beforeEach(async () => {
  h = await createHarness({ env: { AUTH_MODE: "local_noauth" } });
  ws = await seedWorkspace(h.db);
  ({ trackerId } = await seedTracker(h.db, ws, { gridSize: 3 }));
});

const ago = (days: number) => new Date(h.clock.now - days * DAY).toISOString();

/** Runs a finished scan, then back-dates it. */
async function scanAged(days: number) {
  const { scanId } = await createScan(h.deps, ws, trackerId, { trigger: "manual" });
  await h.queue.drain(h.deps);
  await h.db.update(scans).set({ createdAt: ago(days) }).where(eq(scans.id, scanId));
  return scanId;
}

const resultCount = async (scanId: string) => (await h.db.select().from(scanResults).where(eq(scanResults.scanId, scanId))).length;

describe("scan_results retention", () => {
  it("prunes competitor rows and raw archives past the cutoff, keeps younger ones, and keeps every grid and metric", async () => {
    const old = await scanAged(401);
    const recent = await scanAged(399);
    const before = { old: await getScan(h.db, old), points: await h.db.select().from(scanPoints).where(eq(scanPoints.scanId, old)) };
    expect(await resultCount(old)).toBeGreaterThan(0);
    expect(before.old.rawR2Key).not.toBeNull();
    const recentResults = await resultCount(recent);
    const rawBefore = h.raw.objects.size;

    const summary = await runRetention(h.deps);
    expect(summary).toMatchObject({ scansMarkedPruned: 1, rawArchivesDeleted: 1, truncated: false });
    expect(summary.scanResultsDeleted).toBeGreaterThan(0);

    expect(await resultCount(old)).toBe(0);
    expect(await resultCount(recent)).toBe(recentResults);
    expect(h.raw.objects.size).toBe(rawBefore - 1);
    expect([...h.raw.objects.keys()].some((k) => k.startsWith(before.old.rawR2Key!))).toBe(false);

    const after = await getScan(h.db, old);
    expect(after.rawR2Key).toBeNull();
    expect(after.resultsPrunedAt).not.toBeNull();
    expect((await getScan(h.db, recent)).resultsPrunedAt).toBeNull();
    // The scan row (metrics) and its points (the rank grid) are untouched.
    expect({ ...after, rawR2Key: before.old.rawR2Key, resultsPrunedAt: null }).toEqual({ ...before.old, resultsPrunedAt: null });
    expect(await h.db.select().from(scanPoints).where(eq(scanPoints.scanId, old))).toEqual(before.points);
    expect(after.status).toBe("completed");
    expect(after.atrp).not.toBeNull();
  });

  it("uses a strict cutoff on the scan's age, and leaves in-flight scans alone", async () => {
    const exactly = await scanAged(400);
    // 400 days to the millisecond is not older than the cutoff; one second more is.
    await h.db.update(scans).set({ createdAt: new Date(h.clock.now - 400 * DAY).toISOString() }).where(eq(scans.id, exactly));
    await runRetention(h.deps);
    expect((await getScan(h.db, exactly)).resultsPrunedAt).toBeNull();
    await h.db.update(scans).set({ createdAt: new Date(h.clock.now - 400 * DAY - 1000).toISOString() }).where(eq(scans.id, exactly));
    await runRetention(h.deps);
    expect((await getScan(h.db, exactly)).resultsPrunedAt).not.toBeNull();

    const { scanId: active } = await createScan(h.deps, ws, trackerId, { trigger: "manual" });
    await h.db.update(scans).set({ createdAt: ago(500) }).where(eq(scans.id, active));
    await h.queue.drain(h.deps);
    // finished now; back to "polling" to look in flight while old
    await h.db.update(scans).set({ status: "polling" }).where(eq(scans.id, active));
    const rows = await resultCount(active);
    await runRetention(h.deps);
    expect(await resultCount(active)).toBe(rows);
    expect((await getScan(h.db, active)).resultsPrunedAt).toBeNull();
  });

  it("works in bounded batches and finishes over several runs", async () => {
    const old = await scanAged(500);
    const total = await resultCount(old);
    expect(total).toBeGreaterThan(20);
    const first = await runRetention(h.deps, { batchRows: 10, maxLoops: 2 });
    expect(first).toMatchObject({ scanResultsDeleted: 20, truncated: true });
    expect(await resultCount(old)).toBe(total - 20);
    let runs = 0;
    while ((await resultCount(old)) > 0 && runs++ < 100) await runRetention(h.deps, { batchRows: 10, maxLoops: 2 });
    expect(await resultCount(old)).toBe(0);
    expect((await runRetention(h.deps)).truncated).toBe(false);
  });

  it("deletes a raw archive that spans several R2 batches before clearing its key", async () => {
    const old = await scanAged(500);
    const key = (await getScan(h.db, old)).rawR2Key!;
    for (let i = 0; i < 1005; i++) h.raw.objects.set(`${key}extra-${i}.json`, "{}");
    const first = await runRetention(h.deps);
    expect(first.rawArchivesDeleted).toBe(1);
    expect(h.raw.objects.size).toBe(0);
    expect((await getScan(h.db, old)).rawR2Key).toBeNull();
  });

  it("is off when the days are 0", async () => {
    const forever = await createHarness({ env: { RETENTION_SCAN_RESULTS_DAYS: "0", RETENTION_API_CALLS_DAYS: "0", RETENTION_RATE_LIMIT_ROWS: "0" } });
    expect(forever.config.retention).toEqual({ scanResultsDays: 0, apiCallsDays: 0, rateLimitDays: 0 });
    expect(await runRetention(forever.deps)).toEqual({
      scanResultsDeleted: 0,
      scansMarkedPruned: 0,
      rawArchivesDeleted: 0,
      apiCallsDeleted: 0,
      rateLimitRowsDeleted: 0,
      truncated: false,
    });
  });

  it("has the documented defaults and reads overrides", () => {
    expect(loadConfig({}).retention).toEqual({ scanResultsDays: 400, apiCallsDays: 180, rateLimitDays: 1 });
    expect(DEFAULT_RETENTION).toEqual({ scanResultsDays: 400, apiCallsDays: 180, rateLimitDays: 1 });
    expect(loadConfig({ RETENTION_SCAN_RESULTS_DAYS: "30", RETENTION_API_CALLS_DAYS: "x" }).retention).toMatchObject({ scanResultsDays: 30, apiCallsDays: 180 });
  });
});

describe("api_calls and rate_limits retention", () => {
  it("prunes api_calls older than 180 days and rate-limit rows older than a day", async () => {
    const call = (id: string, days: number) => ({ id, workspaceId: ws, provider: "dataforseo", mode: "live" as const, path: "p", taskCount: 1, costUsd: 0.01, createdAt: ago(days) });
    await h.db.insert(apiCalls).values([call("old", 181), call("edge", 179), call("new", 1)]);
    const seconds = Math.floor(h.clock.now / 1000);
    await h.db.insert(rateLimits).values([
      { key: "a:x", windowStart: seconds - 86_400 - 60, count: 5 },
      { key: "a:x", windowStart: seconds - 3600, count: 5 },
      { key: "b:y", windowStart: seconds, count: 1 },
    ]);

    const summary = await runRetention(h.deps);
    expect(summary).toMatchObject({ apiCallsDeleted: 1, rateLimitRowsDeleted: 1 });
    expect((await h.db.select({ id: apiCalls.id }).from(apiCalls)).map((r) => r.id).sort()).toEqual(["edge", "new"]);
    expect(await h.db.select().from(rateLimits)).toHaveLength(2);
  });
});

describe("pruned scans in the API and public reports", () => {
  it("shows the grid and metrics with a competitorsExpired flag instead of an empty list", async () => {
    const c = client(h);
    const biz = await c.call("POST", "/api/businesses", business);
    const tracker = await c.call("POST", "/api/trackers", { businessId: biz.json.id, keyword: "coffee shop", gridSize: 3 });
    const { scanId } = (await c.call("POST", `/api/trackers/${tracker.json.id}/scans`, {})).json;
    await h.queue.drain(h.deps);
    const share = (await c.call("POST", `/api/trackers/${tracker.json.id}/shares`, { showCompetitors: true })).json;

    const fresh = await c.call("GET", `/api/scans/${scanId}`);
    expect(fresh.json.competitorsExpired).toBe(false);
    expect(fresh.json.competitors.length).toBeGreaterThan(0);
    const pointId = fresh.json.points[0].id as string;

    await h.db.update(scans).set({ createdAt: ago(401) }).where(eq(scans.id, scanId));
    await runRetention(h.deps);

    const detail = await c.call("GET", `/api/scans/${scanId}`);
    expect(detail.status).toBe(200);
    expect(detail.json).toMatchObject({ competitorsExpired: true, competitors: [], otherListings: [], retentionDays: 400 });
    expect(detail.json.points).toHaveLength(9);
    expect(detail.json.metrics.totalPoints).toBe(9);
    expect(detail.json.metrics.atrp).toBe(fresh.json.metrics.atrp);

    const point = await c.call("GET", `/api/scans/${scanId}/points/${pointId}`);
    expect(point.status).toBe(200);
    expect(point.json).toMatchObject({ results: [], competitorsExpired: true });
    expect(point.json.point.id).toBe(pointId);

    const report = await client(h).call("GET", `/api/public/reports/${share.token}`);
    expect(report.status).toBe(200);
    expect(report.json).toMatchObject({ competitorsExpired: true, retentionDays: 400, competitors: [] });
    expect(report.json.scan.points).toHaveLength(9);
    expect(report.json.scan.metrics.atrp).toBe(fresh.json.metrics.atrp);
    const publicPoint = await client(h).call("GET", `/api/public/reports/${share.token}/points/${pointId}?scan=${scanId}`);
    expect(publicPoint.json).toMatchObject({ results: [], competitorsExpired: true });
  });
});
