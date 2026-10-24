// Read models for the UI and MCP: the profile overview with its history
// series, and the review list.
import { and, desc, eq, lt, or } from "drizzle-orm";
import { AppError } from "@/shared/errors";
import { getBusiness } from "../catalog";
import type { Db } from "../db";
import { gbpSnapshots, reviews } from "../db/schema";

type SnapshotRow = typeof gbpSnapshots.$inferSelect;

export type GbpSnapshotView = {
  id: string;
  takenAt: string;
  trigger: SnapshotRow["trigger"];
  rating: number | null;
  reviewCount: number | null;
  ratingDistribution: Record<string, number> | null;
  isClaimed: boolean | null;
  totalPhotos: number | null;
  primaryCategory: string | null;
  additionalCategories: string[];
  phone: string | null;
  domain: string | null;
  /** Reviews first seen in this snapshot; null for the baseline (first) snapshot. */
  newReviews: number | null;
  newReviewsAvgRating: number | null;
  /** Reviews per 30 days, from the newest-20 sample. */
  velocity30d: number | null;
  unansweredLast20: number | null;
  costUsd: number;
};

function parseJson<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function view(row: SnapshotRow): GbpSnapshotView {
  return {
    id: row.id,
    takenAt: row.takenAt,
    trigger: row.trigger,
    rating: row.rating,
    reviewCount: row.reviewCount,
    ratingDistribution: parseJson<Record<string, number> | null>(row.ratingDistribution, null),
    isClaimed: row.isClaimed,
    totalPhotos: row.totalPhotos,
    primaryCategory: row.primaryCategory,
    additionalCategories: parseJson<string[]>(row.additionalCategories, []),
    phone: row.phone,
    domain: row.domain,
    newReviews: row.newReviews,
    newReviewsAvgRating: row.newReviewsAvgRating,
    velocity30d: row.velocity30d,
    unansweredLast20: row.unansweredLast20,
    costUsd: row.costUsd,
  };
}

export type GbpSeriesPoint = Pick<GbpSnapshotView, "id" | "takenAt" | "rating" | "reviewCount" | "velocity30d" | "newReviews" | "unansweredLast20">;

/** Latest completed snapshot, the change since the one before it, and the history series (oldest first). */
export async function getGbpOverview(db: Db, workspaceId: string, businessId: string, historyLimit = 60) {
  const business = await getBusiness(db, workspaceId, businessId);
  const completed = await db
    .select()
    .from(gbpSnapshots)
    .where(and(eq(gbpSnapshots.workspaceId, workspaceId), eq(gbpSnapshots.businessId, businessId), eq(gbpSnapshots.status, "completed")))
    .orderBy(desc(gbpSnapshots.takenAt))
    .limit(historyLimit);
  const [newest] = await db
    .select()
    .from(gbpSnapshots)
    .where(and(eq(gbpSnapshots.workspaceId, workspaceId), eq(gbpSnapshots.businessId, businessId)))
    .orderBy(desc(gbpSnapshots.takenAt))
    .limit(1);

  const latest = completed[0] ? view(completed[0]) : null;
  const previous = completed[1] ?? null;
  return {
    business: {
      id: business.id,
      name: business.name,
      placeId: business.placeId,
      gbpTracking: business.gbpTracking,
      gbpNextRunAt: business.gbpNextRunAt,
    },
    latest,
    change:
      latest && previous
        ? {
            rating: latest.rating !== null && previous.rating !== null ? Math.round((latest.rating - previous.rating) * 100) / 100 : null,
            reviewCount: latest.reviewCount !== null && previous.reviewCount !== null ? latest.reviewCount - previous.reviewCount : null,
            since: previous.takenAt,
          }
        : null,
    /** The newest snapshot when it is still running, or failed after the last good one. */
    attempt:
      newest && newest.status !== "completed"
        ? { id: newest.id, status: newest.status, takenAt: newest.takenAt, error: newest.error }
        : null,
    history: completed
      .map(view)
      .map<GbpSeriesPoint>((s) => ({
        id: s.id,
        takenAt: s.takenAt,
        rating: s.rating,
        reviewCount: s.reviewCount,
        velocity30d: s.velocity30d,
        newReviews: s.newReviews,
        unansweredLast20: s.unansweredLast20,
      }))
      .reverse(),
  };
}

export type ReviewView = {
  reviewId: string;
  reviewerName: string | null;
  rating: number;
  text: string | null;
  publishedAt: string;
  ownerAnswered: boolean;
  ownerAnsweredAt: string | null;
};

// Cursor = "<publishedAt>|<row id>" of the last review returned, base64url.
const encodeCursor = (publishedAt: string, id: string) => btoa(`${publishedAt}|${id}`).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function decodeCursor(cursor: string): { publishedAt: string; id: string } {
  try {
    const [publishedAt, id] = atob(cursor.replace(/-/g, "+").replace(/_/g, "/")).split("|");
    if (publishedAt && id) return { publishedAt, id };
  } catch {
    // fall through
  }
  throw new AppError("VALIDATION_ERROR", "cursor is not valid");
}

/** Stored reviews, newest first, with keyset paging. */
export async function listReviews(
  db: Db,
  workspaceId: string,
  businessId: string,
  options: { limit: number; cursor?: string; unansweredOnly?: boolean },
): Promise<{ reviews: ReviewView[]; nextCursor: string | null }> {
  await getBusiness(db, workspaceId, businessId);
  const after = options.cursor ? decodeCursor(options.cursor) : null;
  const rows = await db
    .select()
    .from(reviews)
    .where(
      and(
        eq(reviews.workspaceId, workspaceId),
        eq(reviews.businessId, businessId),
        options.unansweredOnly ? eq(reviews.ownerAnswered, false) : undefined,
        after
          ? or(
              lt(reviews.publishedAt, after.publishedAt),
              and(eq(reviews.publishedAt, after.publishedAt), lt(reviews.id, after.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(reviews.publishedAt), desc(reviews.id))
    .limit(options.limit + 1);
  const page = rows.slice(0, options.limit);
  const last = page[page.length - 1];
  return {
    reviews: page.map((r) => ({
      reviewId: r.reviewId,
      reviewerName: r.reviewerName,
      rating: r.rating,
      text: r.text,
      publishedAt: r.publishedAt,
      ownerAnswered: r.ownerAnswered,
      ownerAnsweredAt: r.ownerAnsweredAt,
    })),
    nextCursor: rows.length > options.limit && last ? encodeCursor(last.publishedAt, last.id) : null,
  };
}
