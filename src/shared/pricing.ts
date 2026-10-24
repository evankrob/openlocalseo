// DataForSEO SERP prices per task (up to 100 results), from SCOPE.md section 3.
// Maps and Local Finder cost the same and location does not change the price.
// Re-check https://dataforseo.com/pricing before budgeting: these are
// upper-bound estimates; the real cost per call is read from each response
// and recorded (see worker/billing/ledger.ts).

export const QUEUE_MODES = ["standard", "priority", "live"] as const;
export type QueueMode = (typeof QUEUE_MODES)[number];

export const SERP_PRICE_USD: Record<QueueMode, number> = {
  standard: 0.0006,
  priority: 0.0012,
  live: 0.002,
};

/** DataForSEO `priority` task field: 1 = standard queue, 2 = high priority. */
export const QUEUE_PRIORITY: Record<Exclude<QueueMode, "live">, 1 | 2> = {
  standard: 1,
  priority: 2,
};

export const CREDITS_PER_USD = 1000;
/** Hosted cost-plus markup on DataForSEO cost (open-seo uses 28%). */
export const DEFAULT_BILLING_MARKUP = 1.28;

export function estimateScanCostUsd(points: number, queue: QueueMode): number {
  return roundUsd(points * SERP_PRICE_USD[queue]);
}

export function applyMarkupUsd(rawUsd: number, markup = DEFAULT_BILLING_MARKUP): number {
  return roundUsd(rawUsd * markup);
}

/**
 * Credits charged for one raw provider cost: marked up, then ceiled, the
 * single formula used for both the pre-scan hold and the final settlement so
 * the two cannot drift apart (same rule as open-seo).
 */
export function creditsForProviderUsd(rawUsd: number, markup = DEFAULT_BILLING_MARKUP): number {
  return Math.ceil(applyMarkupUsd(rawUsd, markup) * CREDITS_PER_USD);
}

export function creditsToUsd(credits: number): number {
  return credits / CREDITS_PER_USD;
}

export function roundUsd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

// Google Business Profile tracking (DataForSEO Business Data API). The profile
// call is live-only; the reviews task is billed per 10 reviews at post time and
// collected for free. Upper-bound estimates: real costs come from each response.
export const GBP_PROFILE_PRICE_USD = 0.0054;
export const GBP_REVIEWS_PRICE_PER_10_USD = 0.00075;
/** Newest reviews fetched per snapshot. */
export const GBP_REVIEWS_DEPTH = 20;

export function estimateGbpReviewsCostUsd(depth: number = GBP_REVIEWS_DEPTH): number {
  return roundUsd(Math.ceil(depth / 10) * GBP_REVIEWS_PRICE_PER_10_USD);
}

export function estimateGbpSnapshotCostUsd(depth: number = GBP_REVIEWS_DEPTH): number {
  return roundUsd(GBP_PROFILE_PRICE_USD + estimateGbpReviewsCostUsd(depth));
}
