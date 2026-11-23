// A service-area business's listed areas (cities, ZIPs, counties) and, where the
// user supplied one, each area's boundary. See `business_service_areas`.
import { and, asc, eq } from "drizzle-orm";
import { AppError } from "@/shared/errors";
import { asBusinessId, type BusinessId, type WorkspaceId } from "@/shared/ids";
import type { ServiceAreaInput } from "@/shared/schemas";
import { polygonsOf } from "@/shared/skip/geo";
import { serviceAreaStatus, type ServiceAreaStatus } from "@/shared/skip/plan";
import { getBusiness } from "./catalog";
import type { Db } from "./db";
import { businessServiceAreas, toServiceAreaEntry } from "./db/schema";
import { newId } from "./lib";

export type ServiceAreaView = {
  id: string;
  name: string;
  kind: "city" | "zip" | "county" | "other";
  source: "manual" | "gbp" | "census_tiger";
  /** True when a boundary is stored. The boundary itself is not returned (it can be large). */
  hasBoundary: boolean;
  boundaryVertices: number;
};

export type ServiceAreaOverview = {
  businessId: BusinessId;
  businessType: "storefront" | "service_area";
  areas: ServiceAreaView[];
  status: ServiceAreaStatus;
  /** Where boundaries can come from, shown by the UI when some are missing. */
  boundarySource: string;
};

export const BOUNDARY_SOURCE_NOTE =
  "OpenLocalSEO ships no city, ZIP or county boundaries and Google Business Profile data does not include any. Import them yourself, for example US Census TIGER/Line (ZCTA, places, counties) as GeoJSON.";

export async function getServiceAreas(db: Db, workspaceId: WorkspaceId, businessId: BusinessId): Promise<ServiceAreaOverview> {
  const business = await getBusiness(db, workspaceId, businessId);
  const rows = await db
    .select()
    .from(businessServiceAreas)
    .where(and(eq(businessServiceAreas.businessId, businessId), eq(businessServiceAreas.workspaceId, workspaceId)))
    .orderBy(asc(businessServiceAreas.name));
  return {
    businessId: asBusinessId(business.id),
    businessType: business.businessType,
    areas: rows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      source: r.source,
      hasBoundary: r.polygon !== null,
      boundaryVertices: r.polygon ? polygonsOf(r.polygon).reduce((n, rings) => n + rings.reduce((m, ring) => m + ring.length, 0), 0) : 0,
    })),
    status: serviceAreaStatus(business.businessType, rows.map(toServiceAreaEntry)),
    boundarySource: BOUNDARY_SOURCE_NOTE,
  };
}

/** Replaces the whole list (the UI edits it as one document). */
export async function replaceServiceAreas(db: Db, workspaceId: WorkspaceId, businessId: BusinessId, input: ServiceAreaInput): Promise<ServiceAreaOverview> {
  await getBusiness(db, workspaceId, businessId);
  const seen = new Set<string>();
  for (const a of input.areas) {
    const key = `${a.kind}:${a.name.toLowerCase()}`;
    if (seen.has(key)) throw new AppError("VALIDATION_ERROR", `"${a.name}" is listed twice`);
    seen.add(key);
  }
  const scope = and(eq(businessServiceAreas.businessId, businessId), eq(businessServiceAreas.workspaceId, workspaceId));
  // The list is edited as one document, but boundaries are never sent back to the client:
  // an entry that omits its polygon keeps the stored one.
  const existing = new Map((await db.select().from(businessServiceAreas).where(scope)).map((r) => [`${r.kind}:${r.name.toLowerCase()}`, r]));
  await db.delete(businessServiceAreas).where(scope);
  for (const a of input.areas) {
    const old = existing.get(`${a.kind}:${a.name.toLowerCase()}`);
    await db.insert(businessServiceAreas).values({
      id: newId(),
      workspaceId,
      businessId,
      name: a.name,
      kind: a.kind,
      source: a.source ?? old?.source ?? "manual",
      polygon: a.polygon === undefined ? (old?.polygon ?? null) : a.polygon,
    });
  }
  return getServiceAreas(db, workspaceId, businessId);
}
