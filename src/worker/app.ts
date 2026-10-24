import { nominatimGeocoder } from "./geocode";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { JWTVerifyGetKey } from "jose";
import { ZodError, z, type ZodType } from "zod";
import { alertSettingsSchema } from "@/shared/alerts";
import { ERROR_STATUS, AppError, type ErrorCode } from "@/shared/errors";
import { gbpRefreshSchema, reviewsQuerySchema } from "@/shared/gbp";
import { asBusinessId, asScanId, asTrackerId } from "@/shared/ids";
import { brandingSchema, businessInputSchema, businessPatchSchema, shareInputSchema, trackerInputSchema, trackerPatchSchema } from "@/shared/schemas";
import { QUEUE_MODES } from "@/shared/pricing";
import { SESSION_COOKIE, createSession, createWorkspace, deleteSession, listWorkspaces, logIn, signUp, type AuthContext } from "./auth/accounts";
import { createApiKey, listApiKeys, revokeApiKey } from "./auth/apikeys";
import { getAlertSettings, listAlerts, markAlertRead, markAllAlertsRead, saveAlertSettings } from "./alerts";
import { authenticate, requireRole } from "./auth/middleware";
import { grantCredits } from "./billing/credits";
import { getUsageSummary } from "./billing/usage";
import { archiveBusiness, archiveTracker, createBusiness, resolveBusinessInput,
  createTracker, getBusiness, getTracker, listBusinesses, updateTracker } from "./catalog";
import { getGbpOverview, listReviews } from "./gbp/queries";
import { createGbpSnapshot, quoteGbpSnapshot, setGbpTracking } from "./gbp/service";
import { loadConfig } from "./config";
import { createDb } from "./db";
import { createDataForSeo, createScopedDataForSeo } from "./dataforseo";
import type { Env } from "./env";
import { handleMcpRequest } from "./mcp/server";
import { listFailedJobs, retryScan } from "./ops";
import { buildRules, createRateLimiter, enforceRateLimit, throttleApiKey, throttleScans } from "./ratelimit";
import { createWebhookSender } from "./notify";
import { createShare, getBranding, getPublicPointResults, getPublicReport, listShares, revokeShare, saveBranding } from "./reports";
import { orderRoutes, type RouteDef } from "./routes";
import type { ProcessDeps } from "./scans/process";
import { getPointResults, getScanDetail, listTrackerScans, listTrackerSummaries, listWorkspaceScans } from "./scans/queries";
import { createScan, quoteScan } from "./scans/service";

type Variables = { deps: ProcessDeps; auth: AuthContext };
type AppEnv = { Bindings: Env; Variables: Variables };
type Ctx = Context<AppEnv>;
export type AppOptions = {
  /** Builds the per-request dependencies. Tests inject libsql + a fake queue. */
  resolveDeps?: (env: Env) => ProcessDeps;
  accessKeys?: JWTVerifyGetKey;
};

/** Production wiring: D1, the Queue binding, R2 and the configured provider. */
export function defaultResolveDeps(env: Env, ctx?: Pick<ExecutionContext, "waitUntil">): ProcessDeps {
  return {
    db: createDb(env.DB),
    queue: {
      send: async (job, options) => void (await env.SCAN_QUEUE.send(job, options)),
      sendBatch: async (jobs) => void (await env.SCAN_QUEUE.sendBatch(jobs.map((j) => ({ body: j.body, delaySeconds: j.delaySeconds })))),
    },
    config: loadConfig(env),
    provider: createDataForSeo(env),
    scopeProvider: createScopedDataForSeo(env),
    notify: createWebhookSender(),
    rateLimiter: createRateLimiter({ db: createDb(env.DB), env }),
    waitUntil: ctx ? (promise) => ctx.waitUntil(promise) : undefined,
    raw: {
      put: async (key, body) => void (await env.R2.put(key, body, { httpMetadata: { contentType: "application/json" } })),
      deletePrefix: async (prefix, limit) => {
        const { objects } = await env.R2.list({ prefix, limit });
        if (objects.length > 0) await env.R2.delete(objects.map((o) => o.key));
        return objects.length;
      },
    },
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

// Per IP; signup and login share the counters (brute force, account spam).
const authThrottle: MiddlewareHandler<AppEnv> = async (c, next) => {
  const { rateLimiter, config } = c.get("deps");
  const rules = buildRules(config.rateLimits);
  const ip = clientIp(c);
  await enforceRateLimit(rateLimiter, rules.authMinute, ip);
  await enforceRateLimit(rateLimiter, rules.authHour, ip);
  await next();
};

/** A path parameter of the matched route; routing guarantees it is present. */
const param = (c: Ctx, name: string): string => {
  const value = c.req.param(name);
  if (value === undefined) throw new AppError("VALIDATION_ERROR", `Missing ${name}`);
  return value;
};

const maxCostBody = z.object({ maxCostUsd: z.number().positive().optional() });

/** Every route, with its access level. Registration order is derived (see `orderRoutes`). */
export function apiRoutes(): RouteDef<AppEnv>[] {
  const ws = (c: Ctx) => c.get("auth").workspaceId;
  const db = (c: Ctx) => c.get("deps").db;
  return [
    // ---- public --------------------------------------------------------------
    { method: "get", path: "/api/health", access: "public", handler: (c) => c.json({ ok: true }) },
    {
      method: "get",
      path: "/api/config",
      access: "public",
      handler: (c) => {
        const { config, provider } = c.get("deps");
        return c.json({ authMode: config.authMode, billingMode: config.billingMode, dataMode: provider.mode, markup: config.markup });
      },
    },
    {
      method: "get",
      path: "/api/public/reports/:token",
      access: "public",
      handler: async (c) => {
        c.header("Cache-Control", "no-store");
        const { db, config } = c.get("deps");
        return c.json(await getPublicReport(db, param(c, "token"), { scanId: c.req.query("scan"), retentionDays: config.retention.scanResultsDays }));
      },
    },
    {
      method: "get",
      path: "/api/public/reports/:token/points/:pointId",
      access: "public",
      handler: async (c) => {
        c.header("Cache-Control", "no-store");
        const scanId = c.req.query("scan");
        if (!scanId) throw new AppError("VALIDATION_ERROR", "scan is required");
        return c.json(await getPublicPointResults(db(c), param(c, "token"), scanId, param(c, "pointId")));
      },
    },

    // ---- hosted accounts -------------------------------------------------------
    {
      method: "post",
      path: "/api/auth/signup",
      access: "public",
      middleware: [authThrottle],
      handler: async (c) => {
        const deps = c.get("deps");
        hostedOnly(deps);
        const input = await body(c, z.object({ email: z.string(), password: z.string(), name: z.string().max(80).optional() }));
        const { userId } = await signUp(deps.db, input, deps.config.billingMode === "hosted" ? deps.config.hostedFreeCredits : 0);
        await startSession(c, deps.db, userId);
        return c.json({ ok: true }, 201);
      },
    },
    {
      method: "post",
      path: "/api/auth/login",
      access: "public",
      middleware: [authThrottle],
      handler: async (c) => {
        const deps = c.get("deps");
        hostedOnly(deps);
        const input = await body(c, z.object({ email: z.string(), password: z.string() }));
        // Also per account, so spreading guesses over many IPs does not help.
        await enforceRateLimit(deps.rateLimiter, buildRules(deps.config.rateLimits).loginEmail, input.email.trim().toLowerCase());
        const user = await logIn(deps.db, input.email, input.password);
        await startSession(c, deps.db, user.id);
        return c.json({ ok: true });
      },
    },
    {
      method: "post",
      path: "/api/auth/logout",
      access: "public",
      handler: async (c) => {
        const token = getCookie(c, SESSION_COOKIE);
        if (token) await deleteSession(db(c), token);
        deleteCookie(c, SESSION_COOKIE, { path: "/" });
        return c.json({ ok: true });
      },
    },

    // ---- MCP (API key only) ----------------------------------------------------
    {
      method: "all",
      path: "/mcp",
      access: "api_key",
      handler: async (c) => {
        const deps = c.get("deps");
        const header = c.req.header("authorization");
        if (!header?.toLowerCase().startsWith("bearer ")) throw new AppError("UNAUTHENTICATED", "Send your API key as a Bearer token");
        const auth = await authenticate(c, { db: deps.db, config: deps.config, env: c.env });
        await throttleApiKey(deps, auth);
        return handleMcpRequest(c.req.raw, { auth, deps, baseUrl: new URL(c.req.url).origin });
      },
    },

    // ---- hosted top-ups until a payment provider is wired in. Guarded by ADMIN_TOKEN, not a user session.
    {
      method: "post",
      path: "/api/admin/credits",
      access: "admin_token",
      handler: async (c) => {
        const expected = c.env.ADMIN_TOKEN;
        const given = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
        if (!expected || !given || !timingSafeEqual(given, expected)) throw new AppError("UNAUTHENTICATED", "Invalid admin token");
        const input = await body(c, z.object({ workspaceId: z.string(), credits: z.number().int().positive() }));
        await grantCredits(db(c), input.workspaceId, input.credits, "topup");
        return c.json({ ok: true });
      },
    },

    // ---- authenticated API -----------------------------------------------------
    {
      method: "get",
      path: "/api/me",
      access: "session",
      handler: async (c) => {
        const { db, config, provider } = c.get("deps");
        const auth = c.get("auth");
        const all = await listWorkspaces(db, auth.userId);
        return c.json({
          user: { id: auth.userId, email: auth.email },
          workspace: all.find((w) => w.id === auth.workspaceId),
          workspaces: all,
          config: { authMode: config.authMode, billingMode: config.billingMode, dataMode: provider.mode, markup: config.markup },
        });
      },
    },
    {
      method: "post",
      path: "/api/workspaces",
      access: "session",
      handler: async (c) => {
        const deps = c.get("deps");
        hostedOnly(deps);
        const { name } = await body(c, z.object({ name: z.string().trim().min(1).max(80) }));
        return c.json(await createWorkspace(deps.db, c.get("auth").userId, name, deps.config.billingMode === "hosted" ? deps.config.hostedFreeCredits : 0), 201);
      },
    },

    // businesses
    { method: "get", path: "/api/businesses", access: "session", handler: async (c) => c.json(await listBusinesses(db(c), ws(c))) },
    {
      method: "post",
      path: "/api/businesses",
      access: "session",
      handler: async (c) => {
        const deps = c.get("deps");
        const input = await resolveBusinessInput(await body(c, businessInputSchema), deps.provider, deps.geocode ?? nominatimGeocoder);
        return c.json(await createBusiness(deps.db, ws(c), input), 201);
      },
    },
    {
      method: "patch",
      path: "/api/businesses/:id",
      access: "session",
      handler: async (c) => {
        const patch = await body(c, businessPatchSchema);
        // Looked up first so another workspace's business is a 404 even for an empty patch.
        let business = await getBusiness(db(c), ws(c), asBusinessId(param(c, "id")));
        if (patch.gbpTracking !== undefined) {
          business = await setGbpTracking(db(c), ws(c), asBusinessId(business.id), patch.gbpTracking);
        }
        return c.json(business);
      },
    },
    {
      method: "get",
      path: "/api/businesses/:id/gbp",
      access: "session",
      handler: async (c) => {
        const overview = await getGbpOverview(db(c), ws(c), asBusinessId(param(c, "id")));
        const quote = quoteGbpSnapshot(c.get("deps").config);
        // A monthly run is one snapshot a month.
        return c.json({ ...overview, quote, monthlyCostUsd: quote.chargedUsd });
      },
    },
    {
      method: "post",
      path: "/api/businesses/:id/gbp/refresh",
      access: "session",
      handler: async (c) => {
        const raw = await c.req.json().catch(() => ({}));
        const input = gbpRefreshSchema.parse(raw);
        await throttleScans(c.get("deps"), ws(c));
        const result = await createGbpSnapshot(c.get("deps"), ws(c), asBusinessId(param(c, "id")), { trigger: "manual", maxCostUsd: input.maxCostUsd });
        return c.json(result, 202);
      },
    },
    {
      method: "get",
      path: "/api/businesses/:id/reviews",
      access: "session",
      handler: async (c) => {
        const query = reviewsQuerySchema.parse({
          limit: c.req.query("limit"),
          cursor: c.req.query("cursor"),
          unanswered: c.req.query("unanswered"),
        });
        return c.json(
          await listReviews(db(c), ws(c), asBusinessId(param(c, "id")), {
            limit: query.limit,
            cursor: query.cursor,
            unansweredOnly: query.unanswered,
          }),
        );
      },
    },
    {
      method: "delete",
      path: "/api/businesses/:id",
      access: "session",
      handler: async (c) => {
        await archiveBusiness(db(c), ws(c), asBusinessId(param(c, "id")));
        return c.json({ ok: true });
      },
    },

    // trackers
    { method: "get", path: "/api/trackers", access: "session", handler: async (c) => c.json(await listTrackerSummaries(db(c), ws(c))) },
    {
      method: "post",
      path: "/api/trackers",
      access: "session",
      handler: async (c) => c.json(await createTracker(db(c), ws(c), await body(c, trackerInputSchema)), 201),
    },
    {
      method: "post",
      path: "/api/estimate",
      access: "session",
      handler: async (c) => {
        const input = await body(c, z.object({ gridSize: z.number().int().min(3).max(13), queueMode: z.enum(QUEUE_MODES) }));
        return c.json(quoteScan(c.get("deps").config, input.gridSize, input.queueMode));
      },
    },
    {
      method: "get",
      path: "/api/trackers/:id",
      access: "session",
      handler: async (c) => {
        const tracker = await getTracker(db(c), ws(c), asTrackerId(param(c, "id")));
        const summary = (await listTrackerSummaries(db(c), ws(c))).find((t) => t.id === tracker.id);
        return c.json(summary);
      },
    },
    {
      method: "patch",
      path: "/api/trackers/:id",
      access: "session",
      handler: async (c) => c.json(await updateTracker(db(c), ws(c), asTrackerId(param(c, "id")), await body(c, trackerPatchSchema))),
    },
    {
      method: "delete",
      path: "/api/trackers/:id",
      access: "session",
      handler: async (c) => {
        await archiveTracker(db(c), ws(c), asTrackerId(param(c, "id")));
        return c.json({ ok: true });
      },
    },
    {
      method: "get",
      path: "/api/trackers/:id/scans",
      access: "session",
      handler: async (c) => {
        const trackerId = asTrackerId(param(c, "id"));
        await getTracker(db(c), ws(c), trackerId);
        return c.json(await listTrackerScans(db(c), ws(c), trackerId));
      },
    },
    {
      method: "post",
      path: "/api/trackers/:id/scans",
      access: "session",
      handler: async (c) => {
        const raw = await c.req.json().catch(() => ({}));
        const input = maxCostBody.parse(raw);
        await throttleScans(c.get("deps"), ws(c));
        const result = await createScan(c.get("deps"), ws(c), asTrackerId(param(c, "id")), { trigger: "manual", maxCostUsd: input.maxCostUsd });
        return c.json(result, 202);
      },
    },
    {
      method: "get",
      path: "/api/trackers/:id/shares",
      access: "admin",
      handler: async (c) => c.json(await listShares(db(c), ws(c), asTrackerId(param(c, "id")))),
    },
    {
      method: "post",
      path: "/api/trackers/:id/shares",
      access: "admin",
      handler: async (c) => {
        const created = await createShare(db(c), ws(c), asTrackerId(param(c, "id")), await body(c, shareInputSchema));
        return c.json({ id: created.id, token: created.token, url: `${new URL(c.req.url).origin}/r/${created.token}` }, 201);
      },
    },
    {
      method: "delete",
      path: "/api/shares/:id",
      access: "admin",
      handler: async (c) => {
        await revokeShare(db(c), ws(c), param(c, "id"));
        return c.json({ ok: true });
      },
    },

    // scans
    {
      method: "get",
      path: "/api/scans",
      access: "session",
      handler: async (c) => c.json(await listWorkspaceScans(db(c), ws(c), { limit: Number(c.req.query("limit")) || 20 })),
    },
    {
      method: "get",
      path: "/api/scans/:id",
      access: "session",
      handler: async (c) => {
        const { db, config } = c.get("deps");
        const detail = await getScanDetail(db, asScanId(param(c, "id")), { workspaceId: ws(c) });
        return c.json({ ...detail, retentionDays: config.retention.scanResultsDays });
      },
    },
    {
      method: "post",
      path: "/api/scans/:id/retry",
      access: "admin",
      handler: async (c) => {
        const raw = await c.req.json().catch(() => ({}));
        const input = maxCostBody.parse(raw);
        const deps = c.get("deps");
        await throttleScans(deps, ws(c));
        return c.json(await retryScan(deps, ws(c), asScanId(param(c, "id")), { maxCostUsd: input.maxCostUsd }), 202);
      },
    },
    {
      method: "get",
      path: "/api/scans/:id/points/:pointId",
      access: "session",
      handler: async (c) => c.json(await getPointResults(db(c), asScanId(param(c, "id")), param(c, "pointId"), { workspaceId: ws(c) })),
    },

    // operations
    { method: "get", path: "/api/ops/failed-jobs", access: "admin", handler: async (c) => c.json(await listFailedJobs(db(c), ws(c))) },

    // alerts
    {
      method: "get",
      path: "/api/alerts",
      access: "session",
      handler: async (c) => {
        const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).parse({ limit: c.req.query("limit") });
        return c.json(await listAlerts(db(c), ws(c), { limit }));
      },
    },
    {
      method: "post",
      path: "/api/alerts/read-all",
      access: "session",
      handler: async (c) => c.json({ updated: await markAllAlertsRead(db(c), ws(c)) }),
    },
    {
      method: "post",
      path: "/api/alerts/:id/read",
      access: "session",
      handler: async (c) => {
        await markAlertRead(db(c), ws(c), param(c, "id"));
        return c.json({ ok: true });
      },
    },
    {
      method: "get",
      path: "/api/alert-settings",
      access: "session",
      handler: async (c) => {
        const auth = c.get("auth");
        const settings = await getAlertSettings(db(c), auth.workspaceId);
        // The webhook URL is a secret: only admins see it.
        const isAdmin = auth.role !== "member";
        return c.json({ ...settings, webhookConfigured: settings.webhookUrl !== null, webhookUrl: isAdmin ? settings.webhookUrl : null });
      },
    },
    {
      method: "put",
      path: "/api/alert-settings",
      access: "admin",
      handler: async (c) => {
        const saved = await saveAlertSettings(db(c), ws(c), await body(c, alertSettingsSchema));
        return c.json({ ...saved, webhookConfigured: saved.webhookUrl !== null });
      },
    },

    // settings
    { method: "get", path: "/api/branding", access: "session", handler: async (c) => c.json(await getBranding(db(c), ws(c))) },
    {
      method: "put",
      path: "/api/branding",
      access: "admin",
      handler: async (c) => c.json(await saveBranding(db(c), ws(c), await body(c, brandingSchema))),
    },
    { method: "get", path: "/api/api-keys", access: "admin", handler: async (c) => c.json(await listApiKeys(db(c), ws(c))) },
    {
      method: "post",
      path: "/api/api-keys",
      access: "admin",
      handler: async (c) => {
        const { name } = await body(c, z.object({ name: z.string().trim().min(1).max(80) }));
        return c.json(await createApiKey(db(c), ws(c), c.get("auth").userId, name), 201);
      },
    },
    {
      method: "delete",
      path: "/api/api-keys/:id",
      access: "admin",
      handler: async (c) => {
        if (!(await revokeApiKey(db(c), ws(c), param(c, "id")))) throw new AppError("NOT_FOUND", "API key not found");
        return c.json({ ok: true });
      },
    },
    {
      method: "get",
      path: "/api/usage",
      access: "session",
      handler: async (c) => c.json(await getUsageSummary(db(c), ws(c), c.get("deps").config.billingMode)),
    },
  ];
}

export function createApp(options: AppOptions = {}) {
  const resolve = options.resolveDeps ?? defaultResolveDeps;
  const app = new Hono<AppEnv>();

  app.onError((error, c) => {
    if (error instanceof ZodError) {
      const message = error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
      return c.json({ error: { code: "VALIDATION_ERROR", message } }, 400);
    }
    if (error instanceof AppError) {
      if (error.code === "RATE_LIMITED") {
        const retryAfterSeconds = Number(error.details?.retryAfterSeconds) || 60;
        c.header("Retry-After", String(retryAfterSeconds));
        return c.json({ error: { code: error.code, message: error.message, retryAfterSeconds } }, ERROR_STATUS[error.code] as 429);
      }
      return c.json({ error: { code: error.code, message: error.message } }, ERROR_STATUS[error.code] as 400);
    }
    console.error("unhandled", error);
    return c.json({ error: { code: "INTERNAL_ERROR" satisfies ErrorCode, message: "Something went wrong" } }, 500);
  });

  app.use("*", async (c, next) => {
    c.set("deps", resolve(c.env));
    await next();
  });

  // Per IP: the tokens are unguessable, but the links are public and cost D1 reads.
  app.use("/api/public/reports/*", async (c, next) => {
    const { rateLimiter, config } = c.get("deps");
    await enforceRateLimit(rateLimiter, buildRules(config.rateLimits).publicReport, clientIp(c));
    await next();
  });

  // Signed-in routes live on a sub-app behind the authentication middleware,
  // which also covers unknown /api paths (so they answer 401 before 404).
  const api = new Hono<AppEnv>();
  api.use("*", async (c, next) => {
    const deps = c.get("deps");
    const auth = await authenticate(c, { db: deps.db, config: deps.config, env: c.env, accessKeys: options.accessKeys });
    c.set("auth", auth);
    await throttleApiKey(deps, auth);
    await next();
  });
  const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
    requireRole(c.get("auth"), "admin");
    await next();
  };

  for (const route of orderRoutes(apiRoutes())) {
    const signedIn = route.access === "session" || route.access === "admin";
    const before: MiddlewareHandler<AppEnv>[] = [...(route.access === "admin" ? [requireAdmin] : []), ...(route.middleware ?? [])];
    const target = signedIn ? api : app;
    const path = signedIn ? route.path.replace(/^\/api/, "") : route.path;
    for (const middleware of before) target.on(route.method.toUpperCase(), path, middleware);
    target.on(route.method.toUpperCase(), path, route.handler);
  }
  app.route("/api", api);

  // Anything under /api that did not match.
  app.all("/api/*", (c) => c.json({ error: { code: "NOT_FOUND", message: "Not found" } }, 404));
  return app;
}

/** Cloudflare sets cf-connecting-ip; other headers are client-controlled, so they are not trusted. */
function clientIp(c: { req: { header: (name: string) => string | undefined } }): string {
  return c.req.header("cf-connecting-ip") ?? "unknown";
}

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
