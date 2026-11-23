import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { buildGrid } from "../grid";
import { circleShape, distanceToRingsM, insideWithBuffer, isValidShape, pointInRings, type GeoPolygon } from "./geo";
import {
  DEFAULT_RULES,
  EMPTY_OVERRIDES,
  SERVICE_AREA_BUFFER_M,
  planSkips,
  serviceAreaStatus,
  setCellOverride,
  summarizePlan,
  type PlanInput,
  type ServiceAreaEntry,
} from "./plan";
import {
  CELL_MIXED,
  CELL_WATER,
  SHORE_TOLERANCE_M,
  WATER_COLS,
  cellOrigin,
  createWaterIndex,
  encodeWater,
  type WaterCell,
  type WaterIndex,
} from "./water";
import { WATER_DATA_B64 } from "../../worker/skip/water-data";
import { decodeBase64 } from "./water";

// ---- geometry --------------------------------------------------------------------

/** A square of `halfKm` around a point, as a GeoJSON polygon (test data, not a real place). */
function square(lat: number, lng: number, halfKm: number): GeoPolygon {
  const dLat = halfKm / 111.32;
  const dLng = dLat / Math.cos((lat * Math.PI) / 180);
  return {
    type: "Polygon",
    coordinates: [[[lng - dLng, lat - dLat], [lng + dLng, lat - dLat], [lng + dLng, lat + dLat], [lng - dLng, lat + dLat], [lng - dLng, lat - dLat]]],
  };
}
const kmNorth = (lat: number, km: number) => lat + km / 111.32;

describe("geometry", () => {
  const box = square(35, -78, 5);
  it("point in polygon, with holes", () => {
    expect(pointInRings(-78, 35, box.coordinates)).toBe(true);
    expect(pointInRings(-78, 36, box.coordinates)).toBe(false);
    const hole = square(35, -78, 1).coordinates[0] ?? [];
    expect(pointInRings(-78, 35, [...box.coordinates, hole])).toBe(false);
    expect(pointInRings(-78 + 0.03, 35, [...box.coordinates, hole])).toBe(true);
  });

  it("measures the distance to the nearest edge in metres", () => {
    // 1 km north of the top edge of a +-5 km box
    const d = distanceToRingsM({ lat: kmNorth(35, 6), lng: -78 }, box.coordinates);
    expect(d).toBeGreaterThan(990);
    expect(d).toBeLessThan(1010);
  });

  it("buffers a boundary: inside counts, near the edge counts, beyond the buffer does not", () => {
    const edge = kmNorth(35, 5);
    expect(insideWithBuffer({ lat: 35, lng: -78 }, box, SERVICE_AREA_BUFFER_M)).toBe(true);
    expect(insideWithBuffer({ lat: edge + 0.7 / 111.32, lng: -78 }, box, SERVICE_AREA_BUFFER_M)).toBe(true); // 700 m outside
    expect(insideWithBuffer({ lat: edge + 0.9 / 111.32, lng: -78 }, box, SERVICE_AREA_BUFFER_M)).toBe(false); // 900 m outside
    expect(insideWithBuffer({ lat: edge + 0.7 / 111.32, lng: -78 }, box, 0)).toBe(false);
  });

  it("validates untrusted GeoJSON", () => {
    expect(isValidShape(box)).toBe(true);
    expect(isValidShape({ type: "Point", coordinates: [0, 0] })).toBe(false);
    expect(isValidShape({ type: "Polygon", coordinates: [[[0, 0], [1, 1]]] })).toBe(false);
    expect(isValidShape({ type: "Polygon", coordinates: [[[0, 0], [1, 1], [200, 1], [0, 0]]] })).toBe(false);
    expect(isValidShape(null)).toBe(false);
  });

  it("circleShape covers its radius", () => {
    const c = circleShape(35, -78, 2);
    expect(insideWithBuffer({ lat: 35, lng: -78 }, c, 0)).toBe(true);
    expect(insideWithBuffer({ lat: kmNorth(35, 1.9), lng: -78 }, c, 0)).toBe(true);
    expect(insideWithBuffer({ lat: kmNorth(35, 2.2), lng: -78 }, c, 0)).toBe(false);
  });
});

// ---- water codec -----------------------------------------------------------------

describe("water index format", () => {
  /** One cell holding a square lake of half-width `halfDeg` around the cell's centre, plus a full-water neighbour. */
  function syntheticIndex(halfDeg: number): { index: WaterIndex; centre: { lat: number; lng: number } } {
    const row = 60;
    const col = 100;
    const o = cellOrigin(row, col);
    const centreX = o.x + 1000; // 1 degree into a 2 degree cell (1e3 units per degree)
    const centreY = o.y + 1000;
    const h = Math.round(halfDeg * 1000);
    const ring = [[centreX - h, centreY - h], [centreX + h, centreY - h], [centreX + h, centreY + h], [centreX - h, centreY + h]];
    const cells = new Map<number, WaterCell>([
      [row * WATER_COLS + col, { state: CELL_MIXED, rings: [ring] }],
      [row * WATER_COLS + col + 1, { state: CELL_WATER }],
    ]);
    return { index: createWaterIndex(encodeWater(cells)), centre: { lat: centreY / 1000, lng: centreX / 1000 } };
  }

  it("round-trips: lake interior is water, outside is land, the rim is shore", () => {
    const { index, centre } = syntheticIndex(0.2); // a 0.4 degree (~44 km) lake
    expect(index.classify(centre)).toBe("water");
    expect(index.classify({ lat: centre.lat, lng: centre.lng + 0.5 })).toBe("land");
  });

  it("classifies by distance to the rim using the shore tolerance", () => {
    const { index, centre } = syntheticIndex(0.2);
    const rimLat = centre.lat + 0.2;
    const metresToDeg = (m: number) => m / 111_320;
    expect(index.classify({ lat: rimLat - metresToDeg(SHORE_TOLERANCE_M - 100), lng: centre.lng })).toBe("shore");
    expect(index.classify({ lat: rimLat - metresToDeg(SHORE_TOLERANCE_M + 150), lng: centre.lng })).toBe("water");
    expect(index.classify({ lat: rimLat + metresToDeg(100), lng: centre.lng })).toBe("land");
    expect(index.classify({ lat: 0, lng: 0 })).toBe("land");
  });

  it("a full-water cell is water everywhere", () => {
    const { index } = syntheticIndex(0.2);
    const o = cellOrigin(60, 101);
    expect(index.classify({ lat: o.y / 1000 + 1, lng: o.x / 1000 + 1 })).toBe("water");
  });

  it("rejects data it cannot read", () => {
    expect(() => createWaterIndex(Uint8Array.from([9, 0]))).toThrow(/version/);
  });
});

// ---- the bundled Natural Earth data ---------------------------------------------

describe("bundled water data (Natural Earth 10m)", () => {
  const index = createWaterIndex(decodeBase64(WATER_DATA_B64));
  const at = (lat: number, lng: number) => index.classify({ lat, lng });

  it("is small enough for a Worker (guards against accidental bloat)", () => {
    const file = readFileSync(join(import.meta.dirname, "../../worker/skip/water-data.ts"));
    expect(decodeBase64(WATER_DATA_B64).length).toBeLessThan(1_000_000);
    expect(gzipSync(file, { level: 9 }).length).toBeLessThan(900_000);
  });

  it("skips open water far from any shore: Pamlico Sound, the Atlantic, Lake Michigan", () => {
    expect(at(35.3, -75.85)).toBe("water"); // Pamlico Sound
    expect(at(35.6, -75.2)).toBe("water"); // Atlantic, 20 km off Rodanthe
    expect(at(43.5, -87)).toBe("water"); // Lake Michigan
    expect(at(27.65, -82.65)).toBe("water"); // Tampa Bay
  });

  it("scans land, including the Outer Banks themselves and big cities", () => {
    expect(at(35.6, -75.47)).toBe("land"); // Rodanthe
    expect(at(35.96, -75.62)).toBe("land"); // Nags Head
    expect(at(35.91, -75.67)).toBe("land"); // Manteo
    expect(at(35.78, -78.64)).toBe("land"); // Raleigh
    expect(at(41.88, -87.63)).toBe("land"); // Chicago
    expect(at(40.78, -73.97)).toBe("land"); // Manhattan
  });

  it("never reports 'water' near a shore: a walk across Rodanthe's coast passes through a shore band", () => {
    // Walk east from the sound, over the island, into the Atlantic at Rodanthe's latitude.
    const classes: string[] = [];
    for (let lng = -75.75; lng <= -75.3; lng += 0.0005) classes.push(at(35.6, lng));
    // Collapse repeats: water -> (shore) -> land -> (shore) -> water; a deep-water point is never adjacent to land.
    const runs = classes.filter((c, i) => c !== classes[i - 1]);
    expect(runs).toContain("land");
    for (let i = 1; i < runs.length; i++) {
      const pair = [runs[i - 1], runs[i]].sort().join("/");
      expect(pair, `land and deep water must be separated by a shore band: ${runs.join(" > ")}`).not.toBe("land/water");
    }
    // ...and the band has a real width: a few hundred metres, not zero.
    const shoreSteps = classes.filter((c) => c === "shore").length;
    expect(shoreSteps).toBeGreaterThan(4);
  });

  it("coarse coastline errors stay scanned: Hatteras village is drawn on water in Natural Earth but is not skipped", () => {
    expect(at(35.22, -75.7)).toBe("shore");
  });

  it("does not treat narrow rivers as water (only lake and ocean polygons are bundled)", () => {
    expect(at(40.78, -74.0)).not.toBe("water"); // Hudson River off Manhattan
  });
});

// ---- the planner -----------------------------------------------------------------

describe("planSkips", () => {
  // A 7x7 grid on the Outer Banks: Atlantic on the east, Pamlico Sound on the west.
  const obx = buildGrid({ centerLat: 35.6, centerLng: -75.47, size: 7, radiusKm: 15 });
  const water = createWaterIndex(decodeBase64(WATER_DATA_B64));
  const base: PlanInput = { points: obx, water, businessType: "storefront", serviceAreas: [], rules: DEFAULT_RULES };

  it("skips water points, scans land and near-shore points", () => {
    const plan = planSkips(base);
    const skipped = plan.filter((p) => p.skip);
    expect(skipped.length).toBeGreaterThan(10);
    expect(skipped.every((p) => p.skip === "water" && p.auto === "water")).toBe(true);
    // the centre cell sits on Rodanthe
    expect(plan.find((p) => p.row === 3 && p.col === 3)?.skip).toBeNull();
    const summary = summarizePlan(plan);
    expect(summary.scannablePoints + summary.skippedPoints).toBe(49);
    expect(summary.byReason.water).toBe(summary.skippedPoints);
  });

  it("is deterministic", () => {
    expect(planSkips(base)).toEqual(planSkips(base));
  });

  it("skips nothing for water when the toggle is off or no water data is loaded", () => {
    expect(planSkips({ ...base, rules: { ...DEFAULT_RULES, skipWater: false } }).some((p) => p.skip)).toBe(false);
    expect(planSkips({ ...base, water: null }).some((p) => p.skip)).toBe(false);
  });

  describe("service area", () => {
    const grid = buildGrid({ centerLat: 35.78, centerLng: -78.64, size: 5, radiusKm: 8 });
    const centreBox: ServiceAreaEntry = { name: "Test Box", kind: "city", source: "manual", polygon: square(35.78, -78.64, 4) };
    const run = (over: Partial<PlanInput>) => planSkips({ points: grid, water: null, businessType: "service_area", serviceAreas: [centreBox], rules: DEFAULT_RULES, ...over });

    it("a storefront is never skipped for being out of area, even with boundaries on file", () => {
      expect(run({ businessType: "storefront" }).some((p) => p.skip)).toBe(false);
    });

    it("a service-area business without any listed area skips nothing", () => {
      expect(run({ serviceAreas: [] }).some((p) => p.skip)).toBe(false);
      expect(serviceAreaStatus("service_area", [])).toMatchObject({ applied: false, reason: "no_areas" });
    });

    it("names without boundaries are not applied", () => {
      const noBoundary: ServiceAreaEntry = { name: "Cary", kind: "city", source: "manual", polygon: null };
      expect(run({ serviceAreas: [noBoundary] }).some((p) => p.skip)).toBe(false);
      expect(serviceAreaStatus("service_area", [noBoundary])).toMatchObject({ applied: false, reason: "missing_boundaries", missing: ["Cary"] });
    });

    it("a partial list (some areas lack a boundary) is not applied, so nothing is wrongly skipped", () => {
      const noBoundary: ServiceAreaEntry = { name: "Cary", kind: "city", source: "manual", polygon: null };
      expect(run({ serviceAreas: [centreBox, noBoundary] }).some((p) => p.skip)).toBe(false);
    });

    it("skips points outside the boundary and keeps the ones inside", () => {
      const plan = run({});
      const skipped = plan.filter((p) => p.skip);
      expect(skipped.length).toBeGreaterThan(0);
      expect(skipped.every((p) => p.skip === "outside_area")).toBe(true);
      expect(plan.find((p) => p.row === 2 && p.col === 2)?.skip).toBeNull();
    });

    it("keeps a point up to 0.5 mi outside the boundary, and skips one beyond it", () => {
      const edgeLat = kmNorth(35.78, 4);
      const at = (metresOutside: number) => ({ row: 0, col: 0, lat: edgeLat + metresOutside / 111_320, lng: -78.64 });
      expect(run({ points: [at(700)] })[0]?.skip).toBeNull();
      expect(run({ points: [at(SERVICE_AREA_BUFFER_M - 20)] })[0]?.skip).toBeNull();
      expect(run({ points: [at(SERVICE_AREA_BUFFER_M + 40)] })[0]?.skip).toBe("outside_area");
      expect(run({ points: [at(2000)] })[0]?.skip).toBe("outside_area");
    });

    it("a point is inside if any listed area contains it", () => {
      const east: ServiceAreaEntry = { name: "East Box", kind: "zip", source: "manual", polygon: square(35.78, -78.55, 3) };
      const plan = run({ serviceAreas: [centreBox, east] });
      expect(plan.filter((p) => p.skip).length).toBeLessThan(run({}).filter((p) => p.skip).length + 1);
    });
  });

  describe("user-drawn exclusion", () => {
    const grid = buildGrid({ centerLat: 35.78, centerLng: -78.64, size: 5, radiusKm: 8 });
    const rules = (enabled: boolean) => ({ ...DEFAULT_RULES, exclusion: { enabled, shapes: [{ type: "circle" as const, lat: 35.78, lng: -78.64, radiusKm: 3 }] } });
    it("is off by default and when disabled", () => {
      expect(planSkips({ ...base, points: grid, water: null }).some((p) => p.skip)).toBe(false);
      expect(planSkips({ ...base, points: grid, water: null, rules: rules(false) }).some((p) => p.skip)).toBe(false);
    });
    it("skips points inside a drawn circle as outside area, for any business type", () => {
      const plan = planSkips({ ...base, points: grid, water: null, rules: rules(true) });
      expect(plan.filter((p) => p.skip).map((p) => `${p.row},${p.col}`)).toEqual(["2,2"]);
      expect(plan.find((p) => p.skip)?.skip).toBe("outside_area");
    });
    it("supports a drawn polygon", () => {
      const shape = { type: "polygon" as const, points: [[-78.7, 35.7], [-78.5, 35.7], [-78.5, 35.9], [-78.7, 35.9]] as Array<[number, number]> };
      const plan = planSkips({ ...base, points: grid, water: null, rules: { ...DEFAULT_RULES, exclusion: { enabled: true, shapes: [shape] } } });
      expect(plan.some((p) => p.skip === "outside_area")).toBe(true);
    });
  });

  describe("user overrides", () => {
    const auto = planSkips(base);
    const water1 = must(auto.find((p) => p.skip === "water"));
    const land1 = must(auto.find((p) => p.skip === null));
    function must<T>(v: T | undefined): T {
      if (v === undefined) throw new Error("fixture missing");
      return v;
    }

    it("include turns a skipped point back on, and keeps the reason it would have had", () => {
      const plan = planSkips({ ...base, rules: { ...DEFAULT_RULES, overrides: { include: [{ row: water1.row, col: water1.col }], exclude: [] } } });
      const p = plan.find((q) => q.row === water1.row && q.col === water1.col);
      expect(p).toMatchObject({ skip: null, auto: "water", override: "include" });
    });

    it("exclude skips a scanned point as 'user'", () => {
      const plan = planSkips({ ...base, rules: { ...DEFAULT_RULES, overrides: { include: [], exclude: [{ row: land1.row, col: land1.col }] } } });
      const p = plan.find((q) => q.row === land1.row && q.col === land1.col);
      expect(p).toMatchObject({ skip: "user", auto: null, override: "exclude" });
      expect(summarizePlan(plan).byReason.user).toBe(1);
    });

    it("exclude wins over include for the same cell", () => {
      const cell = { row: land1.row, col: land1.col };
      const plan = planSkips({ ...base, rules: { ...DEFAULT_RULES, overrides: { include: [cell], exclude: [cell] } } });
      expect(plan.find((q) => q.row === cell.row && q.col === cell.col)?.skip).toBe("user");
    });

    it("setCellOverride stores only what differs from the automatic rules", () => {
      expect(setCellOverride(EMPTY_OVERRIDES, water1, "scan")).toEqual({ include: [{ row: water1.row, col: water1.col }], exclude: [] });
      expect(setCellOverride(EMPTY_OVERRIDES, land1, "scan")).toEqual(EMPTY_OVERRIDES);
      expect(setCellOverride(EMPTY_OVERRIDES, land1, "skip")).toEqual({ include: [], exclude: [{ row: land1.row, col: land1.col }] });
      expect(setCellOverride(EMPTY_OVERRIDES, water1, "skip")).toEqual(EMPTY_OVERRIDES);
      // flipping back removes the override
      const excluded = setCellOverride(EMPTY_OVERRIDES, land1, "skip");
      expect(setCellOverride(excluded, { ...land1, auto: null }, "scan")).toEqual(EMPTY_OVERRIDES);
    });
  });
});
