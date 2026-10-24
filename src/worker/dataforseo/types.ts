import type { QueueMode } from "@/shared/pricing";

export type SearchType = "maps" | "local_finder";
export type Device = "desktop" | "mobile";

/** One business in a Maps / Local Finder result list, normalized. */
export type MapResult = {
  /** 1-based position in the list (DataForSEO `rank_group`). */
  rank: number;
  name: string;
  placeId: string | null;
  cid: string | null;
  domain: string | null;
  rating: number | null;
  ratingCount: number | null;
  category: string | null;
  address: string | null;
};

/** Cost DataForSEO reported for a call: the envelope's `path` and `cost`. */
export type CallBilling = { path: string[]; costUsd: number };

/** The business a provider call is made on behalf of (see `ProcessDeps.scopeProvider`). */
export type ProviderScope = {
  name: string;
  placeId: string | null;
  domain: string | null;
  category: string | null;
  lat: number;
  lng: number;
};

declare const spendBrand: unique symbol;
/**
 * Proof that the decision to spend was made: hosted mode holds credits first,
 * BYOK mode spends the user's own key. Minted only in `billing/spend.ts`.
 */
export type SpendAuthorization = { readonly [spendBrand]: true };

type SearchBase = {
  keyword: string;
  searchType: SearchType;
  languageCode: string;
  device: Device;
  depth: number;
};

export type PostTasksInput = SearchBase & {
  /** "lat,lng,zoomz" per grid point, in point order. */
  coordinates: string[];
  queue: Exclude<QueueMode, "live">;
};

export type PostTasksResult = {
  /** One entry per coordinate, in order; null where DataForSEO rejected it. */
  taskIds: Array<string | null>;
  billing: CallBilling;
};

export type TaskOutcome =
  | { status: "pending" }
  | { status: "failed"; message: string }
  // `raw` is the provider's result object, archived to R2 as-is.
  | { status: "completed"; items: MapResult[]; raw?: unknown };

export type LiveSearchInput = SearchBase & { coordinate: string };

export type LiveSearchResult = { items: MapResult[]; billing: CallBilling };

/**
 * The only seam between scan logic and DataForSEO. `HttpDataForSeo` talks to
 * the real API; `MockDataForSeo` serves deterministic fixtures. Everything
 * else (queueing, metrics, billing) is provider-agnostic.
 */
export interface DataForSeoProvider {
  readonly mode: "mock" | "live";
  /** Collect a queued task. Free: the task was billed when posted. */
  getTask(searchType: SearchType, taskId: string): Promise<TaskOutcome>;
  /** Google business details for a place ID (one cheap live call); null if unknown. */
  lookupPlace?(placeId: string): Promise<PlaceLookupResult | null>;
  /** Collect a reviews task. Free: it was billed when posted. */
  getReviewsTask(taskId: string): Promise<ReviewsOutcome>;
  /** The calls that spend money. Only reachable with a `SpendAuthorization`. */
  billed(authorization: SpendAuthorization): BilledProvider;
}

/** Every call that DataForSEO bills at request time. */
export interface BilledProvider {
  /** Submit one task per coordinate (up to 100 per call). Billed at post time. */
  postTasks(input: PostTasksInput): Promise<PostTasksResult>;
  /** Single synchronous search at the live price. */
  liveSearch(input: LiveSearchInput): Promise<LiveSearchResult>;
  /** Google Business Profile details for a place ID (one live call); profile is null if Google has none (still billed). */
  getBusinessProfile(input: BusinessProfileInput): Promise<BusinessProfileResult>;
  /** Submit a reviews task. Billed at post time, so never replayed after an error. */
  postReviewsTask(input: ReviewsTaskInput): Promise<ReviewsTaskPosted>;
}

export type BusinessProfileInput = { placeId: string; languageCode?: string };

export type BusinessProfile = {
  placeId: string | null;
  name: string | null;
  address: string | null;
  cid: string | null;
  category: string | null;
  additionalCategories: string[];
  rating: number | null;
  reviewCount: number | null;
  /** Star (1-5) to number of reviews. */
  ratingDistribution: Record<string, number> | null;
  isClaimed: boolean | null;
  totalPhotos: number | null;
  phone: string | null;
  domain: string | null;
};

export type BusinessProfileResult = { profile: BusinessProfile | null; billing: CallBilling };

export type ReviewsTaskInput = { placeId: string; languageCode?: string; depth: number };

export type ReviewsTaskPosted = { taskId: string; billing: CallBilling };

/** One Google review, normalized. Reviewer links and images are deliberately dropped. */
export type Review = {
  reviewId: string;
  rating: number;
  text: string | null;
  /** ISO 8601 UTC. */
  publishedAt: string;
  profileName: string | null;
  ownerAnswer: string | null;
  /** ISO 8601 UTC; null when unanswered. */
  ownerAnsweredAt: string | null;
};

export type ReviewsOutcome =
  | { status: "pending" }
  | { status: "failed"; message: string }
  | { status: "completed"; reviews: Review[]; reviewCount: number | null; rating: number | null };

export type PlaceInfo = {
  /** The place ID Google returned; compared against the one requested. */
  placeId: string | null;
  name: string | null;
  address: string | null;
  lat: number;
  lng: number;
  cid: string | null;
  category: string | null;
  domain: string | null;
};

export type PlaceLookupResult = { place: PlaceInfo; billing: CallBilling };

/** DataForSEO accepts at most 100 tasks in one task_post request. */
export const MAX_TASKS_PER_POST = 100;
