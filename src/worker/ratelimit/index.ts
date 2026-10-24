// Rate limiting. Two backends behind one interface:
//   1. Workers Rate Limiting bindings (RL_AUTH, RL_PUBLIC, RL_API_KEY in
//      wrangler.jsonc) for the high-volume per-minute rules. A binding has its
//      own fixed limit/period, so those numbers come from wrangler.jsonc and
//      the RATE_LIMIT_* env vars are ignored for them.
//   2. A D1 fixed-window counter (rate_limits table) for everything else, and
//      for the per-minute rules whenever their binding is absent (local dev,
//      tests). Hourly rules always use D1: bindings only count 10s/60s windows.
// Limiter errors fail open (logged): a broken limiter must not take the API down.
import { sql } from "drizzle-orm";
import { must } from "@/shared/assert";
import { AppError } from "@/shared/errors";
import type { RateLimitConfig } from "../config";
import type { Db } from "../db";
import { rateLimits } from "../db/schema";
import type { Env } from "../env";

export type RateRule = {
  /** Namespaces the counter key; also the rule's name in logs. */
  name: string;
  limit: number;
  windowSeconds: number;
  /** Workers binding that enforces this rule when present (per-minute rules only). */
  binding?: "RL_AUTH" | "RL_PUBLIC" | "RL_API_KEY";
};

export type RateDecision = { ok: true } | { ok: false; retryAfterSeconds: number };

export interface RateLimiter {
  /** Counts one request for `subject` (an IP, workspace id, key id, email) against the rule. */
  check(rule: RateRule, subject: string): Promise<RateDecision>;
}

const MINUTE = 60;
const HOUR = 3600;

/** The rules, with limits from config. A limit of 0 turns the rule off (null). */
export function buildRules(limits: RateLimitConfig) {
  const rule = (r: RateRule): RateRule | null => (r.limit > 0 ? r : null);
  return {
    authMinute: rule({ name: "auth_min", limit: limits.authPerMin, windowSeconds: MINUTE, binding: "RL_AUTH" }),
    authHour: rule({ name: "auth_hour", limit: limits.authPerHour, windowSeconds: HOUR }),
    loginEmail: rule({ name: "login_email_hour", limit: limits.loginEmailPerHour, windowSeconds: HOUR }),
    publicReport: rule({ name: "public_report_min", limit: limits.publicReportPerMin, windowSeconds: MINUTE, binding: "RL_PUBLIC" }),
    scans: rule({ name: "scans_hour", limit: limits.scansPerHour, windowSeconds: HOUR }),
    apiKey: rule({ name: "api_key_min", limit: limits.apiKeyPerMin, windowSeconds: MINUTE, binding: "RL_API_KEY" }),
  };
}

/** D1 / SQLite fixed-window counter. One upsert per check. */
export class DbRateLimiter implements RateLimiter {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async check(rule: RateRule, subject: string): Promise<RateDecision> {
    const nowSeconds = Math.floor(this.now().getTime() / 1000);
    const windowStart = nowSeconds - (nowSeconds % rule.windowSeconds);
    const [row] = await this.db
      .insert(rateLimits)
      .values({ key: `${rule.name}:${subject}`, windowStart, count: 1 })
      .onConflictDoUpdate({ target: [rateLimits.key, rateLimits.windowStart], set: { count: sql`${rateLimits.count} + 1` } })
      .returning({ count: rateLimits.count });
    if (must(row, "rate limit upsert returns a row").count <= rule.limit) return { ok: true };
    return { ok: false, retryAfterSeconds: Math.max(1, windowStart + rule.windowSeconds - nowSeconds) };
  }
}

/** Uses a rule's Workers binding when it is bound, else the fallback. */
export class BindingRateLimiter implements RateLimiter {
  constructor(
    private readonly bindings: Pick<Partial<Env>, "RL_AUTH" | "RL_PUBLIC" | "RL_API_KEY">,
    private readonly fallback: RateLimiter,
  ) {}

  async check(rule: RateRule, subject: string): Promise<RateDecision> {
    const binding = rule.binding ? this.bindings[rule.binding] : undefined;
    if (!binding) return this.fallback.check(rule, subject);
    const { success } = await binding.limit({ key: `${rule.name}:${subject}` });
    // The binding does not say when its window ends; the period is the upper bound.
    return success ? { ok: true } : { ok: false, retryAfterSeconds: rule.windowSeconds };
  }
}

export function createRateLimiter(options: { db: Db; env: Partial<Env>; now?: () => Date }): RateLimiter {
  return new BindingRateLimiter(options.env, new DbRateLimiter(options.db, options.now));
}

/** Which backend serves a rule, for the README / logs. */
export function activeBackend(env: Partial<Env>, rule: RateRule): "binding" | "d1" {
  return rule.binding && env[rule.binding] ? "binding" : "d1";
}

type LimitDeps = { rateLimiter?: RateLimiter; config: { rateLimits: RateLimitConfig } };

/** Per workspace: starting scans / profile refreshes costs money, so cap how often. */
export const throttleScans = (deps: LimitDeps, workspaceId: string) =>
  enforceRateLimit(deps.rateLimiter, buildRules(deps.config.rateLimits).scans, workspaceId);

/** Per API key, for every request made with one. No-op for sessions and Access users. */
export const throttleApiKey = (deps: LimitDeps, auth: { apiKeyId?: string }) =>
  auth.apiKeyId ? enforceRateLimit(deps.rateLimiter, buildRules(deps.config.rateLimits).apiKey, auth.apiKeyId) : Promise.resolve();

/**
 * Counts one request and throws RATE_LIMITED (HTTP 429 + Retry-After) when the
 * subject is over the rule. No limiter or a null rule = no limiting.
 */
export async function enforceRateLimit(limiter: RateLimiter | undefined, rule: RateRule | null, subject: string): Promise<void> {
  if (!limiter || !rule) return;
  let decision: RateDecision;
  try {
    decision = await limiter.check(rule, subject);
  } catch (error) {
    console.error("ratelimit.error", { rule: rule.name, message: error instanceof Error ? error.message : "unknown error" });
    return;
  }
  if (!decision.ok) {
    throw new AppError("RATE_LIMITED", "Too many requests. Try again shortly.", { retryAfterSeconds: String(decision.retryAfterSeconds) });
  }
}
