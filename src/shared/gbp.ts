// Google Business Profile rules and read-model maths. Pure functions: the
// worker feeds them stored snapshots and reviews, the UI reuses the types.
import { z } from "zod";
import type { GbpAlertKind } from "./alerts";

/** Alert when the overall rating falls by at least this much between snapshots. */
export const RATING_DROP_THRESHOLD = 0.2;
/** Rating drop at which the alert becomes critical. */
export const RATING_DROP_CRITICAL = 0.5;
/** A new review at or below this many stars raises a negative_review alert. */
export const NEGATIVE_REVIEW_MAX_STARS = 2;
/** Window for review velocity, in days. */
export const VELOCITY_DAYS = 30;
/** "Unanswered" is judged on this many newest reviews. */
export const UNANSWERED_WINDOW = 20;
export const REVIEW_TEXT_MAX = 2000;

const round = (n: number, digits: number) => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

/** Rating change as a positive number when the rating fell; 2 decimals so 4.3 -> 4.1 counts as 0.2. */
export function ratingDrop(previous: number | null, current: number | null): number | null {
  if (previous === null || current === null) return null;
  return round(previous - current, 2);
}

export type GbpAlertReview = { reviewId: string; rating: number; publishedAt: string; text: string | null };

export type GbpAlertMetrics = {
  rating: { before: number | null; after: number | null };
  reviewCount: { before: number | null; after: number | null };
  /** negative_review: how many new low reviews, and the (up to 3) newest. */
  negativeReviews?: { count: number; reviews: GbpAlertReview[] };
};

export type GbpAlertCandidate = {
  kind: GbpAlertKind;
  severity: "warning" | "critical";
  metrics: GbpAlertMetrics;
};

export function evaluateGbpAlerts(input: {
  current: { rating: number | null; reviewCount: number | null };
  /** Previous completed snapshot; null = first snapshot, nothing to compare. */
  previous: { rating: number | null; reviewCount: number | null } | null;
  newReviews: GbpAlertReview[];
}): GbpAlertCandidate[] {
  const { current, previous } = input;
  if (!previous) return [];
  const base: GbpAlertMetrics = {
    rating: { before: previous.rating, after: current.rating },
    reviewCount: { before: previous.reviewCount, after: current.reviewCount },
  };
  const out: GbpAlertCandidate[] = [];
  const drop = ratingDrop(previous.rating, current.rating);
  if (drop !== null && drop >= RATING_DROP_THRESHOLD) {
    out.push({ kind: "rating_drop", severity: drop >= RATING_DROP_CRITICAL ? "critical" : "warning", metrics: base });
  }
  const negative = input.newReviews
    .filter((r) => r.rating <= NEGATIVE_REVIEW_MAX_STARS)
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  if (negative.length > 0) {
    out.push({
      kind: "negative_review",
      severity: "warning",
      metrics: { ...base, negativeReviews: { count: negative.length, reviews: negative.slice(0, 3) } },
    });
  }
  return out;
}

/**
 * Reviews per 30 days from the newest-N sample. When the sample reaches back
 * past the window the count inside it is exact; otherwise the sample is all
 * we saw, so the rate is extrapolated from the span it covers.
 */
export function reviewVelocity(publishedAt: string[], now: Date): number {
  const nowMs = now.getTime();
  const times = publishedAt.map((p) => new Date(p).getTime()).filter((t) => Number.isFinite(t) && t <= nowMs);
  if (times.length === 0) return 0;
  const windowMs = VELOCITY_DAYS * 86_400_000;
  const oldest = Math.min(...times);
  if (oldest <= nowMs - windowMs) return times.filter((t) => t > nowMs - windowMs).length;
  const spanDays = Math.max((nowMs - oldest) / 86_400_000, 1);
  return round((times.length / spanDays) * VELOCITY_DAYS, 1);
}

/** DataForSEO timestamps look like "2026-10-14 17:05:36 +00:00". */
export function parseDfsTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const iso = value.trim().replace(" ", "T").replace(" ", "");
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

export const reviewsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(200).optional(),
  unanswered: z
    .enum(["1", "true", "0", "false"])
    .optional()
    .transform((v) => v === "1" || v === "true"),
});

export const gbpRefreshSchema = z.object({ maxCostUsd: z.number().positive().optional() });
