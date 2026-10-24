// Deterministic simulated Google Business Profile for the mock provider. Each
// place has an endless review timeline that starts at a fixed date, so asking
// again a month later returns the same older reviews plus the newer ones, and
// the rating and review count drift with them. Same inputs, same output.
import { hash32, mulberry32 } from "./world";
import type { MockHints } from "./types";

/** First simulated review of every place. */
export const TIMELINE_START_MS = Date.UTC(2026, 0, 1);
const MAX_REVIEWS = 5000;
const DAY_MS = 86_400_000;

export type MockReview = {
  reviewId: string;
  rating: number;
  text: string | null;
  publishedMs: number;
  answeredMs: number | null;
};

const unit = (key: string) => mulberry32(hash32(key))();

function starsFor(placeId: string, k: number): number {
  const r = unit(`${placeId}|rating|${k}`);
  return r < 0.04 ? 1 : r < 0.07 ? 2 : r < 0.12 ? 3 : r < 0.3 ? 4 : 5;
}

/** Every review published at or before `atMs`, oldest first. */
export function reviewTimeline(placeId: string, atMs: number): MockReview[] {
  const out: MockReview[] = [];
  let t = TIMELINE_START_MS;
  for (let k = 0; k < MAX_REVIEWS; k++) {
    t += (0.5 + unit(`${placeId}|gap|${k}`) * 5.5) * DAY_MS;
    if (t > atMs) break;
    const answerAt = t + (1 + unit(`${placeId}|answer-delay|${k}`) * 4) * DAY_MS;
    const answered = unit(`${placeId}|answered|${k}`) < 0.6 && answerAt <= atMs;
    out.push({
      reviewId: `mockrev-${hash32(placeId).toString(36)}-${k}`,
      rating: starsFor(placeId, k),
      text: unit(`${placeId}|text|${k}`) < 0.25 ? null : `Mock review ${k + 1}.`,
      publishedMs: Math.round(t),
      answeredMs: answered ? Math.round(answerAt) : null,
    });
  }
  return out;
}

export type MockProfileFacts = {
  rating: number;
  reviewCount: number;
  distribution: Record<string, number>;
  totalPhotos: number;
  phone: string;
};

/** Profile numbers at `atMs`: a base that matches the mock market, plus the timeline's reviews. */
export function profileFacts(placeId: string, atMs: number, hints?: MockHints): MockProfileFacts {
  const h = hash32(placeId);
  // The tracked business is 4.8 stars / 412 reviews in the scan world; others vary by place.
  const baseRating = hints?.target ? 4.8 : 4.2 + (h % 8) / 10;
  const baseCount = hints?.target ? 412 : 60 + (h % 300);
  const timeline = reviewTimeline(placeId, atMs);

  // Base star mix: a few low votes, the rest split between 4 and 5 so the mean is baseRating.
  const five = Math.min(0.96, Math.max(0, baseRating - 3.93));
  const shares: Record<string, number> = { "1": 0.01, "2": 0.01, "3": 0.02, "4": 0.96 - five };
  const dist: Record<string, number> = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
  let assigned = 0;
  for (const [star, share] of Object.entries(shares)) {
    dist[star] = Math.round(baseCount * share);
    assigned += dist[star];
  }
  dist["5"] = baseCount - assigned;
  for (const r of timeline) dist[String(r.rating)] += 1;

  const reviewCount = baseCount + timeline.length;
  const sum = Object.entries(dist).reduce((acc, [star, n]) => acc + Number(star) * n, 0);
  return {
    rating: Math.round((sum / reviewCount) * 10) / 10,
    reviewCount,
    distribution: dist,
    totalPhotos: 20 + (h % 80) + Math.floor(timeline.length / 4),
    phone: `+1919-555-${String(h % 10000).padStart(4, "0")}`,
  };
}

/** "2026-10-14T17:05:36.000Z" -> "2026-10-14 17:05:36 +00:00" (DataForSEO's format). */
export function dfsTimestamp(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19).replace("T", " ")} +00:00`;
}
