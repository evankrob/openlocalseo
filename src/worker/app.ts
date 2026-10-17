import { nominatimGeocoder } from "./geocode";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { JWTVerifyGetKey } from "jose";
import { ZodError, z, type ZodType } from "zod";
import { ERROR_STATUS, AppError, type ErrorCode } from "@/shared/errors";
import { brandingSchema, businessInputSchema, shareInputSchema, trackerInputSchema, trackerPatchSchema } from "@/shared/schemas";
import { QUEUE_MODES } from "@/shared/pricing";
import { SESSION_COOKIE, createSession, createWorkspace, deleteSession, listWorkspaces, logIn, signUp, type AuthContext } from "./auth/accounts";
import { createApiKey, listApiKeys, revokeApiKey } from "./auth/apikeys";
import { authenticate, requireRole } from "./auth/middleware";
import { grantCredits } from "./billing/credits";
import { getUsageSummary } from "./billing/usage";
import { archiveBusiness, archiveTracker, createBusiness, resolveBusinessInput,
  createTracker, getTracker, listBusinesses, updateTracker } from "./catalog";
import { loadConfig } from "./config";
import { createDb } from "./db";
import { createDataForSeo } from "./dataforseo";
import type { Env } from "./env";
import { handleMcpRequest } from "./mcp/server";
import { createShare, getBranding, getPublicPointResults, getPublicReport, listShares, revokeShare, saveBranding } from "./reports";
import type { ProcessDeps } from "./scans/process";
import { getPointResults, getScanDetail, listTrackerScans, listTrackerSummaries, listWorkspaceScans } from "./scans/queries";
import { createScan, quoteScan } from "./scans/service";

type Variables = { deps: ProcessDeps; auth: AuthContext };
export type AppOptions = {
  /** Builds the per-request dependencies. Tests inject libsql + a fake queue. */
  resolveDeps?: (env: Env) => ProcessDeps;
  accessKeys?: JWTVerifyGetKey;
};

/** Production wiring: D1, the Queue binding, R2 and the configured provider. */
export function defaultResolveDeps(env: Env): ProcessDeps {
  return {
    db: createDb(env.DB),
    queue: {
      send: async (job, options) => void (await env.SCAN_QUEUE.send(job, options)),
      sendBatch: async (jobs) => void (await env.SCAN_QUEUE.sendBatch(jobs.map((j) => ({ body: j.body, delaySeconds: j.delaySeconds })))),
    },
    config: loadConfig(env),
    provider: createDataForSeo(env),
    raw: { put: async (key, body) => void (await env.R2.put(key, body, { httpMetadata: { contentType: "application/json" } })) },
  };
}

async function body<T>(c: { req: { json: () => Promise<unknown> } }, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new AppError("VALIDATION_ERROR", "Request body must be JSON");
  }
  return schema.parse(raw);
}

export function createApp(options: AppOptions = {}) {
  const resolve = options.resolveDeps ?? defaultResolveDeps;
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();

  app.onError((error, c) => {
    if (error instanceof ZodError) {
      const message = error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
      return c.json({ error: { code: "VALIDATION_ERROR", message } }, 400);
    }
    if (error instanceof AppError) {
      return c.json({ error: { code: error.code, message: error.message } }, ERROR_STATUS[error.code] as 400);
    }
    console.error("unhandled", error);
    return c.json({ error: { code: "INTERNAL_ERROR" satisfies ErrorCode, message: "Something went wrong" } }, 500);
  });

  app.use("*", async (c, next) => {
    c.set("deps", resolve(c.env));
    await next();
  });

  // ---- public ----------------------------------------------------------------
  app.get("/api/health", (c) => c.json({ ok: true }));
  app.get("/api/config", (c) => {
    const { config, provider } = c.get("deps");
    return c.json({ authMode: config.authMode, billingMode: config.billingMode, dataMode: provider.mode, markup: config.markup });
  });

  app.get("/api/public/reports/:token", async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(await getPublicReport(c.get("deps").db, c.req.param("token"), { scanId: c.req.query("scan") }));
  });
  app.get("/api/public/reports/:token/points/:pointId", async (c) => {
    c.header("Cache-Control", "no-store");
    const scanId = c.req.query("scan");
    if (!scanId) throw new AppError("VALIDATION_ERROR", "scan is required");
    return c.json(await getPublicPointResults(c.get("deps").db, c.req.param("token"), scanId, c.req.param("pointId")));
  });

  // ---- hosted accounts ---------------------------------------------------------
  const hostedOnly = (deps: ProcessDeps) => {
    if (deps.config.authMode !== "hosted") throw new AppError("NOT_FOUND", "Not available in this auth mode");
  };
  const startSession = async (c: Parameters<typeof setCookie>[0], db: ProcessDeps["db"], userId: string) => {
    const { token, expires } = await createSession(db, userId);
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "Lax",
      secure: new URL(c.req.url).protocol === "https:",
      path: "/",
      expires,
    });
  };
  app.post("/api/auth/signup", async (c) => {
    const deps = c.get("deps");
    hostedOnly(deps);
    const input = await body(c, z.object({ email: z.string(), password: z.string(), name: z.string().max(80).optional() }));
    const { userId } = await signUp(deps.db, input, deps.config.billingMode === "hosted" ? deps.config.hostedFreeCredits : 0);
    await startSession(c, deps.db, userId);
    return c.json({ ok: true }, 201);
  });
  app.post("/api/auth/login", async (c) => {
    const deps = c.get("deps");
    hostedOnly(deps);
    const input = await body(c, z.object({ email: z.string(), password: z.string() }));
    const user = await logIn(deps.db, input.email, input.password);
    await startSession(c, deps.db, user.id);
    return c.json({ ok: true });
  });
  app.post("/api/auth/logout", async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await deleteSession(c.get("deps").db, token);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  // ---- MCP (API key only) --------------------------------------------------------
  app.all("/mcp", async (c) => {
    const deps = c.get("deps");
    const header = c.req.header("authorization");
    if (!header?.toLowerCase().startsWith("bearer ")) throw new AppError("UNAUTHENTICATED", "Send your API key as a Bearer token");
    const auth = await authenticate(c, { db: deps.db, config: deps.config, env: c.env });
    return handleMcpRequest(c.req.raw, { auth, deps, baseUrl: new URL(c.req.url).origin });
  });

  // ---- hosted top-ups (registered before the authenticated router so user auth does not apply)
  // Hosted top-ups until a payment provider is wired in (next step). Guarded by ADMIN_TOKEN.
  app.post("/api/admin/credits", async (c) => {
    const expected = c.env.ADMIN_TOKEN;
    const given = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (!expected || !given || !timingSafeEqual(given, expected)) throw new AppError("UNAUTHENTICATED", "Invalid admin token");
    const input = await body(c, z.object({ workspaceId: z.string(), credits: z.number().int().positive() }));
    await grantCredits(c.get("deps").db, input.workspaceId, input.credits, "topup");
    return c.json({ ok: true });
  });

  // ---- authenticated API -----------------------------------------------------------
  const api = new Hono<{ Bindings: Env; Variables: Variables }>();
  api.use("*", async (c, next) => {
    const deps = c.get("deps");
    c.set("auth", await authenticate(c, { db: deps.db, config: deps.config, env: c.env, accessKeys: options.accessKeys }));
    await next();
  });

  api.get("/me", async (c) => {
    const { db, config, provider } = c.get("deps");
    const auth = c.get("auth");
    const all = await listWorkspaces(db, auth.userId);
    return c.json({
      user: { id: auth.userId, email: auth.email },
      workspace: all.find((w) => w.id === auth.workspaceId),
      workspaces: all,
      config: { authMode: config.authMode, billingMode: config.billingMode, dataMode: provider.mode, markup: config.markup },
    });
  });

  api.post("/workspaces", async (c) => {
    const deps = c.get("deps");
    hostedOnly(deps);
    const { name } = await body(c, z.object({ name: z.string().trim().min(1).max(80) }));
    return c.json(await createWorkspace(deps.db, c.get("auth").userId, name, deps.config.billingMode === "hosted" ? deps.config.hostedFreeCredits : 0), 201);
  });

  // businesses
  api.get("/businesses", async (c) => c.json(await listBusinesses(c.get("deps").db, c.get("auth").workspaceId)));
  api.post("/businesses", async (c) => {
    const deps = c.get("deps");
    const input = await resolveBusinessInput(await body(c, businessInputSchema), deps.provider, deps.geocode ?? nominatimGeocoder);
    return c.json(await createBusiness(deps.db, c.get("auth").workspaceId, input), 201);
  });
  api.delete("/businesses/:id", async (c) => {
    await archiveBusiness(c.get("deps").db, c.get("auth").workspaceId, c.req.param("id"));
    return c.json({ ok: true });
  });

  // trackers
  api.get("/trackers", async (c) => c.json(await listTrackerSummaries(c.get("deps").db, c.get("auth").workspaceId)));
  api.post("/trackers", async (c) =>
    c.json(await createTracker(c.get("deps").db, c.get("auth").workspaceId, await body(c, trackerInputSchema)), 201),
  );
  api.post("/estimate", async (c) => {
    const input = await body(c, z.object({ gridSize: z.number().int().min(3).max(13), queueMode: z.enum(QUEUE_MODES) }));
    const { config } = c.get("deps");
    return c.json(quoteScan(config, input.gridSize, input.queueMode));
  });
  api.get("/trackers/:id", async (c) => {
    const { db } = c.get("deps");
    const auth = c.get("auth");
    const tracker = await getTracker(db, auth.workspaceId, c.req.param("id"));
    const summary = (await listTrackerSummaries(db, auth.workspaceId)).find((t) => t.id === tracker.id);
    return c.json(summary);
  });
  api.patch("/trackers/:id", async (c) =>
    c.json(await updateTracker(c.get("deps").db, c.get("auth").workspaceId, c.req.param("id"), await body(c, trackerPatchSchema))),
  );
  api.delete("/trackers/:id", async (c) => {
    await archiveTracker(c.get("deps").db, c.get("auth").workspaceId, c.req.param("id"));
    return c.json({ ok: true });
  });
  api.get("/trackers/:id/scans", async (c) => {
    const auth = c.get("auth");
    await getTracker(c.get("deps").db, auth.workspaceId, c.req.param("id"));
    return c.json(await listTrackerScans(c.get("deps").db, auth.workspaceId, c.req.param("id")));
  });
  api.post("/trackers/:id/scans", async (c) => {
    const raw = await c.req.json().catch(() => ({}));
    const input = z.object({ maxCostUsd: z.number().positive().optional() }).parse(raw);
    const result = await createScan(c.get("deps"), c.get("auth").workspaceId, c.req.param("id"), { trigger: "manual", maxCostUsd: input.maxCostUsd });
    return c.json(result, 202);
  });
  api.get("/trackers/:id/shares", async (c) => {
    const auth = c.get("auth");
    requireRole(auth, "admin");
    return c.json(await listShares(c.get("deps").db, auth.workspaceId, c.req.param("id")));
  });
  api.post("/trackers/:id/shares", async (c) => {
    const auth = c.get("auth");
    requireRole(auth, "admin");
    const created = await createShare(c.get("deps").db, auth.workspaceId, c.req.param("id"), await body(c, shareInputSchema));
    return c.json({ id: created.id, token: created.token, url: `${new URL(c.req.url).origin}/r/${created.token}` }, 201);
  });
  api.delete("/shares/:id", async (c) => {
    const auth = c.get("auth");
    requireRole(auth, "admin");
    await revokeShare(c.get("deps").db, auth.workspaceId, c.req.param("id"));
    return c.json({ ok: true });
  });

  // scans
  api.get("/scans", async (c) =>
    c.json(await listWorkspaceScans(c.get("deps").db, c.get("auth").workspaceId, { limit: Number(c.req.query("limit")) || 20 })),
  );
  api.get("/scans/:id", async (c) => c.json(await getScanDetail(c.get("deps").db, c.req.param("id"), { workspaceId: c.get("auth").workspaceId })));
  api.get("/scans/:id/points/:pointId", async (c) =>
    c.json(await getPointResults(c.get("deps").db, c.req.param("id"), c.req.param("pointId"), { workspaceId: c.get("auth").workspaceId })),
  );

  // settings
  api.get("/branding", async (c) => c.json(await getBranding(c.get("deps").db, c.get("auth").workspaceId)));
  api.put("/branding", async (c) => {
    const auth = c.get("auth");
    requireRole(auth, "admin");
    return c.json(await saveBranding(c.get("deps").db, auth.workspaceId, await body(c, brandingSchema)));
  });
  api.get("/api-keys", async (c) => {
    requireRole(c.get("auth"), "admin");
    return c.json(await listApiKeys(c.get("deps").db, c.get("auth").workspaceId));
  });
  api.post("/api-keys", async (c) => {
    const auth = c.get("auth");
    requireRole(auth, "admin");
    const { name } = await body(c, z.object({ name: z.string().trim().min(1).max(80) }));
    return c.json(await createApiKey(c.get("deps").db, auth.workspaceId, auth.userId, name), 201);
  });
  api.delete("/api-keys/:id", async (c) => {
    const auth = c.get("auth");
    requireRole(auth, "admin");
    if (!(await revokeApiKey(c.get("deps").db, auth.workspaceId, c.req.param("id")))) throw new AppError("NOT_FOUND", "API key not found");
    return c.json({ ok: true });
  });
  api.get("/usage", async (c) => {
    const { db, config } = c.get("deps");
    return c.json(await getUsageSummary(db, c.get("auth").workspaceId, config.billingMode));
  });

  app.route("/api", api);

  // Anything under /api that did not match.
  app.all("/api/*", (c) => c.json({ error: { code: "NOT_FOUND", message: "Not found" } }, 404));
  return app;
}

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
