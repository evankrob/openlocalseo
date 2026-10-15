import { beforeEach, describe, expect, it } from "vitest";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { createApp, type AppOptions } from "@/worker/app";
import type { Env } from "@/worker/env";
import { createHarness, type Harness } from "./helpers/harness";

const origin = "http://localhost:5173";
const business = { name: "Maple & Ember Coffee Roasters", placeId: "ChIJdemo0000000000000001", domain: "mapleember.example", lat: 35.7796, lng: -78.6382 };

function client(h: Harness, env: Partial<Env> = {}, accessKeys?: AppOptions["accessKeys"]) {
  const app = createApp({ resolveDeps: () => h.deps, accessKeys });
  let cookie = "";
  let headers: Record<string, string> = {};
  const call = async (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
    const res = await app.request(
      `${origin}${path}`,
      {
        method,
        headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers, ...extra },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      env as Env,
    );
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
  };
  return { call, setHeaders: (h2: Record<string, string>) => (headers = h2), clearCookie: () => (cookie = "") };
}

describe("local_noauth: the whole flow over HTTP", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness({ env: { AUTH_MODE: "local_noauth" } });
  });

  it("business -> tracker -> estimate -> scan -> heatmap data, competitors, history", async () => {
    const { call } = client(h);
    const biz = await call("POST", "/api/businesses", business);
    expect(biz.status).toBe(201);

    const tracker = await call("POST", "/api/trackers", {
      businessId: biz.json.id,
      keyword: "coffee shop",
      gridSize: 5,
      radius: { value: 3, unit: "mi" },
      schedule: { frequency: "monthly", day: 5 },
    });
    expect(tracker.status).toBe(201);
    expect(tracker.json.radiusKm).toBeCloseTo(4.828, 2);
    expect(tracker.json.nextRunAt).toMatch(/-05T00:00:00/);
    expect(tracker.json.zoom).toBe(15);
    expect(tracker.json.queueMode).toBe("standard");

    const est = await call("POST", "/api/estimate", { gridSize: 13, queueMode: "priority" });
    expect(est.json).toMatchObject({ points: 169, providerCostUsd: 0.2028, chargedUsd: 0.2028, credits: 0 });

    const run = await call("POST", `/api/trackers/${tracker.json.id}/scans`, {});
    expect(run.status).toBe(202);
    const again = await call("POST", `/api/trackers/${tracker.json.id}/scans`, {});
    expect(again.status).toBe(409);
    expect(again.json.error.code).toBe("SCAN_IN_PROGRESS");

    await h.queue.drain(h.deps);

    const detail = await call("GET", `/api/scans/${run.json.scanId}`);
    expect(detail.json.scan.status).toBe("completed");
    expect(detail.json.points).toHaveLength(25);
    expect(detail.json.metrics.totalPoints).toBe(25);
    expect(detail.json.competitors.length).toBeGreaterThan(5);
    const me = detail.json.competitors.find((c: { name: string }) => c.name === business.name);
    expect(me.atrp).toBe(detail.json.scan.atrp);

    const point = detail.json.points[12];
    const pointRes = await call("GET", `/api/scans/${run.json.scanId}/points/${point.id}`);
    expect(pointRes.json.results.length).toBeGreaterThan(5);
    expect(pointRes.json.results[0].rank).toBe(1);

    const history = await call("GET", `/api/trackers/${tracker.json.id}/scans`);
    expect(history.json).toHaveLength(1);

    const trackers = await call("GET", "/api/trackers");
    expect(trackers.json[0].lastCompleted.id).toBe(run.json.scanId);

    const usage = await call("GET", "/api/usage");
    expect(usage.json).toMatchObject({ billingMode: "byok", providerCostUsd: 0, scans: 1 });
    expect(usage.json.simulatedCostUsd).toBeCloseTo(0.015, 6);
  });

  it("validates input", async () => {
    const { call } = client(h);
    const biz = await call("POST", "/api/businesses", business);
    const bad = await call("POST", "/api/trackers", { businessId: biz.json.id, keyword: "x", gridSize: 15 });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe("VALIDATION_ERROR");
    const hugeRadius = await call("POST", "/api/trackers", { businessId: biz.json.id, keyword: "x", radius: { value: 100, unit: "mi" } });
    expect(hugeRadius.status).toBe(400);
    expect((await call("POST", "/api/businesses", { name: "x", lat: 200, lng: 0 })).status).toBe(400);
  });

  it("refuses to run on a non-local hostname, so a deployed copy is never open", async () => {
    const app = createApp({ resolveDeps: () => h.deps });
    const res = await app.request("https://tracker.example.com/api/me", {}, {} as Env);
    const json = (await res.json()) as { error: { message: string } };
    expect(res.status).toBe(403);
    expect(json.error.message).toMatch(/local development only/);
    expect((await app.request("http://127.0.0.1:8787/api/me", {}, {} as Env)).status).toBe(200);
  });
});

describe("hosted accounts and tenant isolation", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness({ env: { AUTH_MODE: "hosted", BILLING_MODE: "hosted", HOSTED_FREE_CREDITS: "200" } });
  });

  it("signs up with a free-credit workspace, requires a session, and keeps workspaces apart", async () => {
    const a = client(h);
    const b = client(h);
    expect((await a.call("GET", "/api/me")).status).toBe(401);

    const signup = await a.call("POST", "/api/auth/signup", { email: "a@example.com", password: "correct horse battery" });
    expect(signup.status).toBe(201);
    const me = await a.call("GET", "/api/me");
    expect(me.json.workspace.role).toBe("owner");
    expect((await a.call("GET", "/api/usage")).json.credits.balance).toBe(200);

    const biz = await a.call("POST", "/api/businesses", business);
    const tracker = await a.call("POST", "/api/trackers", { businessId: biz.json.id, keyword: "coffee shop", gridSize: 7 });
    const run = await a.call("POST", `/api/trackers/${tracker.json.id}/scans`, {});
    expect(run.json.quote).toMatchObject({ credits: 38 });
    expect((await a.call("GET", "/api/usage")).json.credits.balance).toBe(162);
    await h.queue.drain(h.deps);

    await b.call("POST", "/api/auth/signup", { email: "b@example.com", password: "another long password" });
    expect((await b.call("GET", `/api/scans/${run.json.scanId}`)).status).toBe(404);
    expect((await b.call("GET", "/api/trackers")).json).toEqual([]);
    expect((await b.call("POST", `/api/trackers/${tracker.json.id}/scans`, {})).status).toBe(404);
    // asking for a workspace you are not in is refused outright
    const wsA = me.json.workspace.id;
    b.setHeaders({ "x-workspace-id": wsA });
    expect((await b.call("GET", "/api/trackers")).status).toBe(403);
  });

  it("rejects weak passwords, duplicate emails, bad logins and cross-origin writes", async () => {
    const a = client(h);
    expect((await a.call("POST", "/api/auth/signup", { email: "a@example.com", password: "short" })).status).toBe(400);
    await a.call("POST", "/api/auth/signup", { email: "a@example.com", password: "correct horse battery" });
    const dup = client(h);
    expect((await dup.call("POST", "/api/auth/signup", { email: "A@example.com", password: "correct horse battery" })).status).toBe(400);
    const login = client(h);
    expect((await login.call("POST", "/api/auth/login", { email: "a@example.com", password: "wrong wrong wrong" })).status).toBe(401);
    expect((await login.call("POST", "/api/auth/login", { email: "nobody@example.com", password: "wrong wrong wrong" })).status).toBe(401);
    expect((await login.call("POST", "/api/auth/login", { email: "a@example.com", password: "correct horse battery" })).status).toBe(200);
    const evil = await login.call("POST", "/api/businesses", business, { origin: "https://evil.example" });
    expect(evil.status).toBe(403);
  });

  it("logout invalidates the session server-side", async () => {
    const a = client(h);
    const signup = await a.call("POST", "/api/auth/signup", { email: "a@example.com", password: "correct horse battery" });
    const oldCookie = signup.headers.get("set-cookie")!.split(";")[0];
    expect((await a.call("GET", "/api/me", undefined, { cookie: oldCookie })).status).toBe(200);
    await a.call("POST", "/api/auth/logout", undefined, { cookie: oldCookie });
    // replaying the stolen/old cookie must no longer work
    expect((await client(h).call("GET", "/api/me", undefined, { cookie: oldCookie })).status).toBe(401);
  });
});

describe("cloudflare_access", () => {
  it("accepts a valid Access JWT, rejects wrong audience, and shares one workspace", async () => {
    const h = await createHarness({ env: { AUTH_MODE: "cloudflare_access" } });
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
    const keys = createLocalJWKSet({ keys: [jwk] });
    const env = { TEAM_DOMAIN: "https://team.cloudflareaccess.com", POLICY_AUD: "aud123" };
    const { call } = client(h, env, keys);
    const sign = (email: string, aud = "aud123") =>
      new SignJWT({ email }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(env.TEAM_DOMAIN).setAudience(aud).setExpirationTime("5m").sign(privateKey);

    expect((await call("GET", "/api/me")).status).toBe(401);
    expect((await call("GET", "/api/me", undefined, { "cf-access-jwt-assertion": await sign("x@example.com", "other") })).status).toBe(401);

    const first = await call("GET", "/api/me", undefined, { "cf-access-jwt-assertion": await sign("owner@agency.com") });
    expect(first.json.workspace.role).toBe("owner");
    const second = await call("GET", "/api/me", undefined, { "cf-access-jwt-assertion": await sign("staff@agency.com") });
    expect(second.json.workspace).toMatchObject({ id: first.json.workspace.id, role: "member" });
    // members cannot manage API keys
    expect((await call("GET", "/api/api-keys", undefined, { "cf-access-jwt-assertion": await sign("staff@agency.com") })).status).toBe(403);
  });

  it("fails closed when TEAM_DOMAIN / POLICY_AUD are not configured", async () => {
    const h = await createHarness({ env: { AUTH_MODE: "cloudflare_access" } });
    const { call } = client(h, {});
    expect((await call("GET", "/api/me", undefined, { "cf-access-jwt-assertion": "x.y.z" })).status).toBe(500);
  });
});

describe("white-label share links", () => {
  async function setup(showCompetitors = true) {
    const h = await createHarness({ env: { AUTH_MODE: "local_noauth" } });
    const c = client(h);
    const biz = await c.call("POST", "/api/businesses", business);
    const tracker = await c.call("POST", "/api/trackers", { businessId: biz.json.id, keyword: "coffee shop", gridSize: 5 });
    const run = await c.call("POST", `/api/trackers/${tracker.json.id}/scans`, {});
    await h.queue.drain(h.deps);
    await c.call("PUT", "/api/branding", { brandName: "Raleigh Digital", primaryColor: "#0a7d5a", logoUrl: "https://cdn.example/logo.png", hideAttribution: true });
    const share = await c.call("POST", `/api/trackers/${tracker.json.id}/shares`, { showCompetitors });
    return { h, c, tracker: tracker.json, run: run.json, share: share.json };
  }

  it("serves a public, branded report without leaking internals", async () => {
    const { h, share, run } = await setup();
    expect(share.url).toContain(`/r/${share.token}`);
    const anon = client(h); // no auth needed
    const res = await anon.call("GET", `/api/public/reports/${share.token}`);
    expect(res.status).toBe(200);
    expect(res.json.branding).toMatchObject({ brandName: "Raleigh Digital", primaryColor: "#0a7d5a", hideAttribution: true });
    expect(res.json.scan.id).toBe(run.scanId);
    expect(res.json.scan.points).toHaveLength(25);
    expect(res.json.competitors.length).toBeGreaterThan(0);
    const raw = JSON.stringify(res.json);
    for (const secret of ["costUsd", "estimatedCostUsd", "workspaceId", "billedCredits", "error\""]) expect(raw).not.toContain(secret);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const point = await anon.call("GET", `/api/public/reports/${share.token}/points/${res.json.scan.points[0].id}?scan=${run.scanId}`);
    expect(point.status).toBe(200);
  });

  it("hides competitors when the share excludes them", async () => {
    const { h, share, run } = await setup(false);
    const anon = client(h);
    const res = await anon.call("GET", `/api/public/reports/${share.token}`);
    expect(res.json.competitors).toEqual([]);
    expect((await anon.call("GET", `/api/public/reports/${share.token}/points/${res.json.scan.points[0].id}?scan=${run.scanId}`)).status).toBe(404);
  });

  it("revoked, expired and made-up tokens all look the same", async () => {
    const { h, c, share, tracker } = await setup();
    const anon = client(h);
    expect((await anon.call("GET", "/api/public/reports/olrep_doesnotexist")).status).toBe(404);
    expect((await anon.call("GET", "/api/public/reports/garbage")).status).toBe(404);
    const expired = await c.call("POST", `/api/trackers/${tracker.id}/shares`, { showCompetitors: true, expiresAt: "2020-01-01T00:00:00.000Z" });
    expect((await anon.call("GET", `/api/public/reports/${expired.json.token}`)).status).toBe(404);
    await c.call("DELETE", `/api/shares/${share.id}`);
    expect((await anon.call("GET", `/api/public/reports/${share.token}`)).status).toBe(404);
  });

  it("rejects unsafe branding values", async () => {
    const { c } = await setup();
    expect((await c.call("PUT", "/api/branding", { logoUrl: "javascript:alert(1)" })).status).toBe(400);
    expect((await c.call("PUT", "/api/branding", { primaryColor: "red" })).status).toBe(400);
  });
});

describe("MCP server", () => {
  async function mcp(h: Harness, key: string, method: string, params: Record<string, unknown> = {}, id = 1) {
    const app = createApp({ resolveDeps: () => h.deps });
    const res = await app.request(
      `${origin}/mcp`,
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${key}` },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      },
      {} as Env,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, json: (res.status === 200 ? await res.json() : await res.text()) as any };
  }

  it("requires an API key, lists the tools, and runs a scan end to end", async () => {
    const h = await createHarness({ env: { AUTH_MODE: "local_noauth" } });
    const c = client(h);
    const biz = await c.call("POST", "/api/businesses", business);
    const tracker = await c.call("POST", "/api/trackers", { businessId: biz.json.id, keyword: "coffee shop", gridSize: 5 });
    const key = (await c.call("POST", "/api/api-keys", { name: "Claude" })).json.key as string;

    const anon = createApp({ resolveDeps: () => h.deps });
    expect((await anon.request(`${origin}/mcp`, { method: "POST", body: "{}" }, {} as Env)).status).toBe(401);
    expect((await mcp(h, "olseo_wrong", "tools/list")).status).toBe(401);

    const list = await mcp(h, key, "tools/list");
    expect(list.json.result.tools.map((t: { name: string }) => t.name).sort()).toEqual(["get_scan", "list_scans", "list_trackers", "run_scan"]);

    const trackers = await mcp(h, key, "tools/call", { name: "list_trackers", arguments: {} });
    expect(trackers.json.result.structuredContent.trackers[0].trackerId).toBe(tracker.json.id);

    const tooCheap = await mcp(h, key, "tools/call", { name: "run_scan", arguments: { trackerId: tracker.json.id, maxCostUsd: 0.001 } });
    expect(tooCheap.json.result.isError).toBe(true);
    expect(tooCheap.json.result.content[0].text).toContain("COST_CEILING_EXCEEDED");

    const run = await mcp(h, key, "tools/call", { name: "run_scan", arguments: { trackerId: tracker.json.id, maxCostUsd: 0.05 } });
    const scanId = run.json.result.structuredContent.scanId;
    expect(run.json.result.structuredContent.status).toBe("queued");

    const pending = await mcp(h, key, "tools/call", { name: "get_scan", arguments: { scanId } });
    expect(pending.json.result.structuredContent.status).toBe("queued");
    await h.queue.drain(h.deps);

    const done = await mcp(h, key, "tools/call", { name: "get_scan", arguments: { scanId, competitors: 3 } });
    const sc = done.json.result.structuredContent;
    expect(sc.status).toBe("completed");
    expect(sc.grid).toHaveLength(5);
    expect(sc.grid[0]).toHaveLength(5);
    expect(sc.competitors).toHaveLength(3);
    expect(sc.metrics.totalPoints).toBe(25);

    const scans = await mcp(h, key, "tools/call", { name: "list_scans", arguments: { trackerId: tracker.json.id } });
    expect(scans.json.result.structuredContent.scans[0]).toMatchObject({ scanId, status: "completed" });
  });

  it("a key only sees its own workspace", async () => {
    const h = await createHarness({ env: { AUTH_MODE: "hosted" } });
    const a = client(h);
    const b = client(h);
    await a.call("POST", "/api/auth/signup", { email: "a@example.com", password: "correct horse battery" });
    await b.call("POST", "/api/auth/signup", { email: "b@example.com", password: "another long password" });
    const biz = await a.call("POST", "/api/businesses", business);
    const tracker = await a.call("POST", "/api/trackers", { businessId: biz.json.id, keyword: "coffee shop", gridSize: 5 });
    const bKey = (await b.call("POST", "/api/api-keys", { name: "b" })).json.key as string;
    const res = await mcp(h, bKey, "tools/call", { name: "run_scan", arguments: { trackerId: tracker.json.id, maxCostUsd: 1 } });
    expect(res.json.result.isError).toBe(true);
    expect(res.json.result.content[0].text).toContain("NOT_FOUND");
  });
});

describe("hosted top-ups", () => {
  it("POST /api/admin/credits needs ADMIN_TOKEN, not a user session, and adds credits", async () => {
    const h = await createHarness({ env: { AUTH_MODE: "hosted", BILLING_MODE: "hosted", HOSTED_FREE_CREDITS: "0" } });
    const a = client(h);
    await a.call("POST", "/api/auth/signup", { email: "a@example.com", password: "correct horse battery" });
    const wsId = (await a.call("GET", "/api/me")).json.workspace.id;
    const env = { ADMIN_TOKEN: "s3cret-admin-token" } as Partial<Env>;
    const admin = client(h, env);
    expect((await admin.call("POST", "/api/admin/credits", { workspaceId: wsId, credits: 500 })).status).toBe(401);
    expect((await admin.call("POST", "/api/admin/credits", { workspaceId: wsId, credits: 500 }, { authorization: "Bearer wrong" })).status).toBe(401);
    // unset token disables the endpoint entirely
    expect((await a.call("POST", "/api/admin/credits", { workspaceId: wsId, credits: 500 }, { authorization: "Bearer undefined" })).status).toBe(401);
    const ok = await admin.call("POST", "/api/admin/credits", { workspaceId: wsId, credits: 500 }, { authorization: "Bearer s3cret-admin-token" });
    expect(ok.status).toBe(200);
    expect((await a.call("GET", "/api/usage")).json.credits.balance).toBe(500);
  });
});
