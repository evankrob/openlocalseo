// Server side of the skip rules: loads what `planSkips` needs (water index,
// the business's service areas, the tracker's rules) and returns the plan the
// scan will use. Scan creation, the preview endpoints and the MCP quote tool all
// come through `planTrackerGrid`, so the quote always matches what is scanned.
import { and, asc, eq } from "drizzle-orm";
import { buildGrid, type GridInput } from "@/shared/grid";
import type { BusinessId, WorkspaceId } from "@/shared/ids";
import {
  DEFAULT_RULES,
  exclusionSchema,
  planSkips,
  serviceAreaStatus,
  skipOverridesSchema,
  summarizePlan,
  type BusinessType,
  type PlannedPoint,
  type PlanSummary,
  type ServiceAreaEntry,
  type ServiceAreaStatus,
  type SkipRules,
} from "@/shared/skip/plan";
import type { WaterIndex } from "@/shared/skip/water";
import type { Db } from "../db";
import { businessServiceAreas, toServiceAreaEntry, trackers } from "../db/schema";
import { loadWaterIndex } from "../skip/water";

type TrackerRow = typeof trackers.$inferSelect;

/** The tracker's stored rules. Malformed JSON falls back to the defaults (scan everything automatic rules allow). */
export function rulesOf(tracker: Pick<TrackerRow, "autoSkipWater" | "skipOverrides" | "skipExclusion">): SkipRules {
  const overrides = skipOverridesSchema.safeParse(tracker.skipOverrides);
  const exclusion = exclusionSchema.safeParse(tracker.skipExclusion);
  return {
    skipWater: tracker.autoSkipWater,
    overrides: overrides.success ? overrides.data : DEFAULT_RULES.overrides,
    exclusion: exclusion.success ? exclusion.data : DEFAULT_RULES.exclusion,
  };
}

export async function loadServiceAreas(db: Db, workspaceId: WorkspaceId, businessId: BusinessId): Promise<ServiceAreaEntry[]> {
  const rows = await db
    .select()
    .from(businessServiceAreas)
    .where(and(eq(businessServiceAreas.businessId, businessId), eq(businessServiceAreas.workspaceId, workspaceId)))
    .orderBy(asc(businessServiceAreas.name));
  return rows.map(toServiceAreaEntry);
}

export type GridPlan = {
  points: PlannedPoint[];
  summary: PlanSummary;
  serviceArea: ServiceAreaStatus;
};

export async function planTrackerGrid(
  db: Db,
  workspaceId: WorkspaceId,
  business: { id: string; businessType: BusinessType },
  grid: GridInput,
  rules: SkipRules,
): Promise<GridPlan> {
  const serviceAreas = await loadServiceAreas(db, workspaceId, business.id as BusinessId);
  let water: WaterIndex | null = null;
  if (rules.skipWater) {
    try {
      water = await loadWaterIndex();
    } catch (error) {
      // Safe default: without water data every point is scanned.
      console.warn("skip.water-unavailable", { message: error instanceof Error ? error.message : "unknown" });
    }
  }
  const points = planSkips({ points: buildGrid(grid), water, businessType: business.businessType, serviceAreas, rules });
  return { points, summary: summarizePlan(points), serviceArea: serviceAreaStatus(business.businessType, serviceAreas) };
}
