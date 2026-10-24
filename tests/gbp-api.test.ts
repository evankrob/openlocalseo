import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createApp } from "@/worker/app";
import type { Env } from "@/worker/env";
import { alerts, creditLedger, gbpSnapshots } from "@/worker/db/schema";
import { createHarness, type Harness } from "./helpers/harness";
import { DAY_MS } from "./helpers/gbp";

const origin = "http://localhost:5173";
const business = { name: "Maple & Ember Coffee Roasters", placeId: "ChIJdemo0000000000000001", domain: "mapleember.example", category: "Coffee shop", lat: 35.7796, lng: -78.6382 };

function client(h: Harness) {
  const app = createApp({ resolveDeps: () => h.deps });
  let cookie = "";
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(
      `${origin}${path}`,
      { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) },
      {} as Env,
    );
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  return { call };
}

async function mcp(h: Harness, key: string, name: string, args: Record<string, unknown> = {}) {
  const app = createApp({ resolveDeps: () => h.deps });
  const res = await app.request(
    `${origin}/mcp`,
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${key}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    },
    {} as Env,
  );
  return ((await res.json()) as { result: McpResult }).result;
}

type McpResult = {
  isError?: boolean;
  content: Array<{ text: string }>;
  structuredContent: {
    latest?: { isClaimed: boolean | null } | null;
    reviews: Array<{ ownerAnswered: boolean }>;
    nextCursor: string | null;
    alerts: Array<{ kind: string; businessId?: string; business?: string }>;
    trackers: Array<{ trackerId: string; businessId: string }>;
  };
};

describe("GBP API (local_noauth)", () => {
  async function setup() {
    const h = await createHarness({ env: { AUTH_MODE: "local_noauth" } });
    const c = client(h);
    const biz = (await c.call("POST", "/api/businesses", business)).json;
    return { h, c, biz };
  }

  it("shows an empty overview with the quote and tracking off by default", async () => {
    const { c, biz } = await setup();
    expect(biz).toMatchObject({ gbpTracking: false, gbpNextRunAt: null });
    const res = await c.call("GET", `/api/businesses/${biz.id}/gbp`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      business: { id: biz.id, gbpTracking: false },
      latest: null,
      change: null,
      attempt: null,
      history: [],
      quote: { providerCostUsd: 0.0069, chargedUsd: 0.0069, credits: 0, reviewsDepth: 20 },
      monthlyCostUsd: 0.0069,
    });
  });

  it("PATCH gbpTracking toggles the monthly schedule and validates the body", async () => {
    const { c, biz } = await setup();
    const on = await c.call("PATCH", `/api/businesses/${biz.id}`, { gbpTracking: true });
    expect(on.status).toBe(200);
    expect(on.json.gbpTracking).toBe(true);
    expect(on.json.gbpNextRunAt).toMatch(/-01T00:00:00\.000Z$/);
    const off = await c.call("PATCH", `/api/businesses/${biz.id}`, { gbpTracking: false });
    expect(off.json).toMatchObject({ gbpTracking: false, gbpNextRunAt: null });
    expect((await c.call("PATCH", `/api/businesses/${biz.id}`, { gbpTracking: "yes" })).status).toBe(400);
    expect((await c.call("PATCH", `/api/businesses/${biz.id}`, {})).status).toBe(200);
  });

  it("business without a place ID cannot be tracked or refreshed", async () => {
    const { c } = await setup();
    const bare = (await c.call("POST", "/api/businesses", { name: "No Place", lat: 35.7, lng: -78.6 })).json;
    expect((await c.call("PATCH", `/api/businesses/${bare.id}`, { gbpTracking: true })).json.error.code).toBe("VALIDATION_ERROR");
    expect((await c.call("POST", `/api/businesses/${bare.id}/gbp/refresh`, {})).json.error.code).toBe("VALIDATION_ERROR");
  });

  it("refresh -> 202 with a quote, a cost ceiling, one at a time, then overview, history and reviews", async () => {
    const { h, c, biz } = await setup();
    const tooCheap = await c.call("POST", `/api/businesses/${biz.id}/gbp/refresh`, { maxCostUsd: 0.001 });
    expect(tooCheap.status).toBe(409);
    expect(tooCheap.json.error.code).toBe("COST_CEILING_EXCEEDED");
    expect((await c.call("POST", `/api/businesses/${biz.id}/gbp/refresh`, { maxCostUsd: -1 })).status).toBe(400);

    const started = await c.call("POST", `/api/businesses/${biz.id}/gbp/refresh`, { maxCostUsd: 0.01 });
    expect(started.status).toBe(202);
    expect(started.json).toMatchObject({ quote: { providerCostUsd: 0.0069, chargedUsd: 0.0069 } });
    expect((await c.call("POST", `/api/businesses/${biz.id}/gbp/refresh`)).json.error.code).toBe("SCAN_IN_PROGRESS");

    const running = (await c.call("GET", `/api/businesses/${biz.id}/gbp`)).json;
    expect(running.latest).toBeNull();
    expect(running.attempt).toMatchObject({ id: started.json.snapshotId, status: "queued" });

    await h.queue.drain(h.deps);
    h.clock.now += 35 * DAY_MS;
    await c.call("POST", `/api/businesses/${biz.id}/gbp/refresh`);
    await h.queue.drain(h.deps);

    const overview = (await c.call("GET", `/api/businesses/${biz.id}/gbp`)).json;
    expect(overview.attempt).toBeNull();
    expect(overview.history).toHaveLength(2);
    expect(overview.history[0].takenAt < overview.history[1].takenAt).toBe(true); // oldest first
    expect(overview.latest).toMatchObject({ id: overview.history[1].id, isClaimed: true, primaryCategory: "Coffee shop" });
    expect(overview.latest.newReviews).toBeGreaterThan(0);
    expect(overview.change.reviewCount).toBe(overview.history[1].reviewCount - overview.history[0].reviewCount);
    expect(overview.change.since).toBe(overview.history[0].takenAt);

    // Reviews: newest first, paged by cursor with no gaps or repeats.
    const all = (await c.call("GET", `/api/businesses/${biz.id}/reviews?limit=100`)).json;
    expect(all.nextCursor).toBeNull();
    expect(all.reviews.length).toBeGreaterThanOrEqual(20);
    const dates = all.reviews.map((r: { publishedAt: string }) => r.publishedAt);
    expect([...dates].sort().reverse()).toEqual(dates);
    expect(Object.keys(all.reviews[0]).sort()).toEqual(["ownerAnswered", "ownerAnsweredAt", "publishedAt", "rating", "reviewerName", "reviewId", "text"].sort());

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { json: { reviews: Array<{ reviewId: string }>; nextCursor: string | null } } = await c.call(
        "GET",
        `/api/businesses/${biz.id}/reviews?limit=7${cursor ? `&cursor=${cursor}` : ""}`,
      );
      expect(page.json.reviews.length).toBeLessThanOrEqual(7);
      seen.push(...page.json.reviews.map((r) => r.reviewId));
      cursor = page.json.nextCursor;
    } while (cursor);
    expect(seen).toEqual(all.reviews.map((r: { reviewId: string }) => r.reviewId));

    const unanswered = (await c.call("GET", `/api/businesses/${biz.id}/reviews?unanswered=1&limit=100`)).json;
    expect(unanswered.reviews.length).toBeGreaterThan(0);
    expect(unanswered.reviews.length).toBeLessThan(all.reviews.length);
    expect(unanswered.reviews.every((r: { ownerAnswered: boolean }) => !r.ownerAnswered)).toBe(true);

    expect((await c.call("GET", `/api/businesses/${biz.id}/reviews?limit=0`)).status).toBe(400);
    expect((await c.call("GET", `/api/businesses/${biz.id}/reviews?cursor=%25%25`)).status).toBe(400);
  });

  it("an alert from a snapshot shows up in /api/alerts and can be marked read", async () => {
    const { h, c, biz } = await setup();
    await c.call("POST", `/api/businesses/${biz.id}/gbp/refresh`);
    await h.queue.drain(h.deps);
    const [first] = await h.db.select().from(gbpSnapshots).where(eq(gbpSnapshots.businessId, biz.id));
    await h.db.update(gbpSnapshots).set({ rating: 5.6 }).where(eq(gbpSnapshots.id, first.id));
    h.clock.now += 35 * DAY_MS;
    await c.call("POST", `/api/businesses/${biz.id}/gbp/refresh`);
    await h.queue.drain(h.deps);

    const list = (await c.call("GET", "/api/alerts")).json;
    // The mock's own new reviews may include a low-star one, so look the drop up by kind.
    const drop = list.alerts.find((a: { kind: string }) => a.kind === "rating_drop");
    expect(list.unreadCount).toBe(list.alerts.length);
    expect(drop).toMatchObject({ source: "gbp", businessId: biz.id, businessName: business.name, severity: "critical" });
    expect(drop.metrics.rating.before).toBe(5.6);
    expect((await c.call("POST", `/api/alerts/${drop.id}/read`)).status).toBe(200);
    expect((await c.call("GET", "/api/alerts")).json.unreadCount).toBe(list.unreadCount - 1);
  });
});

describe("GBP API tenant isolation (hosted accounts)", () => {
  async function twoWorkspaces() {
    const h = await createHarness({ env: { AUTH_MODE: "hosted", BILLING_MODE: "hosted", HOSTED_FREE_CREDITS: "100" } });
    const a = client(h);
    const b = client(h);
    await a.call("POST", "/api/auth/signup", { email: "a@example.com", password: "correct horse battery" });
    await b.call("POST", "/api/auth/signup", { email: "b@example.com", password: "another long password" });
    const biz = (await a.call("POST", "/api/businesses", business)).json;
    return { h, a, b, biz };
  }

  it("another workspace gets 404 on every GBP route and cannot spend or change anything", async () => {
    const { h, a, b, biz } = await twoWorkspaces();
    await a.call("POST", `/api/businesses/${biz.id}/gbp/refresh`);
    await h.queue.drain(h.deps);
    const bBalance = (await b.call("GET", "/api/usage")).json.credits.balance;

    for (const [method, path, body] of [
      ["GET", `/api/businesses/${biz.id}/gbp`, undefined],
      ["GET", `/api/businesses/${biz.id}/reviews`, undefined],
      ["POST", `/api/businesses/${biz.id}/gbp/refresh`, {}],
      ["PATCH", `/api/businesses/${biz.id}`, { gbpTracking: true }],
      ["PATCH", `/api/businesses/${biz.id}`, {}],
    ] as const) {
      const res = await b.call(method, path, body);
      expect([method, path, res.status, res.json.error.code]).toEqual([method, path, 404, "NOT_FOUND"]);
    }
    expect((await b.call("GET", "/api/usage")).json.credits.balance).toBe(bBalance);
    expect(await h.db.select().from(gbpSnapshots)).toHaveLength(1);
    expect((await a.call("GET", `/api/businesses/${biz.id}/gbp`)).json.business.gbpTracking).toBe(false);
    expect((await a.call("GET", `/api/businesses/${biz.id}/reviews`)).json.reviews).toHaveLength(20);
    expect((await b.call("GET", "/api/alerts")).json.alerts).toEqual([]);
  });

  it("holds credits for the refresh, settles on the cost, and refuses without a balance", async () => {
    const { h, a, biz } = await twoWorkspaces();
    const before = (await a.call("GET", "/api/usage")).json.credits.balance;
    const started = await a.call("POST", `/api/businesses/${biz.id}/gbp/refresh`);
    expect(started.json.quote).toMatchObject({ credits: 9, chargedUsd: 0.008832 });
    expect((await a.call("GET", "/api/usage")).json.credits.balance).toBe(before - 9);
    await h.queue.drain(h.deps);
    expect((await a.call("GET", "/api/usage")).json.credits.balance).toBe(before - 9);
    expect((await h.db.select().from(creditLedger)).map((l) => l.reason)).toContain("gbp_hold");

    // Drain the balance, then a refresh is refused up front.
    await h.db.update((await import("@/worker/db/schema")).workspaces).set({ creditBalance: 2 });
    const refused = await a.call("POST", `/api/businesses/${biz.id}/gbp/refresh`);
    expect(refused.status).toBe(402);
    expect(refused.json.error.code).toBe("INSUFFICIENT_CREDITS");
  });

  it("MCP get_gbp_profile and list_reviews are scoped to the key's workspace", async () => {
    const { h, a, b, biz } = await twoWorkspaces();
    await a.call("POST", `/api/businesses/${biz.id}/gbp/refresh`);
    await h.queue.drain(h.deps);
    const aKey = (await a.call("POST", "/api/api-keys", { name: "a" })).json.key as string;
    const bKey = (await b.call("POST", "/api/api-keys", { name: "b" })).json.key as string;

    const profile = await mcp(h, aKey, "get_gbp_profile", { businessId: biz.id });
    expect(profile.isError).toBeUndefined();
    expect(profile.structuredContent.latest).toMatchObject({ isClaimed: true });
    expect(profile.content[0].text).toContain("stars from");

    const list = await mcp(h, aKey, "list_reviews", { businessId: biz.id, limit: 5 });
    expect(list.structuredContent.reviews).toHaveLength(5);
    expect(list.structuredContent.nextCursor).toEqual(expect.any(String));
    const page2 = await mcp(h, aKey, "list_reviews", { businessId: biz.id, limit: 100, cursor: list.structuredContent.nextCursor });
    expect(page2.structuredContent.reviews).toHaveLength(15);
    const unanswered = await mcp(h, aKey, "list_reviews", { businessId: biz.id, unansweredOnly: true, limit: 100 });
    expect(unanswered.structuredContent.reviews.every((r: { ownerAnswered: boolean }) => !r.ownerAnswered)).toBe(true);

    for (const [tool, args] of [["get_gbp_profile", { businessId: biz.id }], ["list_reviews", { businessId: biz.id }]] as const) {
      const denied = await mcp(h, bKey, tool, args);
      expect(denied.isError).toBe(true);
      expect(denied.content[0].text).toContain("NOT_FOUND");
    }

    // list_trackers hands out the business id these tools take.
    const t = (await a.call("POST", "/api/trackers", { businessId: biz.id, keyword: "coffee shop", gridSize: 5 })).json;
    const trackers = await mcp(h, aKey, "list_trackers");
    expect(trackers.structuredContent.trackers[0]).toMatchObject({ trackerId: t.id, businessId: biz.id });
  });

  it("MCP list_alerts includes profile alerts", async () => {
    const { h, a, biz } = await twoWorkspaces();
    await a.call("POST", `/api/businesses/${biz.id}/gbp/refresh`);
    await h.queue.drain(h.deps);
    const [first] = await h.db.select().from(gbpSnapshots);
    await h.db.update(gbpSnapshots).set({ rating: 5.6 }).where(eq(gbpSnapshots.id, first.id));
    h.clock.now += 35 * DAY_MS;
    await h.db.update((await import("@/worker/db/schema")).workspaces).set({ creditBalance: 500 });
    await a.call("POST", `/api/businesses/${biz.id}/gbp/refresh`);
    await h.queue.drain(h.deps);
    expect((await h.db.select().from(alerts)).map((r) => r.kind)).toContain("rating_drop");
    const key = (await a.call("POST", "/api/api-keys", { name: "a" })).json.key as string;
    const res = await mcp(h, key, "list_alerts");
    const drop = res.structuredContent.alerts.find((x: { kind: string }) => x.kind === "rating_drop");
    expect(drop).toMatchObject({ businessId: biz.id, business: business.name });
    expect(res.content[0].text).toContain("rating_drop");
  });
});
