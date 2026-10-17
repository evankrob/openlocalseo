import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { apiCalls, creditLedger, scanPoints, scanResults, scans, workspaces } from "@/worker/db/schema";
import { createScan } from "@/worker/scans/service";
import { reapStaleScans } from "@/worker/scans/process";
import { computeMetrics } from "@/shared/metrics";
import { getBalance, grantCredits } from "@/worker/billing/credits";
import { MockDataForSeo } from "@/worker/dataforseo/mock";
import type { DataForSeoProvider } from "@/worker/dataforseo/types";
import { createHarness, getScan, seedTracker, seedWorkspace, type Harness } from "./helpers/harness";

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});

describe("scan pipeline (standard queue, mock provider)", () => {
  it("runs a 5x5 scan end to end: points, ranks, metrics, results and tracked cost", async () => {
    const ws = await seedWorkspace(h.db);
    const { trackerId } = await seedTracker(h.db, ws);

    const { scanId, quote } = await createScan(h.deps, ws, trackerId, { trigger: "manual" });
    expect(quote).toMatchObject({ points: 25, providerCostUsd: 0.015, credits: 0 });
    expect((await getScan(h.db, scanId)).status).toBe("queued");

    await h.queue.drain(h.deps);

    const scan = await getScan(h.db, scanId);
    expect(scan.status).toBe("completed");
    expect(scan.error).toBeNull();
    const points = await h.db.select().from(scanPoints).where(eq(scanPoints.scanId, scanId));
    expect(points).toHaveLength(25);
    expect(points.every((p) => p.status === "completed")).toBe(true);

    const expected = computeMetrics(points.map((p) => p.rank));
    expect(scan).toMatchObject({ arp: expected.arp, atrp: expected.atrp, solv: expected.solv, foundPoints: expected.foundPoints });
    // The tracked business sits in the middle of the grid, so it ranks well there.
    const center = points.find((p) => p.row === 2 && p.col === 2)!;
    expect(center.rank).not.toBeNull();
    expect(center.rank!).toBeLessThanOrEqual(3);

    const results = await h.db.select().from(scanResults).where(eq(scanResults.scanId, scanId));
    expect(results.length).toBeGreaterThan(25 * 5);
    // is_target lines up with the point rank
    const targetRows = results.filter((r) => r.isTarget);
    expect(targetRows.length).toBe(points.filter((p) => p.rank !== null).length);

    const calls = await h.db.select().from(apiCalls).where(eq(apiCalls.scanId, scanId));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ mode: "mock", taskCount: 25, costUsd: 0.015, path: "v3/serp/google/maps/task_post" });
    expect(scan.costUsd).toBeCloseTo(0.015, 6);
    expect(scan.rawR2Key).toMatch(/^raw\/ws-1\//);
    expect(h.raw.objects.size).toBeGreaterThan(0);
  });

  it("polls until the standard queue delay has passed instead of finishing early", async () => {
    const ws = await seedWorkspace(h.db);
    const { trackerId } = await seedTracker(h.db, ws);
    const start = h.clock.now;
    const { scanId } = await createScan(h.deps, ws, trackerId, { trigger: "manual" });
    await h.queue.drain(h.deps);
    expect((await getScan(h.db, scanId)).status).toBe("completed");
    // mock standard delay is 12 s; collection cannot have finished sooner
    expect(h.clock.now - start).toBeGreaterThanOrEqual(12_000);
    expect(h.queue.delivered.filter((j) => j.type === "collect").length).toBeGreaterThan(1);
  });

  it("splits a 13x13 grid into 100-task posts and 25-point collect jobs", async () => {
    const ws = await seedWorkspace(h.db);
    const { trackerId } = await seedTracker(h.db, ws, { gridSize: 13, radiusKm: 10 });
    const { scanId } = await createScan(h.deps, ws, trackerId, { trigger: "manual" });
    await h.queue.drain(h.deps);
    const scan = await getScan(h.db, scanId);
    expect(scan.status).toBe("completed");
    expect(scan.totalPoints).toBe(169);
    const calls = await h.db.select().from(apiCalls).where(eq(apiCalls.scanId, scanId));
    expect(calls.map((c) => c.taskCount).sort((a, b) => a - b)).toEqual([69, 100]);
    expect(scan.costUsd).toBeCloseTo(0.1014, 6);
  });

  it("is idempotent when the post message is delivered twice", async () => {
    const ws = await seedWorkspace(h.db);
    const { trackerId } = await seedTracker(h.db, ws);
    const { scanId } = await createScan(h.deps, ws, trackerId, { trigger: "manual" });
    h.queue.messages.push({ job: { type: "post", scanId }, at: h.clock.now });
    await h.queue.drain(h.deps);
    expect(await h.db.select().from(apiCalls).where(eq(apiCalls.scanId, scanId))).toHaveLength(1);
    expect((await getScan(h.db, scanId)).status).toBe("completed");
  });

  it("allows one active scan per tracker", async () => {
    const ws = await seedWorkspace(h.db);
    const { trackerId } = await seedTracker(h.db, ws);
    await createScan(h.deps, ws, trackerId, { trigger: "manual" });
    await expect(createScan(h.deps, ws, trackerId, { trigger: "manual" })).rejects.toMatchObject({ code: "SCAN_IN_PROGRESS" });
    await h.queue.drain(h.deps);
    await expect(createScan(h.deps, ws, trackerId, { trigger: "manual" })).resolves.toBeTruthy();
  });

  it("keeps tenants apart: another workspace cannot scan this tracker", async () => {
    const ws = await seedWorkspace(h.db);
    await seedWorkspace(h.db, 0, "ws-2");
    const { trackerId } = await seedTracker(h.db, ws);
    await expect(createScan(h.deps, "ws-2", trackerId, { trigger: "manual" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses to start above the approved cost ceiling", async () => {
    const ws = await seedWorkspace(h.db);
    const { trackerId } = await seedTracker(h.db, ws, { gridSize: 13 });
    await expect(createScan(h.deps, ws, trackerId, { trigger: "mcp", maxCostUsd: 0.05 })).rejects.toMatchObject({ code: "COST_CEILING_EXCEEDED" });
    expect(await h.db.select().from(scans)).toHaveLength(0);
    await expect(createScan(h.deps, ws, trackerId, { trigger: "mcp", maxCostUsd: 0.11 })).resolves.toBeTruthy();
  });
});

describe("queue modes", () => {
  it("priority is quoted and billed at the priority price and finishes faster", async () => {
    const ws = await seedWorkspace(h.db);
    const { trackerId } = await seedTracker(h.db, ws, { queueMode: "priority", gridSize: 7 });
    const start = h.clock.now;
    const { scanId, quote } = await createScan(h.deps, ws, trackerId, { trigger: "manual" });
    expect(quote.providerCostUsd).toBe(0.0588);
    await h.queue.drain(h.deps);
    const scan = await getScan(h.db, scanId);
    expect(scan.status).toBe("completed");
    expect(scan.costUsd).toBeCloseTo(0.0588, 6);
    expect(h.clock.now - start).toBeLessThan(12_000);
  });

  it("live runs one search per point at the live price, no polling", async () => {
    const ws = await seedWorkspace(h.db);
    const { trackerId } = await seedTracker(h.db, ws, { queueMode: "live", gridSize: 7 });
    const { scanId } = await createScan(h.deps, ws, trackerId, { trigger: "manual" });
    await h.queue.drain(h.deps);
    const scan = await getScan(h.db, scanId);
    expect(scan.status).toBe("completed");
    expect(scan.costUsd).toBeCloseTo(0.098, 6);
    expect(h.queue.delivered.some((j) => j.type === "collect")).toBe(false);
    expect(h.queue.delivered.filter((j) => j.type === "live")).toHaveLength(3); // 49 points / 20 per job
  });

  it("Local Finder scans use the local_finder endpoint path", async () => {
    const ws = await seedWorkspace(h.db);
    const { trackerId } = await seedTracker(h.db, ws, { searchType: "local_finder" });
    const { scanId } = await createScan(h.deps, ws, trackerId, { trigger: "manual" });
    await h.queue.drain(h.deps);
    const [call] = await h.db.select().from(apiCalls).where(eq(apiCalls.scanId, scanId));
    expect(call.path).toBe("v3/serp/google/local_finder/task_post");
  });
});

describe("failure handling", () => {
  it("completes with partial metrics when some points fail", async () => {
    h = await createHarness({ mock: { shouldFail: (c) => c.startsWith("35.7") && c.includes("-78.6382") } });
    const ws = await seedWorkspace(h.db);
    const { trackerId } = await seedTracker(h.db, ws);
    const { scanId } = await createScan(h.deps, ws, trackerId, { trigger: "manual" });
    await h.queue.drain(h.deps);
    const scan = await getScan(h.db, scanId);
    const points = await h.db.select().from(scanPoints).where(eq(scanPoints.scanId, scanId));
    const failed = points.filter((p) => p.status === "failed");
    expect(failed.length).toBeGreaterThan(0);
    expect(scan.status).toBe("completed");
    expect(scan.error).toMatch(/points failed/);
    const done = points.filter((p) => p.status === "completed");
    expect(scan.atrp).toBe(computeMetrics(done.map((p) => p.rank)).atrp);
  });

  it("fails the scan and refunds the hold when the post step errors", async () => {
    const broken = (clock: { now: number }): DataForSeoProvider => {
      const inner = new MockDataForSeo({ now: () => clock.now });
      return { mode: "mock", getTask: inner.getTask.bind(inner), liveSearch: inner.liveSearch.bind(inner), postTasks: async () => { throw new Error("DataForSEO HTTP 401"); } };
    };
    h = await createHarness({ env: { BILLING_MODE: "hosted" }, provider: broken });
    const ws = await seedWorkspace(h.db, 500);
    const { trackerId } = await seedTracker(h.db, ws);
    const { scanId } = await createScan(h.deps, ws, trackerId, { trigger: "manual" });
    expect(await getBalance(h.db, ws)).toBe(500 - 20); // 25 pts: $0.015 * 1.28 -> 20 credits
    await h.queue.drain(h.deps);
    const scan = await getScan(h.db, scanId);
    expect(scan.status).toBe("failed");
    expect(scan.error).toContain("401");
    expect(await getBalance(h.db, ws)).toBe(500);
  });

  it("gives up on tasks DataForSEO never finishes, then fails and refunds", async () => {
    h = await createHarness({ env: { BILLING_MODE: "hosted", POLL_INTERVAL_SECONDS: "600" }, mock: { delaysMs: { standard: 10 * 3600_000, priority: 1 } } });
    const ws = await seedWorkspace(h.db, 500);
    const { trackerId } = await seedTracker(h.db, ws);
    const { scanId } = await createScan(h.deps, ws, trackerId, { trigger: "manual" });
    await h.queue.drain(h.deps);
    const scan = await getScan(h.db, scanId);
    expect(scan.status).toBe("failed");
    expect(scan.error).toMatch(/Timed out/);
    // the tasks were posted (and billed upstream), so the cost is still charged
    expect(await getBalance(h.db, ws)).toBe(500 - scan.billedCredits);
    expect(scan.billedCredits).toBe(20);
  });

  it("reaper stops scans stuck in an active state and refunds the unspent hold", async () => {
    h = await createHarness({ env: { BILLING_MODE: "hosted" } });
    const ws = await seedWorkspace(h.db, 500);
    const { trackerId } = await seedTracker(h.db, ws);
    const { scanId } = await createScan(h.deps, ws, trackerId, { trigger: "manual" });
    h.queue.messages = []; // the consumer never ran
    expect(await reapStaleScans(h.deps)).toBe(0); // not old enough yet
    h.clock.now += 7 * 3600_000;
    expect(await reapStaleScans(h.deps)).toBe(1);
    expect((await getScan(h.db, scanId)).status).toBe("failed");
    expect(await getBalance(h.db, ws)).toBe(500);
  });
});

describe("target matching", () => {
  it("falls back to the business name when no place id is known", async () => {
    const ws = await seedWorkspace(h.db);
    const { trackerId } = await seedTracker(h.db, ws, { business: { placeId: null, cid: null, domain: null } });
    const { scanId } = await createScan(h.deps, ws, trackerId, { trigger: "manual" });
    await h.queue.drain(h.deps);
    expect((await getScan(h.db, scanId)).foundPoints).toBeGreaterThan(0);
  });

});

describe("hosted credits", () => {
  beforeEach(async () => {
    h = await createHarness({ env: { BILLING_MODE: "hosted" } });
  });

  it("holds the marked-up estimate, then settles on the real cost", async () => {
    const ws = await seedWorkspace(h.db, 1000);
    const { trackerId } = await seedTracker(h.db, ws, { gridSize: 7 });
    const { scanId, quote } = await createScan(h.deps, ws, trackerId, { trigger: "manual" });
    // 49 points * $0.0006 = $0.0294; * 1.28 = $0.037632 -> 38 credits
    expect(quote).toMatchObject({ providerCostUsd: 0.0294, credits: 38, chargedUsd: 0.037632 });
    expect(await getBalance(h.db, ws)).toBe(962);
    await h.queue.drain(h.deps);
    const scan = await getScan(h.db, scanId);
    expect(scan.billedCredits).toBe(38);
    expect(await getBalance(h.db, ws)).toBe(962);
    const ledger = await h.db.select().from(creditLedger).where(eq(creditLedger.workspaceId, ws));
    expect(ledger.map((l) => [l.reason, l.delta])).toEqual([["scan_hold", -38]]);
  });

  it("rejects a scan the balance cannot cover and leaves nothing behind", async () => {
    const ws = await seedWorkspace(h.db, 10);
    const { trackerId } = await seedTracker(h.db, ws, { gridSize: 7 });
    await expect(createScan(h.deps, ws, trackerId, { trigger: "manual" })).rejects.toMatchObject({ code: "INSUFFICIENT_CREDITS" });
    expect(await h.db.select().from(scans)).toHaveLength(0);
    expect(await h.db.select().from(scanPoints)).toHaveLength(0);
    expect(await getBalance(h.db, ws)).toBe(10);
  });

  it("two concurrent scans cannot both spend one balance", async () => {
    const ws = await seedWorkspace(h.db, 50);
    const a = await seedTracker(h.db, ws, { gridSize: 7 });
    const b = await seedTracker(h.db, ws, { gridSize: 7 });
    const results = await Promise.allSettled([
      createScan(h.deps, ws, a.trackerId, { trigger: "manual" }),
      createScan(h.deps, ws, b.trackerId, { trigger: "manual" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await getBalance(h.db, ws)).toBe(12);
  });

  it("grants credits and records them in the ledger", async () => {
    const ws = await seedWorkspace(h.db, 0);
    await grantCredits(h.db, ws, 250, "topup");
    const [row] = await h.db.select().from(workspaces).where(eq(workspaces.id, ws));
    expect(row.creditBalance).toBe(250);
  });
});

describe("BYOK mode", () => {
  it("records cost but never touches credits", async () => {
    const ws = await seedWorkspace(h.db, 0);
    const { trackerId } = await seedTracker(h.db, ws);
    const { scanId } = await createScan(h.deps, ws, trackerId, { trigger: "manual" });
    await h.queue.drain(h.deps);
    const scan = await getScan(h.db, scanId);
    expect(scan.costUsd).toBeGreaterThan(0);
    expect(scan.reservedCredits).toBe(0);
    expect(await h.db.select().from(creditLedger)).toHaveLength(0);
  });
});

describe("other listings note", () => {
  it("flags the tracked website ranking under a different place ID", async () => {
    const { getScanDetail } = await import("@/worker/scans/queries");
    const ws = await seedWorkspace(h.db);
    const { trackerId } = await seedTracker(h.db, ws);
    const { scanId } = await createScan(h.deps, ws, trackerId, { trigger: "manual" });
    await h.queue.drain(h.deps);
    const [p1, p2] = await h.db.select().from(scanPoints).where(eq(scanPoints.scanId, scanId)).limit(2);
    const row = (pointId: string, rank: number) => ({ id: `x-${pointId}`, scanId, pointId, rank, businessKey: "ChIJotherListing", name: "Maple & Ember (duplicate)", placeId: "ChIJotherListing", domain: "www.mapleember.example", isTarget: false });
    await h.db.insert(scanResults).values([row(p1.id, 4), row(p2.id, 2)]);
    const detail = await getScanDetail(h.db, scanId, { workspaceId: ws });
    expect(detail.otherListings).toEqual([{ name: "Maple & Ember (duplicate)", placeId: "ChIJotherListing", points: 2, bestRank: 2 }]);
  });
});
