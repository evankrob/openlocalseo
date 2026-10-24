import { describe, expect, it } from "vitest";
import { evaluateGbpAlerts, parseDfsTimestamp, ratingDrop, reviewVelocity, reviewsQuerySchema } from "./gbp";
import { estimateGbpReviewsCostUsd, estimateGbpSnapshotCostUsd } from "./pricing";
import { at } from "@/shared/assert";

const review = (rating: number, publishedAt = "2026-10-10T00:00:00.000Z", reviewId = `r-${rating}-${publishedAt}`) => ({
  reviewId,
  rating,
  publishedAt,
  text: null,
});

describe("ratingDrop", () => {
  it("rounds to 2 decimals so float noise cannot hide a 0.2 drop", () => {
    expect(ratingDrop(4.3, 4.1)).toBe(0.2); // 4.3 - 4.1 is 0.19999999999999929 in floats
    expect(ratingDrop(4.8, 4.9)).toBe(-0.1);
    expect(ratingDrop(null, 4.5)).toBeNull();
    expect(ratingDrop(4.5, null)).toBeNull();
  });
});

describe("evaluateGbpAlerts", () => {
  const prev = { rating: 4.7, reviewCount: 197 };

  it("raises nothing for the first snapshot, however bad the reviews are", () => {
    expect(evaluateGbpAlerts({ current: { rating: 3, reviewCount: 10 }, previous: null, newReviews: [review(1)] })).toEqual([]);
  });

  it("raises rating_drop at exactly 0.2 and not below it", () => {
    const alerts = evaluateGbpAlerts({ current: { rating: 4.5, reviewCount: 200 }, previous: prev, newReviews: [] });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: "rating_drop", severity: "warning" });
    expect(at(alerts, 0).metrics).toMatchObject({ rating: { before: 4.7, after: 4.5 }, reviewCount: { before: 197, after: 200 } });
    expect(evaluateGbpAlerts({ current: { rating: 4.6, reviewCount: 200 }, previous: prev, newReviews: [] })).toEqual([]);
    expect(evaluateGbpAlerts({ current: { rating: 4.9, reviewCount: 200 }, previous: prev, newReviews: [] })).toEqual([]);
  });

  it("makes a big drop critical", () => {
    const alert = at(evaluateGbpAlerts({ current: { rating: 4.1, reviewCount: 200 }, previous: prev, newReviews: [] }), 0);
    expect(alert.severity).toBe("critical");
  });

  it("does not compare when a rating is unknown", () => {
    expect(evaluateGbpAlerts({ current: { rating: null, reviewCount: null }, previous: prev, newReviews: [] })).toEqual([]);
  });

  it("raises one negative_review alert for new reviews of 2 stars or fewer, newest first, capped at 3", () => {
    const alerts = evaluateGbpAlerts({
      current: { rating: 4.7, reviewCount: 202 },
      previous: prev,
      newReviews: [
        review(2, "2026-10-01T00:00:00.000Z"),
        review(1, "2026-10-05T00:00:00.000Z"),
        review(3),
        review(5),
        review(1, "2026-10-03T00:00:00.000Z"),
        review(2, "2026-10-04T00:00:00.000Z"),
      ],
    });
    expect(alerts).toHaveLength(1);
    expect(at(alerts, 0).kind).toBe("negative_review");
    const negative = at(alerts, 0).metrics.negativeReviews!;
    expect(negative.count).toBe(4);
    expect(negative.reviews.map((r) => r.publishedAt)).toEqual(["2026-10-05T00:00:00.000Z", "2026-10-04T00:00:00.000Z", "2026-10-03T00:00:00.000Z"]);
  });

  it("can raise both kinds at once", () => {
    const kinds = evaluateGbpAlerts({ current: { rating: 4.3, reviewCount: 200 }, previous: prev, newReviews: [review(1)] }).map((a) => a.kind);
    expect(kinds).toEqual(["rating_drop", "negative_review"]);
  });
});

describe("reviewVelocity", () => {
  const now = new Date("2026-10-31T00:00:00.000Z");
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();

  it("counts reviews inside the 30-day window when the sample reaches back past it", () => {
    expect(reviewVelocity([daysAgo(1), daysAgo(10), daysAgo(29), daysAgo(40), daysAgo(80)], now)).toBe(3);
  });

  it("extrapolates from the span when the sample is all inside the window", () => {
    // 20 reviews over the last 10 days: 60 per 30 days.
    const sample = Array.from({ length: 20 }, (_, i) => daysAgo(0.5 + i * 0.5));
    expect(reviewVelocity(sample, now)).toBeCloseTo(60, 0);
  });

  it("is 0 with no reviews, and ignores unparseable or future dates", () => {
    expect(reviewVelocity([], now)).toBe(0);
    expect(reviewVelocity(["nonsense", daysAgo(-3)], now)).toBe(0);
  });
});

describe("parseDfsTimestamp", () => {
  it("converts DataForSEO timestamps to ISO UTC", () => {
    expect(parseDfsTimestamp("2026-10-14 17:05:36 +00:00")).toBe("2026-10-14T17:05:36.000Z");
    expect(parseDfsTimestamp("2026-10-14 17:05:36 +02:00")).toBe("2026-10-14T15:05:36.000Z");
    expect(parseDfsTimestamp(null)).toBeNull();
    expect(parseDfsTimestamp("soon")).toBeNull();
  });
});

describe("reviewsQuerySchema", () => {
  it("defaults, coerces and bounds the query", () => {
    expect(reviewsQuerySchema.parse({})).toEqual({ limit: 20, unanswered: false });
    expect(reviewsQuerySchema.parse({ limit: "5", unanswered: "1" })).toEqual({ limit: 5, unanswered: true });
    expect(() => reviewsQuerySchema.parse({ limit: "0" })).toThrow();
    expect(() => reviewsQuerySchema.parse({ limit: "101" })).toThrow();
    expect(() => reviewsQuerySchema.parse({ unanswered: "maybe" })).toThrow();
  });
});

describe("GBP pricing", () => {
  it("is about $0.007 per snapshot at depth 20", () => {
    expect(estimateGbpReviewsCostUsd(20)).toBe(0.0015);
    expect(estimateGbpReviewsCostUsd(10)).toBe(0.00075);
    expect(estimateGbpSnapshotCostUsd(20)).toBe(0.0069);
  });
});
