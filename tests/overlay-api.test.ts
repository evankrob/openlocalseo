// Competitor overlay over HTTP: default selection from a real (mock-provider)
// scan, per-tracker pin/hide persistence with the 10-pin limit enforced server
// side, tenant isolation, expired results, and the stored phone.
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { at, must } from "@/shared/assert";
import { MAX_PINNED } from "@/shared/overlay";
import { scanResults, scans } from "@/worker/db/schema";
import { createHarness } from "./helpers/harness";
import { business, client } from "./helpers/http";

type Competitor = {
  identity: string;
  name: string;
  source: string;
  metrics: { atrp: number; solv: number; foundPoints: number; top3Points: number; totalPoints: number };
  headToHead: { wins: number; losses: number; ties: number; neither: number };
  ranks: Array<number | null>;
  possibleDuplicateOf: string[];
};

async function setup() {
  const h = await createHarness({ env: { AUTH_MODE: "hosted" } });
  const a = client(h);
  const b = client(h);
  await a.call("POST", "/api/auth/signup", { email: "a@example.com", password: "correct horse battery" });
  await b.call("POST", "/api/auth/signup", { email: "b@example.com", password: "another long password" });
  const biz = await a.call("POST", "/api/businesses", business);
  const tracker = await a.call("POST", "/api/trackers", { businessId: biz.json.id, keyword: "coffee shop", gridSize: 5 });
  const trackerId = tracker.json.id as string;
  const run = await a.call("POST", `/api/trackers/${trackerId}/scans`, {});
  await h.queue.drain(h.deps);
  return { h, a, b, trackerId, scanId: run.json.scanId as string };
}

const identityOf = (n: number) => `p:ChIJpin${String(n).padStart(2, "0")}`;
const pin = (n: number) => ({ identity: identityOf(n), name: `Pin ${n}`, status: "pinned" });

describe("GET /api/scans/:id/overlay", () => {
  let t: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    t = await setup();
  });

  it("returns the default top 5, never the client, with metrics, head-to-head and per-point top lists", async () => {
    const res = await t.a.call("GET", `/api/scans/${t.scanId}/overlay`);
    expect(res.status).toBe(200);
    const overlay = res.json;
    expect(overlay.expired).toBe(false);
    expect(overlay.pointIds).toHaveLength(25);
    expect(overlay.clientRanks).toHaveLength(25);
    const competitors = overlay.competitors as Competitor[];
    expect(competitors).toHaveLength(5);
    expect(competitors.every((c) => c.source === "default")).toBe(true);
    expect(competitors.map((c) => c.name)).not.toContain(business.name);
    // ordered by top-3 appearances, ties by average rank
    const order = competitors.map((c) => [c.metrics.top3Points, -c.metrics.atrp]);
    expect(order).toEqual([...order].sort((x, y) => (y[0] ?? 0) - (x[0] ?? 0) || (y[1] ?? 0) - (x[1] ?? 0)));
    for (const c of competitors) {
      expect(c.ranks).toHaveLength(25);
      expect(c.metrics.totalPoints).toBe(25);
      expect(c.metrics.foundPoints).toBe(c.ranks.filter((r) => r !== null).length);
      const { wins, losses, ties, neither } = c.headToHead;
      expect(wins + losses + ties + neither).toBe(25);
    }
    expect(overlay.pointTop).toHaveLength(25);
    const firstPointTop = at(overlay.pointTop as unknown[][], 0);
    expect(firstPointTop.length).toBeLessThanOrEqual(5);
    expect(firstPointTop.length).toBeGreaterThan(0);
  });

  it("flags the mock market's near-duplicate listing pair (same phone, near-identical name) without merging it", async () => {
    const first = (await t.a.call("GET", `/api/scans/${t.scanId}/overlay`)).json;
    const everyone = first.candidates as Array<{ identity: string; name: string }>;
    const twin = must(everyone.find((c) => c.name.endsWith(" LLC")), "a generated twin listing");
    const base = must(everyone.find((c) => c.name === twin.name.replace(/ LLC$/, "")), "its original");
    for (const c of [twin, base]) await t.a.call("PUT", `/api/trackers/${t.trackerId}/competitors`, { identity: c.identity, name: c.name, status: "pinned" });
    const shown = ((await t.a.call("GET", `/api/scans/${t.scanId}/overlay`)).json.competitors as Competitor[]).filter((c) => [twin.identity, base.identity].includes(c.identity));
    expect(shown).toHaveLength(2); // two separate listings
    expect(must(shown.find((c) => c.identity === twin.identity), "twin").possibleDuplicateOf).toEqual([base.name]);
    expect(must(shown.find((c) => c.identity === base.identity), "base").possibleDuplicateOf).toEqual([twin.name]);
  });

  it("stores each listing's phone, and the overlay is rebuilt from stored rows (no provider)", async () => {
    const rows = await t.h.db.select({ phone: scanResults.phone }).from(scanResults).where(eq(scanResults.scanId, t.scanId));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => /^\(\d{3}\) 555-\d{4}$/.test(r.phone ?? ""))).toBe(true);
    const before = t.h.queue.messages.length;
    await t.a.call("GET", `/api/scans/${t.scanId}/overlay`);
    expect(t.h.queue.messages.length).toBe(before);
  });

  it("answers expired (not empty) once retention pruned the scan's results", async () => {
    await t.h.db.update(scans).set({ resultsPrunedAt: "2026-01-01T00:00:00.000Z" }).where(eq(scans.id, t.scanId));
    await t.h.db.delete(scanResults).where(eq(scanResults.scanId, t.scanId));
    const overlay = (await t.a.call("GET", `/api/scans/${t.scanId}/overlay`)).json;
    expect(overlay).toMatchObject({ expired: true, competitors: [], pointTop: [] });
  });

  it("404s for another workspace and for an unknown scan", async () => {
    expect((await t.b.call("GET", `/api/scans/${t.scanId}/overlay`)).status).toBe(404);
    expect((await t.a.call("GET", "/api/scans/nonexistent/overlay")).status).toBe(404);
  });
});

describe("pinning and hiding competitors", () => {
  let t: Awaited<ReturnType<typeof setup>>;
  const put = (body: unknown, who = t.a) => who.call("PUT", `/api/trackers/${t.trackerId}/competitors`, body);
  const settings = async () => (await t.a.call("GET", `/api/trackers/${t.trackerId}/competitors`)).json;
  beforeEach(async () => {
    t = await setup();
  });

  it("persists pins and hides per tracker, and they apply to the overlay of every scan", async () => {
    const overlay = (await t.a.call("GET", `/api/scans/${t.scanId}/overlay`)).json;
    const [top, , third] = overlay.competitors as Competitor[];
    expect((await put({ identity: must(top, "top").identity, name: must(top, "top").name, status: "hidden" })).json.hidden).toHaveLength(1);
    const pinTarget = at(overlay.candidates as Array<{ identity: string; name: string; state: string }>, 12);
    expect(pinTarget.state).toBe("available");
    expect((await put({ identity: pinTarget.identity, name: pinTarget.name, status: "pinned" })).json.pinned).toEqual([{ identity: pinTarget.identity, name: pinTarget.name }]);

    expect(await settings()).toMatchObject({ maxPinned: MAX_PINNED, hidden: [{ identity: must(top, "top").identity }], pinned: [{ identity: pinTarget.identity }] });

    // a second scan of the same tracker sees the same choices
    const second = await t.a.call("POST", `/api/trackers/${t.trackerId}/scans`, {});
    await t.h.queue.drain(t.h.deps);
    for (const scanId of [t.scanId, second.json.scanId as string]) {
      const shown = (await t.a.call("GET", `/api/scans/${scanId}/overlay`)).json.competitors as Competitor[];
      expect(shown.map((c) => c.identity)).not.toContain(must(top, "top").identity);
      expect(shown.at(-1)).toMatchObject({ identity: pinTarget.identity, source: "pinned" });
      expect(shown.filter((c) => c.source === "default")).toHaveLength(5); // the hidden one was replaced
      expect(shown.map((c) => c.identity)).toContain(must(third, "third").identity);
    }

    // default = remove the choice
    await put({ identity: must(top, "top").identity, name: "x", status: "default" });
    expect((await settings()).hidden).toEqual([]);
  });

  it("allows 10 pins and rejects the 11th with a validation error, server side", async () => {
    for (let n = 1; n <= MAX_PINNED; n++) expect((await put(pin(n))).status).toBe(200);
    const eleventh = await put(pin(11));
    expect(eleventh.status).toBe(400);
    expect(eleventh.json.error.code).toBe("VALIDATION_ERROR");
    expect((await settings()).pinned).toHaveLength(MAX_PINNED);
    // re-pinning an existing pin is fine; unpinning one makes room
    expect((await put(pin(3))).status).toBe(200);
    await put({ ...pin(3), status: "default" });
    expect((await put(pin(11))).status).toBe(200);
    // hiding a pinned competitor moves it out of the pins too
    await put({ ...pin(4), status: "hidden" });
    const s = await settings();
    expect(s.pinned).toHaveLength(MAX_PINNED - 1);
    expect(s.hidden).toEqual([{ identity: identityOf(4), name: "Pin 4" }]);
  });

  it("validates the body: identities must be a place id or cid", async () => {
    expect((await put({ identity: "r:some-row", name: "x", status: "pinned" })).status).toBe(400);
    expect((await put({ identity: "Joe's Coffee", name: "x", status: "pinned" })).status).toBe(400);
    expect((await put({ identity: "p:abc", name: "x", status: "starred" })).status).toBe(400);
    expect((await put({ identity: "p:abc", name: "", status: "pinned" })).status).toBe(400);
  });

  it("is workspace scoped: another workspace gets 404 and changes nothing", async () => {
    expect((await put(pin(1), t.b)).status).toBe(404);
    expect((await t.b.call("GET", `/api/trackers/${t.trackerId}/competitors`)).status).toBe(404);
    expect((await settings()).pinned).toEqual([]);
    // B's own tracker is separate: the same identity can be pinned there
    const biz = await t.b.call("POST", "/api/businesses", { ...business, placeId: "ChIJdemoOtherB" });
    const other = await t.b.call("POST", "/api/trackers", { businessId: biz.json.id, keyword: "coffee shop", gridSize: 3 });
    expect((await t.b.call("PUT", `/api/trackers/${other.json.id}/competitors`, pin(1))).status).toBe(200);
    expect((await settings()).pinned).toEqual([]);
  });
});
