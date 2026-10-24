import { describe, expect, it, vi } from "vitest";
import readyFixture from "./fixtures/maps-task-get-ready.json";
import finderFixture from "./fixtures/local-finder-task-get-ready.json";
import pendingFixture from "./fixtures/maps-task-get-pending.json";
import noResultsFixture from "./fixtures/maps-task-get-no-results.json";
import failedFixture from "./fixtures/maps-task-get-failed.json";
import postFixture from "./fixtures/maps-task-post.json";
import liveFixture from "./fixtures/maps-live-advanced.json";
import { HttpDataForSeo } from "./http";
import { MockDataForSeo } from "./mock";
import { createDataForSeo } from "./index";
import { at } from "@/shared/assert";
import { buildGrid,formatLocationCoordinate } from "@/shared/grid";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function httpWith(...responses: Response[]) {
  const fetchImpl = vi.fn<typeof fetch>();
  for (const r of responses) fetchImpl.mockResolvedValueOnce(r);
  return { client: new HttpDataForSeo("dGVzdDp0ZXN0", "https://dfs.test", fetchImpl), fetchImpl };
}

describe("HttpDataForSeo against recorded-shape fixtures (no network)", () => {
  it("postTasks maps task ids back to coordinates by tag and sums reported cost", async () => {
    const { client, fetchImpl } = httpWith(json(postFixture));
    const result = await client.postTasks({
      keyword: "coffee shop",
      searchType: "maps",
      coordinates: ["1,1,15z", "2,2,15z", "3,3,15z"],
      languageCode: "en",
      device: "mobile",
      depth: 20,
      queue: "standard",
    });
    expect(result.taskIds).toEqual(postFixture.tasks.map((t) => t.id));
    expect(result.billing.costUsd).toBeCloseTo(0.0018, 6);
    expect(result.billing.path).toEqual(["v3", "serp", "google", "maps", "task_post"]);

    const [url, init] = at(fetchImpl.mock.calls, 0);
    expect(url).toBe("https://dfs.test/v3/serp/google/maps/task_post");
    expect(init?.headers).toMatchObject({ Authorization: "Basic dGVzdDp0ZXN0" });
    const body = JSON.parse(init!.body as string);
    expect(body).toHaveLength(3);
    expect(body[1]).toMatchObject({ location_coordinate: "2,2,15z", priority: 1, tag: "1", search_places: false, search_this_area: false });
  });

  it("uses priority 2 for the priority queue and the local_finder path for Local Finder", async () => {
    const { client, fetchImpl } = httpWith(json(postFixture));
    await client.postTasks({ keyword: "k", searchType: "local_finder", coordinates: ["1,1,15z"], languageCode: "en", device: "desktop", depth: 20, queue: "priority" });
    const [url, init] = at(fetchImpl.mock.calls, 0);
    expect(url).toBe("https://dfs.test/v3/serp/google/local_finder/task_post");
    expect(JSON.parse(init!.body as string)[0]).toMatchObject({ priority: 2, os: "windows" });
    expect(JSON.parse(init!.body as string)[0]).not.toHaveProperty("search_places");
    expect(JSON.parse(init!.body as string)[0]).not.toHaveProperty("search_this_area");
  });

  it("refuses more than 100 tasks in one post", async () => {
    const { client } = httpWith();
    await expect(
      client.postTasks({ keyword: "k", searchType: "maps", coordinates: Array(101).fill("1,1,15z"), languageCode: "en", device: "mobile", depth: 20, queue: "standard" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("getTask returns normalized businesses, skipping paid items", async () => {
    const { client } = httpWith(json(readyFixture));
    const outcome = await client.getTask("maps", "task-1");
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") return;
    expect(outcome.items.map((i) => i.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(outcome.items[0]).toMatchObject({
      name: "Maple & Ember Coffee Roasters",
      placeId: "ChIJdemo0000000000000001",
      rating: 4.8,
      ratingCount: 412,
      category: "Coffee shop",
      domain: "mapleember.example",
    });
    expect(outcome.items.some((i) => i.name.startsWith("Sponsored"))).toBe(false);
  });

  it("parses Local Finder items", async () => {
    const { client } = httpWith(json(finderFixture));
    const outcome = await client.getTask("local_finder", "t");
    expect(outcome).toMatchObject({ status: "completed" });
  });

  it("maps pending / no-results / failed task statuses", async () => {
    const { client } = httpWith(json(pendingFixture), json(noResultsFixture), json(failedFixture));
    expect(await client.getTask("maps", "a")).toEqual({ status: "pending" });
    expect(await client.getTask("maps", "b")).toEqual({ status: "completed", items: [] });
    expect(await client.getTask("maps", "c")).toMatchObject({ status: "failed", message: "Internal SE Server Error." });
  });

  it("liveSearch reports the cost DataForSEO returned", async () => {
    const { client } = httpWith(json(liveFixture));
    const result = await client.liveSearch({ keyword: "k", searchType: "maps", coordinate: "1,1,15z", languageCode: "en", device: "mobile", depth: 20 });
    expect(result.billing).toEqual({ path: ["v3", "serp", "google", "maps", "live", "advanced"], costUsd: 0.002 });
    expect(result.items).toHaveLength(5);
  });

  it("does not replay a billed POST on a 5xx but retries an idempotent GET", async () => {
    const post = httpWith(new Response("boom", { status: 503 }), json(postFixture));
    await expect(
      post.client.postTasks({ keyword: "k", searchType: "maps", coordinates: ["1,1,15z"], languageCode: "en", device: "mobile", depth: 20, queue: "standard" }),
    ).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    expect(post.fetchImpl).toHaveBeenCalledTimes(1);

    const get = httpWith(new Response("boom", { status: 503 }), json(readyFixture));
    expect((await get.client.getTask("maps", "x")).status).toBe("completed");
    expect(get.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("classifies 401 and 429", async () => {
    const { client } = httpWith(new Response("no", { status: 401 }), new Response("slow", { status: 429 }));
    await expect(client.getTask("maps", "x")).rejects.toMatchObject({ code: "DATAFORSEO_AUTH_FAILED" });
    await expect(client.getTask("maps", "x")).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });
});

describe("MockDataForSeo", () => {
  const center = { lat: 35.7796, lng: -78.6382 };
  const target = { name: "Test Roasters", placeId: "ChIJtest1", domain: "testroasters.example", ...center };
  const base = { keyword: "coffee shop", searchType: "maps" as const, languageCode: "en", device: "mobile" as const, depth: 20 };

  it("is pending until the queue delay elapses, then returns results, costing the standard price per task", async () => {
    let now = 1_000_000;
    const mock = new MockDataForSeo({ now: () => now, delaysMs: { standard: 10_000, priority: 2_000 }, target });
    const { taskIds, billing } = await mock.postTasks({ ...base, coordinates: [formatLocationCoordinate(center, 15)], queue: "standard" });
    expect(billing.costUsd).toBe(0.0006);
    expect(await mock.getTask("maps", taskIds[0]!)).toEqual({ status: "pending" });
    now += 9_999;
    expect((await mock.getTask("maps", taskIds[0]!)).status).toBe("pending");
    now += 1;
    const outcome = await mock.getTask("maps", taskIds[0]!);
    expect(outcome.status).toBe("completed");
  });

  it("priority queue is ready sooner than standard", async () => {
    let now = 0;
    const mock = new MockDataForSeo({ now: () => now, delaysMs: { standard: 10_000, priority: 2_000 }, target });
    const { taskIds }= await mock.postTasks({ ...base, coordinates: ["1,1,15z"], queue: "priority" });
    now = 2_000;
    expect((await mock.getTask("maps", taskIds[0]!)).status).toBe("completed");
  });

  it("is deterministic and lists the target near its home but loses it far away", async () => {
    const mock = new MockDataForSeo({ delaysMs: { standard: 0, priority: 0 }, target });
    const grid = buildGrid({ centerLat: center.lat, centerLng: center.lng, size: 13, radiusKm: 10 });
    const coords = grid.map((p) => formatLocationCoordinate(p, 15));
    const { taskIds } = await mock.postTasks({ ...base, coordinates: coords, queue: "standard" });
    const run = async () => {
      const ranks: Array<number | null> = [];
      for (const id of taskIds) {
        const outcome = await mock.getTask("maps", id!);
        if (outcome.status !== "completed") throw new Error("expected completed");
        ranks.push(outcome.items.find((i) => i.placeId === "ChIJtest1")?.rank ?? null);
      }
      return ranks;
    };
    const first = await run();
    expect(await run()).toEqual(first);
    expect(first[84]).toBeLessThanOrEqual(3); // center of 13x13
    expect(first.filter((r) => r === null).length).toBeGreaterThan(10); // fades out toward the edges
    expect(first.filter((r) => r !== null).length).toBeGreaterThan(40);
  });

  it("serves failure injection and rejects foreign task ids", async () => {
    const mock = new MockDataForSeo({ delaysMs: { standard: 0, priority: 0 }, shouldFail: (c) => c.startsWith("9,"), target });
    const { taskIds } = await mock.postTasks({ ...base, coordinates: ["9,9,15z"], queue: "standard" });
    expect(await mock.getTask("maps", taskIds[0]!)).toMatchObject({ status: "failed" });
    expect(await mock.getTask("maps", "not-a-mock-id")).toMatchObject({ status: "failed" });
  });

  it("live search costs the live price and returns Local Finder items too", async () => {
    const mock = new MockDataForSeo({ target });
    const result = await mock.liveSearch({ ...base, searchType: "local_finder", coordinate: "35.7796,-78.6382,15z" });
    expect(result.billing.costUsd).toBe(0.002);
    expect(result.items.length).toBeGreaterThan(5);
  });
});

describe("createDataForSeo", () => {
  it("defaults to the mock and never reaches live without a key", () => {
    expect(createDataForSeo({}).mode).toBe("mock");
    expect(createDataForSeo({ DATAFORSEO_API_KEY: "abc" }).mode).toBe("mock");
    expect(() => createDataForSeo({ DATAFORSEO_MODE: "live" })).toThrow(/DATAFORSEO_API_KEY/);
    expect(createDataForSeo({ DATAFORSEO_MODE: "live", DATAFORSEO_API_KEY: "test:test" }).mode).toBe("live");
  });
});

describe("HttpDataForSeo.lookupPlace", () => {
  const envelope = (items: unknown[] | null) => ({
    status_code: 20000,
    tasks: [{ status_code: 20000, status_message: "Ok.", cost: 0.0054, path: ["v3", "business_data", "google", "my_business_info", "live"], result: [{ items }] }],
  });
  it("returns coordinates and details for a place ID via my_business_info", async () => {
    const { client, fetchImpl } = httpWith(json(envelope([{ title: "Google Sydney", address: "48 Pirrama Rd", latitude: -33.86, longitude: 151.19, cid: "1028", category: "Office", domain: "google.com" }])));
    const found = await client.lookupPlace("ChIJN1t_tDeuEmsRUsoyG83frY4");
    expect(found?.place).toMatchObject({ name: "Google Sydney", address: "48 Pirrama Rd", lat: -33.86, lng: 151.19, cid: "1028" });
    expect(found?.billing.costUsd).toBeCloseTo(0.0054, 6);
    const [url, init] = at(fetchImpl.mock.calls, 0);
    expect(url).toBe("https://dfs.test/v3/business_data/google/my_business_info/live");
    expect(JSON.parse(init!.body as string)[0]).toMatchObject({ keyword: "place_id:ChIJN1t_tDeuEmsRUsoyG83frY4" });
  });
  it("returns null when the place has no coordinates", async () => {
    const { client } = httpWith(json(envelope([])));
    expect(await client.lookupPlace("ChIJnothing")).toBeNull();
  });
});

describe("auth failures", () => {
  it("explains a rejected API key in plain words", async () => {
    const { client } = httpWith(new Response("", { status: 401 }));
    await expect(client.lookupPlace("ChIJx")).rejects.toThrow(/DataForSEO rejected the API key/);
  });
});

describe("normalizeDataForSeoKey", () => {
  it("accepts base64 or raw login:password and always returns single base64", async () => {
    const { normalizeDataForSeoKey } = await import("./index");
    expect(normalizeDataForSeoKey("test:test")).toBe("dGVzdDp0ZXN0");
    expect(normalizeDataForSeoKey(" dGVzdDp0ZXN0\n")).toBe("dGVzdDp0ZXN0");
    expect(() => normalizeDataForSeoKey("[REDACTED]")).toThrow(/not in a usable form/);
  });
});
