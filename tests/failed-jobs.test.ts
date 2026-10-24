import { beforeEach, describe, expect, it } from "vitest";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { AppError } from "@/shared/errors";
import { creditsForProviderUsd } from "@/shared/pricing";
import { saveAlertSettings } from "@/worker/alerts";
import { getBalance } from "@/worker/billing/credits";
import { MockDataForSeo } from "@/worker/dataforseo/mock";
import { alerts, creditLedger, gbpSnapshots, scanPoints, scans } from "@/worker/db/schema";
import { createGbpSnapshot } from "@/worker/gbp/service";
import { handleQueueBatch, type QueueMessage } from "@/worker/queue";
import { DLQ_QUEUE, FAILED_AFTER_RETRIES, classifyJobError, retryDelaySeconds } from "@/worker/scans/failed";
import type { ScanJob } from "@/worker/scans/jobs";
import { handleScanJob, type ProcessDeps } from "@/worker/scans/process";
import { createScan } from "@/worker/scans/service";
import { createHarness, getScan, seedTracker, seedWorkspace, type Harness } from "./helpers/harness";
import { seedBusiness, wrapProvider } from "./helpers/gbp";
import { business, client } from "./helpers/http";

class FakeMessage implements QueueMessage {
  acked = 0;
  retries: Array<number | undefined> = [];
  constructor(
    readonly body: ScanJob,
    readonly attempts = 1,
  ) {}
  ack() {
    this.acked++;
  }
  retry(options?: { delaySeconds?: number }) {
    this.retries.push(options?.delaySeconds);
  }
}

const SCANS_QUEUE = "openlocalseo-scans";
const deliver = (deps: ProcessDeps, queue: string, ...messages: FakeMessage[]) => handleQueueBatch(deps, { queue, messages });

type Counts = { posts: number; reviewPosts: number };

async function hostedHarness(credits = 1000) {
  const counts: Counts = { posts: 0, reviewPosts: 0 };
  const h = await createHarness({
    env: { BILLING_MODE: "hosted", AUTH_MODE: "local_noauth" },
    provider: (clock) => {
      const inner = new MockDataForSeo({ now: () => clock.now });
      return wrapProvider(inner, {
        postTasks: async (i) => (counts.posts++, inner.postTasks(i)),
        postReviewsTask: async (i) => (counts.reviewPosts++, inner.postReviewsTask(i)),
      });
    },
  });
  const ws = await seedWorkspace(h.db, credits);
  return { h, ws, counts };
}

const refunds = async (h: Harness, reason: "scan_refund" | "gbp_refund") =>
  (await h.db.select().from(creditLedger)).filter((r) => r.reason === reason);
const jobAlerts = (h: Harness) => h.db.select().from(alerts).then((rows) => rows.filter((a) => a.kind === "job_failed"));

describe("dead-letter queue consumer: scans", () => {
  let h: Harness;
  let ws: string;
  let trackerId: string;
  let counts: Counts;
  beforeEach(async () => {
    ({ h, ws, counts } = await hostedHarness());
    ({ trackerId } = await seedTracker(h.db, ws));
  });

  it("fails the scan and its pending points, refunds the whole hold once, raises one alert, and is idempotent on redelivery", async () => {
    const start = await getBalance(h.db, ws);
    const { scanId } = await createScan(h.deps, ws, trackerId, { trigger: "manual" });
    const held = start - (await getBalance(h.db, ws));
    expect(held).toBeGreaterThan(0);
    h.queue.messages.length = 0; // the original message exhausted its retries

    const first = new FakeMessage({ type: "post", scanId }, 6);
    await deliver(h.deps, DLQ_QUEUE, first);
    expect(first.acked).toBe(1);
    expect(first.retries).toEqual([]);

    const scan = await getScan(h.db, scanId);
    expect(scan).toMatchObject({ status: "failed", error: FAILED_AFTER_RETRIES });
    expect(scan.completedAt).not.toBeNull();
    const points = await h.db.select().from(scanPoints).where(eq(scanPoints.scanId, scanId));
    expect(points).toHaveLength(25);
    expect(points.every((p) => p.status === "failed" && p.error === FAILED_AFTER_RETRIES)).toBe(true);
    expect(await getBalance(h.db, ws)).toBe(start);
    expect((await refunds(h, "scan_refund")).map((r) => r.delta)).toEqual([held]);
    const [alert] = await jobAlerts(h);
    expect(alert).toMatchObject({ workspaceId: ws, trackerId, scanId, severity: "warning", businessId: null, snapshotId: null });
    expect(JSON.parse(alert.metrics)).toEqual({ message: FAILED_AFTER_RETRIES });

    // The same dead message delivered again (or a sibling job of the same scan): nothing changes.
    const again = new FakeMessage({ type: "collect", scanId, pointIds: ["x"] }, 6);
    await deliver(h.deps, DLQ_QUEUE, first, again);
    expect(again.acked).toBe(1);
    expect(await getBalance(h.db, ws)).toBe(start);
    expect(await refunds(h, "scan_refund")).toHaveLength(1);
    expect(await jobAlerts(h)).toHaveLength(1);
    expect(counts.posts).toBe(0);
  });

  it("settles on what was really spent when tasks were already posted, and never posts again", async () => {
    const start = await getBalance(h.db, ws);
    const { scanId } = await createScan(h.deps, ws, trackerId, { trigger: "manual" });
    await handleScanJob(h.deps, h.queue.messages.shift()!.job); // post
    expect(counts.posts).toBe(1);
    h.queue.messages.length = 0;
    const posted = await getScan(h.db, scanId);
    expect(posted.costUsd).toBeGreaterThan(0);
    expect((await h.db.select().from(scanPoints).where(eq(scanPoints.scanId, scanId))).every((p) => p.status === "posted")).toBe(true);

    const msg = new FakeMessage({ type: "collect", scanId, pointIds: [] }, 6);
    await deliver(h.deps, DLQ_QUEUE, msg, new FakeMessage({ type: "post", scanId }, 6));
    const scan = await getScan(h.db, scanId);
    expect(scan.status).toBe("failed");
    expect(scan.billedCredits).toBe(creditsForProviderUsd(posted.costUsd, h.config.markup));
    expect(await getBalance(h.db, ws)).toBe(start - scan.billedCredits);
    expect((await h.db.select().from(scanPoints).where(eq(scanPoints.scanId, scanId))).every((p) => p.status === "failed")).toBe(true);
    expect(await jobAlerts(h)).toHaveLength(1);
    expect(counts.posts).toBe(1);
  });

  it("leaves a scan that finished normally alone", async () => {
    const start = await getBalance(h.db, ws);
    const { scanId } = await createScan(h.deps, ws, trackerId, { trigger: "manual" });
    await h.queue.drain(h.deps);
    const done = await getScan(h.db, scanId);
    const balance = await getBalance(h.db, ws);
    expect(done.status).toBe("completed");
    expect(balance).toBeLessThanOrEqual(start);

    const msg = new FakeMessage({ type: "collect", scanId, pointIds: [] }, 6);
    await deliver(h.deps, DLQ_QUEUE, msg);
    expect(msg.acked).toBe(1);
    expect(await getScan(h.db, scanId)).toEqual(done);
    expect(await getBalance(h.db, ws)).toBe(balance);
    expect(await jobAlerts(h)).toEqual([]);
  });

  it("acks messages for scans that no longer exist", async () => {
    const msg = new FakeMessage({ type: "post", scanId: "gone" }, 6);
    await deliver(h.deps, DLQ_QUEUE, msg);
    expect(msg.acked).toBe(1);
  });

  it("announces the failure to the webhook once, and respects alerts being turned off", async () => {
    const sent: string[] = [];
    h.deps.notify = async (_url, payload) => void sent.push(payload.text);
    await saveAlertSettings(h.db, ws, { webhookUrl: "https://hooks.slack.com/services/T/B/X" });
    const { scanId } = await createScan(h.deps, ws, trackerId, { trigger: "manual" });
    await deliver(h.deps, DLQ_QUEUE, new FakeMessage({ type: "post", scanId }), new FakeMessage({ type: "post", scanId }));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("failed");
    expect(sent[0]).not.toContain("hooks.slack.com");

    await saveAlertSettings(h.db, ws, { enabled: false });
    const second = await createScan(h.deps, ws, trackerId, { trigger: "manual" });
    await deliver(h.deps, DLQ_QUEUE, new FakeMessage({ type: "post", scanId: second.scanId }));
    expect((await getScan(h.db, second.scanId)).status).toBe("failed");
    expect(await jobAlerts(h)).toHaveLength(1);
  });

  it("retries the dead message itself when the failure cannot be recorded", async () => {
    const { scanId } = await createScan(h.deps, ws, trackerId, { trigger: "manual" });
    const busy = { set: () => ({ where: () => ({ returning: () => Promise.reject(new Error("D1_ERROR: busy")) }) }) };
    const broken = { ...h.deps, db: new Proxy(h.db, { get: (t, p, r) => (p === "update" ? () => busy : Reflect.get(t, p, r)) }) };
    const msg = new FakeMessage({ type: "post", scanId });
    await deliver(broken, DLQ_QUEUE, msg);
    expect(msg.acked).toBe(0);
    expect(msg.retries).toEqual([30]);
    expect((await getScan(h.db, scanId)).status).toBe("queued");
  });
});

describe("dead-letter queue consumer: Google profile snapshots", () => {
  it("fails the snapshot, settles credits once, raises one alert, and never posts the reviews task again", async () => {
    const { h, ws, counts } = await hostedHarness();
    const businessId = await seedBusiness(h.db, ws);
    const start = await getBalance(h.db, ws);
    const { snapshotId } = await createGbpSnapshot(h.deps, ws, businessId, { trigger: "manual" });
    await handleScanJob(h.deps, h.queue.messages.shift()!.job); // profile call + reviews task_post
    expect(counts.reviewPosts).toBe(1);
    h.queue.messages.length = 0;
    expect(await getBalance(h.db, ws)).toBeLessThan(start);

    const msg = new FakeMessage({ type: "gbp_reviews_collect", snapshotId, attempt: 4 }, 6);
    await deliver(h.deps, DLQ_QUEUE, msg);
    expect(msg.acked).toBe(1);
    const [snap] = await h.db.select().from(gbpSnapshots).where(eq(gbpSnapshots.id, snapshotId));
    expect(snap).toMatchObject({ status: "failed", error: FAILED_AFTER_RETRIES });
    expect(snap.reviewsTaskId).not.toBeNull();
    expect(snap.billedCredits).toBe(creditsForProviderUsd(snap.costUsd, h.config.markup));
    expect(await getBalance(h.db, ws)).toBe(start - snap.billedCredits);
    const refundRows = (await refunds(h, "gbp_refund")).length;

    await deliver(h.deps, DLQ_QUEUE, new FakeMessage({ type: "gbp_snapshot", snapshotId }), msg);
    expect(await getBalance(h.db, ws)).toBe(start - snap.billedCredits);
    expect(await refunds(h, "gbp_refund")).toHaveLength(refundRows);
    const rows = await jobAlerts(h);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ workspaceId: ws, businessId, snapshotId, scanId: null, trackerId: null });
    expect(counts.reviewPosts).toBe(1);
  });
});

describe("retry policy", () => {
  let h: Harness;
  let ws: string;
  let trackerId: string;
  let counts: Counts;
  let start: number;
  beforeEach(async () => {
    ({ h, ws, counts } = await hostedHarness());
    ({ trackerId } = await seedTracker(h.db, ws));
    start = await getBalance(h.db, ws);
  });

  /** Deps whose queue breaks after the tasks were posted, so handlePost throws `error`. */
  const breaking = (error: unknown): ProcessDeps => ({
    ...h.deps,
    queue: {
      send: (job, options) => h.queue.send(job, options),
      sendBatch: () => Promise.reject(error),
    },
  });

  async function postJob() {
    const { scanId } = await createScan(h.deps, ws, trackerId, { trigger: "manual" });
    return { scanId, job: h.queue.messages.shift()!.job };
  }

  it("retries transient errors with exponential backoff and lets the redelivery finish without posting again", async () => {
    const { scanId, job } = await postJob();
    const first = new FakeMessage(job, 1);
    await deliver(breaking(new Error("D1_ERROR: database is locked")), SCANS_QUEUE, first);
    expect(first).toMatchObject({ acked: 0, retries: [10] });
    const third = new FakeMessage(job, 3);
    await deliver(breaking(new AppError("UPSTREAM_UNAVAILABLE", "DataForSEO HTTP 503")), SCANS_QUEUE, third);
    expect(third).toMatchObject({ acked: 0, retries: [40] });
    expect((await getScan(h.db, scanId)).status).toBe("posting");
    expect(await jobAlerts(h)).toEqual([]);

    const redelivery = new FakeMessage(job, 4);
    await deliver(h.deps, SCANS_QUEUE, redelivery);
    expect(redelivery.acked).toBe(1);
    expect((await getScan(h.db, scanId)).status).toBe("polling");
    expect(counts.posts).toBe(1);
  });

  it("fails the scan at once on a permanent error: acked, no retry, credits settled, alert raised, no re-post", async () => {
    const { scanId, job } = await postJob();
    const msg = new FakeMessage(job, 1);
    await deliver(breaking(new AppError("VALIDATION_ERROR", "Grid size is not supported")), SCANS_QUEUE, msg);
    expect(msg).toMatchObject({ acked: 1, retries: [] });
    const scan = await getScan(h.db, scanId);
    expect(scan).toMatchObject({ status: "failed", error: "Processing failed: Grid size is not supported" });
    expect(await getBalance(h.db, ws)).toBe(start - scan.billedCredits);
    expect(await jobAlerts(h)).toHaveLength(1);
    expect(counts.posts).toBe(1);

    // A duplicate delivery of the same job is a no-op.
    const dup = new FakeMessage(job, 2);
    await deliver(h.deps, SCANS_QUEUE, dup);
    expect(dup.acked).toBe(1);
    expect(await jobAlerts(h)).toHaveLength(1);
    expect(counts.posts).toBe(1);
  });

  it("does not leak internal error text for unexpected permanent errors", async () => {
    const { scanId, job } = await postJob();
    const msg = new FakeMessage(job, 1);
    await deliver(breaking(new TypeError("Cannot read properties of undefined (reading 'secret-detail')")), SCANS_QUEUE, msg);
    expect(msg.acked).toBe(1);
    expect((await getScan(h.db, scanId)).error).toBe("Processing failed: unexpected error");
  });

  it("classifies errors", () => {
    const permanent = ["VALIDATION_ERROR", "NOT_FOUND", "INSUFFICIENT_CREDITS", "COST_CEILING_EXCEEDED", "DATAFORSEO_AUTH_FAILED", "FORBIDDEN", "SCAN_IN_PROGRESS"] as const;
    for (const code of permanent) expect(classifyJobError(new AppError(code))).toBe("permanent");
    for (const code of ["UPSTREAM_UNAVAILABLE", "RATE_LIMITED", "INTERNAL_ERROR"] as const) expect(classifyJobError(new AppError(code))).toBe("transient");
    expect(classifyJobError(z.string().safeParse(1).error)).toBe("permanent");
    expect(classifyJobError(new TypeError("Cannot read properties of undefined"))).toBe("permanent");
    expect(classifyJobError(new TypeError("Network connection lost"))).toBe("transient");
    expect(classifyJobError(new Error("D1_ERROR: database is locked"))).toBe("transient");
    expect(classifyJobError(new Error("DataForSEO request timed out"))).toBe("transient");
    expect(classifyJobError(new Error("something unrecognised"))).toBe("transient");
    expect(classifyJobError("a string")).toBe("transient");
  });

  it("backs off exponentially up to five minutes", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(retryDelaySeconds)).toEqual([10, 20, 40, 80, 160, 300, 300]);
    expect(retryDelaySeconds(0)).toBe(10);
  });
});

describe("GET /api/ops/failed-jobs and POST /api/scans/:id/retry", () => {
  const env = { AUTH_MODE: "hosted", BILLING_MODE: "hosted", HOSTED_FREE_CREDITS: "500" };
  const password = "correct horse battery";

  async function twoWorkspaces() {
    const counts: Counts = { posts: 0, reviewPosts: 0 };
    const h = await createHarness({
      env,
      provider: (clock) => {
        const inner = new MockDataForSeo({ now: () => clock.now });
        return wrapProvider(inner, { postTasks: async (i) => (counts.posts++, inner.postTasks(i)) });
      },
    });
    const a = client(h);
    const b = client(h);
    await a.call("POST", "/api/auth/signup", { email: "a@example.com", password });
    await b.call("POST", "/api/auth/signup", { email: "b@example.com", password });
    const biz = await a.call("POST", "/api/businesses", business);
    const tracker = await a.call("POST", "/api/trackers", { businessId: biz.json.id, keyword: "coffee shop", gridSize: 5 });
    return { h, a, b, counts, trackerId: tracker.json.id as string, businessId: biz.json.id as string };
  }

  /** A scan in workspace A that posted its tasks and then died in the DLQ. */
  async function deadScan(t: Awaited<ReturnType<typeof twoWorkspaces>>) {
    const { scanId } = (await t.a.call("POST", `/api/trackers/${t.trackerId}/scans`, {})).json;
    await handleScanJob(t.h.deps, t.h.queue.messages.shift()!.job);
    t.h.queue.messages.length = 0;
    await deliver(t.h.deps, DLQ_QUEUE, new FakeMessage({ type: "collect", scanId, pointIds: [] }, 6));
    return scanId as string;
  }

  it("lists the workspace's failed scans and snapshots of the last 30 days, with error and cost", async () => {
    const t = await twoWorkspaces();
    const failed = await deadScan(t);
    // An older failure is out of the window.
    const old = await createScan(t.h.deps, (await t.a.call("GET", "/api/me")).json.workspace.id, t.trackerId, { trigger: "manual" });
    await t.h.db.update(scans).set({ status: "failed", error: "ancient", createdAt: new Date(t.h.clock.now - 31 * 86_400_000).toISOString() }).where(eq(scans.id, old.scanId));
    const wsA = (await t.a.call("GET", "/api/me")).json.workspace.id as string;
    await t.h.db.insert(gbpSnapshots).values({ id: "snap-1", workspaceId: wsA, businessId: t.businessId, trigger: "schedule", takenAt: new Date(t.h.clock.now + 1000).toISOString(), status: "failed", error: "Profile lookup failed: x" });

    const res = await t.a.call("GET", "/api/ops/failed-jobs");
    expect(res.status).toBe(200);
    expect(res.json.jobs.map((j: { id: string }) => j.id)).toEqual(["snap-1", failed]);
    expect(res.json.jobs[0]).toMatchObject({ kind: "gbp", error: "Profile lookup failed: x", businessName: business.name });
    expect(res.json.jobs[1]).toMatchObject({ kind: "scan", error: FAILED_AFTER_RETRIES, trackerId: t.trackerId, keyword: "coffee shop", businessName: business.name });
    expect(res.json.jobs[1].costUsd).toBeGreaterThan(0);

    // Another workspace sees none of it.
    expect((await t.b.call("GET", "/api/ops/failed-jobs")).json.jobs).toEqual([]);
    expect((await client(t.h).call("GET", "/api/ops/failed-jobs")).status).toBe(401);
  });

  it("is admin only", async () => {
    const h = await createHarness({ env: { AUTH_MODE: "cloudflare_access" } });
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" }] });
    const accessEnv = { TEAM_DOMAIN: "https://team.cloudflareaccess.com", POLICY_AUD: "aud123" };
    const sign = (email: string) =>
      new SignJWT({ email }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(accessEnv.TEAM_DOMAIN).setAudience("aud123").setExpirationTime("5m").sign(privateKey);
    const { call } = client(h, accessEnv, {}, keys);
    const owner = { "cf-access-jwt-assertion": await sign("owner@agency.com") };
    const staff = { "cf-access-jwt-assertion": await sign("staff@agency.com") };
    expect((await call("GET", "/api/ops/failed-jobs", undefined, owner)).status).toBe(200);
    expect((await call("GET", "/api/ops/failed-jobs", undefined, staff)).status).toBe(403);
    expect((await call("POST", "/api/scans/whatever/retry", {}, staff)).status).toBe(403);
  });

  it("retry creates a NEW scan for the same tracker with a fresh hold, leaving the failed one as it was", async () => {
    const t = await twoWorkspaces();
    const failedId = await deadScan(t);
    const failedBefore = await getScan(t.h.db, failedId);
    const failedPoints = await t.h.db.select().from(scanPoints).where(eq(scanPoints.scanId, failedId));
    const balance = (await t.a.call("GET", "/api/usage")).json.credits.balance as number;
    expect(t.counts.posts).toBe(1);

    const res = await t.a.call("POST", `/api/scans/${failedId}/retry`, {});
    expect(res.status).toBe(202);
    expect(res.json.retriedScanId).toBe(failedId);
    expect(res.json.scanId).not.toBe(failedId);
    expect(res.json.quote.credits).toBeGreaterThan(0);
    const created = await getScan(t.h.db, res.json.scanId);
    expect(created).toMatchObject({ status: "queued", trackerId: t.trackerId, trigger: "manual", reservedCredits: res.json.quote.credits, costUsd: 0 });
    expect((await t.a.call("GET", "/api/usage")).json.credits.balance).toBe(balance - res.json.quote.credits);

    await t.h.queue.drain(t.h.deps);
    expect(t.counts.posts).toBe(2); // a fresh task_post, not a replay
    expect((await getScan(t.h.db, res.json.scanId)).status).toBe("completed");
    expect(await getScan(t.h.db, failedId)).toEqual(failedBefore);
    expect(await t.h.db.select().from(scanPoints).where(eq(scanPoints.scanId, failedId))).toEqual(failedPoints);
  });

  it("retry is workspace-scoped, only for failed scans, and respects the one-active-scan rule", async () => {
    const t = await twoWorkspaces();
    const failedId = await deadScan(t);

    const other = await t.b.call("POST", `/api/scans/${failedId}/retry`, {});
    expect(other.status).toBe(404);
    expect(other.json.error.code).toBe("NOT_FOUND");
    expect((await t.a.call("POST", "/api/scans/nope/retry", {})).status).toBe(404);
    expect((await client(t.h).call("POST", `/api/scans/${failedId}/retry`, {})).status).toBe(401);

    const first = await t.a.call("POST", `/api/scans/${failedId}/retry`, {});
    expect(first.status).toBe(202);
    const concurrent = await t.a.call("POST", `/api/scans/${failedId}/retry`, {});
    expect(concurrent.status).toBe(409);
    expect(concurrent.json.error.code).toBe("SCAN_IN_PROGRESS");
    await t.h.queue.drain(t.h.deps);
    const completed = await t.a.call("POST", `/api/scans/${first.json.scanId}/retry`, {});
    expect(completed.status).toBe(400);
    expect(completed.json.error.message).toContain("failed");
    expect((await t.a.call("POST", `/api/scans/${failedId}/retry`, { maxCostUsd: 0.0001 })).json.error.code).toBe("COST_CEILING_EXCEEDED");
  });

  it("retry refuses when the workspace cannot afford a new hold, charging nothing", async () => {
    const t = await twoWorkspaces();
    const failedId = await deadScan(t);
    const wsA = (await t.a.call("GET", "/api/me")).json.workspace.id as string;
    const { workspaces } = await import("@/worker/db/schema");
    await t.h.db.update(workspaces).set({ creditBalance: 0 }).where(eq(workspaces.id, wsA));
    const res = await t.a.call("POST", `/api/scans/${failedId}/retry`, {});
    expect(res.status).toBe(402);
    expect(res.json.error.code).toBe("INSUFFICIENT_CREDITS");
    expect(await t.h.db.select().from(scans).where(eq(scans.trackerId, t.trackerId))).toHaveLength(1);
  });

  it("surfaces job_failed in the alerts API", async () => {
    const t = await twoWorkspaces();
    const failedId = await deadScan(t);
    const list = await t.a.call("GET", "/api/alerts");
    expect(list.json.unreadCount).toBe(1);
    expect(list.json.alerts[0]).toMatchObject({ source: "job", kind: "job_failed", jobType: "scan", scanId: failedId, trackerId: t.trackerId, keyword: "coffee shop", message: FAILED_AFTER_RETRIES, businessName: business.name });
    expect((await t.b.call("GET", "/api/alerts")).json.alerts).toEqual([]);
  });
});
