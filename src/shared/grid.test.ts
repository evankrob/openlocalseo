import { describe, expect, it } from "vitest";
import { buildGrid, fromKm, formatLocationCoordinate, haversineKm, toKm, validateGridInput } from "./grid";

const center = { centerLat: 35.7796, centerLng: -78.6382 };

describe("buildGrid", () => {
  it("makes size*size points with the center point on the business for odd sizes", () => {
    const points = buildGrid({ ...center, size: 7, radiusKm: 6 });
    expect(points).toHaveLength(49);
    const mid = points[24];
    expect(mid.row).toBe(3);
    expect(mid.col).toBe(3);
    expect(mid.lat).toBeCloseTo(center.centerLat, 5);
    expect(mid.lng).toBeCloseTo(center.centerLng, 5);
  });

  it("puts row 0 in the north-west and spaces edge points at the radius", () => {
    const points = buildGrid({ ...center, size: 5, radiusKm: 4 });
    const nw = points[0];
    const se = points[24];
    expect(nw.lat).toBeGreaterThan(se.lat);
    expect(nw.lng).toBeLessThan(se.lng);
    const north = points[2]; // row 0, col 2: straight north of center
    expect(haversineKm({ lat: center.centerLat, lng: center.centerLng }, north)).toBeCloseTo(4, 1);
  });

  it("keeps east-west spacing equal to north-south spacing in km at high latitude", () => {
    const points = buildGrid({ centerLat: 60, centerLng: 10, size: 3, radiusKm: 10 });
    const ns = haversineKm(points[0], points[3]);
    const ew = haversineKm(points[0], points[1]);
    expect(ew).toBeCloseTo(ns, 1);
  });

  it("rejects sizes outside 3..13 and bad radii", () => {
    expect(validateGridInput({ ...center, size: 2, radiusKm: 5 })).toMatch(/between 3x3 and 13x13/);
    expect(validateGridInput({ ...center, size: 14, radiusKm: 5 })).toMatch(/between 3x3 and 13x13/);
    expect(validateGridInput({ ...center, size: 5, radiusKm: 0 })).toMatch(/Radius/);
    expect(() => buildGrid({ ...center, size: 4.5, radiusKm: 5 })).toThrow();
    expect(buildGrid({ ...center, size: 13, radiusKm: 20 })).toHaveLength(169);
  });
});

describe("units and coordinates", () => {
  it("round-trips miles and km", () => {
    expect(toKm(5, "mi")).toBeCloseTo(8.04672, 5);
    expect(fromKm(toKm(5, "mi"), "mi")).toBeCloseTo(5, 9);
  });

  it("formats DataForSEO location_coordinate with a z-suffixed zoom", () => {
    expect(formatLocationCoordinate({ lat: 35.7796, lng: -78.6382 }, 15)).toBe("35.779600,-78.638200,15z");
  });
});
