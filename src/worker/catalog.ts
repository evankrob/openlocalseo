import type { DataForSeoProvider } from "./dataforseo/types";
import type { Geocoder } from "./geocode";
// Businesses and trackers (saved grid configurations).
import { and, desc, eq, isNull } from "drizzle-orm";
import { toKm, validateGridInput } from "@/shared/grid";
import { AppError } from "@/shared/errors";
import type { BusinessInput, TrackerInput, TrackerPatch } from "@/shared/schemas";
import type { Db } from "./db";
import { businesses, trackers } from "./db/schema";
import { newId } from "./lib";
import { nextMonthlyRun } from "./scans/schedule";

const cleanDomain = (d?: string | null) =>
  d ? d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "") || null : null;

export async function listBusinesses(db: Db, workspaceId: string) {
  return db
    .select()
    .from(businesses)
    .where(and(eq(businesses.workspaceId, workspaceId), isNull(businesses.archivedAt)))
    .orderBy(desc(businesses.createdAt));
}

export async function getBusiness(db: Db, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(businesses)
    .where(and(eq(businesses.id, id), eq(businesses.workspaceId, workspaceId), isNull(businesses.archivedAt)));
  if (!row) throw new AppError("NOT_FOUND", "Business not found");
  return row;
}

/**
 * Fills in what the user did not type: coordinates (and blank name parts) from
 * the Google place ID via DataForSEO, else coordinates from the address.
 */
export async function resolveBusinessInput(
  input: BusinessInput,
  provider: DataForSeoProvider,
  geocode: Geocoder,
): Promise<BusinessInput & { lat: number; lng: number }> {
  if (input.lat != null && input.lng != null) return { ...input, lat: input.lat, lng: input.lng };
  if (!input.placeId && !input.address) {
    throw new AppError("VALIDATION_ERROR", "Add a Google place ID or an address so we can find the business on the map.");
  }
  if (input.placeId && provider.lookupPlace) {
    const found = await provider.lookupPlace(input.placeId);
    if (found) {
      console.log("business.place-lookup", { costUsd: found.billing.costUsd });
      const p = found.place;
      return {
        ...input,
        address: input.address ?? p.address,
        category: input.category ?? p.category,
        domain: input.domain ?? p.domain,
        cid: input.cid ?? p.cid,
        lat: p.lat,
        lng: p.lng,
      };
    }
  }
  if (input.address) {
    const geo = await geocode(input.address);
    if (geo) return { ...input, lat: geo.lat, lng: geo.lng };
  }
  throw new AppError(
    "VALIDATION_ERROR",
    input.placeId
      ? "We couldn't find that place ID on Google. Check it starts with ChIJ, or add the street address instead."
      : "We couldn't find that address on the map. Try adding the city and state.",
  );
}

export async function createBusiness(db: Db, workspaceId: string, input: BusinessInput & { lat: number; lng: number }) {
  const id = newId();
  await db.insert(businesses).values({
    id,
    workspaceId,
    name: input.name,
    placeId: input.placeId ?? null,
    cid: input.cid ?? null,
    domain: cleanDomain(input.domain),
    address: input.address ?? null,
    category: input.category ?? null,
    lat: input.lat,
    lng: input.lng,
  });
  return getBusiness(db, workspaceId, id);
}

export async function archiveBusiness(db: Db, workspaceId: string, id: string) {
  await getBusiness(db, workspaceId, id);
  const now = new Date().toISOString();
  await db.update(trackers).set({ archivedAt: now, scheduleFrequency: "none", nextRunAt: null }).where(and(eq(trackers.businessId, id), eq(trackers.workspaceId, workspaceId)));
  await db.update(businesses).set({ archivedAt: now }).where(and(eq(businesses.id, id), eq(businesses.workspaceId, workspaceId)));
}

export async function getTracker(db: Db, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(trackers)
    .where(and(eq(trackers.id, id), eq(trackers.workspaceId, workspaceId), isNull(trackers.archivedAt)));
  if (!row) throw new AppError("NOT_FOUND", "Tracker not found");
  return row;
}

export async function createTracker(db: Db, workspaceId: string, input: TrackerInput, now = new Date()) {
  const business = await getBusiness(db, workspaceId, input.businessId);
  const id = newId();
  await db.insert(trackers).values({
    id,
    workspaceId,
    businessId: business.id,
    keyword: input.keyword,
    centerLat: input.centerLat ?? business.lat,
    centerLng: input.centerLng ?? business.lng,
    gridSize: input.gridSize,
    radiusKm: toKm(input.radius.value, input.radius.unit),
    radiusUnit: input.radius.unit,
    zoom: input.zoom,
    searchType: input.searchType,
    queueMode: input.queueMode,
    device: input.device,
    languageCode: input.languageCode,
    depth: input.depth,
    scheduleFrequency: input.schedule.frequency,
    scheduleDay: input.schedule.day,
    nextRunAt: input.schedule.frequency === "monthly" ? nextMonthlyRun(now, input.schedule.day).toISOString() : null,
  });
  return getTracker(db, workspaceId, id);
}

/**
 * Edits apply to future scans only: finished scans keep the settings they ran
 * with. Changing grid, zoom or search type breaks comparability with earlier
 * scans, which the UI warns about.
 */
export async function updateTracker(db: Db, workspaceId: string, id: string, patch: TrackerPatch, now = new Date()) {
  const current = await getTracker(db, workspaceId, id);
  const set: Partial<typeof trackers.$inferInsert> = {};
  if (patch.keyword !== undefined) set.keyword = patch.keyword;
  if (patch.centerLat !== undefined) set.centerLat = patch.centerLat;
  if (patch.centerLng !== undefined) set.centerLng = patch.centerLng;
  if (patch.gridSize !== undefined) set.gridSize = patch.gridSize;
  if (patch.radius !== undefined) {
    set.radiusKm = toKm(patch.radius.value, patch.radius.unit);
    set.radiusUnit = patch.radius.unit;
  }
  if (patch.zoom !== undefined) set.zoom = patch.zoom;
  if (patch.searchType !== undefined) set.searchType = patch.searchType;
  if (patch.queueMode !== undefined) set.queueMode = patch.queueMode;
  if (patch.device !== undefined) set.device = patch.device;
  if (patch.languageCode !== undefined) set.languageCode = patch.languageCode;
  if (patch.schedule) {
    set.scheduleFrequency = patch.schedule.frequency;
    set.scheduleDay = patch.schedule.day;
    set.nextRunAt = patch.schedule.frequency === "monthly" ? nextMonthlyRun(now, patch.schedule.day).toISOString() : null;
  }
  const gridError = validateGridInput({
    centerLat: set.centerLat ?? current.centerLat,
    centerLng: set.centerLng ?? current.centerLng,
    size: set.gridSize ?? current.gridSize,
    radiusKm: set.radiusKm ?? current.radiusKm,
  });
  if (gridError) throw new AppError("VALIDATION_ERROR", gridError);
  if (Object.keys(set).length > 0) {
    await db.update(trackers).set(set).where(and(eq(trackers.id, id), eq(trackers.workspaceId, workspaceId)));
  }
  return getTracker(db, workspaceId, id);
}

export async function archiveTracker(db: Db, workspaceId: string, id: string) {
  await getTracker(db, workspaceId, id);
  await db
    .update(trackers)
    .set({ archivedAt: new Date().toISOString(), scheduleFrequency: "none", nextRunAt: null })
    .where(and(eq(trackers.id, id), eq(trackers.workspaceId, workspaceId)));
}
