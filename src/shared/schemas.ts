import { z } from "zod";
import {
  GRID_DEFAULT_ZOOM,
  GRID_MAX_RADIUS_KM,
  GRID_MAX_SIZE,
  GRID_MAX_ZOOM,
  GRID_MIN_SIZE,
  GRID_MIN_ZOOM,
  toKm,
} from "./grid";
import { QUEUE_MODES } from "./pricing";
import { isValidShape, polygonsOf, type GeoShape } from "./skip/geo";
import { BUSINESS_TYPES, SERVICE_AREA_KINDS, exclusionSchema, skipOverridesSchema } from "./skip/plan";

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional();

export const businessInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  placeId: optionalText(200),
  cid: optionalText(40),
  domain: optionalText(200),
  address: optionalText(300),
  category: optionalText(120),
  // Optional: filled from the place ID or by geocoding the address when blank.
  lat: z.number().min(-85).max(85).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
  /** storefront (default) or service_area; only service-area businesses can be skipped for being out of area. */
  businessType: z.enum(BUSINESS_TYPES).optional(),
});
export type BusinessInput = z.infer<typeof businessInputSchema>;

export const businessPatchSchema = z.object({ gbpTracking: z.boolean().optional(), businessType: z.enum(BUSINESS_TYPES).optional() });
export type BusinessPatch = z.infer<typeof businessPatchSchema>;

const radiusSchema = z.object({
  value: z.number().positive(),
  unit: z.enum(["km", "mi"]),
});

export const trackerInputSchema = z
  .object({
    businessId: z.string().min(1),
    keyword: z.string().trim().min(1).max(120),
    /** Defaults to the business location. */
    centerLat: z.number().min(-85).max(85).optional(),
    centerLng: z.number().min(-180).max(180).optional(),
    gridSize: z.number().int().min(GRID_MIN_SIZE).max(GRID_MAX_SIZE).default(7),
    radius: radiusSchema.default({ value: 5, unit: "km" }),
    zoom: z.number().int().min(GRID_MIN_ZOOM).max(GRID_MAX_ZOOM).default(GRID_DEFAULT_ZOOM),
    searchType: z.enum(["maps", "local_finder"]).default("maps"),
    queueMode: z.enum(QUEUE_MODES).default("standard"),
    device: z.enum(["desktop", "mobile"]).default("mobile"),
    languageCode: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/).default("en"),
    depth: z.number().int().min(10).max(20).default(20),
    schedule: z
      .object({
        frequency: z.enum(["none", "monthly"]),
        day: z.number().int().min(1).max(28).default(1),
      })
      .default({ frequency: "none", day: 1 }),
    /** Skip grid points on open water. On by default. */
    autoSkipWater: z.boolean().optional(),
    skipOverrides: skipOverridesSchema.optional(),
    exclusion: exclusionSchema.optional(),
  })
  .refine((v) => toKm(v.radius.value, v.radius.unit) <= GRID_MAX_RADIUS_KM, {
    message: `Radius cannot exceed ${GRID_MAX_RADIUS_KM} km`,
    path: ["radius"],
  });
export type TrackerInput = z.infer<typeof trackerInputSchema>;

/** Partial update: every field optional, no defaults applied. */
export const trackerPatchSchema = z.object({
  keyword: z.string().trim().min(1).max(120).optional(),
  centerLat: z.number().min(-85).max(85).optional(),
  centerLng: z.number().min(-180).max(180).optional(),
  gridSize: z.number().int().min(GRID_MIN_SIZE).max(GRID_MAX_SIZE).optional(),
  radius: radiusSchema.optional(),
  zoom: z.number().int().min(GRID_MIN_ZOOM).max(GRID_MAX_ZOOM).optional(),
  searchType: z.enum(["maps", "local_finder"]).optional(),
  queueMode: z.enum(QUEUE_MODES).optional(),
  device: z.enum(["desktop", "mobile"]).optional(),
  languageCode: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/).optional(),
  schedule: z
    .object({ frequency: z.enum(["none", "monthly"]), day: z.number().int().min(1).max(28).default(1) })
    .optional(),
  autoSkipWater: z.boolean().optional(),
  /** Replaces the per-cell include/skip lists. Cleared automatically when the grid geometry changes. */
  skipOverrides: skipOverridesSchema.optional(),
  exclusion: exclusionSchema.optional(),
});
export type TrackerPatch = z.infer<typeof trackerPatchSchema>;

export const brandingSchema = z.object({
  brandName: optionalText(80),
  logoUrl: z
    .string()
    .trim()
    .max(500)
    .refine((v) => v === "" || /^https?:\/\//i.test(v), "Logo must be an http(s) URL")
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional(),
  primaryColor: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, "Use a hex colour like #1f6feb")
    .nullable()
    .optional(),
  footerText: optionalText(300),
  contactUrl: z
    .string()
    .trim()
    .max(500)
    .refine((v) => v === "" || /^https?:\/\//i.test(v), "Contact link must be an http(s) URL")
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional(),
  hideAttribution: z.boolean().optional(),
});
export type BrandingInput = z.infer<typeof brandingSchema>;

export const shareInputSchema = z.object({
  label: optionalText(80),
  showCompetitors: z.boolean().default(true),
  /** ISO date; omit for a link that never expires. */
  expiresAt: z.string().datetime().nullable().optional(),
});

const MAX_BOUNDARY_VERTICES = 20_000;
const vertexCount = (shape: GeoShape) => polygonsOf(shape).reduce((n, rings) => n + rings.reduce((m, ring) => m + ring.length, 0), 0);

/**
 * The areas a service-area business works in. A boundary (GeoJSON Polygon or
 * MultiPolygon, [lng, lat]) is optional: a name alone is stored but never used
 * to skip anything. Boundaries are user-supplied (e.g. exported from US Census
 * TIGER); the app ships none. `gbp` as a source is reserved and not accepted.
 */
export const serviceAreaInputSchema = z.object({
  areas: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(120),
        kind: z.enum(SERVICE_AREA_KINDS).default("other"),
        /** Omitted = keep what is stored for this name (or "manual" for a new one). */
        source: z.enum(["manual", "census_tiger"]).optional(),
        /** Omitted = keep the stored boundary for this name; null = remove it. */
        polygon: z
          .unknown()
          .nullable()
          .optional()
          .refine((v) => v == null || isValidShape(v), "Boundary must be a GeoJSON Polygon or MultiPolygon with [lng, lat] coordinates")
          .refine((v) => v == null || !isValidShape(v) || vertexCount(v) <= MAX_BOUNDARY_VERTICES, `Boundary has too many vertices (max ${MAX_BOUNDARY_VERTICES}); simplify it first`)
          .transform((v) => (v === undefined ? undefined : v === null ? null : (v as GeoShape))),
      }),
    )
    .max(100),
});
export type ServiceAreaInput = z.infer<typeof serviceAreaInputSchema>;

/** Body of POST /api/skip-preview: what a not-yet-saved grid would skip, and what it would cost. */
export const skipPreviewSchema = z
  .object({
    businessId: z.string().min(1),
    centerLat: z.number().min(-85).max(85).optional(),
    centerLng: z.number().min(-180).max(180).optional(),
    gridSize: z.number().int().min(GRID_MIN_SIZE).max(GRID_MAX_SIZE),
    radius: radiusSchema,
    queueMode: z.enum(QUEUE_MODES).default("standard"),
    autoSkipWater: z.boolean().default(true),
    skipOverrides: skipOverridesSchema.optional(),
    exclusion: exclusionSchema.optional(),
  })
  .refine((v) => toKm(v.radius.value, v.radius.unit) <= GRID_MAX_RADIUS_KM, { message: `Radius cannot exceed ${GRID_MAX_RADIUS_KM} km`, path: ["radius"] });
export type SkipPreviewInput = z.infer<typeof skipPreviewSchema>;
