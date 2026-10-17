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

/**
 * Hints used only by the mock provider, so a business added in the UI shows up
 * in simulated results. The live provider ignores them.
 */
export type MockHints = {
  target?: {
    name: string;
    placeId: string | null;
    domain: string | null;
    lat: number;
    lng: number;
    /** 0-1 strength of the tracked business in the simulated market. */
    prominence?: number;
  };
};

type SearchBase = {
  keyword: string;
  searchType: SearchType;
  languageCode: string;
  device: Device;
  depth: number;
  mockHints?: MockHints;
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
  /** Submit one task per coordinate (up to 100 per call). Billed at post time. */
  postTasks(input: PostTasksInput): Promise<PostTasksResult>;
  /** Collect a queued task. Free: the task was billed when posted. */
  getTask(searchType: SearchType, taskId: string): Promise<TaskOutcome>;
  /** Single synchronous search at the live price. */
  liveSearch(input: LiveSearchInput): Promise<LiveSearchResult>;
  /** Google business details for a place ID (one cheap live call); null if unknown. */
  lookupPlace?(placeId: string): Promise<PlaceLookupResult | null>;
}

export type PlaceInfo = {
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
