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
import { SERP_PRICE_USD, roundUsd, type QueueMode } from "@/shared/pricing";
import { buildWorld, rankWorldAt, type WorldBusiness } from "./world";
import { buildTaskBilling, type TaskLike } from "./envelope";
import { parseMapItems, taskToOutcome } from "./parse";
import type {
  DataForSeoProvider,
  Device,
  LiveSearchInput,
  LiveSearchResult,
  MockHints,
  PlaceLookupResult,
  PostTasksInput,
  PostTasksResult,
  SearchType,
  TaskOutcome,
} from "./types";

export type MockOptions = {
  now?: () => number;
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

export class MockDataForSeo implements DataForSeoProvider {
  readonly mode = "mock" as const;
  private readonly now: () => number;
  private readonly delays: { standard: number; priority: number };
  private readonly shouldFail: (coordinate: string) => boolean;

  /** Deterministic fake place lookup: ids containing "unknown" resolve to nothing. */
  async lookupPlace(placeId: string): Promise<PlaceLookupResult | null> {
    if (placeId.includes("unknown")) return null;
    let h = 0;
    for (const ch of placeId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return {
      place: { name: "Mock Place", address: "101 Mock St, Raleigh, NC", lat: 35.7796 + (h % 1000) / 100000, lng: -78.6382 + (h % 777) / 100000, cid: String(h), category: null, domain: null },
      billing: { path: ["v3", "business_data", "google", "my_business_info", "live"], costUsd: 0 },
    };
  }

  constructor(options: MockOptions = {}) {
    this.now = options.now ?? Date.now;
    this.delays = options.delaysMs ?? DEFAULT_DELAYS;
    this.shouldFail = options.shouldFail ?? (() => false);
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
        h: input.mockHints,
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
      h: input.mockHints,
    };
    const task = buildTask(payload, "live");
    task.cost = SERP_PRICE_USD.live;
    return { items: parseMapItems(task.result?.[0] && (task.result[0] as { items: unknown }).items), billing: buildTaskBilling(task) };
  }
}

function buildTask(payload: TaskPayload, fn: "task_get" | "live"): TaskLike {
  const template = payload.t === "maps" ? readyTemplate : finderTemplate;
  const task = structuredClone(template.tasks[0]) as TaskLike;
  const [lat, lng] = parseCoordinate(payload.c);
  const world = buildWorld(payload.k, worldCenter(payload, lat, lng), payload.h);
  const ranked = rankWorldAt(world, { lat, lng }, payload.k, payload.dp);
  const itemTemplate = (template.tasks[0].result[0].items.find((i) => i.type !== "maps_paid_item") ?? {}) as Record<string, unknown>;
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
  return [lat, lng];
}

function encodeTaskId(payload: TaskPayload): string {
  return `mock.${btoa(unescape(encodeURIComponent(JSON.stringify(payload)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

function decodeTaskId(taskId: string): TaskPayload | null {
  if (!taskId.startsWith("mock.")) return null;
  try {
    const b64 = taskId.slice(5).replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(decodeURIComponent(escape(atob(b64)))) as TaskPayload;
  } catch {
    return null;
  }
}
