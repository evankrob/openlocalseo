import { describe, expect, it, vi } from "vitest";
import { AppError } from "@/shared/errors";
import { DEFAULT_RATE_LIMITS, loadConfig } from "@/worker/config";
import type { RateLimitBinding } from "@/worker/env";
import { BindingRateLimiter, DbRateLimiter, activeBackend, buildRules, enforceRateLimit, type RateRule } from "@/worker/ratelimit";
import { createHarness } from "./helpers/harness";
import { business, client, mcpCall } from "./helpers/http";

const rule: RateRule = { name: "test", limit: 3, windowSeconds: 60 };

/** Harness with the D1/SQLite limiter driven by the virtual clock. */
async function setup(env: Record<string, string> = {}, mode: "local_noauth" | "hosted" = "local_noauth") {
  const h = await createHarness({ env: { AUTH_MODE: mode, ...env } });
  h.deps.rateLimiter = new DbRateLimiter(h.db, () => new Date(h.clock.now));
  return h;
}

describe("DbRateLimiter (fixed window)", () => {
  it("allows up to the limit, then blocks with Retry-After until the window ends", async () => {
    const h = await setup();
    const limiter = h.deps.rateLimiter!;
    for (let i = 0; i < 3; i++) expect(await limiter.check(rule, "ip-1")).toEqual({ ok: true });
    const blocked = await limiter.check(rule, "ip-1");
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(60);
      // Resets when that window is over, not before.
      h.clock.now += (blocked.retryAfterSeconds - 1) * 1000;
      expect((await limiter.check(rule, "ip-1")).ok).toBe(false);
      h.clock.now += 1000;
      expect(await limiter.check(rule, "ip-1")).toEqual({ ok: true });
    }
  });

  it("keeps subjects and rules apart", async () => {
    const h = await setup();
    const limiter = h.deps.rateLimiter!;
    for (let i = 0; i < 4; i++) await limiter.check(rule, "ip-1");
    expect((await limiter.check(rule, "ip-1")).ok).toBe(false);
    expect(await limiter.check(rule, "ip-2")).toEqual({ ok: true });
    expect(await limiter.check({ ...rule, name: "other" }, "ip-1")).toEqual({ ok: true });
  });

  it("gives each window its own count", async () => {
    const h = await setup();
    const limiter = h.deps.rateLimiter!;
    const hourly: RateRule = { name: "hourly", limit: 1, windowSeconds: 3600 };
    expect(await limiter.check(hourly, "w")).toEqual({ ok: true });
    expect((await limiter.check(hourly, "w")).ok).toBe(false);
    h.clock.now += 3600 * 1000;
    expect(await limiter.check(hourly, "w")).toEqual({ ok: true });
  });
});

describe("BindingRateLimiter", () => {
  const perMinute: RateRule = { ...rule, binding: "RL_AUTH" };

  it("uses the Workers binding for a rule that has one, and never touches D1", async () => {
    const h = await setup();
    const keys: string[] = [];
    const binding: RateLimitBinding = { limit: async ({ key }) => (keys.push(key), { success: keys.length <= 1 }) };
    const limiter = new BindingRateLimiter({ RL_AUTH: binding }, h.deps.rateLimiter!);
    expect(await limiter.check(perMinute, "1.2.3.4")).toEqual({ ok: true });
    expect(await limiter.check(perMinute, "1.2.3.4")).toEqual({ ok: false, retryAfterSeconds: 60 });
    expect(keys).toEqual(["test:1.2.3.4", "test:1.2.3.4"]);
    const { rateLimits } = await import("@/worker/db/schema");
    expect(await h.db.select().from(rateLimits)).toEqual([]);
  });

  it("falls back to D1 without the binding, and for rules that have none (hourly)", async () => {
    const h = await setup();
    const limiter = new BindingRateLimiter({ RL_AUTH: { limit: async () => ({ success: true }) } }, h.deps.rateLimiter!);
    const hourly: RateRule = { name: "hourly", limit: 1, windowSeconds: 3600 };
    await limiter.check(hourly, "w");
    expect((await limiter.check(hourly, "w")).ok).toBe(false);
    const bare = new BindingRateLimiter({}, h.deps.rateLimiter!);
    for (let i = 0; i < 3; i++) await bare.check(perMinute, "ip");
    expect((await bare.check(perMinute, "ip")).ok).toBe(false);
  });

  it("reports which backend is active", () => {
    const binding: RateLimitBinding = { limit: async () => ({ success: true }) };
    const rules = buildRules(DEFAULT_RATE_LIMITS);
    expect(activeBackend({ RL_AUTH: binding }, rules.authMinute!)).toBe("binding");
    expect(activeBackend({}, rules.authMinute!)).toBe("d1");
    expect(activeBackend({ RL_AUTH: binding }, rules.authHour!)).toBe("d1");
  });
});

describe("enforceRateLimit and config", () => {
  it("throws RATE_LIMITED carrying retryAfterSeconds, and is a no-op without a limiter or rule", async () => {
    const h = await setup();
    const limiter = h.deps.rateLimiter!;
    for (let i = 0; i < 3; i++) await enforceRateLimit(limiter, rule, "s");
    const error = await enforceRateLimit(limiter, rule, "s").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("RATE_LIMITED");
    expect(Number((error as AppError).details?.retryAfterSeconds)).toBeGreaterThan(0);
    await expect(enforceRateLimit(undefined, rule, "s")).resolves.toBeUndefined();
    await expect(enforceRateLimit(limiter, null, "s")).resolves.toBeUndefined();
  });

  it("fails open (and logs) when the limiter itself breaks", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = { check: async () => Promise.reject(new Error("D1 down")) };
    await expect(enforceRateLimit(broken, rule, "s")).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledWith("ratelimit.error", expect.objectContaining({ rule: "test" }));
  });

  it("has sane defaults, reads overrides, ignores junk and turns a rule off with 0", () => {
    expect(loadConfig({}).rateLimits).toEqual(DEFAULT_RATE_LIMITS);
    expect(DEFAULT_RATE_LIMITS).toMatchObject({ authPerMin: 10, authPerHour: 30, publicReportPerMin: 60, scansPerHour: 30, apiKeyPerMin: 600 });
    const config = loadConfig({ RATE_LIMIT_AUTH_PER_MIN: "5", RATE_LIMIT_SCANS_PER_HOUR: "abc", RATE_LIMIT_API_KEY_PER_MIN: "-1", RATE_LIMIT_AUTH_PER_HOUR: "0" });
    expect(config.rateLimits).toMatchObject({ authPerMin: 5, scansPerHour: 30, apiKeyPerMin: 600, authPerHour: 0 });
    expect(buildRules(config.rateLimits).authHour).toBeNull();
  });
});

const signupBody = (n: number) => ({ email: `u${n}@example.com`, password: "correct horse battery" });

describe("HTTP: 429 shape and scoping", () => {
  it("signup/login: per IP, 429 with Retry-After and the error body, other IPs unaffected, resets", async () => {
    const h = await setup({ RATE_LIMIT_AUTH_PER_MIN: "2" }, "hosted");
    const call = (ip: string, path: string, body: unknown) => client(h, {}, { "cf-connecting-ip": ip }).call("POST", path, body);
    expect((await call("1.1.1.1", "/api/auth/signup", signupBody(1))).status).toBe(201);
    expect((await call("1.1.1.1", "/api/auth/login", { email: "u1@example.com", password: "correct horse battery" })).status).toBe(200);

    const blocked = await call("1.1.1.1", "/api/auth/signup", signupBody(2));
    expect(blocked.status).toBe(429);
    expect(blocked.json.error).toMatchObject({ code: "RATE_LIMITED" });
    const retryAfter = Number(blocked.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(blocked.json.error.retryAfterSeconds).toBe(retryAfter);
    // The login endpoint shares the IP's counter.
    expect((await call("1.1.1.1", "/api/auth/login", { email: "u1@example.com", password: "correct horse battery" })).status).toBe(429);

    expect((await call("2.2.2.2", "/api/auth/signup", signupBody(3))).status).toBe(201);
    h.clock.now += retryAfter * 1000;
    expect((await call("1.1.1.1", "/api/auth/signup", signupBody(4))).status).toBe(201);
  });

  it("login: per email across IPs (case-insensitive)", async () => {
    const h = await setup({ RATE_LIMIT_LOGIN_EMAIL_PER_HOUR: "2" }, "hosted");
    await client(h).call("POST", "/api/auth/signup", signupBody(1));
    const login = (ip: string, email: string, password = "wrong wrong wrong") =>
      client(h, {}, { "cf-connecting-ip": ip }).call("POST", "/api/auth/login", { email, password });
    expect((await login("1.1.1.1", "u1@example.com")).status).toBe(401);
    expect((await login("2.2.2.2", "U1@Example.com")).status).toBe(401);
    const blocked = await login("3.3.3.3", "u1@example.com", "correct horse battery");
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    // Another account is untouched.
    expect((await login("3.3.3.3", "nobody@example.com")).status).toBe(401);
  });

  it("public reports: per IP", async () => {
    const h = await setup({ RATE_LIMIT_PUBLIC_REPORT_PER_MIN: "2" });
    const get = (ip: string, path = "/api/public/reports/olseo_r_nope") => client(h, {}, { "cf-connecting-ip": ip }).call("GET", path);
    expect((await get("9.9.9.9")).status).toBe(404);
    expect((await get("9.9.9.9", "/api/public/reports/olseo_r_nope/points/x?scan=y")).status).toBe(404);
    const blocked = await get("9.9.9.9");
    expect(blocked.status).toBe(429);
    expect(blocked.json.error.code).toBe("RATE_LIMITED");
    expect((await get("8.8.8.8")).status).toBe(404);
  });

  it("scan creation: per workspace, covering manual scans and the GBP refresh; MCP run_scan too", async () => {
    const h = await setup({ RATE_LIMIT_SCANS_PER_HOUR: "2" }, "hosted");
    const a = client(h);
    const b = client(h);
    await a.call("POST", "/api/auth/signup", signupBody(1));
    await b.call("POST", "/api/auth/signup", signupBody(2));
    const biz = await a.call("POST", "/api/businesses", business);
    const tracker = await a.call("POST", "/api/trackers", { businessId: biz.json.id, keyword: "coffee shop", gridSize: 5 });
    const run = () => a.call("POST", `/api/trackers/${tracker.json.id}/scans`, {});

    expect((await run()).status).toBe(202);
    // Second counts too (and is refused for the running scan), the third is rate limited.
    expect((await run()).status).toBe(409);
    const blocked = await run();
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).not.toBeNull();
    expect((await a.call("POST", `/api/businesses/${biz.json.id}/gbp/refresh`, {})).status).toBe(429);
    const key = (await a.call("POST", "/api/api-keys", { name: "k" })).json.key as string;
    const viaMcp = await mcpCall(h, key, "tools/call", { name: "run_scan", arguments: { trackerId: tracker.json.id, maxCostUsd: 1 } });
    expect(viaMcp.json.result.isError).toBe(true);
    expect(viaMcp.json.result.content[0].text).toContain("RATE_LIMITED");

    // Workspace B has its own budget.
    const bBiz = await b.call("POST", "/api/businesses", business);
    const bTracker = await b.call("POST", "/api/trackers", { businessId: bBiz.json.id, keyword: "coffee shop", gridSize: 5 });
    expect((await b.call("POST", `/api/trackers/${bTracker.json.id}/scans`, {})).status).toBe(202);

    h.clock.now += 3600 * 1000;
    h.queue.messages.length = 0;
    expect((await a.call("POST", `/api/businesses/${biz.json.id}/gbp/refresh`, {})).status).not.toBe(429);
  });

  it("API keys: per key on /api and /mcp, never on sessions", async () => {
    const h = await setup({ RATE_LIMIT_API_KEY_PER_MIN: "3" });
    const c = client(h);
    const key1 = (await c.call("POST", "/api/api-keys", { name: "one" })).json.key as string;
    const key2 = (await c.call("POST", "/api/api-keys", { name: "two" })).json.key as string;
    const withKey = (key: string) => client(h).call("GET", "/api/trackers", undefined, { authorization: `Bearer ${key}` });
    for (let i = 0; i < 3; i++) expect((await withKey(key1)).status).toBe(200);
    const blocked = await withKey(key1);
    expect(blocked.status).toBe(429);
    expect(blocked.json.error.code).toBe("RATE_LIMITED");
    expect((await mcpCall(h, key1, "tools/list")).status).toBe(429);
    expect((await withKey(key2)).status).toBe(200);
    for (let i = 0; i < 6; i++) expect((await c.call("GET", "/api/trackers")).status).toBe(200);
    h.clock.now += 60 * 1000;
    expect((await withKey(key1)).status).toBe(200);
  });

  it("limits stay off when no limiter is wired (queue consumer, other tests)", async () => {
    const h = await createHarness({ env: { AUTH_MODE: "local_noauth", RATE_LIMIT_API_KEY_PER_MIN: "1" } });
    const c = client(h);
    const key = (await c.call("POST", "/api/api-keys", { name: "k" })).json.key as string;
    for (let i = 0; i < 3; i++) expect((await client(h).call("GET", "/api/trackers", undefined, { authorization: `Bearer ${key}` })).status).toBe(200);
  });
});
