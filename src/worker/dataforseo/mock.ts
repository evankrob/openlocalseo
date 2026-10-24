// Mock DataForSEO provider. Serves responses in DataForSEO's real envelope
// shape (built from the recorded-shape fixtures in ./fixtures) through the same
// parser the live client uses, so switching DATAFORSEO_MODE changes the data
// source and nothing else. No network access, no credentials.
//
// Stateless on purpose: each queue invocation may run in a fresh isolate, so a
// task id carries everything needed to answer it (the request, when it was
// posted). A task is "ready" once its queue's simulated delay has elapsed.
import readyTemplate from "./fixtures/maps-task-get-ready.json";
import finderTemplate from "./fixtures/local-finder-task-get-ready.json";
import pendingTemplate from "./fixtures/maps-task-get-pending.json";
import failedTemplate from "./fixtures/maps-task-get-failed.json";
import profileTemplate from "./fixtures/business-info-live.json";
import reviewsTemplate from "./fixtures/reviews-task-get-ready.json";
import { must } from "@/shared/assert";
import { GBP_PROFILE_PRICE_USD, SERP_PRICE_USD, estimateGbpReviewsCostUsd, roundUsd, type QueueMode } from "@/shared/pricing";
import { buildWorld, rankWorldAt, type MockHints, type MockTarget, type WorldBusiness } from "./world";
import { buildTaskBilling, type TaskLike } from "./envelope";
import { dfsTimestamp, profileFacts, reviewTimeline } from "./gbp-world";
import { parseBusinessProfile, parseMapItems, reviewsTaskToOutcome, taskToOutcome } from "./parse";
import type {
  BusinessProfileInput,
  BusinessProfileResult,
  DataForSeoProvider,
  Device,
  LiveSearchInput,
  LiveSearchResult,
  BilledProvider,
  PlaceLookupResult,
  PostTasksInput,
  PostTasksResult,
  ReviewsOutcome,
  ReviewsTaskInput,
  ReviewsTaskPosted,
  SearchType,
  SpendAuthorization,
  TaskOutcome,
} from "./types";

export type MockOptions = {
  now?: () => number;
  /** The business the simulated market is built around, so it shows up in results. */
  target?: MockTarget;
  /** Simulated time until a queued task is ready, per queue. */
  delaysMs?: { standard: number; priority: number };
  /** Make specific coordinates fail, to exercise error handling. */
  shouldFail?: (coordinate: string) => boolean;
};

const DEFAULT_DELAYS = { standard: 12_000, priority: 4_000 };

type TaskPayload = {
  k: string; // keyword
  c: string; // coordinate
  t: SearchType;
  l: string;
  dv: Device;
  dp: number;
  q: Exclude<QueueMode, "live">;
  at: number; // posted at, epoch ms
  h?: MockHints;
};

type ReviewsPayload = {
  p: string; // place id
  d: number; // depth
  at: number; // posted at, epoch ms
  h?: MockHints;
};

export class MockDataForSeo implements DataForSeoProvider {
  readonly mode = "mock" as const;
  private readonly now: () => number;
  private readonly delays: { standard: number; priority: number };
  private readonly shouldFail: (coordinate: string) => boolean;
  private readonly hints: MockHints | undefined;

  /** Deterministic fake place lookup: ids containing "unknown" resolve to nothing. */
  async lookupPlace(placeId: string): Promise<PlaceLookupResult | null> {
    if (placeId.includes("unknown")) return null;
    let h = 0;
    for (const ch of placeId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return {
      place: { placeId: placeId.includes("other") ? "ChIJsomethingElse" : placeId, name: "Mock Place", address: "101 Mock St, Raleigh, NC", lat: 35.7796 + (h % 1000) / 100000, lng: -78.6382 + (h % 777) / 100000, cid: String(h), category: null, domain: null },
      billing: { path: ["v3", "business_data", "google", "my_business_info", "live"], costUsd: 0 },
    };
  }

  constructor(options: MockOptions = {}) {
    this.now = options.now ?? Date.now;
    this.delays = options.delaysMs ?? DEFAULT_DELAYS;
    this.shouldFail = options.shouldFail ?? (() => false);
    this.hints = options.target ? { target: options.target } : undefined;
  }

  /** The authorization is a compile-time gate (see `billing/spend.ts`); nothing to check at runtime. */
  billed(_authorization: SpendAuthorization): BilledProvider {
    return this;
  }

  async getBusinessProfile(input: BusinessProfileInput): Promise<BusinessProfileResult> {
    if (input.placeId.includes("unknown")) {
      return { profile: null, billing: { path: ["v3", "business_data", "google", "my_business_info", "live"], costUsd: GBP_PROFILE_PRICE_USD } };
    }
    const facts = profileFacts(input.placeId, this.now(), this.hints);
    const target = this.hints?.target;
    const task = structuredClone(profileTemplate.tasks[0]) as unknown as TaskLike;
    const result = task.result![0] as { items: Array<Record<string, unknown>> };
    result.items = [
      {
        ...result.items[0],
        title: target?.name ?? "Mock Place",
        place_id: input.placeId,
        category: target?.category ?? "Business",
        additional_categories: [],
        domain: target?.domain ?? null,
        phone: facts.phone,
        is_claimed: true,
        total_photos: facts.totalPhotos,
        rating: { rating_type: "Max5", value: facts.rating, votes_count: facts.reviewCount, rating_max: 5 },
        rating_distribution: facts.distribution,
      },
    ];
    return { profile: parseBusinessProfile(result.items), billing: buildTaskBilling(task) };
  }

  async postReviewsTask(input: ReviewsTaskInput): Promise<ReviewsTaskPosted> {
    const payload: ReviewsPayload = { p: input.placeId, d: input.depth, at: this.now(), h: this.hints };
    return {
      taskId: encodePayload("mockrev", payload),
      billing: {
        path: ["v3", "business_data", "google", "reviews", "task_post"],
        costUsd: estimateGbpReviewsCostUsd(input.depth),
      },
    };
  }

  async getReviewsTask(taskId: string): Promise<ReviewsOutcome> {
    const payload = decodePayload<ReviewsPayload>("mockrev", taskId);
    if (!payload) return { status: "failed", message: "Unknown mock task id" };
    if (this.now() < payload.at + this.delays.standard) {
      return reviewsTaskToOutcome(structuredClone(pendingTemplate.tasks[0]) as unknown as TaskLike);
    }
    // The newest `depth` reviews as of the moment the task was posted.
    const reviews = reviewTimeline(payload.p, payload.at).slice(-payload.d).reverse();
    const facts = profileFacts(payload.p, payload.at, payload.h);
    const task = structuredClone(reviewsTemplate.tasks[0]) as unknown as TaskLike;
    const result = task.result![0] as Record<string, unknown> & { items: Array<Record<string, unknown>> };
    const itemTemplate = result.items[0];
    result.items = reviews.map((r, index) => ({
      ...itemTemplate,
      rank_group: index + 1,
      rank_absolute: index + 1,
      review_id: r.reviewId,
      review_text: r.text,
      timestamp: dfsTimestamp(r.publishedMs),
      rating: { rating_type: "Max5", value: r.rating, votes_count: null, rating_max: 5 },
      profile_name: `Reviewer ${r.reviewId.split("-").pop()}`,
      profile_url: null,
      profile_image_url: null,
      review_url: null,
      owner_answer: r.answeredMs ? "Thank you for your review!" : null,
      owner_timestamp: r.answeredMs ? dfsTimestamp(r.answeredMs) : null,
    }));
    result.items_count = result.items.length;
    result.reviews_count = facts.reviewCount;
    result.rating = { rating_type: "Max5", value: facts.rating, votes_count: facts.reviewCount, rating_max: 5 };
    return reviewsTaskToOutcome(task);
  }

  async postTasks(input: PostTasksInput): Promise<PostTasksResult> {
    const at = this.now();
    const taskIds = input.coordinates.map((coordinate) =>
      encodeTaskId({
        k: input.keyword,
        c: coordinate,
        t: input.searchType,
        l: input.languageCode,
        dv: input.device,
        dp: input.depth,
        q: input.queue,
        at,
        h: this.hints,
      }),
    );
    return {
      taskIds,
      billing: {
        path: ["v3", "serp", "google", input.searchType, "task_post"],
        costUsd: roundUsd(input.coordinates.length * SERP_PRICE_USD[input.queue]),
      },
    };
  }

  async getTask(_searchType: SearchType, taskId: string): Promise<TaskOutcome> {
    const payload = decodeTaskId(taskId);
    if (!payload) return { status: "failed", message: "Unknown mock task id" };
    if (this.now() < payload.at + this.delays[payload.q]) {
      return taskToOutcome(structuredClone(pendingTemplate.tasks[0]) as unknown as TaskLike);
    }
    if (this.shouldFail(payload.c)) {
      return taskToOutcome(structuredClone(failedTemplate.tasks[0]) as unknown as TaskLike);
    }
    return taskToOutcome(buildTask(payload, "task_get"));
  }

  async liveSearch(input: LiveSearchInput): Promise<LiveSearchResult> {
    const payload: TaskPayload = {
      k: input.keyword,
      c: input.coordinate,
      t: input.searchType,
      l: input.languageCode,
      dv: input.device,
      dp: input.depth,
      q: "standard",
      at: this.now(),
      h: this.hints,
    };
    const task = buildTask(payload, "live");
    task.cost = SERP_PRICE_USD.live;
    return { items: parseMapItems(task.result?.[0] && (task.result[0] as { items: unknown }).items), billing: buildTaskBilling(task) };
  }
}

function buildTask(payload: TaskPayload, fn: "task_get" | "live"): TaskLike {
  const template = payload.t === "maps" ? readyTemplate : finderTemplate;
  const templateTask = must(template.tasks[0], "mock template has a task");
  const task = structuredClone(templateTask) as TaskLike;
  const [lat, lng] = parseCoordinate(payload.c);
  const world = buildWorld(payload.k, worldCenter(payload, lat, lng), payload.h);
  const ranked = rankWorldAt(world, { lat, lng }, payload.k, payload.dp);
  const itemTemplate = (must(templateTask.result[0], "mock template has a result").items.find((i) => i.type !== "maps_paid_item") ?? {}) as Record<string, unknown>;
  const items = ranked.map((b, index) => toItem(itemTemplate, b, index + 1));
  const result = task.result![0] as Record<string, unknown>;
  result.keyword = payload.k;
  result.items = items;
  result.items_count = items.length;
  result.se_results_count = items.length;
  task.cost = SERP_PRICE_USD[payload.q];
  task.path = ["v3", "serp", "google", payload.t, fn === "live" ? "live" : "task_get", "advanced"];
  return task;
}

/** The mock market is anchored on the target's home when known, else the point. */
function worldCenter(payload: TaskPayload, lat: number, lng: number) {
  return payload.h?.target ? { lat: payload.h.target.lat, lng: payload.h.target.lng } : { lat, lng };
}

function toItem(base: Record<string, unknown>, b: WorldBusiness, rank: number): Record<string, unknown> {
  return {
    ...base,
    rank_group: rank,
    rank_absolute: rank,
    title: b.name,
    domain: b.domain,
    url: `https://${b.domain}/`,
    place_id: b.placeId,
    cid: b.cid,
    category: b.category,
    address: b.address,
    latitude: b.lat,
    longitude: b.lng,
    rating: { rating_type: "Max5", value: b.rating, votes_count: b.ratingCount, rating_max: 5 },
  };
}

function parseCoordinate(coordinate: string): [number, number] {
  const [lat, lng] = coordinate.split(",").map(Number);
  return [must(lat, "coordinate latitude"), must(lng, "coordinate longitude")];
}

function encodePayload(prefix: string, payload: object): string {
  return `${prefix}.${btoa(unescape(encodeURIComponent(JSON.stringify(payload)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

function decodePayload<T>(prefix: string, taskId: string): T | null {
  if (!taskId.startsWith(`${prefix}.`)) return null;
  try {
    const b64 = taskId.slice(prefix.length + 1).replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(decodeURIComponent(escape(atob(b64)))) as T;
  } catch {
    return null;
  }
}

const encodeTaskId = (payload: TaskPayload) => encodePayload("mock", payload);
const decodeTaskId = (taskId: string) => decodePayload<TaskPayload>("mock", taskId);
