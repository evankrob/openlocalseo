import { DEFAULT_BILLING_MARKUP, type QueueMode } from "@/shared/pricing";
import type { Env } from "./env";

export type AppConfig = {
  authMode: "local_noauth" | "cloudflare_access" | "hosted";
  billingMode: "byok" | "hosted";
  dataMode: "mock" | "live";
  markup: number;
  hostedFreeCredits: number;
  /** Seconds between collection attempts for a queued task, per queue. */
  pollDelaySeconds: Record<Exclude<QueueMode, "live">, number>;
  /** Give up on a queued scan after this long. */
  maxScanSeconds: Record<QueueMode, number>;
  /** Give up on a Google Business Profile reviews task after this long. */
  maxGbpSeconds: number;
  /** Requests allowed per window; 0 = rule off. Defaults in DEFAULT_RATE_LIMITS. */
  rateLimits: RateLimitConfig;
  /** Days to keep prunable rows; 0 = keep forever. */
  retention: RetentionConfig;
};

export type RateLimitConfig = {
  authPerMin: number;
  authPerHour: number;
  loginEmailPerHour: number;
  publicReportPerMin: number;
  scansPerHour: number;
  apiKeyPerMin: number;
};

export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  authPerMin: 10,
  authPerHour: 30,
  loginEmailPerHour: 20,
  publicReportPerMin: 60,
  scansPerHour: 30,
  apiKeyPerMin: 600,
};

export type RetentionConfig = {
  /** scan_results (per-point competitor lists) and their raw R2 archives. */
  scanResultsDays: number;
  apiCallsDays: number;
  rateLimitDays: number;
};

export const DEFAULT_RETENTION: RetentionConfig = { scanResultsDays: 400, apiCallsDays: 180, rateLimitDays: 1 };

/** Whole number >= 0, else the default (blank, negative, fractional or non-numeric values are ignored). */
function count(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

export function loadConfig(env: Partial<Env>): AppConfig {
  const authMode =
    env.AUTH_MODE === "local_noauth" || env.AUTH_MODE === "hosted" ? env.AUTH_MODE : "cloudflare_access";
  const dataMode = env.DATAFORSEO_MODE === "live" ? "live" : "mock";
  const markup = Number(env.BILLING_MARKUP);
  const poll = Number(env.POLL_INTERVAL_SECONDS);
  const hasPoll = env.POLL_INTERVAL_SECONDS !== undefined && Number.isFinite(poll) && poll > 0;
  return {
    authMode,
    billingMode: env.BILLING_MODE === "hosted" ? "hosted" : "byok",
    dataMode,
    markup: Number.isFinite(markup) && markup >= 1 ? markup : DEFAULT_BILLING_MARKUP,
    hostedFreeCredits: Number(env.HOSTED_FREE_CREDITS ?? 100) || 0,
    // Standard queue turnaround is minutes; priority is tens of seconds.
    // The mock answers in seconds, so poll quickly while developing.
    pollDelaySeconds: hasPoll
      ? { standard: poll, priority: poll }
      : dataMode === "mock"
        ? { standard: 5, priority: 3 }
        : { standard: 60, priority: 15 },
    maxScanSeconds: { standard: 3 * 3600, priority: 30 * 60, live: 15 * 60 },
    maxGbpSeconds: 3600,
    rateLimits: {
      authPerMin: count(env.RATE_LIMIT_AUTH_PER_MIN, DEFAULT_RATE_LIMITS.authPerMin),
      authPerHour: count(env.RATE_LIMIT_AUTH_PER_HOUR, DEFAULT_RATE_LIMITS.authPerHour),
      loginEmailPerHour: count(env.RATE_LIMIT_LOGIN_EMAIL_PER_HOUR, DEFAULT_RATE_LIMITS.loginEmailPerHour),
      publicReportPerMin: count(env.RATE_LIMIT_PUBLIC_REPORT_PER_MIN, DEFAULT_RATE_LIMITS.publicReportPerMin),
      scansPerHour: count(env.RATE_LIMIT_SCANS_PER_HOUR, DEFAULT_RATE_LIMITS.scansPerHour),
      apiKeyPerMin: count(env.RATE_LIMIT_API_KEY_PER_MIN, DEFAULT_RATE_LIMITS.apiKeyPerMin),
    },
    retention: {
      scanResultsDays: count(env.RETENTION_SCAN_RESULTS_DAYS, DEFAULT_RETENTION.scanResultsDays),
      apiCallsDays: count(env.RETENTION_API_CALLS_DAYS, DEFAULT_RETENTION.apiCallsDays),
      rateLimitDays: count(env.RETENTION_RATE_LIMIT_ROWS, DEFAULT_RETENTION.rateLimitDays),
    },
  };
}
