// What a grid would skip and cost, before anything runs. Backs the tracker
// page, the "new grid" builder and the MCP quote tool.
import { toKm } from "@/shared/grid";
import type { TrackerId, WorkspaceId } from "@/shared/ids";
import type { SkipPreviewInput } from "@/shared/schemas";
import { DEFAULT_RULES } from "@/shared/skip/plan";
import { getBusiness, getTracker } from "../catalog";
import type { AppConfig } from "../config";
import type { Db } from "../db";
import { asBusinessId } from "@/shared/ids";
import { quoteScanPoints, type ScanQuote } from "./service";
import { planTrackerGrid, rulesOf, type GridPlan } from "./skip";

export type SkipPreview = GridPlan & {
  /** The quote for the scannable points only. A cost estimate must use `quote.points`, not the grid size squared. */
  quote: ScanQuote;
};

type Deps = { db: Db; config: Pick<AppConfig, "billingMode" | "markup"> };

/** The plan a saved tracker's next scan would use (current rules and overrides). */
export async function previewTrackerSkips(deps: Deps, workspaceId: WorkspaceId, trackerId: TrackerId): Promise<SkipPreview> {
  const tracker = await getTracker(deps.db, workspaceId, trackerId);
  const business = await getBusiness(deps.db, workspaceId, asBusinessId(tracker.businessId));
  const plan = await planTrackerGrid(
    deps.db,
    workspaceId,
    business,
    { centerLat: tracker.centerLat, centerLng: tracker.centerLng, size: tracker.gridSize, radiusKm: tracker.radiusKm },
    rulesOf(tracker),
  );
  return { ...plan, quote: quoteScanPoints(deps.config, plan.summary.scannablePoints, plan.summary.skippedPoints, tracker.queueMode) };
}

/** The plan for a grid that has not been saved yet (the "new grid" form). */
export async function previewGridSkips(deps: Deps, workspaceId: WorkspaceId, input: SkipPreviewInput): Promise<SkipPreview> {
  const business = await getBusiness(deps.db, workspaceId, asBusinessId(input.businessId));
  const plan = await planTrackerGrid(
    deps.db,
    workspaceId,
    business,
    {
      centerLat: input.centerLat ?? business.lat,
      centerLng: input.centerLng ?? business.lng,
      size: input.gridSize,
      radiusKm: toKm(input.radius.value, input.radius.unit),
    },
    {
      skipWater: input.autoSkipWater,
      overrides: input.skipOverrides ?? DEFAULT_RULES.overrides,
      exclusion: input.exclusion ?? DEFAULT_RULES.exclusion,
    },
  );
  return { ...plan, quote: quoteScanPoints(deps.config, plan.summary.scannablePoints, plan.summary.skippedPoints, input.queueMode) };
}
