import { z } from "zod";
import { AppError } from "@/shared/errors";
import { isNoResultsTask, isTaskInProgress, type TaskLike } from "./envelope";
import { parseDfsTimestamp } from "@/shared/gbp";
import type { BusinessProfile, MapResult, Review, ReviewsOutcome, TaskOutcome } from "./types";

// Fields we read from a Maps / Local Finder item; everything else is ignored.
// Business rows carry type "maps_search" (Maps) or "local_finder" (Local
// Finder); ads and other item types are skipped.
const ratingSchema = z
  .object({ value: z.number().nullable().optional(), votes_count: z.number().nullable().optional() })
  .nullable()
  .optional();

const itemSchema = z
  .object({
    type: z.string(),
    rank_group: z.number().optional(),
    rank_absolute: z.number().optional(),
    title: z.string().nullable().optional(),
    domain: z.string().nullable().optional(),
    place_id: z.string().nullable().optional(),
    cid: z.string().nullable().optional(),
    category: z.string().nullable().optional(),
    address: z.string().nullable().optional(),
    rating: ratingSchema,
  })
  .passthrough();

const BUSINESS_ITEM_TYPES = new Set(["maps_search", "local_finder"]);

export function parseMapItems(items: unknown): MapResult[] {
  const parsed = z.array(itemSchema).safeParse(items ?? []);
  if (!parsed.success) {
    console.error("dataforseo.invalid-payload", parsed.error.issues.slice(0, 5));
    throw new AppError("INTERNAL_ERROR", "DataForSEO returned an invalid Maps response shape");
  }
  const results: MapResult[] = [];
  for (const item of parsed.data) {
    if (!BUSINESS_ITEM_TYPES.has(item.type) || !item.title) continue;
    const rank = item.rank_group ?? item.rank_absolute;
    if (rank === undefined) continue;
    results.push({
      rank,
      name: item.title,
      placeId: item.place_id ?? null,
      cid: item.cid ?? null,
      domain: item.domain ?? null,
      rating: item.rating?.value ?? null,
      ratingCount: item.rating?.votes_count ?? null,
      category: item.category ?? null,
      address: item.address ?? null,
    });
  }
  return results.sort((a, b) => a.rank - b.rank);
}

export function firstResultItems(task: TaskLike): unknown {
  const first = task.result?.[0];
  return typeof first === "object" && first !== null ? (first as { items?: unknown }).items : [];
}

/**
 * Interprets one task_get task. Shared by the live client and the mock, so
 * the fixtures exercise exactly the code that parses real responses.
 */
export function taskToOutcome(task: TaskLike): TaskOutcome {
  if (isTaskInProgress(task)) return { status: "pending" };
  if (task.status_code !== 20000) {
    // "No Search Results" is a billed empty SERP, not a failure.
    if (isNoResultsTask(task)) return { status: "completed", items: [] };
    return { status: "failed", message: task.status_message || `DataForSEO task failed (${task.status_code})` };
  }
  return { status: "completed", items: parseMapItems(firstResultItems(task)), raw: task.result?.[0] };
}

// ---- Business Data: profile and reviews -------------------------------------------

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

const profileItemSchema = z
  .object({
    title: z.string().nullable().optional(),
    place_id: z.string().nullable().optional(),
    cid: z.string().nullable().optional(),
    address: z.string().nullable().optional(),
    category: z.string().nullable().optional(),
    additional_categories: z.array(z.string()).nullable().optional(),
    phone: z.string().nullable().optional(),
    domain: z.string().nullable().optional(),
    is_claimed: z.boolean().nullable().optional(),
    total_photos: z.number().nullable().optional(),
    rating: ratingSchema,
    rating_distribution: z.record(z.string(), z.number().nullable()).nullable().optional(),
  })
  .passthrough();

/** Normalizes the first `my_business_info` item; null when the response has none. */
export function parseBusinessProfile(items: unknown): BusinessProfile | null {
  const first = Array.isArray(items) ? items[0] : undefined;
  if (first === undefined) return null;
  const parsed = profileItemSchema.safeParse(first);
  if (!parsed.success) {
    console.error("dataforseo.invalid-payload", parsed.error.issues.slice(0, 5));
    throw new AppError("INTERNAL_ERROR", "DataForSEO returned an invalid business profile shape");
  }
  const item = parsed.data;
  const distribution: Record<string, number> = {};
  for (const [star, count] of Object.entries(item.rating_distribution ?? {})) {
    if (count !== null) distribution[star] = count;
  }
  return {
    placeId: str(item.place_id),
    name: str(item.title),
    address: str(item.address),
    cid: str(item.cid),
    category: str(item.category),
    additionalCategories: (item.additional_categories ?? []).map(str).filter((c): c is string => c !== null),
    rating: item.rating?.value ?? null,
    reviewCount: item.rating?.votes_count ?? null,
    ratingDistribution: Object.keys(distribution).length > 0 ? distribution : null,
    isClaimed: item.is_claimed ?? null,
    totalPhotos: item.total_photos ?? null,
    phone: str(item.phone),
    domain: str(item.domain),
  };
}

const reviewItemSchema = z
  .object({
    type: z.string(),
    review_id: z.string().nullable().optional(),
    review_text: z.string().nullable().optional(),
    timestamp: z.string().nullable().optional(),
    rating: ratingSchema,
    profile_name: z.string().nullable().optional(),
    owner_answer: z.string().nullable().optional(),
    owner_timestamp: z.string().nullable().optional(),
  })
  .passthrough();

/** Normalizes review items, skipping any without an id, a star rating or a date. */
export function parseReviewItems(items: unknown): Review[] {
  const parsed = z.array(reviewItemSchema).safeParse(items ?? []);
  if (!parsed.success) {
    console.error("dataforseo.invalid-payload", parsed.error.issues.slice(0, 5));
    throw new AppError("INTERNAL_ERROR", "DataForSEO returned an invalid reviews response shape");
  }
  const reviews: Review[] = [];
  for (const item of parsed.data) {
    if (item.type !== "google_reviews_search" || !item.review_id) continue;
    const rating = item.rating?.value;
    const publishedAt = parseDfsTimestamp(item.timestamp);
    if (rating == null || !publishedAt) continue;
    const ownerAnswer = str(item.owner_answer);
    reviews.push({
      reviewId: item.review_id,
      rating,
      text: str(item.review_text),
      publishedAt,
      profileName: str(item.profile_name),
      ownerAnswer,
      // An answer without a timestamp still counts as answered.
      ownerAnsweredAt: ownerAnswer ? parseDfsTimestamp(item.owner_timestamp) : null,
    });
  }
  return reviews.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

type ReviewsResult = { items?: unknown; reviews_count?: number | null; rating?: { value?: number | null } | null };

/** Interprets one reviews task_get task; shared by the live client and the mock. */
export function reviewsTaskToOutcome(task: TaskLike): ReviewsOutcome {
  if (isTaskInProgress(task)) return { status: "pending" };
  if (task.status_code !== 20000) {
    // "No Search Results": a business with no reviews is a valid, empty answer.
    if (isNoResultsTask(task)) return { status: "completed", reviews: [], reviewCount: 0, rating: null };
    return { status: "failed", message: task.status_message || `DataForSEO task failed (${task.status_code})` };
  }
  const result = task.result?.[0] as ReviewsResult | undefined;
  return {
    status: "completed",
    reviews: parseReviewItems(result?.items),
    reviewCount: result?.reviews_count ?? null,
    rating: result?.rating?.value ?? null,
  };
}
