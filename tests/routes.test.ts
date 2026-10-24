// Route-level guarantees, enumerated from the app itself rather than from a
// list someone has to remember to update:
//  - ordering: no param route is registered before a static sibling it would shadow
//  - guards: every non-public route answers 401 without credentials, admin routes
//    answer 403 to a plain member, and the public list is explicit
//  - tenant isolation: every route with a path parameter has a cross-workspace case
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { at, must } from "@/shared/assert";
import { createApp, apiRoutes } from "@/worker/app";
import { alerts, memberships } from "@/worker/db/schema";
import { findShadowedRoutes, orderRoutes, shadows, type RouteAccess } from "@/worker/routes";
import { createHarness, type Harness } from "./helpers/harness";
import { business, client } from "./helpers/http";

const table = apiRoutes();
const key = (r: { method: string; path: string }) => `${r.method.toUpperCase()} ${r.path}`;
const probePath = (path: string) => path.replace(/:\w+/g, "nonexistent");

describe("route ordering", () => {
  it("detects a param route that would shadow a static sibling", () => {
    expect(shadows({ method: "POST", path: "/api/alerts/:id" }, { method: "POST", path: "/api/alerts/read-all" })).toBe(true);
    expect(shadows({ method: "GET", path: "/api/alerts/:id" }, { method: "POST", path: "/api/alerts/read-all" })).toBe(false);
    expect(shadows({ method: "POST", path: "/api/alerts/read-all" }, { method: "POST", path: "/api/alerts/:id" })).toBe(false);
    expect(shadows({ method: "GET", path: "/api/a/:id/x" }, { method: "GET", path: "/api/a/:id/:other" })).toBe(false);
    expect(shadows({ method: "ALL", path: "/api/*" }, { method: "GET", path: "/api/me" })).toBe(true);
  });

  it("orderRoutes puts literals before params", () => {
    const ordered = orderRoutes([
      { method: "post", path: "/api/admin/:id" },
      { method: "post", path: "/api/admin/credits" },
    ]);
    expect(ordered.map((r) => r.path)).toEqual(["/api/admin/credits", "/api/admin/:id"]);
    expect(findShadowedRoutes(ordered)).toEqual([]);
    expect(findShadowedRoutes([...ordered].reverse())).toHaveLength(1);
  });

  it("the route table has no shadowed routes, and neither does what Hono registered", async () => {
    expect(findShadowedRoutes(table.map((r) => ({ method: r.method.toUpperCase(), path: r.path })))).toEqual([]);
    const h = await createHarness({ env: { AUTH_MODE: "hosted" } });
    const app = createApp({ resolveDeps: () => h.deps });
    const registered = app.routes.filter((r) => r.method !== "ALL").map((r) => ({ method: r.method, path: r.path }));
    expect(registered.length).toBeGreaterThan(table.length / 2);
    expect(findShadowedRoutes(registered)).toEqual([]);
  });

  it("every route Hono serves comes from the table", async () => {
    const h = await createHarness({ env: { AUTH_MODE: "hosted" } });
    const app = createApp({ resolveDeps: () => h.deps });
    const fromTable = new Set(table.map((r) => key(r)));
    // middleware and the /api/* 404 catch-all are registered with method ALL and wildcard paths
    const extra = app.routes.filter((r) => !r.path.includes("*") && !fromTable.has(`${r.method} ${r.path}`));
    expect(extra.map(key)).toEqual([]);
  });
});

/** Routes that need no credentials. Adding one here is a deliberate, reviewed decision. */
const PUBLIC_ROUTES = [
  "GET /api/health",
  "GET /api/config",
  "GET /api/public/reports/:token",
  "GET /api/public/reports/:token/points/:pointId",
  "POST /api/auth/signup",
  "POST /api/auth/login",
  "POST /api/auth/logout",
];

/** Routes that require the admin or owner role. */
const ADMIN_ROUTES = [
  "GET /api/trackers/:id/shares",
  "POST /api/trackers/:id/shares",
  "DELETE /api/shares/:id",
  "POST /api/scans/:id/retry",
  "GET /api/ops/failed-jobs",
  "PUT /api/alert-settings",
  "PUT /api/branding",
  "GET /api/api-keys",
  "POST /api/api-keys",
  "DELETE /api/api-keys/:id",
];

describe("route guards", () => {
  const accessOf = (access: RouteAccess) => table.filter((r) => r.access === access).map(key);

  it("the public and admin lists match the table", () => {
    expect([...accessOf("public")].sort()).toEqual([...PUBLIC_ROUTES].sort());
    expect([...accessOf("admin")].sort()).toEqual([...ADMIN_ROUTES].sort());
    // the two routes with their own credential check
    expect(accessOf("admin_token")).toEqual(["POST /api/admin/credits"]);
    expect(accessOf("api_key")).toEqual(["ALL /mcp"]);
  });

  describe("in hosted mode", () => {
    let h: Harness;
    let member: ReturnType<typeof client>;
    let workspaceA: string;
    beforeEach(async () => {
      h = await createHarness({ env: { AUTH_MODE: "hosted" } });
      const owner = client(h);
      await owner.call("POST", "/api/auth/signup", { email: "owner@example.com", password: "correct horse battery" });
      workspaceA = (await owner.call("GET", "/api/me")).json.workspace.id;
      member = client(h);
      await member.call("POST", "/api/auth/signup", { email: "member@example.com", password: "another long password" });
      const me = (await member.call("GET", "/api/me")).json;
      await h.db.insert(memberships).values({ workspaceId: workspaceA, userId: me.user.id, role: "member" });
    });

    it("answers 401 to every non-public route without credentials", async () => {
      const anonymous = client(h);
      const statuses: Record<string, number> = {};
      for (const route of table.filter((r) => r.access !== "public")) {
        const method = route.method === "all" ? "POST" : route.method.toUpperCase();
        statuses[key(route)] = (await anonymous.call(method, probePath(route.path), method === "GET" ? undefined : {})).status;
      }
      const notGuarded = Object.entries(statuses).filter(([, status]) => status !== 401);
      expect(notGuarded).toEqual([]);
    });

    it("lets the public routes through without credentials", async () => {
      const anonymous = client(h);
      for (const route of table.filter((r) => r.access === "public")) {
        const method = route.method.toUpperCase();
        const res = await anonymous.call(method, probePath(route.path) + (route.path.includes("points") ? "?scan=x" : ""), method === "GET" ? undefined : {});
        expect([route.path, res.status < 500 && res.status !== 401 && res.status !== 403]).toEqual([route.path, true]);
      }
    });

    it("answers 403 to a plain member on every admin route, and never 403 on the others", async () => {
      const asMember = { "x-workspace-id": workspaceA };
      for (const route of table.filter((r) => r.access === "admin" || r.access === "session")) {
        if (route.path === "/api/workspaces") continue; // creating a workspace is not workspace-scoped
        const method = route.method.toUpperCase();
        const res = await member.call(method, probePath(route.path), method === "GET" ? undefined : {}, asMember);
        const forbidden = res.status === 403;
        expect([key(route), forbidden]).toEqual([key(route), route.access === "admin"]);
      }
    });
  });
});

// ---- tenant isolation ---------------------------------------------------------

type Fixtures = { businessId: string; trackerId: string; scanId: string; pointId: string; shareId: string; alertId: string; apiKeyId: string };

/** One request per parameterised route: workspace B asks for workspace A's records. Every one must be a 404. */
const CROSS_WORKSPACE: Record<string, (f: Fixtures) => { method: string; path: string; body?: unknown }> = {
  "PATCH /api/businesses/:id": (f) => ({ method: "PATCH", path: `/api/businesses/${f.businessId}`, body: { gbpTracking: false } }),
  "GET /api/businesses/:id/gbp": (f) => ({ method: "GET", path: `/api/businesses/${f.businessId}/gbp` }),
  "POST /api/businesses/:id/gbp/refresh": (f) => ({ method: "POST", path: `/api/businesses/${f.businessId}/gbp/refresh`, body: {} }),
  "GET /api/businesses/:id/reviews": (f) => ({ method: "GET", path: `/api/businesses/${f.businessId}/reviews` }),
  "DELETE /api/businesses/:id": (f) => ({ method: "DELETE", path: `/api/businesses/${f.businessId}` }),
  "GET /api/trackers/:id": (f) => ({ method: "GET", path: `/api/trackers/${f.trackerId}` }),
  "PATCH /api/trackers/:id": (f) => ({ method: "PATCH", path: `/api/trackers/${f.trackerId}`, body: { keyword: "hijacked" } }),
  "DELETE /api/trackers/:id": (f) => ({ method: "DELETE", path: `/api/trackers/${f.trackerId}` }),
  "GET /api/trackers/:id/scans": (f) => ({ method: "GET", path: `/api/trackers/${f.trackerId}/scans` }),
  "POST /api/trackers/:id/scans": (f) => ({ method: "POST", path: `/api/trackers/${f.trackerId}/scans`, body: {} }),
  "GET /api/trackers/:id/shares": (f) => ({ method: "GET", path: `/api/trackers/${f.trackerId}/shares` }),
  "POST /api/trackers/:id/shares": (f) => ({ method: "POST", path: `/api/trackers/${f.trackerId}/shares`, body: { label: "leak" } }),
  "DELETE /api/shares/:id": (f) => ({ method: "DELETE", path: `/api/shares/${f.shareId}` }),
  "GET /api/scans/:id": (f) => ({ method: "GET", path: `/api/scans/${f.scanId}` }),
  "POST /api/scans/:id/retry": (f) => ({ method: "POST", path: `/api/scans/${f.scanId}/retry`, body: {} }),
  "GET /api/scans/:id/points/:pointId": (f) => ({ method: "GET", path: `/api/scans/${f.scanId}/points/${f.pointId}` }),
  "POST /api/alerts/:id/read": (f) => ({ method: "POST", path: `/api/alerts/${f.alertId}/read`, body: {} }),
  "DELETE /api/api-keys/:id": (f) => ({ method: "DELETE", path: `/api/api-keys/${f.apiKeyId}` }),
};

/** Parameterised routes without a cross-workspace case, and why. */
const CROSS_WORKSPACE_EXEMPT: Record<string, string> = {
  "GET /api/public/reports/:token": "authorised by the unguessable share token itself, not by a session (tests/api.test.ts, share links)",
  "GET /api/public/reports/:token/points/:pointId": "same: token-scoped, and the scan must belong to the token's tracker",
};

describe("tenant isolation", () => {
  it("every parameterised route has a cross-workspace case or a documented exemption", () => {
    const parameterised = table.filter((r) => r.path.includes(":")).map(key);
    const uncovered = parameterised.filter((k) => !(k in CROSS_WORKSPACE) && !(k in CROSS_WORKSPACE_EXEMPT));
    expect(uncovered, "add a case to CROSS_WORKSPACE (or a reasoned exemption)").toEqual([]);
    const stale = [...Object.keys(CROSS_WORKSPACE), ...Object.keys(CROSS_WORKSPACE_EXEMPT)].filter((k) => !parameterised.includes(k));
    expect(stale).toEqual([]);
  });

  it("workspace B gets 404 for workspace A's records on every parameterised route, and nothing of A's changes", async () => {
    const h = await createHarness({ env: { AUTH_MODE: "hosted" } });
    const a = client(h);
    const b = client(h);
    await a.call("POST", "/api/auth/signup", { email: "a@example.com", password: "correct horse battery" });
    await b.call("POST", "/api/auth/signup", { email: "b@example.com", password: "another long password" });
    const wsA = (await a.call("GET", "/api/me")).json.workspace.id as string;

    const biz = await a.call("POST", "/api/businesses", business);
    const tracker = await a.call("POST", "/api/trackers", { businessId: biz.json.id, keyword: "coffee shop", gridSize: 3 });
    const run = await a.call("POST", `/api/trackers/${tracker.json.id}/scans`, {});
    await h.queue.drain(h.deps);
    const detail = await a.call("GET", `/api/scans/${run.json.scanId}`);
    const share = await a.call("POST", `/api/trackers/${tracker.json.id}/shares`, { label: "client" });
    const key = await a.call("POST", "/api/api-keys", { name: "ci" });
    await h.db.insert(alerts).values({
      id: "alert-a",
      workspaceId: wsA,
      trackerId: tracker.json.id,
      scanId: run.json.scanId,
      kind: "job_failed",
      severity: "warning",
      metrics: JSON.stringify({ message: "x" }),
    });
    const fixtures: Fixtures = {
      businessId: biz.json.id,
      trackerId: tracker.json.id,
      scanId: run.json.scanId,
      pointId: must(at(detail.json.points as Array<{ id: string }>, 0).id, "a scan point"),
      shareId: share.json.id,
      alertId: "alert-a",
      apiKeyId: key.json.id,
    };

    const results: Record<string, number> = {};
    for (const [routeKey, build] of Object.entries(CROSS_WORKSPACE)) {
      const request = build(fixtures);
      const res = await b.call(request.method, request.path, request.body);
      // Listing shares answers 200 with an empty list rather than 404: no data leaks either way.
      results[routeKey] = routeKey === "GET /api/trackers/:id/shares" && res.status === 200 && res.json.length === 0 ? 404 : res.status;
    }
    expect(Object.fromEntries(Object.entries(results).filter(([, status]) => status !== 404))).toEqual({});

    // ...and A's records are exactly as they were.
    expect((await a.call("GET", `/api/businesses/${fixtures.businessId}/gbp`)).status).toBe(200);
    expect((await a.call("GET", `/api/trackers/${fixtures.trackerId}`)).json.keyword).toBe("coffee shop");
    expect((await a.call("GET", `/api/trackers/${fixtures.trackerId}/scans`)).json).toHaveLength(1);
    expect((await a.call("GET", `/api/trackers/${fixtures.trackerId}/shares`)).json).toHaveLength(1);
    expect((await a.call("GET", "/api/api-keys")).json).toHaveLength(1);
    const [alert] = await h.db.select().from(alerts).where(eq(alerts.id, "alert-a"));
    expect(must(alert, "alert-a").readAt).toBeNull();
  });
});
