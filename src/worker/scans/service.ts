import { and, eq, isNull } from "drizzle-orm";
import { buildGrid, formatLocationCoordinate } from "@/shared/grid";
import {
  applyMarkupUsd,
  creditsForProviderUsd,
  estimateScanCostUsd,
  type QueueMode,
} from "@/shared/pricing";
import { AppError } from "@/shared/errors";
import { asScanId, type ScanId, type TrackerId, type WorkspaceId } from "@/shared/ids";
import type { AppConfig } from "../config";
import type { Db } from "../db";
import { scans, trackers } from "../db/schema";
import { withCreditHold } from "../billing/spend";
import { newId, nowIso } from "../lib";
import type { ScanQueue } from "./jobs";
import { insertPoints } from "./sql";

export type ScanDeps = {
  db: Db;
  queue: ScanQueue;
  config: AppConfig;
  /** Injectable clock (tests); defaults to the real time. */
  now?: () => Date;
};

export type ScanQuote = {
  points: number;
  queueMode: QueueMode;
  /** What DataForSEO will charge (upper bound), in USD. */
  providerCostUsd: number;
  /** What this workspace pays: provider cost, plus markup in hosted mode. */
  chargedUsd: number;
  /** Hosted only: credits held for the scan; 0 in BYOK mode. */
  credits: number;
};

export function quoteScan(
  config: Pick<AppConfig, "billingMode" | "markup">,
  gridSize: number,
  queueMode: QueueMode,
): ScanQuote {
  const points = gridSize * gridSize;
  const providerCostUsd = estimateScanCostUsd(points, queueMode);
  const hosted = config.billingMode === "hosted";
  return {
    points,
    queueMode,
    providerCostUsd,
    chargedUsd: hosted ? applyMarkupUsd(providerCostUsd, config.markup) : providerCostUsd,
    credits: hosted ? creditsForProviderUsd(providerCostUsd, config.markup) : 0,
  };
}

export type CreateScanOptions = {
  trigger: "manual" | "schedule" | "mcp";
  /** Refuse to start if the estimated charge (USD) is above this. */
  maxCostUsd?: number;
};

const ACTIVE = ["queued", "posting", "polling"] as const;

/** Creates a scan for a tracker, holds credits (hosted) and queues it. */
export async function createScan(
  deps: ScanDeps,
  workspaceId: WorkspaceId,
  trackerId: TrackerId,
  options: CreateScanOptions,
): Promise<{ scanId: ScanId; quote: ScanQuote }> {
  const { db, queue, config } = deps;
  const [tracker] = await db
    .select()
    .from(trackers)
    .where(and(eq(trackers.id, trackerId), eq(trackers.workspaceId, workspaceId), isNull(trackers.archivedAt)));
  if (!tracker) throw new AppError("NOT_FOUND", "Tracker not found");

  const quote = quoteScan(config, tracker.gridSize, tracker.queueMode);
  if (options.maxCostUsd !== undefined && quote.chargedUsd > options.maxCostUsd) {
    throw new AppError(
      "COST_CEILING_EXCEEDED",
      `Estimated cost $${quote.chargedUsd} is above the approved maximum of $${options.maxCostUsd}`,
    );
  }

  const points = buildGrid({
    centerLat: tracker.centerLat,
    centerLng: tracker.centerLng,
    size: tracker.gridSize,
    radiusKm: tracker.radiusKm,
  });

  const scanId = asScanId(newId());
  try {
    await db.insert(scans).values({
      id: scanId,
      workspaceId,
      trackerId,
      status: "queued",
      trigger: options.trigger,
      keyword: tracker.keyword,
      centerLat: tracker.centerLat,
      centerLng: tracker.centerLng,
      gridSize: tracker.gridSize,
      radiusKm: tracker.radiusKm,
      zoom: tracker.zoom,
      searchType: tracker.searchType,
      queueMode: tracker.queueMode,
      device: tracker.device,
      languageCode: tracker.languageCode,
      depth: tracker.depth,
      totalPoints: points.length,
      estimatedCostUsd: quote.providerCostUsd,
      reservedCredits: quote.credits,
      createdAt: nowIso(deps.now?.()),
    });
  } catch (error) {
    // The partial unique index allows one active scan per tracker.
    if (String(error).includes("UNIQUE") || String((error as Error).cause).includes("UNIQUE")) {
      throw new AppError("SCAN_IN_PROGRESS", "A scan is already running for this tracker");
    }
    throw error;
  }

  let held = false;
  try {
    await insertPoints(
      db,
      scanId,
      points.map((p) => ({ id: newId(), row: p.row, col: p.col, lat: p.lat, lng: p.lng })),
    );
    await withCreditHold(
      db,
      workspaceId,
      { billingMode: config.billingMode, credits: quote.credits, scope: "scan", refId: scanId },
      async () => {
        held = true;
        await queue.send({ type: "post", scanId });
      },
    );
  } catch (error) {
    // Nothing was charged yet (the hold failed): remove the half-created scan.
    // Once the credits are held the row stays so the reaper can refund them.
    if (!held) await db.delete(scans).where(eq(scans.id, scanId));
    throw error;
  }
  return { scanId, quote };
}

/** Coordinate string for a grid point at the scan's fixed zoom. */
export function pointCoordinate(point: { lat: number; lng: number }, zoom: number) {
  return formatLocationCoordinate(point, zoom);
}

export { ACTIVE as ACTIVE_SCAN_STATUSES };
