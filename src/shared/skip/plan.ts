// Which grid points a scan skips, and why. Pure and deterministic: the worker
// (scan creation, the preview endpoint) and the tests all call `planSkips`, so
// what the preview shows is what gets scanned.
//
// Precedence for each point:
//   1. the user's per-cell override ("skip this one" -> `user`; "include this one" -> scan)
//   2. water: on water and farther than SHORE_TOLERANCE_M from the shore -> `water`
//   3. outside the service area (service-area businesses with boundary data only,
//      or inside a user-drawn exclusion shape) -> `outside_area`
// Storefront businesses are never skipped for being out of area.
import { z } from "zod";
import type { GridPoint } from "../grid";
import { circleShape, insideWithBuffer, isValidShape, type GeoShape, type LngLat } from "./geo";
import { SHORE_TOLERANCE_M, type WaterIndex } from "./water";

export const SKIP_REASONS = ["water", "outside_area", "user"] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export const SKIP_REASON_LABEL: Record<SkipReason, string> = {
  water: "skipped: water",
  outside_area: "skipped: outside area",
  user: "skipped: user",
};

export const BUSINESS_TYPES = ["storefront", "service_area"] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];

/** 0.5 mile. A point this close to the edge of a service area still counts as inside it. */
export const SERVICE_AREA_BUFFER_M = 805;

export const SERVICE_AREA_KINDS = ["city", "zip", "county", "other"] as const;
export type ServiceAreaKind = (typeof SERVICE_AREA_KINDS)[number];

/** Where a service-area list came from. `gbp` is reserved for a future import; nothing in the app produces it yet. */
export const SERVICE_AREA_SOURCES = ["manual", "gbp", "census_tiger"] as const;

export type ServiceAreaEntry = {
  name: string;
  kind: ServiceAreaKind;
  source: (typeof SERVICE_AREA_SOURCES)[number];
  /** GeoJSON boundary; null = we only know the name ("not applied: no boundary data"). */
  polygon: GeoShape | null;
};

// ---- stored per-tracker rules (zod: they arrive from the API and live in JSON columns) ----

export const cellRefSchema = z.object({ row: z.number().int().min(0).max(12), col: z.number().int().min(0).max(12) });
export type CellRef = z.infer<typeof cellRefSchema>;

export const skipOverridesSchema = z.object({
  /** Cells the user wants scanned even when a rule would skip them. */
  include: z.array(cellRefSchema).max(169).default([]),
  /** Cells the user wants skipped ("skipped: user"). */
  exclude: z.array(cellRefSchema).max(169).default([]),
});
export type SkipOverrides = z.infer<typeof skipOverridesSchema>;
export const EMPTY_OVERRIDES: SkipOverrides = { include: [], exclude: [] };

const lngLatSchema = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);

export const exclusionShapeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("circle"), lat: z.number().min(-85).max(85), lng: z.number().min(-180).max(180), radiusKm: z.number().positive().max(80) }),
  z.object({ type: z.literal("polygon"), points: z.array(lngLatSchema).min(3).max(200) }),
]);
export type ExclusionShape = z.infer<typeof exclusionShapeSchema>;

/** A user-drawn "do not scan here" area. Off by default. */
export const exclusionSchema = z.object({
  enabled: z.boolean().default(false),
  shapes: z.array(exclusionShapeSchema).max(10).default([]),
});
export type Exclusion = z.infer<typeof exclusionSchema>;
export const NO_EXCLUSION: Exclusion = { enabled: false, shapes: [] };

export type SkipRules = {
  skipWater: boolean;
  exclusion: Exclusion;
  overrides: SkipOverrides;
};

export const DEFAULT_RULES: SkipRules = { skipWater: true, exclusion: NO_EXCLUSION, overrides: EMPTY_OVERRIDES };

// ---- service area ---------------------------------------------------------------

export type ServiceAreaStatus = {
  /** True when the service-area rule can run: a service-area business whose every listed area has a boundary. */
  applied: boolean;
  /** Why it is not applied. */
  reason: "storefront" | "no_areas" | "missing_boundaries" | null;
  total: number;
  withBoundary: number;
  /** Names still lacking a boundary: "not applied: no boundary data". */
  missing: string[];
};

/**
 * The rule only runs when every listed area has a boundary. With a partial
 * list we would wrongly skip points inside the cities we have no polygon for.
 */
export function serviceAreaStatus(businessType: BusinessType, areas: readonly ServiceAreaEntry[]): ServiceAreaStatus {
  const withBoundary = areas.filter((a) => a.polygon !== null).length;
  const missing = areas.filter((a) => a.polygon === null).map((a) => a.name);
  const base = { total: areas.length, withBoundary, missing };
  if (businessType !== "service_area") return { ...base, applied: false, reason: "storefront" };
  if (areas.length === 0) return { ...base, applied: false, reason: "no_areas" };
  if (missing.length > 0) return { ...base, applied: false, reason: "missing_boundaries" };
  return { ...base, applied: true, reason: null };
}

// ---- planning --------------------------------------------------------------------

export type PlannedPoint = GridPoint & {
  /** Final decision: why the point is skipped, or null when it will be scanned. */
  skip: SkipReason | null;
  /** What the automatic rules alone say (ignoring the user's overrides). */
  auto: "water" | "outside_area" | null;
  /** The user's override for this cell, if any. */
  override: "include" | "exclude" | null;
};

export type PlanInput = {
  points: readonly GridPoint[];
  /** null = water data unavailable: nothing is skipped for water. */
  water: WaterIndex | null;
  businessType: BusinessType;
  serviceAreas: readonly ServiceAreaEntry[];
  rules: SkipRules;
};

const exclusionShapes = (exclusion: Exclusion): GeoShape[] =>
  exclusion.enabled
    ? exclusion.shapes.map((s): GeoShape => {
        if (s.type === "circle") return circleShape(s.lat, s.lng, s.radiusKm);
        const ring: LngLat[] = s.points.map(([lng, lat]) => [lng, lat]);
        const start = ring[0];
        if (start) ring.push(start);
        return { type: "Polygon", coordinates: [ring] };
      })
    : [];

export function planSkips(input: PlanInput): PlannedPoint[] {
  const { rules } = input;
  const area = serviceAreaStatus(input.businessType, input.serviceAreas);
  const boundaries = area.applied ? input.serviceAreas.flatMap((a) => (a.polygon && isValidShape(a.polygon) ? [a.polygon] : [])) : [];
  const excluded = exclusionShapes(rules.exclusion);
  const has = (cells: readonly CellRef[], p: GridPoint) => cells.some((c) => c.row === p.row && c.col === p.col);

  return input.points.map((p): PlannedPoint => {
    let auto: PlannedPoint["auto"] = null;
    if (rules.skipWater && input.water?.classify(p, SHORE_TOLERANCE_M) === "water") auto = "water";
    else if (
      (boundaries.length > 0 && !boundaries.some((b) => insideWithBuffer(p, b, SERVICE_AREA_BUFFER_M))) ||
      // A drawn exclusion is the user's own line, so it gets no buffer.
      excluded.some((shape) => insideWithBuffer(p, shape, 0))
    ) {
      auto = "outside_area";
    }
    // "Skip" wins over "include" if a stale list holds both.
    const override = has(rules.overrides.exclude, p) ? "exclude" : has(rules.overrides.include, p) ? "include" : null;
    const skip: SkipReason | null = override === "exclude" ? "user" : override === "include" ? null : auto;
    return { ...p, skip, auto, override };
  });
}

export type PlanSummary = { gridPoints: number; scannablePoints: number; skippedPoints: number; byReason: Record<SkipReason, number> };

export function summarizePlan(plan: readonly PlannedPoint[]): PlanSummary {
  const byReason: Record<SkipReason, number> = { water: 0, outside_area: 0, user: 0 };
  for (const p of plan) if (p.skip) byReason[p.skip]++;
  const skippedPoints = byReason.water + byReason.outside_area + byReason.user;
  return { gridPoints: plan.length, scannablePoints: plan.length - skippedPoints, skippedPoints, byReason };
}

/** Toggles a cell's override so that it ends up scanned (`scan`) or skipped (`skip`); no-op overrides are dropped. */
export function setCellOverride(
  overrides: SkipOverrides,
  point: Pick<PlannedPoint, "row" | "col" | "auto">,
  want: "scan" | "skip",
): SkipOverrides {
  const same = (c: CellRef) => c.row === point.row && c.col === point.col;
  const include = overrides.include.filter((c) => !same(c));
  const exclude = overrides.exclude.filter((c) => !same(c));
  // Only store an override when it differs from what the automatic rules would do.
  if (want === "scan" && point.auto !== null) include.push({ row: point.row, col: point.col });
  if (want === "skip" && point.auto === null) exclude.push({ row: point.row, col: point.col });
  return { include, exclude };
}
