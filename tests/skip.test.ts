// Skipped grid points: never posted, never charged, never counted. Runs the
// real scan pipeline on a coastal grid (Rodanthe on the Outer Banks: Atlantic to
// the east, Pamlico Sound to the west), so the water data is exercised as shipped.
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { at, must } from "@/shared/assert";
import { buildGrid, formatLocationCoordinate } from "@/shared/grid";
import { computeMetrics, NOT_FOUND_RANK } from "@/shared/metrics";
import { creditsForProviderUsd, estimateScanCostUsd } from "@/shared/pricing";
import { DEFAULT_RULES, planSkips, summarizePlan } from "@/shared/skip/plan";
import { loadWaterIndex } from "@/worker/skip/water";
import { getBalance } from "@/worker/billing/credits";
import { apiCalls, creditLedger, scanPoints, scans, trackers } from "@/worker/db/schema";
import { MockDataForSeo } from "@/worker/dataforseo/mock";
import { getScanDetail } from "@/worker/scans/queries";
import { updateTracker } from "@/worker/catalog";
import { createScan, quoteScan } from "@/worker/scans/service";
import { wrapProvider } from "./helpers/gbp";
import { createHarness, getScan, seedTracker, seedWorkspace, type Harness } from "./helpers/harness";

const RODANTHE = { lat: 35.6, lng: -75.47 };
const GRID = { centerLat: RODANTHE.lat, centerLng: RODANTHE.lng, size: 7, radiusKm: 15 };

type Posted = { post: string[]; live: string[] };

async function coastalHarness(env: Record<string, string> = {}) {
  const posted: Posted = { post: [], live: [] };
  const h = await createHarness({
    env,
    provider: (clock, target) => {
      const inner = new MockDataForSeo({ now: () => clock.now, target });
      return wrapProvider(inner, {
        postTasks: async (input) => (posted.post.push(...input.coordinates), inner.postTasks(input)),
        liveSearch: async (input) => (posted.live.push(input.coordinate), inner.liveSearch(input)),
      });
    },
  });
  return { h, posted };
}

/** What the planner decides for the coastal grid, computed independently of the scan. */
async function expectedPlan(rules = DEFAULT_RULES) {
  const water = await loadWaterIndex();
  return planSkips({ points: buildGrid(GRID), water, businessType: "storefront", serviceAreas: [], rules });
}

const coordsOf = (plan: Array<{ lat: number; lng: number }>, zoom = 15) => plan.map((p) => formatLocationCoordinate(p, zoom)).sort();

async function seedCoastal(h: Harness, credits = 0, tracker: Partial<typeof trackers.$inferInsert> = {}) {
  const ws = await seedWorkspace(h.db, credits);
  const seeded = await seedTracker(h.db, ws, {
    centerLat: RODANTHE.lat,
    centerLng: RODANTHE.lng,
    gridSize: 7,
    radiusKm: 15,
    ...tracker,
    business: { name: "Outer Banks Towel Rental", placeId: "ChIJdemoOuterBanks00001", lat: RODANTHE.lat, lng: RODANTHE.lng },
  });
  return { ws, ...seeded };
}

describe("skipped points are never sent to the provider", () => {
  it("standard queue: only scannable points are posted", async () => {
    const { h, posted } = await coastalHarness();
    const { ws, trackerId } = await seedCoastal(h);
    const plan = await expectedPlan();
    const summary = summarizePlan(plan);
    expect(summary.skippedPoints).toBeGreaterThan(10);

    const { scanId, quote } = await createScan(h.deps, ws, trackerId, { trigger: "manual" });
    await h.queue.drain(h.deps);

    expect(posted.post.sort()).toEqual(coordsOf(plan.filter((p) => !p.skip)));
    expect(posted.post.some((c) => coordsOf(plan.filter((p) => p.skip)).includes(c))).toBe(false);
    expect(quote).toMatchObject({ points: summary.scannablePoints, skippedPoints: summary.skippedPoints, gridPoints: 49 });

    const points = await h.db.select().from(scanPoints).where(eq(scanPoints.scanId, scanId));
    expect(points).toHaveLength(49);
    expect(points.filter((p) => p.status === "skipped")).toHaveLength(summary.skippedPoints);
    expect(points.filter((p) => p.status === "skipped").every((p) => p.skipReason === "water" && p.rank === null && p.taskId === null)).toBe(true);
    expect(points.filter((p) => p.status === "completed")).toHaveLength(summary.scannablePoints);

    const scan = await getScan(h.db, scanId);
    expect(scan).toMatchObject({ status: "completed", error: null, totalPoints: summary.scannablePoints, skippedPoints: summary.skippedPoints });
    const calls = await h.db.select().from(apiCalls).where(eq(apiCalls.scanId, scanId));
    expect(calls.reduce((n, c) => n + c.taskCount, 0)).toBe(summary.scannablePoints);
    expect(scan.costUsd).toBeCloseTo(estimateScanCostUsd(summary.scannablePoints, "standard"), 6);
  });

  it("live queue: only scannable points are searched", async () => {
    const { h, posted } = await coastalHarness();
    const { ws, trackerId } = await seedCoastal(h, 0, { queueMode: "live" });
    const plan = await expectedPlan();
    await createScan(h.deps, ws, trackerId, { trigger: "manual" });
    await h.queue.drain(h.deps);
    expect(posted.live.sort()).toEqual(coordsOf(plan.filter((p) => !p.skip)));
    expect(posted.post).toEqual([]);
  });
});

describe("credits and the quote cover only scanned points", () => {
  it("holds the scannable quote, settles on the real cost, and the quote matches the scan", async () => {
    const { h } = await coastalHarness({ BILLING_MODE: "hosted" });
    const { ws, trackerId } = await seedCoastal(h, 1000);
    const summary = summarizePlan(await expectedPlan());
    const raw = estimateScanCostUsd(summary.scannablePoints, "standard");
    const credits = creditsForProviderUsd(raw, h.config.markup);
    // The quote is smaller than the full grid's.
    expect(credits).toBeLessThan(quoteScan(h.config, 7, "standard").credits);

    const { scanId, quote } = await createScan(h.deps, ws, trackerId, { trigger: "manual" });
    expect(quote.credits).toBe(credits);
    expect((await getScan(h.db, scanId)).reservedCredits).toBe(credits);
    expect(await getBalance(h.db, ws)).toBe(1000 - credits);

    await h.queue.drain(h.deps);
    const scan = await getScan(h.db, scanId);
    // The mock's real cost equals the estimate, so nothing is refunded or charged on top.
    expect(scan.billedCredits).toBe(credits);
    expect(await getBalance(h.db, ws)).toBe(1000 - credits);
    // Exactly one hold for the scannable quote; no refund and no top-up charge afterwards.
    const ledger = await h.db.select().from(creditLedger);
    expect(ledger.map((r) => [r.reason, r.delta])).toEqual([["scan_hold", -credits]]);
  });

  it("the cost ceiling is checked against the scannable quote", async () => {
    const { h } = await coastalHarness();
    const { ws, trackerId } = await seedCoastal(h);
    const { chargedUsd } = (await createScan(h.deps, ws, trackerId, { trigger: "manual", maxCostUsd: 1 })).quote;
    expect(chargedUsd).toBeLessThan(quoteScan(h.config, 7, "standard").chargedUsd);
    await h.queue.drain(h.deps);
    // The full-grid price would have been refused at this ceiling; the scannable one is accepted.
    const exact = chargedUsd;
    await expect(createScan(h.deps, ws, trackerId, { trigger: "manual", maxCostUsd: exact - 0.0001 })).rejects.toMatchObject({ code: "COST_CEILING_EXCEEDED" });
    await expect(createScan(h.deps, ws, trackerId, { trigger: "manual", maxCostUsd: exact })).resolves.toBeDefined();
  });

  it("a grid where every point is skipped is refused: nothing created, nothing held", async () => {
    const { h } = await coastalHarness({ BILLING_MODE: "hosted" });
    // 6 km out in the Atlantic: all 9 points are deep water.
    const { ws, trackerId } = await seedCoastal(h, 500, { centerLat: 35.6, centerLng: -74.0, gridSize: 3, radiusKm: 2 });
    await expect(createScan(h.deps, ws, trackerId, { trigger: "manual" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(await h.db.select().from(scans)).toEqual([]);
    expect(await getBalance(h.db, ws)).toBe(500);
  });
});

describe("metrics leave skipped points out", () => {
  it("ATRP, ARP, SoLV and found use the scanned points only; a scanned point not in the top 20 still counts as 21", async () => {
    const { h } = await coastalHarness();
    const { ws, trackerId } = await seedCoastal(h);
    const { scanId } = await createScan(h.deps, ws, trackerId, { trigger: "manual" });
    await h.queue.drain(h.deps);

    const points = await h.db.select().from(scanPoints).where(eq(scanPoints.scanId, scanId));
    const scanned = points.filter((p) => p.status === "completed");
    // Make one scanned point "not found" so the 21 rule is exercised deterministically.
    const victim = must(scanned.find((p) => p.rank !== null), "a found point");
    await h.db.update(scanPoints).set({ rank: null }).where(eq(scanPoints.id, victim.id));
    const after = (await h.db.select().from(scanPoints).where(eq(scanPoints.scanId, scanId))).filter((p) => p.status === "completed");
    const expected = computeMetrics(after.map((p) => p.rank));
    expect(expected.totalPoints).toBe(scanned.length);
    expect(expected.atrp).toBeCloseTo(after.reduce((n, p) => n + (p.rank ?? NOT_FOUND_RANK), 0) / after.length, 1);

    const detail = await getScanDetail(h.db, scanId, { workspaceId: ws });
    expect(detail.metrics?.totalPoints).toBe(scanned.length);
    expect(detail.scan.skippedPoints).toBe(49 - scanned.length);
    expect(detail.scan.totalPoints).toBe(scanned.length);
    expect(detail.points.filter((p) => p.skipReason === "water")).toHaveLength(49 - scanned.length);
    // The stored metrics were computed over scanned points only (before the manual edit above).
    const scan = await getScan(h.db, scanId);
    const original = computeMetrics(scanned.map((p) => (p.id === victim.id ? victim.rank : p.rank)));
    expect(scan).toMatchObject({ atrp: original.atrp, solv: original.solv, foundPoints: original.foundPoints });
    // Counting the skipped points as 21 would give a visibly worse ATRP.
    const penalised = (scanned.reduce((n, p) => n + (p.rank ?? NOT_FOUND_RANK), 0) + (49 - scanned.length) * NOT_FOUND_RANK) / 49;
    expect(scan.atrp ?? 0).toBeLessThan(penalised);
  });

  it("alert totals are scanned totals", async () => {
    const { h } = await coastalHarness();
    const { ws, trackerId } = await seedCoastal(h);
    const { scanId } = await createScan(h.deps, ws, trackerId, { trigger: "manual" });
    await h.queue.drain(h.deps);
    const scan = await getScan(h.db, scanId);
    expect(scan.totalPoints).toBeLessThan(49);
    expect(scan.error).toBeNull(); // skipped points are not "failed points"
  });
});

describe("user overrides", () => {
  it("include turns a water point back on for future scans; the old scan keeps its recorded status", async () => {
    const { h, posted } = await coastalHarness();
    const { ws, trackerId } = await seedCoastal(h);
    const plan = await expectedPlan();
    const water = must(plan.find((p) => p.skip === "water"), "a water point");
    const land = must(plan.find((p) => p.skip === null), "a land point");

    const first = await createScan(h.deps, ws, trackerId, { trigger: "manual" });
    await h.queue.drain(h.deps);
    const before = await h.db.select().from(scanPoints).where(eq(scanPoints.scanId, first.scanId));

    await updateTracker(h.db, ws, trackerId, {
      skipOverrides: { include: [{ row: water.row, col: water.col }], exclude: [{ row: land.row, col: land.col }] },
    });
    posted.post.length = 0;
    const second = await createScan(h.deps, ws, trackerId, { trigger: "manual" });
    await h.queue.drain(h.deps);

    const cell = (rows: typeof before, p: { row: number; col: number }) => must(rows.find((r) => r.row === p.row && r.col === p.col), "cell");
    const after = await h.db.select().from(scanPoints).where(eq(scanPoints.scanId, second.scanId));
    expect(cell(after, water)).toMatchObject({ status: "completed", skipReason: null });
    expect(cell(after, land)).toMatchObject({ status: "skipped", skipReason: "user" });
    expect(posted.post).toContain(formatLocationCoordinate(water, 15));
    expect(posted.post).not.toContain(formatLocationCoordinate(land, 15));
    expect(second.quote.points).toBe(first.quote.points); // one more in, one out

    // History never changes.
    const again = await h.db.select().from(scanPoints).where(eq(scanPoints.scanId, first.scanId));
    expect(cell(again, water)).toMatchObject({ status: "skipped", skipReason: "water" });
    expect(cell(again, land)).toMatchObject({ status: "completed", skipReason: null });
  });

  it("changing the grid geometry clears the overrides; other edits keep them", async () => {
    const { h } = await coastalHarness();
    const { ws, trackerId } = await seedCoastal(h);
    const overrides = { include: [{ row: 0, col: 0 }], exclude: [] };
    await updateTracker(h.db, ws, trackerId, { skipOverrides: overrides });
    await updateTracker(h.db, ws, trackerId, { keyword: "towel rental" });
    expect((await h.db.select().from(trackers).where(eq(trackers.id, trackerId)))[0]?.skipOverrides).toEqual(overrides);
    await updateTracker(h.db, ws, trackerId, { gridSize: 5 });
    expect((await h.db.select().from(trackers).where(eq(trackers.id, trackerId)))[0]?.skipOverrides).toEqual({ include: [], exclude: [] });
  });

  it("turning auto-skip off scans every point", async () => {
    const { h, posted } = await coastalHarness();
    const { ws, trackerId } = await seedCoastal(h, 0, { autoSkipWater: false });
    const { quote } = await createScan(h.deps, ws, trackerId, { trigger: "manual" });
    await h.queue.drain(h.deps);
    expect(quote).toMatchObject({ points: 49, skippedPoints: 0 });
    expect(posted.post).toHaveLength(49);
    expect(at(await h.db.select().from(scans), 0).totalPoints).toBe(49);
  });
});
