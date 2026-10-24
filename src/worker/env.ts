import type { ScanJob } from "./scans/jobs";

/** The slice of the Workers Rate Limiting binding we use. */
export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  DB: D1Database;
  R2: R2Bucket;
  SCAN_QUEUE: Queue<ScanJob>;
  ASSETS: Fetcher;

  /** local_noauth | cloudflare_access | hosted (default: cloudflare_access). */
  AUTH_MODE?: string;
  /** byok (you pay DataForSEO directly) | hosted (credits, cost-plus). */
  BILLING_MODE?: string;
  /** mock (default) | live. */
  DATAFORSEO_MODE?: string;
  /** Base64 of `login:password`. Secret; only read when DATAFORSEO_MODE=live. */
  DATAFORSEO_API_KEY?: string;
  /** Hosted markup multiplier on DataForSEO cost; 1.28 = +28%. */
  BILLING_MARKUP?: string;
  /** Hosted: credits granted to each new workspace. */
  HOSTED_FREE_CREDITS?: string;
  /** Bearer token for POST /api/admin/credits (hosted top-ups). */
  ADMIN_TOKEN?: string;
  TEAM_DOMAIN?: string;
  POLICY_AUD?: string;
  /**
   * Optional Workers Rate Limiting bindings (wrangler.jsonc "ratelimits").
   * Each has its own fixed limit/period; without one the D1 fallback is used.
   */
  RL_AUTH?: RateLimitBinding;
  RL_PUBLIC?: RateLimitBinding;
  RL_API_KEY?: RateLimitBinding;
  /** Rate limits, requests per window. 0 turns a rule off. See ratelimit/rules.ts. */
  RATE_LIMIT_AUTH_PER_MIN?: string;
  RATE_LIMIT_AUTH_PER_HOUR?: string;
  RATE_LIMIT_LOGIN_EMAIL_PER_HOUR?: string;
  RATE_LIMIT_PUBLIC_REPORT_PER_MIN?: string;
  RATE_LIMIT_SCANS_PER_HOUR?: string;
  RATE_LIMIT_API_KEY_PER_MIN?: string;
  /** Retention in days; 0 keeps forever. See retention.ts. */
  RETENTION_SCAN_RESULTS_DAYS?: string;
  RETENTION_API_CALLS_DAYS?: string;
  RETENTION_RATE_LIMIT_ROWS?: string;
  POLL_INTERVAL_SECONDS?: string;
  MOCK_STANDARD_DELAY_SECONDS?: string;
  MOCK_PRIORITY_DELAY_SECONDS?: string;
}
