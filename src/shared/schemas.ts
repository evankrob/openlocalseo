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
});
export type BusinessInput = z.infer<typeof businessInputSchema>;

export const businessPatchSchema = z.object({ gbpTracking: z.boolean().optional() });
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
