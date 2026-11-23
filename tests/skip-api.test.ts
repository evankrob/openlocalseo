// HTTP-level tests for the skip feature: business type, service areas, the
// preview endpoints, tracker rules, scan/report output, and the MCP quote tool.
import { beforeEach, describe, expect, it } from "vitest";
import { at, must } from "@/shared/assert";
import { createHarness, type Harness } from "./helpers/harness";
import { client, mcpCall } from "./helpers/http";

const rodanthe = { name: "Outer Banks Towel Rental", placeId: "ChIJdemoOuterBanks00001", lat: 35.6, lng: -75.47 };
const raleigh = { name: "Capital City Plumbing", placeId: "ChIJdemoCapitalPlumb001", lat: 35.78, lng: -78.64 };
const coastalTracker = (businessId: string) => ({ businessId, keyword: "beach towel rental", gridSize: 7, radius: { value: 15, unit: "km" } });

/** A box around a point: test data only, not the boundary of any real place. */
function box(lat: number, lng: number, halfKm: number) {
  const dLat = halfKm / 111.32;
  const dLng = dLat / Math.cos((lat * Math.PI) / 180);
  return { type: "Polygon", coordinates: [[[lng - dLng, lat - dLat], [lng + dLng, lat - dLat], [lng + dLng, lat + dLat], [lng - dLng, lat + dLat], [lng - dLng, lat - dLat]]] };
}

describe("skip rules over HTTP (local_noauth)", () => {
  let h: Harness;
  let c: ReturnType<typeof client>;
  beforeEach(async () => {
    h = await createHarness({ env: { AUTH_MODE: "local_noauth" } });
    c = client(h);
  });

  it("businesses are storefronts by default and can be switched to service-area", async () => {
    const biz = await c.call("POST", "/api/businesses", raleigh);
    expect(biz.json.businessType).toBe("storefront");
    const sab = await c.call("POST", "/api/businesses", { ...raleigh, name: "Mobile Plumber", placeId: "ChIJdemoMobile00000001", businessType: "service_area" });
    expect(sab.json.businessType).toBe("service_area");

    const patched = await c.call("PATCH", `/api/businesses/${biz.json.id}`, { businessType: "service_area" });
    expect(patched.status).toBe(200);
    expect(patched.json.businessType).toBe("service_area");
    expect((await c.call("PATCH", `/api/businesses/${biz.json.id}`, { businessType: "restaurant" })).status).toBe(400);
    // unrelated patches leave it alone
    expect((await c.call("PATCH", `/api/businesses/${biz.json.id}`, { gbpTracking: false })).json.businessType).toBe("service_area");
  });

  describe("service areas", () => {
    it("starts empty; names are stored but 'not applied: no boundary data'", async () => {
      const biz = (await c.call("POST", "/api/businesses", { ...raleigh, businessType: "service_area" })).json;
      const empty = await c.call("GET", `/api/businesses/${biz.id}/service-area`);
      expect(empty.json).toMatchObject({ areas: [], businessType: "service_area", status: { applied: false, reason: "no_areas" } });
      expect(empty.json.boundarySource).toMatch(/TIGER/);

      const put = await c.call("PUT", `/api/businesses/${biz.id}/service-area`, { areas: [{ name: "Cary", kind: "city" }, { name: "27601", kind: "zip" }] });
      expect(put.status).toBe(200);
      expect(put.json.areas.map((a: { name: string; hasBoundary: boolean }) => [a.name, a.hasBoundary])).toEqual([["27601", false], ["Cary", false]]);
      expect(put.json.status).toMatchObject({ applied: false, reason: "missing_boundaries", missing: ["27601", "Cary"] });
    });

    it("accepts a boundary the user supplies, applies once every area has one, and never echoes the polygon", async () => {
      const biz = (await c.call("POST", "/api/businesses", { ...raleigh, businessType: "service_area" })).json;
      const put = await c.call("PUT", `/api/businesses/${biz.id}/service-area`, {
        areas: [{ name: "Test Box", kind: "city", source: "census_tiger", polygon: box(35.78, -78.64, 4) }],
      });
      expect(put.json.status).toMatchObject({ applied: true, reason: null, withBoundary: 1 });
      expect(put.json.areas[0]).toMatchObject({ hasBoundary: true, source: "census_tiger", boundaryVertices: 5 });
      expect(JSON.stringify(put.json)).not.toContain("coordinates");
      // an entry that omits its polygon keeps the stored boundary; null removes it
      const kept = await c.call("PUT", `/api/businesses/${biz.id}/service-area`, { areas: [{ name: "Test Box", kind: "city" }, { name: "Cary", kind: "city" }] });
      expect(kept.json.areas.map((a: { name: string; hasBoundary: boolean; source: string }) => [a.name, a.hasBoundary, a.source])).toEqual([["Cary", false, "manual"], ["Test Box", true, "census_tiger"]]);
      expect(kept.json.status).toMatchObject({ applied: false, reason: "missing_boundaries", missing: ["Cary"] });
      const removed = await c.call("PUT", `/api/businesses/${biz.id}/service-area`, { areas: [{ name: "Test Box", kind: "city", polygon: null }] });
      expect(removed.json.areas[0]).toMatchObject({ hasBoundary: false });
      // replacing the list replaces everything
      expect((await c.call("PUT", `/api/businesses/${biz.id}/service-area`, { areas: [] })).json.areas).toEqual([]);
    });

    it("rejects bad input", async () => {
      const biz = (await c.call("POST", "/api/businesses", raleigh)).json;
      const put = (areas: unknown) => c.call("PUT", `/api/businesses/${biz.id}/service-area`, { areas });
      expect((await put([{ name: "", kind: "city" }])).status).toBe(400);
      expect((await put([{ name: "X", kind: "planet" }])).status).toBe(400);
      expect((await put([{ name: "X", polygon: { type: "Point", coordinates: [0, 0] } }])).status).toBe(400);
      expect((await put([{ name: "X", polygon: { type: "Polygon", coordinates: [[[0, 0], [1, 1], [500, 1], [0, 0]]] } }])).status).toBe(400);
      expect((await put([{ name: "X", source: "gbp" }])).status).toBe(400);
      const twice = await put([{ name: "Cary", kind: "city" }, { name: "cary", kind: "city" }]);
      expect(twice.status).toBe(400);
      expect(twice.json.error.code).toBe("VALIDATION_ERROR");
      expect((await c.call("PUT", "/api/businesses/nope/service-area", { areas: [] })).status).toBe(404);
    });
  });

  describe("skip preview", () => {
    it("a coastal grid shows water skips and a quote for the scannable points only", async () => {
      const biz = (await c.call("POST", "/api/businesses", rodanthe)).json;
      const tracker = (await c.call("POST", "/api/trackers", coastalTracker(biz.id))).json;
      expect(tracker).toMatchObject({ autoSkipWater: true });

      const saved = await c.call("GET", `/api/trackers/${tracker.id}/skip-plan`);
      expect(saved.status).toBe(200);
      const { points, summary, quote } = saved.json;
      expect(points).toHaveLength(49);
      expect(summary.skippedPoints).toBeGreaterThan(10);
      expect(summary.byReason).toMatchObject({ outside_area: 0, user: 0 });
      expect(quote).toMatchObject({ points: summary.scannablePoints, skippedPoints: summary.skippedPoints, gridPoints: 49 });
      expect(quote.providerCostUsd).toBeCloseTo(summary.scannablePoints * 0.0006, 6);
      expect(points.every((p: { skip: string | null; auto: string | null }) => (p.skip === null) === (p.auto === null))).toBe(true);

      // The same grid, previewed before it is saved, gives the same plan.
      const unsaved = await c.call("POST", "/api/skip-preview", { businessId: biz.id, gridSize: 7, radius: { value: 15, unit: "km" }, queueMode: "standard" });
      expect(unsaved.status).toBe(200);
      expect(unsaved.json.points).toEqual(points);
      expect(unsaved.json.quote).toEqual(quote);

      // Water skipping off: everything is scanned and the quote is the full grid.
      const off = await c.call("POST", "/api/skip-preview", { businessId: biz.id, gridSize: 7, radius: { value: 15, unit: "km" }, autoSkipWater: false });
      expect(off.json.quote).toMatchObject({ points: 49, skippedPoints: 0 });
      // The estimate route is unchanged: it knows nothing about skipping.
      expect((await c.call("POST", "/api/estimate", { gridSize: 7, queueMode: "standard" })).json).toMatchObject({ points: 49, skippedPoints: 0 });
    });

    it("applies overrides from the request, and validates the body", async () => {
      const biz = (await c.call("POST", "/api/businesses", rodanthe)).json;
      const base = { businessId: biz.id, gridSize: 7, radius: { value: 15, unit: "km" } };
      const plain = (await c.call("POST", "/api/skip-preview", base)).json;
      const water = must(plain.points.find((p: { skip: string | null }) => p.skip === "water"), "water point");
      const withOverride = await c.call("POST", "/api/skip-preview", { ...base, skipOverrides: { include: [{ row: water.row, col: water.col }], exclude: [] } });
      expect(withOverride.json.summary.scannablePoints).toBe(plain.summary.scannablePoints + 1);
      expect(withOverride.json.points.find((p: { row: number; col: number }) => p.row === water.row && p.col === water.col)).toMatchObject({ skip: null, auto: "water", override: "include" });

      expect((await c.call("POST", "/api/skip-preview", { ...base, gridSize: 2 })).status).toBe(400);
      expect((await c.call("POST", "/api/skip-preview", { ...base, radius: { value: 500, unit: "km" } })).status).toBe(400);
      expect((await c.call("POST", "/api/skip-preview", { ...base, skipOverrides: { include: [{ row: 99, col: 0 }] } })).status).toBe(400);
      expect((await c.call("POST", "/api/skip-preview", { ...base, businessId: "nope" })).status).toBe(404);
    });

    it("service-area businesses: outside points are skipped only when every listed area has a boundary", async () => {
      const biz = (await c.call("POST", "/api/businesses", { ...raleigh, businessType: "service_area" })).json;
      const preview = () => c.call("POST", "/api/skip-preview", { businessId: biz.id, gridSize: 5, radius: { value: 8, unit: "km" }, autoSkipWater: false });
      expect((await preview()).json.summary.skippedPoints).toBe(0); // no service area listed

      await c.call("PUT", `/api/businesses/${biz.id}/service-area`, { areas: [{ name: "Cary", kind: "city" }] });
      const named = await preview();
      expect(named.json.summary.skippedPoints).toBe(0); // names without boundaries
      expect(named.json.serviceArea).toMatchObject({ applied: false, reason: "missing_boundaries" });

      await c.call("PUT", `/api/businesses/${biz.id}/service-area`, { areas: [{ name: "Test Box", kind: "city", polygon: box(35.78, -78.64, 4) }] });
      const applied = await preview();
      expect(applied.json.serviceArea.applied).toBe(true);
      expect(applied.json.summary.byReason.outside_area).toBeGreaterThan(0);
      expect(applied.json.quote.points).toBe(25 - applied.json.summary.skippedPoints);

      // The same boundary on a storefront skips nothing.
      await c.call("PATCH", `/api/businesses/${biz.id}`, { businessType: "storefront" });
      expect((await preview()).json.summary.skippedPoints).toBe(0);
    });

    it("a user-drawn exclusion is off by default and skips points inside it when enabled", async () => {
      const biz = (await c.call("POST", "/api/businesses", raleigh)).json;
      const body = { businessId: biz.id, gridSize: 5, radius: { value: 8, unit: "km" }, autoSkipWater: false };
      const circle = { type: "circle", lat: 35.78, lng: -78.64, radiusKm: 3 };
      expect((await c.call("POST", "/api/skip-preview", { ...body, exclusion: { enabled: false, shapes: [circle] } })).json.summary.skippedPoints).toBe(0);
      const on = await c.call("POST", "/api/skip-preview", { ...body, exclusion: { enabled: true, shapes: [circle] } });
      expect(on.json.summary.byReason.outside_area).toBe(1);
      expect((await c.call("POST", "/api/skip-preview", { ...body, exclusion: { enabled: true, shapes: [{ type: "circle", lat: 35.78, lng: -78.64, radiusKm: 0 }] } })).status).toBe(400);
    });
  });

  describe("tracker rules", () => {
    it("PATCH stores overrides, exclusion and the water toggle; a bad cell is rejected; a grid change clears overrides", async () => {
      const biz = (await c.call("POST", "/api/businesses", rodanthe)).json;
      const tracker = (await c.call("POST", "/api/trackers", coastalTracker(biz.id))).json;
      const plan = (await c.call("GET", `/api/trackers/${tracker.id}/skip-plan`)).json;
      const water = must(plan.points.find((p: { skip: string | null }) => p.skip === "water"), "water point");

      const patched = await c.call("PATCH", `/api/trackers/${tracker.id}`, {
        skipOverrides: { include: [{ row: water.row, col: water.col }], exclude: [] },
        exclusion: { enabled: true, shapes: [{ type: "circle", lat: 35.6, lng: -75.47, radiusKm: 1 }] },
      });
      expect(patched.status).toBe(200);
      const after = (await c.call("GET", `/api/trackers/${tracker.id}`)).json;
      expect(after.skipOverrides.include).toEqual([{ row: water.row, col: water.col }]);
      expect(after.exclusion).toMatchObject({ enabled: true });
      expect((await c.call("GET", `/api/trackers/${tracker.id}/skip-plan`)).json.points.find((p: { row: number; col: number }) => p.row === water.row && p.col === water.col)).toMatchObject({ skip: null, override: "include" });

      expect((await c.call("PATCH", `/api/trackers/${tracker.id}`, { skipOverrides: { include: [{ row: -1, col: 0 }] } })).status).toBe(400);
      expect((await c.call("PATCH", `/api/trackers/${tracker.id}`, { autoSkipWater: "yes" })).status).toBe(400);

      await c.call("PATCH", `/api/trackers/${tracker.id}`, { radius: { value: 20, unit: "km" } });
      expect((await c.call("GET", `/api/trackers/${tracker.id}`)).json.skipOverrides).toEqual({ include: [], exclude: [] });
    });
  });

  describe("scans, reports and MCP", () => {
    async function scannedCoastalTracker() {
      const biz = (await c.call("POST", "/api/businesses", rodanthe)).json;
      const tracker = (await c.call("POST", "/api/trackers", coastalTracker(biz.id))).json;
      const run = await c.call("POST", `/api/trackers/${tracker.id}/scans`, {});
      expect(run.status).toBe(202);
      await h.queue.drain(h.deps);
      return { biz, tracker, scanId: run.json.scanId as string, quote: run.json.quote };
    }

    it("scan detail carries the final per-point status, and scanned vs skipped counts", async () => {
      const { scanId, quote } = await scannedCoastalTracker();
      const detail = (await c.call("GET", `/api/scans/${scanId}`)).json;
      expect(detail.points).toHaveLength(49);
      const skipped: Array<{ id: string; skipReason: string; rank: number | null; status: string }> = detail.points.filter((p: { status: string }) => p.status === "skipped");
      expect(skipped.length).toBe(quote.skippedPoints);
      expect(skipped.every((p: { skipReason: string; rank: number | null }) => p.skipReason === "water" && p.rank === null)).toBe(true);
      expect(detail.scan).toMatchObject({ totalPoints: quote.points, skippedPoints: quote.skippedPoints, status: "completed" });
      expect(detail.metrics.totalPoints).toBe(quote.points);
      const list = (await c.call("GET", `/api/trackers/${detail.scan.trackerId}/scans`)).json;
      expect(list[0]).toMatchObject({ totalPoints: quote.points, skippedPoints: quote.skippedPoints });
      // a skipped point has no competitor list but is still addressable
      const point = await c.call("GET", `/api/scans/${scanId}/points/${at(skipped, 0).id}`);
      expect(point.json.point).toMatchObject({ status: "skipped", skipReason: "water" });
      expect(point.json.results).toEqual([]);
    });

    it("the public report shows skipped points with their reason", async () => {
      const { tracker, quote } = await scannedCoastalTracker();
      const share = (await c.call("POST", `/api/trackers/${tracker.id}/shares`, { label: "client" })).json;
      const report = (await client(h).call("GET", `/api/public/reports/${share.token}`)).json;
      expect(report.scan.skippedPoints).toBe(quote.skippedPoints);
      const skipped = report.scan.points.filter((p: { status: string }) => p.status === "skipped");
      expect(skipped).toHaveLength(quote.skippedPoints);
      expect(skipped.every((p: { skipReason: string }) => p.skipReason === "water")).toBe(true);
      expect(report.history[0].totalPoints).toBe(quote.points);
    });

    it("MCP quote_scan previews skips and cost without starting anything; get_scan reports skipped cells", async () => {
      const { tracker, scanId } = await scannedCoastalTracker();
      const key = (await c.call("POST", "/api/api-keys", { name: "Claude" })).json.key as string;
      const quoted = await mcpCall(h, key, "tools/call", { name: "quote_scan", arguments: { trackerId: tracker.id } });
      const out = quoted.json.result.structuredContent;
      expect(out.quote.points + out.quote.skippedPoints).toBe(49);
      expect(out.skipped).toHaveLength(out.quote.skippedPoints);
      expect(quoted.json.result.content[0].text).toMatch(/of 49 points would be scanned/);
      expect(await h.db.query.scans.findMany()).toHaveLength(1); // nothing new was created

      const got = await mcpCall(h, key, "tools/call", { name: "get_scan", arguments: { scanId } });
      const grid = got.json.result.structuredContent;
      expect(grid.skippedPoints).toBe(out.quote.skippedPoints);
      expect(grid.skippedGrid.flat().filter((x: string | null) => x === "water")).toHaveLength(out.quote.skippedPoints);

      const unknown = await mcpCall(h, key, "tools/call", { name: "quote_scan", arguments: { trackerId: "nope" } });
      expect(unknown.json.result.isError).toBe(true);
    });
  });
});

describe("tenant isolation for the skip routes", () => {
  it("workspace B cannot preview, read or change workspace A's businesses and trackers", async () => {
    const h = await createHarness({ env: { AUTH_MODE: "hosted" } });
    const a = client(h);
    const b = client(h);
    await a.call("POST", "/api/auth/signup", { email: "a@example.com", password: "correct horse battery" });
    await b.call("POST", "/api/auth/signup", { email: "b@example.com", password: "another long password" });
    const biz = (await a.call("POST", "/api/businesses", { ...rodanthe, businessType: "service_area" })).json;
    const tracker = (await a.call("POST", "/api/trackers", coastalTracker(biz.id))).json;
    await a.call("PUT", `/api/businesses/${biz.id}/service-area`, { areas: [{ name: "Dare County", kind: "county" }] });

    expect((await b.call("POST", "/api/skip-preview", { businessId: biz.id, gridSize: 7, radius: { value: 15, unit: "km" } })).status).toBe(404);
    expect((await b.call("GET", `/api/trackers/${tracker.id}/skip-plan`)).status).toBe(404);
    expect((await b.call("GET", `/api/businesses/${biz.id}/service-area`)).status).toBe(404);
    expect((await b.call("PUT", `/api/businesses/${biz.id}/service-area`, { areas: [] })).status).toBe(404);
    expect((await b.call("PATCH", `/api/businesses/${biz.id}`, { businessType: "storefront" })).status).toBe(404);
    expect((await b.call("PATCH", `/api/trackers/${tracker.id}`, { autoSkipWater: false })).status).toBe(404);

    // A's data is untouched.
    expect((await a.call("GET", `/api/businesses/${biz.id}/service-area`)).json.areas).toHaveLength(1);
    expect((await a.call("GET", `/api/trackers/${tracker.id}`)).json).toMatchObject({ autoSkipWater: true });
    expect((await a.call("GET", "/api/businesses")).json[0].businessType).toBe("service_area");
  });
});
