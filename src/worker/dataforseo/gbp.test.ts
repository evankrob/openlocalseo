import { describe, expect, it, vi } from "vitest";
import profileFixture from "./fixtures/business-info-live.json";
import postFixture from "./fixtures/reviews-task-post.json";
import readyFixture from "./fixtures/reviews-task-get-ready.json";
import pendingFixture from "./fixtures/maps-task-get-pending.json";
import { HttpDataForSeo } from "./http";
import { MockDataForSeo } from "./mock";
import { parseBusinessProfile, parseReviewItems, reviewsTaskToOutcome } from "./parse";
import type { TaskLike } from "./envelope";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function httpWith(...responses: Response[]) {
  const fetchImpl = vi.fn<typeof fetch>();
  for (const r of responses) fetchImpl.mockResolvedValueOnce(r);
  return { client: new HttpDataForSeo("dGVzdDp0ZXN0", "https://dfs.test", fetchImpl), fetchImpl };
}

const PLACE = "ChIJi_IC309ZrIkRH3MyjF43V84";

describe("business profile parsing (recorded fixture)", () => {
  it("reads rating, review count, distribution, claimed, photos, categories, phone and domain", () => {
    const items = profileFixture.tasks[0].result[0].items;
    expect(parseBusinessProfile(items)).toEqual({
      placeId: PLACE,
      name: "Carolina Wildlife Removal",
      address: "5640 Quail Covey Ln, Wendell, NC 27591",
      cid: "14868413574005551903",
      category: "Pest control service",
      additionalCategories: ["Animal control service", "Wildlife rescue service"],
      rating: 4.7,
      reviewCount: 197,
      ratingDistribution: { "1": 13, "2": 1, "3": 2, "4": 6, "5": 175 },
      isClaimed: true,
      totalPhotos: 44,
      phone: "+1919-896-4278",
      domain: "carolinawildliferemoval.com",
    });
  });

  it("returns null for an empty result and tolerates missing optional fields", () => {
    expect(parseBusinessProfile([])).toBeNull();
    expect(parseBusinessProfile([{ title: "Bare" }])).toMatchObject({
      name: "Bare",
      rating: null,
      reviewCount: null,
      ratingDistribution: null,
      isClaimed: null,
      additionalCategories: [],
    });
  });
});

describe("reviews parsing (recorded fixture)", () => {
  const task = readyFixture.tasks[0] as unknown as TaskLike;

  it("normalizes reviews newest first and never keeps reviewer links or images", () => {
    const outcome = reviewsTaskToOutcome(task);
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") return;
    expect(outcome.reviewCount).toBe(197);
    expect(outcome.rating).toBe(4.7);
    expect(outcome.reviews.map((r) => r.publishedAt)).toEqual([
      "2026-10-14T17:05:36.000Z",
      "2026-10-12T23:13:42.000Z",
      "2026-10-05T18:07:15.000Z",
      "2026-10-02T19:44:19.000Z",
    ]);
    expect(outcome.reviews[0]).toMatchObject({
      rating: 4,
      text: "Sample review text 1.",
      profileName: "Reviewer 1",
      ownerAnsweredAt: "2026-10-19T16:25:54.000Z",
    });
    expect(outcome.reviews[0].ownerAnswer).toContain("warranties");
    expect(outcome.reviews[2].text).toBeNull();
    for (const review of outcome.reviews) {
      expect(Object.keys(review).sort()).toEqual(["ownerAnswer", "ownerAnsweredAt", "profileName", "publishedAt", "rating", "reviewId", "text"]);
    }
  });

  it("treats an unanswered review as unanswered and skips items without id, stars or date", () => {
    const reviews = parseReviewItems([
      { type: "google_reviews_search", review_id: "a", rating: { value: 3 }, timestamp: "2026-10-01 10:00:00 +00:00", owner_answer: null, owner_timestamp: null },
      { type: "google_reviews_search", review_id: "b", rating: { value: null }, timestamp: "2026-10-01 10:00:00 +00:00" },
      { type: "google_reviews_search", review_id: "c", rating: { value: 5 }, timestamp: "garbage" },
      { type: "google_reviews_search", rating: { value: 5 }, timestamp: "2026-10-01 10:00:00 +00:00" },
      { type: "something_else", review_id: "d", rating: { value: 5 }, timestamp: "2026-10-01 10:00:00 +00:00" },
    ]);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ reviewId: "a", ownerAnswer: null, ownerAnsweredAt: null });
  });

  it("in-progress statuses are pending, other statuses fail, and no results is an empty success", () => {
    expect(reviewsTaskToOutcome(pendingFixture.tasks[0] as unknown as TaskLike)).toEqual({ status: "pending" });
    expect(reviewsTaskToOutcome({ status_code: 40602 })).toEqual({ status: "pending" });
    expect(reviewsTaskToOutcome({ status_code: 40501, status_message: "Invalid Field: 'depth'." })).toMatchObject({ status: "failed" });
    expect(reviewsTaskToOutcome({ status_code: 40501, status_message: "No Search Results." })).toEqual({ status: "completed", reviews: [], reviewCount: 0, rating: null });
  });
});

describe("HttpDataForSeo GBP calls (stubbed fetch, no network)", () => {
  it("getBusinessProfile posts a place_id query to my_business_info and returns profile plus billing", async () => {
    const { client, fetchImpl } = httpWith(json(profileFixture));
    const result = await client.getBusinessProfile({ placeId: PLACE });
    expect(result.profile).toMatchObject({ rating: 4.7, reviewCount: 197, isClaimed: true, totalPhotos: 44 });
    expect(result.billing).toEqual({ path: ["v3", "business_data", "google", "my_business_info", "live"], costUsd: 0.0054 });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://dfs.test/v3/business_data/google/my_business_info/live");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init!.body as string)).toEqual([{ keyword: `place_id:${PLACE}`, location_code: 2840, language_code: "en" }]);
  });

  it("getBusinessProfile is null when Google has no such place, and never retries a billed call on a 5xx", async () => {
    const empty = { status_code: 20000, tasks: [{ status_code: 20000, cost: 0.0054, path: ["v3"], result: [{ items: [] }] }] };
    // An empty answer is still billed, so the cost is not lost.
    expect(await httpWith(json(empty)).client.getBusinessProfile({ placeId: "ChIJnone" })).toEqual({ profile: null, billing: { path: ["v3"], costUsd: 0.0054 } });
    const { client, fetchImpl } = httpWith(new Response("", { status: 503 }), json(profileFixture));
    await expect(client.getBusinessProfile({ placeId: PLACE })).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("postReviewsTask sends depth 20 newest-first and returns the task id and the billed cost", async () => {
    const { client, fetchImpl } = httpWith(json(postFixture));
    const posted = await client.postReviewsTask({ placeId: PLACE, depth: 20 });
    expect(posted.taskId).toBe("10241625-1468-0298-0000-2ea770d98c71");
    expect(posted.billing).toEqual({ path: ["v3", "business_data", "google", "reviews", "task_post"], costUsd: 0.0015 });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://dfs.test/v3/business_data/google/reviews/task_post");
    expect(JSON.parse(init!.body as string)).toEqual([
      { keyword: `place_id:${PLACE}`, location_code: 2840, language_code: "en", depth: 20, sort_by: "newest" },
    ]);
  });

  it("postReviewsTask is never replayed on a server error, and a rejected task carries its cost", async () => {
    const { client, fetchImpl } = httpWith(new Response("", { status: 500 }), json(postFixture));
    await expect(client.postReviewsTask({ placeId: PLACE, depth: 20 })).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const rejected = { status_code: 20000, tasks: [{ status_code: 40501, status_message: "Invalid Field.", cost: 0.0015, path: ["v3", "business_data", "google", "reviews", "task_post"] }] };
    await expect(httpWith(json(rejected)).client.postReviewsTask({ placeId: PLACE, depth: 20 })).rejects.toMatchObject({
      billing: { costUsd: 0.0015 },
    });
  });

  it("getReviewsTask reads the task by id: pending first, then the reviews", async () => {
    const pending = { status_code: 20000, tasks: [{ status_code: 40602, status_message: "Task In Queue." }] };
    const { client, fetchImpl } = httpWith(json(pending), json(readyFixture));
    expect(await client.getReviewsTask("abc 1")).toEqual({ status: "pending" });
    const done = await client.getReviewsTask("abc 1");
    expect(done.status === "completed" && done.reviews).toHaveLength(4);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://dfs.test/v3/business_data/google/reviews/task_get/abc%201");
    expect(init?.method).toBe("GET");
  });
});

describe("MockDataForSeo GBP calls", () => {
  const clock = { now: Date.UTC(2026, 9, 14, 12) };
  const mock = () => new MockDataForSeo({ now: () => clock.now, delaysMs: { standard: 10_000, priority: 1000 } });
  const hints = { target: { name: "Maple & Ember", placeId: "ChIJmock1", domain: "m.example", category: "Coffee shop", lat: 35.78, lng: -78.64 } };

  it("serves a deterministic profile that matches the mock market's numbers for a tracked business", async () => {
    const a = await mock().getBusinessProfile({ placeId: "ChIJmock1", mockHints: hints });
    const b = await mock().getBusinessProfile({ placeId: "ChIJmock1", mockHints: hints });
    expect(a).toEqual(b);
    expect(a.profile).toMatchObject({ name: "Maple & Ember", category: "Coffee shop", isClaimed: true, domain: "m.example" });
    expect(a.profile!.reviewCount).toBeGreaterThan(412);
    expect(a.profile!.rating).toBeGreaterThan(4.5);
    expect(a.billing).toEqual({ path: ["v3", "business_data", "google", "my_business_info", "live"], costUsd: 0.0054 });
    const dist = a.profile!.ratingDistribution!;
    expect(Object.values(dist).reduce((x, y) => x + y, 0)).toBe(a.profile!.reviewCount);
  });

  it("returns no profile (still billed) for an unknown place", async () => {
    expect(await mock().getBusinessProfile({ placeId: "ChIJunknown" })).toMatchObject({ profile: null, billing: { costUsd: 0.0054 } });
  });

  it("bills the reviews post per 10 reviews and is pending until the queue delay passes", async () => {
    const m = mock();
    const posted = await m.postReviewsTask({ placeId: "ChIJmock1", depth: 20, mockHints: hints });
    expect(posted.billing).toEqual({ path: ["v3", "business_data", "google", "reviews", "task_post"], costUsd: 0.0015 });
    expect((await m.postReviewsTask({ placeId: "ChIJmock1", depth: 10 })).billing.costUsd).toBe(0.00075);
    expect(await m.getReviewsTask(posted.taskId)).toEqual({ status: "pending" });
    clock.now += 10_000;
    const outcome = await m.getReviewsTask(posted.taskId);
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") return;
    expect(outcome.reviews).toHaveLength(20);
    const dates = outcome.reviews.map((r) => r.publishedAt);
    expect([...dates].sort().reverse()).toEqual(dates);
    expect(new Set(outcome.reviews.map((r) => r.reviewId)).size).toBe(20);
    expect(await m.getReviewsTask("not-a-mock-id")).toMatchObject({ status: "failed" });
  });

  it("is consistent over time: a later task returns the same older reviews plus newer ones", async () => {
    const m = mock();
    const first = await m.postReviewsTask({ placeId: "ChIJmock1", depth: 20 });
    clock.now += 40 * 86_400_000;
    const second = await m.postReviewsTask({ placeId: "ChIJmock1", depth: 20 });
    clock.now += 20_000;
    const a = await m.getReviewsTask(first.taskId);
    const b = await m.getReviewsTask(second.taskId);
    if (a.status !== "completed" || b.status !== "completed") throw new Error("expected completed");
    const ids = new Set(b.reviews.map((r) => r.reviewId));
    expect(b.reviews[0].publishedAt > a.reviews[0].publishedAt).toBe(true);
    const sharedWithBoth = a.reviews.filter((r) => ids.has(r.reviewId));
    for (const r of sharedWithBoth) expect(b.reviews.find((x) => x.reviewId === r.reviewId)?.text).toBe(r.text);
    expect(b.reviewCount!).toBeGreaterThan(a.reviewCount!);
  });
});
