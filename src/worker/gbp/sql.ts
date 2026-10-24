// Bulk review upsert through json_each (D1 caps a statement at 100 bound
// parameters, and a re-fetch must update rows instead of duplicating them).
import { sql } from "drizzle-orm";
import { REVIEW_TEXT_MAX } from "@/shared/gbp";
import type { Db } from "../db";
import { execRaw } from "../db/raw";
import { newId } from "../lib";
import type { Review } from "../dataforseo/types";

/**
 * Inserts reviews, or refreshes rating/text/owner reply of ones already stored
 * (an owner can answer later). `first_seen_snapshot_id` is set once, on insert.
 */
export async function upsertReviews(
  db: Db,
  ctx: { workspaceId: string; businessId: string; snapshotId: string },
  reviews: Review[],
) {
  if (reviews.length === 0) return;
  const rows = reviews.map((r) => ({
    id: newId(),
    reviewId: r.reviewId,
    reviewerName: r.profileName,
    rating: r.rating,
    text: r.text === null ? null : r.text.slice(0, REVIEW_TEXT_MAX),
    publishedAt: r.publishedAt,
    ownerAnswered: r.ownerAnswer !== null,
    ownerAnsweredAt: r.ownerAnsweredAt,
  }));
  // `WHERE true` keeps SQLite from reading ON CONFLICT as part of the SELECT.
  await execRaw(db, sql`
    INSERT INTO reviews (id, workspace_id, business_id, review_id, reviewer_name, rating, text,
                         published_at, owner_answered, owner_answered_at, first_seen_snapshot_id)
    SELECT json_extract(j.value, '$.id'), ${ctx.workspaceId}, ${ctx.businessId},
           json_extract(j.value, '$.reviewId'), json_extract(j.value, '$.reviewerName'),
           json_extract(j.value, '$.rating'), json_extract(j.value, '$.text'),
           json_extract(j.value, '$.publishedAt'), json_extract(j.value, '$.ownerAnswered'),
           json_extract(j.value, '$.ownerAnsweredAt'), ${ctx.snapshotId}
    FROM json_each(${JSON.stringify(rows)}) AS j
    WHERE true
    ON CONFLICT (business_id, review_id) DO UPDATE SET
      reviewer_name = excluded.reviewer_name,
      rating = excluded.rating,
      text = excluded.text,
      published_at = excluded.published_at,
      owner_answered = excluded.owner_answered,
      owner_answered_at = excluded.owner_answered_at`);
}
