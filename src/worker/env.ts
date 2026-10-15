import type { ScanJob } from "./scans/jobs";

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
  POLL_INTERVAL_SECONDS?: string;
  MOCK_STANDARD_DELAY_SECONDS?: string;
  MOCK_PRIORITY_DELAY_SECONDS?: string;
}
