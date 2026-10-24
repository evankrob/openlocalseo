import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createAlertsForSnapshot, createGbpAlertsSafely, saveAlertSettings } from "@/worker/alerts";
import { getBalance } from "@/worker/billing/credits";
import { MockDataForSeo } from "@/worker/dataforseo/mock";
import type { DataForSeoProvider, ReviewsOutcome } from "@/worker/dataforseo/types";
import type { Db } from "@/worker/db";
import { alerts, apiCalls, businesses, creditLedger, gbpSnapshots, reviews } from "@/worker/db/schema";
import { reapStaleGbpSnapshots } from "@/worker/gbp/process";
import { createGbpSnapshot, runDueGbpSnapshots, setGbpTracking } from "@/worker/gbp/service";
import { handleScanJob } from "@/worker/scans/process";
import { createHarness, seedWorkspace, type Harness } from "./helpers/harness";
import { DAY_MS, seedBusiness, snapshotsOf, wrapProvider } from "./helpers/gbp";

type Calls = { profile: number; post: number; collect: number };

/** Harness whose provider counts calls and can have methods replaced. */
async function setup(
  options: { hosted?: boolean; credits?: number; override?: (inner: MockDataForSeo, clock: { now: number }) => Partial<DataForSeoProvider> } = {},
) {
  const calls: Calls = { profile: 0, post: 0, collect: 0 };
  const h = await createHarness({
    env: options.hosted ? { BILLING_MODE: "hosted" } : {},
    provider: (clock) => {
      const inner = new MockDataForSeo({ now: () => clock.now });
      const extra = options.override?.(inner, clock) ?? {};
      return wrapProvider(inner, {
        getBusinessProfile: async (i) => (calls.profile++, (extra.getBusinessProfile ?? inner.getBusinessProfile.bind(inner))(i)),
        postReviewsTask: async (i) => (calls.post++, (extra.postReviewsTask ?? inner.postReviewsTask.bind(inner))(i)),
        getReviewsTask: async (id) => (calls.collect++, (extra.getReviewsTask ?? inner.getReviewsTask.bind(inner))(id)),
      });
    },
  });
  const ws = await seedWorkspace(h.db, options.credits ?? 0);
  const businessId = await seedBusiness(h.db, ws, { category: "Coffee shop" });
  return { h, ws, businessId, calls };
}

const only = async <T,>(rows: Promise<T[]>) => {
  const all = await rows;
  expect(all).toHaveLength(1);
  return all[0];
};

/** Delivers the next queued message, without advancing the clock. */
async function step(h: Harness) {
  const message = h.queue.messages.shift()!;
  await handleScanJob(h.deps, message.job);
  return message;
}

describe("snapshot pipeline", () => {
  it("runs profile -> reviews post -> collect -> completed, records both billed calls and derives the stats", async () => {
    const { h, ws, businessId } = await setup();
    const { snapshotId, quote } = await createGbpSnapshot(h.deps, ws, businessId, { trigger: "manual" });
    expect(quote).toEqual({ reviewsDepth: 20, providerCostUsd: 0.0069, chargedUsd: 0.0069, credits: 0 });
    expect(h.queue.messages.map((m) => m.job)).toEqual([{ type: "gbp_snapshot", snapshotId }]);
    await h.queue.drain(h.deps);

    const snap = await only(snapshotsOf(h.db, businessId));
    expect(snap).toMatchObject({
      id: snapshotId,
      workspaceId: ws,
      status: "completed",
      trigger: "manual",
      isClaimed: true,
      primaryCategory: "Coffee shop",
      error: null,
      newReviews: null, // the first snapshot is a baseline
    });
    expect(snap.reviewCount).toBeGreaterThan(412);
    expect(snap.rating).toBeGreaterThan(4.5);
    expect(snap.totalPhotos).toBeGreaterThan(0);
    expect(JSON.parse(snap.ratingDistribution!)).toHaveProperty("5");
    expect(snap.costUsd).toBeCloseTo(0.0069, 6);
    expect(snap.completedAt).not.toBeNull();

    const calls = await h.db.select().from(apiCalls);
    expect(calls.map((c) => c.path).sort()).toEqual([
      "v3/business_data/google/my_business_info/live",
      "v3/business_data/google/reviews/task_post",
    ]);
    expect(calls.every((c) => c.mode === "mock" && c.workspaceId === ws && c.scanId === null)).toBe(true);
    expect(calls.reduce((sum, c) => sum + c.costUsd, 0)).toBeCloseTo(0.0069, 6);

    const stored = await h.db.select().from(reviews).where(eq(reviews.businessId, businessId));
    expect(stored).toHaveLength(20);
    expect(stored.every((r) => r.workspaceId === ws && r.firstSeenSnapshotId === snapshotId)).toBe(true);
    expect(snap.unansweredLast20).toBe(stored.filter((r) => !r.ownerAnswered).length);
    expect(snap.velocity30d).toBeGreaterThan(0);
  });

  it("polls with backoff while DataForSEO is still working, then completes", async () => {
    const { h, ws, businessId } = await setup();
    const { snapshotId } = await createGbpSnapshot(h.deps, ws, businessId, { trigger: "manual" });
    await step(h); // gbp_snapshot: profile call + task_post
    expect((await only(snapshotsOf(h.db, businessId))).reviewsTaskId).toMatch(/^mockrev\./);

    const first = h.queue.messages[0];
    expect(first.job).toEqual({ type: "gbp_reviews_collect", snapshotId, attempt: 0 });
    expect(first.at - h.clock.now).toBe(5000);

    await step(h); // too early: the mock's queue delay has not passed
    expect((await only(snapshotsOf(h.db, businessId))).status).toBe("running");
    const second = h.queue.messages[0];
    expect(second.job).toMatchObject({ type: "gbp_reviews_collect", attempt: 1 });
    expect(second.at - h.clock.now).toBe(8000); // 5s * 1.5, rounded up

    await h.queue.drain(h.deps);
    expect((await only(snapshotsOf(h.db, businessId))).status).toBe("completed");
  });

  it("treats a transient collect error as still pending", async () => {
    let failures = 1;
    const { h, ws, businessId } = await setup({
      override: (inner) => ({
        getReviewsTask: async (id) => {
          if (failures-- > 0) throw new Error("DataForSEO HTTP 429");
          return inner.getReviewsTask(id);
        },
      }),
    });
    await createGbpSnapshot(h.deps, ws, businessId, { trigger: "manual" });
    await h.queue.drain(h.deps);
    expect((await only(snapshotsOf(h.db, businessId))).status).toBe("completed");
  });

  it("re-fetching never duplicates reviews and refreshes the owner reply and text", async () => {
    const { h, ws, businessId } = await setup();
    await createGbpSnapshot(h.deps, ws, businessId, { trigger: "manual" });
    await h.queue.drain(h.deps);
    const before = await h.db.select().from(reviews).where(eq(reviews.businessId, businessId));
    const answered = before.find((r) => r.ownerAnswered)!;
    await h.db.update(reviews).set({ ownerAnswered: false, ownerAnsweredAt: null, text: "stale" }).where(eq(reviews.id, answered.id));

    h.clock.now += DAY_MS;
    const second = await createGbpSnapshot(h.deps, ws, businessId, { trigger: "manual" });
    await h.queue.drain(h.deps);

    const after = await h.db.select().from(reviews).where(eq(reviews.businessId, businessId));
    expect(new Set(after.map((r) => r.reviewId)).size).toBe(after.length);
    const unchanged = after.filter((r) => before.some((b) => b.reviewId === r.reviewId));
    expect(unchanged.length).toBeGreaterThanOrEqual(19); // at most the odd review fell out of the newest 20
    const refreshed = after.find((r) => r.id === answered.id)!;
    expect(refreshed.ownerAnswered).toBe(true);
    expect(refreshed.text).toBe(answered.text);
    // first_seen stays on the snapshot that saw the review first.
    const firstSeen = new Set(before.map((r) => r.firstSeenSnapshotId));
    expect(after.filter((r) => firstSeen.has(r.firstSeenSnapshotId)).length).toBeGreaterThanOrEqual(19);
    const [secondRow] = await h.db.select().from(gbpSnapshots).where(eq(gbpSnapshots.id, second.snapshotId));
    expect(secondRow.newReviews).toBe(after.filter((r) => r.firstSeenSnapshotId === second.snapshotId).length);
  });

  it("counts new reviews and their average rating a month later", async () => {
    const { h, ws, businessId } = await setup();
    await createGbpSnapshot(h.deps, ws, businessId, { trigger: "manual" });
    await h.queue.drain(h.deps);
    h.clock.now += 35 * DAY_MS;
    const { snapshotId } = await createGbpSnapshot(h.deps, ws, businessId, { trigger: "schedule" });
    await h.queue.drain(h.deps);

    const [snap] = await h.db.select().from(gbpSnapshots).where(eq(gbpSnapshots.id, snapshotId));
    const fresh = await h.db.select().from(reviews).where(eq(reviews.firstSeenSnapshotId, snapshotId));
    expect(snap.newReviews).toBeGreaterThan(0);
    expect(snap.newReviews).toBe(fresh.length);
    expect(snap.newReviewsAvgRating).toBeCloseTo(fresh.reduce((a, r) => a + r.rating, 0) / fresh.length, 1);
    expect(snap.trigger).toBe("schedule");
  });

  it("allows one active snapshot per business, a cost ceiling and a place ID", async () => {
    const { h, ws, businessId } = await setup();
    await expect(createGbpSnapshot(h.deps, ws, businessId, { trigger: "manual", maxCostUsd: 0.001 })).rejects.toMatchObject({ code: "COST_CEILING_EXCEEDED" });
    expect(await snapshotsOf(h.db, businessId)).toHaveLength(0);
    await createGbpSnapshot(h.deps, ws, businessId, { trigger: "manual", maxCostUsd: 0.01 });
    await expect(createGbpSnapshot(h.deps, ws, businessId, { trigger: "manual" })).rejects.toMatchObject({ code: "SCAN_IN_PROGRESS" });
    expect(await snapshotsOf(h.db, businessId)).toHaveLength(1);

    const noPlace = await seedBusiness(h.db, ws, { placeId: null });
    await expect(createGbpSnapshot(h.deps, ws, noPlace, { trigger: "manual" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("keeps tenants apart: another workspace cannot snapshot this business", async () => {
    const { h, businessId } = await setup();
    const other = await seedWorkspace(h.db, 0, "ws-2");
    await expect(createGbpSnapshot(h.deps, other, businessId, { trigger: "manual" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await snapshotsOf(h.db, businessId)).toHaveLength(0);
  });

  it("is idempotent when the snapshot message is delivered twice: no second profile call or billed post", async () => {
    const { h, ws, businessId, calls } = await setup();
    const { snapshotId } = await createGbpSnapshot(h.deps, ws, businessId, { trigger: "manual" });
    await handleScanJob(h.deps, { type: "gbp_snapshot", snapshotId });
    await handleScanJob(h.deps, { type: "gbp_snapshot", snapshotId });
    await h.queue.drain(h.deps);
    expect(calls).toMatchObject({ profile: 1, post: 1 });
    expect(await h.db.select().from(apiCalls)).toHaveLength(2);
    expect((await only(snapshotsOf(h.db, businessId))).status).toBe("completed");
  });

  it("a duplicate collect after completion changes nothing", async () => {
    const { h, ws, businessId } = await setup({ hosted: true, credits: 500 });
    const { snapshotId } = await createGbpSnapshot(h.deps, ws, businessId, { trigger: "manual" });
    await h.queue.drain(h.deps);
    const balance = await getBalance(h.db, ws);
    const ledger = await h.db.select().from(creditLedger);
    await handleScanJob(h.deps, { type: "gbp_reviews_collect", snapshotId, attempt: 0 });
    expect(await getBalance(h.db, ws)).toBe(balance);
    expect(await h.db.select().from(creditLedger)).toHaveLength(ledger.length);
    expect(await h.db.select().from(reviews)).toHaveLength(20);
  });
});

describe("hosted credits", () => {
  // $0.0069 * 1.28 = $0.008832 -> 9 credits held; the profile call alone is $0.0054 -> 7 credits.
  const ledgerOf = async (db: Db) => (await db.select().from(creditLedger)).map((l) => [l.reason, l.delta, l.scanId] as const);

  it("holds the marked-up estimate, then settles on the real cost", async () => {
    const { h, ws, businessId } = await setup({ hosted: true, credits: 500 });
    const { snapshotId, quote } = await createGbpSnapshot(h.deps, ws, businessId, { trigger: "manual" });
    expect(quote).toMatchObject({ credits: 9, chargedUsd: 0.008832 });
    expect(await getBalance(h.db, ws)).toBe(491);
    await h.queue.drain(h.deps);
    const [snap] = await h.db.select().from(gbpSnapshots).where(eq(gbpSnapshots.id, snapshotId));
    expect(snap).toMatchObject({ status: "completed", reservedCredits: 9, billedCredits: 9 });
    expect(await getBalance(h.db, ws)).toBe(491);
    // Ledger rows are not linked to a scan (scan_id is a foreign key to scans).
    expect(await ledgerOf(h.db)).toEqual([["gbp_hold", -9, null]]);
  });

  it("rejects a snapshot the balance cannot cover and leaves nothing behind", async () => {
    const { h, ws, businessId } = await setup({ hosted: true, credits: 3 });
    await expect(createGbpSnapshot(h.deps, ws, businessId, { trigger: "manual" })).rejects.toMatchObject({ code: "INSUFFICIENT_CREDITS" });
    expect(await getBalance(h.db, ws)).toBe(3);
    expect(await snapshotsOf(h.db, businessId)).toHaveLength(0);
    expect(h.queue.messages).toHaveLength(0);
  });

  it("when the reviews post fails: fails the snapshot, never replays the post, refunds the unspent part", async () => {
    const { h, ws, businessId, calls } = await setup({
      hosted: true,
      credits: 500,
      override: () => ({ postReviewsTask: async () => { throw new Error("DataForSEO HTTP 500"); } }),
    });
    await createGbpSnapshot(h.deps, ws, businessId, { trigger: "manual" });
    await h.queue.drain(h.deps);
    const snap = await only(snapshotsOf(h.db, businessId));
    expect(snap.status).toBe("failed");
    expect(snap.error).toContain("Submitting the reviews task failed");
    expect(snap.error).toContain("500");
    expect(calls).toMatchObject({ profile: 1, post: 1, collect: 0 });
    // The profile call was billed ($0.0054 -> 7 credits); the rest of the hold comes back.
    expect(snap).toMatchObject({ billedCredits: 7, reservedCredits: 9 });
    expect(snap.costUsd).toBeCloseTo(0.0054, 6);
    expect(await getBalance(h.db, ws)).toBe(493);
    expect(await ledgerOf(h.db)).toEqual(expect.arrayContaining([["gbp_hold", -9, null], ["gbp_refund", 2, null]]));
    expect(await h.db.select().from(apiCalls)).toHaveLength(1);
    // The profile numbers fetched before the failure are kept on the failed row, but no reviews are stored.
    expect(snap.rating).not.toBeNull();
    expect(await h.db.select().from(reviews)).toHaveLength(0);
  });

  it("a post that was billed but then rejected still counts its cost", async () => {
    const { h, ws, businessId } = await setup({
      hosted: true,
      credits: 500,
      override: () => ({
        postReviewsTask: async () => {
          throw Object.assign(new Error("Invalid Field"), { billing: { path: ["v3", "business_data", "google", "reviews", "task_post"], costUsd: 0.0015 } });
        },
      }),
    });
    await createGbpSnapshot(h.deps, ws, businessId, { trigger: "manual" });
    await h.queue.drain(h.deps);
    const snap = await only(snapshotsOf(h.db, businessId));
    expect(snap.costUsd).toBeCloseTo(0.0069, 6);
    expect(snap.billedCredits).toBe(9);
    expect(await getBalance(h.db, ws)).toBe(491);
  });

  it("when the profile call fails nothing was spent: the whole hold is refunded and no post is made", async () => {
    const { h, ws, businessId, calls } = await setup({
      hosted: true,
      credits: 500,
      override: () => ({ getBusinessProfile: async () => { throw new Error("DataForSEO HTTP 401"); } }),
    });
    await createGbpSnapshot(h.deps, ws, businessId, { trigger: "manual" });
    await h.queue.drain(h.deps);
    const snap = await only(snapshotsOf(h.db, businessId));
    expect(snap.status).toBe("failed");
    expect(snap.error).toContain("Profile lookup failed");
    expect(calls).toMatchObject({ profile: 1, post: 0 });
    expect(await getBalance(h.db, ws)).toBe(500);
    expect(await ledgerOf(h.db)).toEqual(expect.arrayContaining([["gbp_refund", 9, null]]));
  });

  it("an unknown place fails the snapshot and still records the billed empty answer", async () => {
    const { h, ws } = await setup({ hosted: true, credits: 500 });
    const unknown = await seedBusiness(h.db, ws, { placeId: "ChIJunknown0001" });
    await createGbpSnapshot(h.deps, ws, unknown, { trigger: "manual" });
    await h.queue.drain(h.deps);
    const snap = await only(snapshotsOf(h.db, unknown));
    expect(snap.status).toBe("failed");
    expect(snap.error).toContain("no business profile");
    expect(snap.billedCredits).toBe(7);
    expect(await getBalance(h.db, ws)).toBe(493);
  });

  it("DataForSEO failing the reviews task fails the snapshot and settles on the cost", async () => {
    const { h, ws, businessId } = await setup({
      hosted: true,
      credits: 500,
      override: () => ({ getReviewsTask: async (): Promise<ReviewsOutcome> => ({ status: "failed", message: "Google blocked the request" }) }),
    });
    await createGbpSnapshot(h.deps, ws, businessId, { trigger: "manual" });
    await h.queue.drain(h.deps);
    const snap = await only(snapshotsOf(h.db, businessId));
    expect(snap).toMatchObject({ status: "failed", error: "Google blocked the request", billedCredits: 9 });
    expect(await getBalance(h.db, ws)).toBe(491);
  });

  it("gives up on a reviews task that never finishes, with backoff capped at 5 minutes", async () => {
    const { h, ws, businessId, calls } = await setup({
      override: () => ({ getReviewsTask: async (): Promise<ReviewsOutcome> => ({ status: "pending" }) }),
    });
    await createGbpSnapshot(h.deps, ws, businessId, { trigger: "manual" });
    await h.queue.drain(h.deps);
    const snap = await only(snapshotsOf(h.db, businessId));
    expect(snap).toMatchObject({ status: "failed", error: "Timed out waiting for DataForSEO" });
    expect(calls.collect).toBeGreaterThan(5);
    expect(calls.collect).toBeLessThan(40);
    expect(calls.post).toBe(1);
  });

  it("the reaper fails a snapshot stuck in the queue and returns the hold", async () => {
    const { h, ws, businessId } = await setup({ hosted: true, credits: 500 });
    await createGbpSnapshot(h.deps, ws, businessId, { trigger: "manual" });
    expect(await getBalance(h.db, ws)).toBe(491);
    expect(await reapStaleGbpSnapshots(h.deps)).toBe(0);
    h.clock.now += 7 * 3600 * 1000;
    expect(await reapStaleGbpSnapshots(h.deps)).toBe(1);
    expect((await only(snapshotsOf(h.db, businessId))).status).toBe("failed");
    expect(await getBalance(h.db, ws)).toBe(500);
    expect(await reapStaleGbpSnapshots(h.deps)).toBe(0);
  });
});

describe("monthly schedule", () => {
  const due = "2026-10-01T00:00:00.000Z";

  it("starts only opted-in, due, active businesses and advances them to the 1st of next month first", async () => {
    const { h, ws } = await setup();
    const a = await seedBusiness(h.db, ws, { gbpTracking: true, gbpNextRunAt: due });
    const later = await seedBusiness(h.db, ws, { gbpTracking: true, gbpNextRunAt: "2026-11-01T00:00:00.000Z" });
    const off = await seedBusiness(h.db, ws, { gbpTracking: false, gbpNextRunAt: due });
    const archived = await seedBusiness(h.db, ws, { gbpTracking: true, gbpNextRunAt: due, archivedAt: "2026-10-02T00:00:00.000Z" });

    expect(await runDueGbpSnapshots(h.deps)).toEqual({ started: 1, failed: 0 });
    const [aSnap] = await snapshotsOf(h.db, a);
    expect(aSnap).toMatchObject({ trigger: "schedule", status: "queued" });
    for (const id of [later, off, archived]) expect(await snapshotsOf(h.db, id)).toHaveLength(0);
    const next = async (id: string) => (await h.db.select().from(businesses).where(eq(businesses.id, id)))[0].gbpNextRunAt;
    expect(await next(a)).toBe("2026-11-01T00:00:00.000Z");
    expect(await next(off)).toBe(due);

    // The same day again does nothing, and the queued snapshot completes.
    expect(await runDueGbpSnapshots(h.deps)).toEqual({ started: 0, failed: 0 });
    await h.queue.drain(h.deps);
    expect((await snapshotsOf(h.db, a))[0].status).toBe("completed");
  });

  it("leaves a visible failed snapshot when a scheduled run cannot start, and still moves on", async () => {
    const { h, ws } = await setup({ hosted: true, credits: 0 });
    const id = await seedBusiness(h.db, ws, { gbpTracking: true, gbpNextRunAt: due });
    expect(await runDueGbpSnapshots(h.deps)).toEqual({ started: 0, failed: 1 });
    const snap = await only(snapshotsOf(h.db, id));
    expect(snap).toMatchObject({ status: "failed", trigger: "schedule" });
    expect(snap.error).toContain("INSUFFICIENT_CREDITS");
    expect((await h.db.select().from(businesses).where(eq(businesses.id, id)))[0].gbpNextRunAt).toBe("2026-11-01T00:00:00.000Z");
  });

  it("the toggle schedules the 1st of next month on, clears it off, and needs a place ID", async () => {
    const { h, ws, businessId } = await setup();
    const now = new Date("2026-10-14T12:00:00Z");
    expect(await setGbpTracking(h.db, ws, businessId, true, now)).toMatchObject({ gbpTracking: true, gbpNextRunAt: "2026-11-01T00:00:00.000Z" });
    // Enabling again keeps the existing schedule.
    expect((await setGbpTracking(h.db, ws, businessId, true, new Date("2026-10-20T00:00:00Z"))).gbpNextRunAt).toBe("2026-11-01T00:00:00.000Z");
    expect(await setGbpTracking(h.db, ws, businessId, false, now)).toMatchObject({ gbpTracking: false, gbpNextRunAt: null });
    const noPlace = await seedBusiness(h.db, ws, { placeId: null });
    await expect(setGbpTracking(h.db, ws, noPlace, true, now)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const other = await seedWorkspace(h.db, 0, "ws-2");
    await expect(setGbpTracking(h.db, other, businessId, true, now)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("GBP alerts", () => {
  const BAD = "mock-new-bad-review";

  /** After the first snapshot: raise its stored rating, so the next one is a drop. */
  async function twoSnapshots(opts: { badReview?: number; before?: number; sent?: Array<{ url: string; text: string }> } = {}) {
    const ctx = await setup({
      override: (inner, clock) => ({
        getReviewsTask: async (id) => {
          const outcome = await inner.getReviewsTask(id);
          // Only the later fetches carry the review, so the first snapshot is a clean baseline.
          if (outcome.status !== "completed" || opts.badReview === undefined || clock.now < Date.UTC(2026, 10, 1)) return outcome;
          const injected = { reviewId: BAD, rating: opts.badReview, text: "Awful", publishedAt: new Date(clock.now).toISOString(), profileName: "Someone", ownerAnswer: null, ownerAnsweredAt: null };
          return { ...outcome, reviews: [injected, ...outcome.reviews] };
        },
      }),
    });
    const { h, ws, businessId } = ctx;
    const { sent } = opts;
    if (sent) {
      h.deps.notify = async (url, payload) => void sent.push({ url, text: payload.text });
      await saveAlertSettings(h.db, ws, { webhookUrl: "https://hooks.example.com/secret" });
    }
    const first = await createGbpSnapshot(h.deps, ws, businessId, { trigger: "manual" });
    await h.queue.drain(h.deps);
    await h.db.update(gbpSnapshots).set({ rating: opts.before ?? 5.6 }).where(eq(gbpSnapshots.id, first.snapshotId));
    h.clock.now += 35 * DAY_MS;
    const second = await createGbpSnapshot(h.deps, ws, businessId, { trigger: "manual" });
    await h.queue.drain(h.deps);
    return { ...ctx, first: first.snapshotId, second: second.snapshotId };
  }
  const allAlerts = (h: Harness) => h.db.select().from(alerts);

  it("raises nothing for the first snapshot, even with a 1-star review in it", async () => {
    const { h, ws, businessId } = await setup({
      override: (inner, clock) => ({
        getReviewsTask: async (id) => {
          const o = await inner.getReviewsTask(id);
          return o.status === "completed"
            ? { ...o, reviews: [{ reviewId: BAD, rating: 1, text: null, publishedAt: new Date(clock.now).toISOString(), profileName: null, ownerAnswer: null, ownerAnsweredAt: null }, ...o.reviews] }
            : o;
        },
      }),
    });
    await createGbpSnapshot(h.deps, ws, businessId, { trigger: "manual" });
    await h.queue.drain(h.deps);
    expect(await allAlerts(h)).toEqual([]);
  });

  it("raises rating_drop (critical for a big drop) with before/after, keyed to the snapshot", async () => {
    const { h, ws, businessId, second, first } = await twoSnapshots();
    const rows = await allAlerts(h);
    const drop = rows.find((r) => r.kind === "rating_drop")!;
    const [snap] = await h.db.select().from(gbpSnapshots).where(eq(gbpSnapshots.id, second));
    expect(drop).toMatchObject({ workspaceId: ws, businessId, snapshotId: second, trackerId: null, scanId: null, severity: "critical", readAt: null });
    const metrics = JSON.parse(drop.metrics);
    expect(metrics.rating).toEqual({ before: 5.6, after: snap.rating });
    expect(metrics.reviewCount.after).toBe(snap.reviewCount);
    expect(rows.every((r) => r.snapshotId === second && r.snapshotId !== first)).toBe(true);
  });

  it("raises one negative_review alert for a new 1-star review and not for a 3-star one", async () => {
    const low = await twoSnapshots({ badReview: 1, before: 4.7 });
    const [neg] = (await allAlerts(low.h)).filter((r) => r.kind === "negative_review");
    expect(neg).toMatchObject({ snapshotId: low.second, severity: "warning" });
    const metrics = JSON.parse(neg.metrics);
    expect(metrics.negativeReviews.count).toBeGreaterThanOrEqual(1);
    expect(metrics.negativeReviews.reviews[0]).toMatchObject({ reviewId: BAD, rating: 1, text: "Awful" });

    const three = await twoSnapshots({ badReview: 3, before: 4.7 });
    expect((await allAlerts(three.h)).some((r) => JSON.parse(r.metrics).negativeReviews?.reviews.some((x: { reviewId: string }) => x.reviewId === BAD))).toBe(false);
  });

  it("does not alert again for a low review that an earlier snapshot already saw", async () => {
    const { h, ws, businessId, second } = await twoSnapshots({ badReview: 1, before: 4.7 });
    h.clock.now += DAY_MS;
    const third = await createGbpSnapshot(h.deps, ws, businessId, { trigger: "manual" });
    await h.queue.drain(h.deps);
    const forThird = (await allAlerts(h)).filter((r) => r.snapshotId === third.snapshotId);
    expect(forThird.some((r) => JSON.parse(r.metrics).negativeReviews?.reviews.some((x: { reviewId: string }) => x.reviewId === BAD))).toBe(false);
    expect((await allAlerts(h)).filter((r) => r.snapshotId === second && r.kind === "negative_review")).toHaveLength(1);
  });

  it("sends the webhook once per new alert; evaluating the snapshot again adds and sends nothing", async () => {
    const sent: Array<{ url: string; text: string }> = [];
    const { h, second } = await twoSnapshots({ badReview: 1, sent });
    expect(await allAlerts(h)).toHaveLength(2);
    expect(sent).toHaveLength(2);
    expect(sent.every((s) => s.url === "https://hooks.example.com/secret")).toBe(true);
    expect(sent.map((s) => s.text).join("\n")).toContain("Maple & Ember Coffee Roasters");
    expect(sent.some((s) => /rating dropped 5\.6/i.test(s.text))).toBe(true);
    expect(sent.some((s) => /stars or fewer/.test(s.text))).toBe(true);

    await createAlertsForSnapshot(h.deps, second);
    await createAlertsForSnapshot(h.deps, second);
    expect(await allAlerts(h)).toHaveLength(2);
    expect(sent).toHaveLength(2);
  });

  it("respects alert_settings.enabled", async () => {
    const { h, ws, businessId } = await setup();
    await saveAlertSettings(h.db, ws, { enabled: false });
    const a = await createGbpSnapshot(h.deps, ws, businessId, { trigger: "manual" });
    await h.queue.drain(h.deps);
    await h.db.update(gbpSnapshots).set({ rating: 5.6 }).where(eq(gbpSnapshots.id, a.snapshotId));
    h.clock.now += 35 * DAY_MS;
    await createGbpSnapshot(h.deps, ws, businessId, { trigger: "manual" });
    await h.queue.drain(h.deps);
    expect(await allAlerts(h)).toEqual([]);
  });

  it("never fails the snapshot: an error while evaluating is logged and swallowed", async () => {
    const broken = { select: () => { throw new Error("boom"); } } as unknown as Db;
    await expect(createGbpAlertsSafely({ db: broken }, "snap-1")).resolves.toBeUndefined();
  });

  it("the unique index refuses a second alert of the same kind for a snapshot", async () => {
    const { h, ws, businessId, second } = await twoSnapshots();
    const [row] = await allAlerts(h);
    const error = await h.db
      .insert(alerts)
      .values({ ...row, id: "dup", workspaceId: ws, businessId, snapshotId: second })
      .then(() => null, (e: unknown) => e as Error);
    expect(String(error?.cause)).toMatch(/UNIQUE/i);
  });
});
