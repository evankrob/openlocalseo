// Live DataForSEO client. Only used when DATAFORSEO_MODE=live and
// DATAFORSEO_API_KEY is set; nothing in tests or local dev reaches it.
// Transport (auth, timeout, 5xx retry of idempotent reads, error ladder) is
// ported from open-seo's src/server/lib/dataforseo/core.ts (MIT).
import { AppError, type ErrorCode } from "@/shared/errors";
import { QUEUE_PRIORITY } from "@/shared/pricing";
import {
  assertOk,
  buildTaskBilling,
  failedResponseError,
  type ResponseLike,
  type TaskLike,
} from "./envelope";
import { firstResultItems, parseMapItems, taskToOutcome } from "./parse";
import {
  MAX_TASKS_PER_POST,
  type DataForSeoProvider,
  type LiveSearchInput,
  type LiveSearchResult,
  type PlaceLookupResult,
  type PostTasksInput,
  type PostTasksResult,
  type SearchType,
  type TaskOutcome,
} from "./types";

const API_BASE = "https://api.dataforseo.com";
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 2;
const RETRY_BACKOFF_MS = 250;

type RequestOptions = {
  /** Billed, non-idempotent calls must never be replayed on a 5xx. */
  maxServerErrorRetries?: number;
};

export class HttpDataForSeo implements DataForSeoProvider {
  readonly mode = "live" as const;

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = API_BASE,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  async postTasks(input: PostTasksInput): Promise<PostTasksResult> {
    if (input.coordinates.length > MAX_TASKS_PER_POST) {
      throw new AppError("VALIDATION_ERROR", `At most ${MAX_TASKS_PER_POST} tasks per task_post`);
    }
    const base = `/v3/serp/google/${input.searchType}/task_post`;
    const response = await this.request<TaskLike>("POST", base, taskBodies(input), {
      maxServerErrorRetries: 0,
    });
    if (!response || response.status_code !== 20000) {
      throw failedResponseError(response, "DataForSEO task_post failed");
    }
    const taskIds: Array<string | null> = input.coordinates.map(() => null);
    let costUsd = 0;
    for (const entry of response.tasks ?? []) {
      // Sum every entry, accepted or not: anything charged is metered.
      costUsd += entry.cost ?? 0;
      const index = Number(entry.data?.tag);
      if (entry.status_code === 20100 && entry.id && taskIds[index] === null) {
        taskIds[index] = entry.id;
      } else {
        console.warn(`dataforseo.task_post.rejected-entry (${entry.status_code}): ${entry.status_message}`);
      }
    }
    return { taskIds, billing: { path: ["v3", "serp", "google", input.searchType, "task_post"], costUsd } };
  }

  async getTask(searchType: SearchType, taskId: string): Promise<TaskOutcome> {
    const response = await this.request<TaskLike>(
      "GET",
      `/v3/serp/google/${searchType}/task_get/advanced/${encodeURIComponent(taskId)}`,
    );
    const task = response?.tasks?.[0];
    if (!response || response.status_code !== 20000 || !task) {
      throw failedResponseError(response, "DataForSEO task_get failed");
    }
    return taskToOutcome(task);
  }

  async liveSearch(input: LiveSearchInput): Promise<LiveSearchResult> {
    const response = await this.request<TaskLike>(
      "POST",
      `/v3/serp/google/${input.searchType}/live/advanced`,
      [searchBody(input, input.coordinate)],
      { maxServerErrorRetries: 0 },
    );
    // 40501 is a billed empty SERP, which some coordinate-only queries return.
    const task = assertOk(response, { treatNoResultsAsEmpty: true });
    return { items: parseMapItems(firstResultItems(task)), billing: buildTaskBilling(task) };
  }

  async lookupPlace(placeId: string): Promise<PlaceLookupResult | null> {
    const response = await this.request<TaskLike>(
      "POST",
      "/v3/business_data/google/my_business_info/live",
      // location is required by the endpoint; a place_id resolves regardless.
      [{ keyword: `place_id:${placeId}`, location_code: 2840, language_code: "en" }],
      { maxServerErrorRetries: 0 },
    );
    const task = assertOk(response, { treatNoResultsAsEmpty: true });
    const billing = buildTaskBilling(task);
    const items = firstResultItems(task);
    const item = (Array.isArray(items) ? items[0] : undefined) as Record<string, unknown> | undefined;
    const lat = Number(item?.latitude);
    const lng = Number(item?.longitude);
    if (!item || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
    return {
      place: { placeId: str(item.place_id), name: str(item.title), address: str(item.address), lat, lng, cid: str(item.cid), category: str(item.category), domain: str(item.domain) },
      billing,
    };
  }

  private async request<T extends TaskLike>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<ResponseLike<T> | null> {
    const maxRetries = options.maxServerErrorRetries ?? MAX_RETRIES;
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: {
            Authorization: `Basic ${this.apiKey}`,
            Accept: "application/json",
            ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
          },
          body: method === "POST" ? JSON.stringify(body) : undefined,
          signal,
        });
      } catch (error) {
        if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
          // May already be billed, so deliberately not retried.
          throw new AppError("UPSTREAM_UNAVAILABLE", `DataForSEO request timed out on ${path}`);
        }
        throw error;
      }
      if (response.ok) {
        const text = await response.text();
        return text === "" ? null : (JSON.parse(text) as ResponseLike<T>);
      }
      if (response.status >= 500 && attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS * (attempt + 1)));
        continue;
      }
      const code: ErrorCode =
        response.status >= 500
          ? "UPSTREAM_UNAVAILABLE"
          : response.status === 429
            ? "RATE_LIMITED"
            : response.status === 401
              ? "DATAFORSEO_AUTH_FAILED"
              : "INTERNAL_ERROR";
      if (code === "DATAFORSEO_AUTH_FAILED") {
        throw new AppError(code, "DataForSEO rejected the API key. Check the DataForSEO login and password saved for this app.");
      }
      throw new AppError(code, `DataForSEO HTTP ${response.status} on ${path}`);
    }
  }
}

function searchBody(input: Omit<LiveSearchInput, "coordinate" | "mockHints">, coordinate: string) {
  return {
    keyword: input.keyword,
    location_coordinate: coordinate,
    language_code: input.languageCode,
    device: input.device,
    os: input.device === "desktop" ? "windows" : "android",
    depth: input.depth,
    // Maps only: skip the "places" sub-search so results stay one flat list,
    // and rank like a fresh search from this spot. DataForSEO defaults to
    // search_this_area=true, which only lists businesses pinned inside the
    // zoom-15 viewport (a few hundred metres), so most nearby service-area
    // businesses were dropped and the tracked business looked "not found".
    ...(input.searchType === "maps" ? { search_places: false, search_this_area: false } : {}),
  };
}

function taskBodies(input: PostTasksInput) {
  return input.coordinates.map((coordinate, index) => ({
    ...searchBody(input, coordinate),
    priority: QUEUE_PRIORITY[input.queue],
    // Echoed back on each entry so ids map to points without relying on order.
    tag: String(index),
  }));
}

