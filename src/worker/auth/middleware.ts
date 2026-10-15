import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { JWTVerifyGetKey } from "jose";
import { AppError } from "@/shared/errors";
import type { AppConfig } from "../config";
import type { Db } from "../db";
import type { Env } from "../env";
import { ROLE_RANK, SESSION_COOKIE, ensureSharedWorkspaceMember, getSessionUser, resolveWorkspace, type AuthContext, type Role } from "./accounts";
import { remoteAccessKeys, verifyAccessJwt } from "./access";
import { authenticateApiKey } from "./apikeys";

export type AuthOptions = {
  db: Db;
  config: AppConfig;
  env: Partial<Env>;
  /** Override the Access JWKS (tests). */
  accessKeys?: JWTVerifyGetKey;
};

/** Resolves who is calling and which workspace they act in, per AUTH_MODE. */
export async function authenticate(c: Context, options: AuthOptions): Promise<AuthContext> {
  const { db, config, env } = options;
  const bearer = c.req.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer) {
    const viaKey = await authenticateApiKey(db, bearer);
    if (!viaKey) throw new AppError("UNAUTHENTICATED", "Invalid API key");
    return viaKey;
  }

  if (config.authMode === "local_noauth") {
    // Requests that came through Cloudflare's edge carry cf-connecting-ip;
    // local wrangler/vite dev does not. Refuse so a deployed copy left on the
    // default mode is not open to the internet.
    if (c.req.header("cf-connecting-ip")) {
      throw new AppError(
        "FORBIDDEN",
        "AUTH_MODE=local_noauth is for local development only. Set AUTH_MODE=cloudflare_access (or hosted) before deploying.",
      );
    }
    return ensureSharedWorkspaceMember(db, "admin@localhost");
  }

  if (config.authMode === "cloudflare_access") {
    const token = c.req.header("cf-access-jwt-assertion");
    if (!token) throw new AppError("UNAUTHENTICATED", "Missing Cloudflare Access token");
    if (!env.TEAM_DOMAIN || !env.POLICY_AUD) {
      throw new AppError("INTERNAL_ERROR", "TEAM_DOMAIN and POLICY_AUD must be set when AUTH_MODE=cloudflare_access");
    }
    const { email } = await verifyAccessJwt(token, {
      keys: options.accessKeys ?? remoteAccessKeys(env.TEAM_DOMAIN),
      teamDomain: env.TEAM_DOMAIN,
      audience: env.POLICY_AUD,
    });
    return { ...(await ensureSharedWorkspaceMember(db, email)), via: "access" };
  }

  // hosted: session cookie
  const sessionToken = getCookie(c, SESSION_COOKIE);
  const user = sessionToken ? await getSessionUser(db, sessionToken) : null;
  if (!user) throw new AppError("UNAUTHENTICATED", "Sign in to continue");
  // Cookie-authenticated writes must come from our own origin.
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const origin = c.req.header("origin");
    if (origin && new URL(origin).host !== new URL(c.req.url).host) {
      throw new AppError("FORBIDDEN", "Cross-origin request blocked");
    }
  }
  const workspace = await resolveWorkspace(db, user.id, c.req.header("x-workspace-id"));
  return { userId: user.id, email: user.email, workspaceId: workspace.id, role: workspace.role, via: "session" };
}

export function requireRole(auth: AuthContext, minimum: Role) {
  if (ROLE_RANK[auth.role] < ROLE_RANK[minimum]) {
    throw new AppError("FORBIDDEN", `This needs the ${minimum} role`);
  }
}
