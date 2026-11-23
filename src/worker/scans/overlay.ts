// Competitor overlay read model and per-tracker competitor choices. The
// selection, matching and head-to-head rules are pure and live in
// src/shared/overlay.ts; this file loads the stored per-point results (no
// provider calls, no rescans) and persists pins/hides.
import { and, asc, eq } from "drizzle-orm";
import { newId } from "../lib";
import { AppError } from "@/shared/errors";
import type { ScanId, TrackerId, WorkspaceId } from "@/shared/ids";
import type { ScanMetrics } from "@/shared/metrics";
import {
  MAX_PINNED,
  DEFAULT_COMPETITORS,
  buildCandidates,
  countHeadToHead,
  selectCompetitors,
  topPerPoint,
  type CompetitorSettings,
  type ExcludedListing,
  type HeadToHeadCounts,
  type OverlayRow,
  type PointTopEntry,
} from "@/shared/overlay";
import type { CompetitorChoice } from "@/shared/schemas";
import { getTracker } from "../catalog";
import type { Db } from "../db";
import { businesses, scanPoints, scanResults, scans, trackerCompetitors, trackers } from "../db/schema";

export type CompetitorSettingsView = CompetitorSettings & { maxPinned: number };

export async function getCompetitorSettings(db: Db, workspaceId: WorkspaceId, trackerId: TrackerId): Promise<CompetitorSettingsView> {
  await getTracker(db, workspaceId, trackerId);
  return { ...(await loadSettings(db, workspaceId, trackerId)), maxPinned: MAX_PINNED };
}

async function loadSettings(db: Db, workspaceId: WorkspaceId, trackerId: TrackerId): Promise<CompetitorSettings> {
  const rows = await db
    .select({ identity: trackerCompetitors.identity, name: trackerCompetitors.name, status: trackerCompetitors.status })
    .from(trackerCompetitors)
    .where(and(eq(trackerCompetitors.trackerId, trackerId), eq(trackerCompetitors.workspaceId, workspaceId)))
    .orderBy(asc(trackerCompetitors.createdAt), asc(trackerCompetitors.name));
  return {
    pinned: rows.filter((r) => r.status === "pinned").map(({ identity, name }) => ({ identity, name })),
    hidden: rows.filter((r) => r.status === "hidden").map(({ identity, name }) => ({ identity, name })),
  };
}

/** Pin (max 10 per tracker), hide, or reset one competitor. Applies to every scan of the tracker. */
export async function setCompetitorChoice(db: Db, workspaceId: WorkspaceId, trackerId: TrackerId, choice: CompetitorChoice): Promise<CompetitorSettingsView> {
  await getTracker(db, workspaceId, trackerId);
  const current = await loadSettings(db, workspaceId, trackerId);
  const alreadyPinned = current.pinned.some((p) => p.identity === choice.identity);
  if (choice.status === "pinned" && !alreadyPinned && current.pinned.length >= MAX_PINNED) {
    throw new AppError("VALIDATION_ERROR", `You can pin at most ${MAX_PINNED} competitors. Unpin one first.`, { status: "pinned" });
  }
  if (choice.status === "default") {
    await db
      .delete(trackerCompetitors)
      .where(and(eq(trackerCompetitors.trackerId, trackerId), eq(trackerCompetitors.workspaceId, workspaceId), eq(trackerCompetitors.identity, choice.identity)));
  } else {
    await db
      .insert(trackerCompetitors)
      .values({ id: newId(), workspaceId, trackerId, identity: choice.identity, name: choice.name, status: choice.status })
      .onConflictDoUpdate({
        target: [trackerCompetitors.trackerId, trackerCompetitors.identity],
        set: { status: choice.status, name: choice.name },
      });
  }
  return { ...(await loadSettings(db, workspaceId, trackerId)), maxPinned: MAX_PINNED };
}

export type OverlayCompetitor = {
  identity: string;
  name: string;
  source: "default" | "pinned";
  rating: number | null;
  ratingCount: number | null;
  category: string | null;
  address: string | null;
  phone: string | null;
  /** atrp = average rank (not found = 21); solv = top-3 share; foundPoints = points in the top 20. */
  metrics: ScanMetrics;
  /** Client vs this competitor over the same points. */
  headToHead: HeadToHeadCounts;
  /** Rank at each point, aligned with `pointIds`; null = not in the top 20. */
  ranks: Array<number | null>;
  /** Names of listings that share this one's phone and nearly its name. Flag only, never merged. */
  possibleDuplicateOf: string[];
};

export type OverlayCandidate = {
  identity: string;
  name: string;
  top3Points: number;
  atrp: number | null;
  foundPoints: number;
  state: "shown" | "pinned" | "hidden" | "available";
};

export type ScanOverlay = {
  scanId: string;
  trackerId: string;
  /** Retention pruned this scan's per-point results: nothing to overlay, the grid and metrics remain. */
  expired: boolean;
  /** Completed points in grid order; every per-point array below is aligned with this. */
  pointIds: string[];
  clientRanks: Array<number | null>;
  competitors: OverlayCompetitor[];
  /** Top 5 businesses at each point, for the hover/tap card. */
  pointTop: PointTopEntry[][];
  /** Best other businesses, for the "add a competitor" picker. */
  candidates: OverlayCandidate[];
  settings: CompetitorSettingsView;
  excluded: ExcludedListing[];
  unmatchedResults: number;
  defaultCount: number;
};

const PICKER_SIZE = 40;

export async function getScanOverlay(db: Db, workspaceId: WorkspaceId, scanId: ScanId): Promise<ScanOverlay> {
  const [row] = await db
    .select({ scan: scans, business: businesses })
    .from(scans)
    .innerJoin(trackers, eq(trackers.id, scans.trackerId))
    .innerJoin(businesses, eq(businesses.id, trackers.businessId))
    .where(and(eq(scans.id, scanId), eq(scans.workspaceId, workspaceId)));
  if (!row) throw new AppError("NOT_FOUND", "Scan not found");
  const { scan, business } = row;
  const trackerId = scan.trackerId as TrackerId;
  const settings = { ...(await loadSettings(db, workspaceId, trackerId)), maxPinned: MAX_PINNED };
  const empty = (expired: boolean, pointIds: string[] = [], clientRanks: Array<number | null> = []): ScanOverlay => ({
    scanId: scan.id,
    trackerId: scan.trackerId,
    expired,
    pointIds,
    clientRanks,
    competitors: [],
    pointTop: [],
    candidates: [],
    settings,
    excluded: [],
    unmatchedResults: 0,
    defaultCount: DEFAULT_COMPETITORS,
  });
  if (scan.resultsPrunedAt !== null) return empty(true);

  const points = (
    await db
      .select({ id: scanPoints.id, rank: scanPoints.rank, status: scanPoints.status })
      .from(scanPoints)
      .where(eq(scanPoints.scanId, scan.id))
      .orderBy(scanPoints.row, scanPoints.col)
  ).filter((p) => p.status === "completed");
  if (scan.status !== "completed" || points.length === 0) return empty(false);
  const pointIds = points.map((p) => p.id);
  const clientRanks = points.map((p) => p.rank);

  const rows: OverlayRow[] = await db
    .select({
      id: scanResults.id,
      pointId: scanResults.pointId,
      rank: scanResults.rank,
      name: scanResults.name,
      placeId: scanResults.placeId,
      cid: scanResults.cid,
      domain: scanResults.domain,
      phone: scanResults.phone,
      rating: scanResults.rating,
      ratingCount: scanResults.ratingCount,
      category: scanResults.category,
      address: scanResults.address,
      isTarget: scanResults.isTarget,
    })
    .from(scanResults)
    .where(eq(scanResults.scanId, scan.id));

  const { candidates, excluded, unmatchedResults } = buildCandidates(rows, pointIds, { name: business.name, domain: business.domain });
  const selected = selectCompetitors(candidates, settings);
  const shown = new Set(selected.map((c) => c.identity));
  const pinned = new Set(settings.pinned.map((p) => p.identity));
  const hidden = new Set(settings.hidden.map((h) => h.identity));
  return {
    ...empty(false, pointIds, clientRanks),
    competitors: selected.map((c) => ({
      identity: c.identity,
      name: c.name,
      source: c.source,
      rating: c.rating,
      ratingCount: c.ratingCount,
      category: c.category,
      address: c.address,
      phone: c.phone,
      metrics: c.metrics,
      headToHead: countHeadToHead(clientRanks, c.ranks),
      ranks: c.ranks,
      possibleDuplicateOf: c.possibleDuplicateOf,
    })),
    pointTop: topPerPoint(rows, pointIds),
    candidates: candidates
      .filter((c, i) => i < PICKER_SIZE || pinned.has(c.identity) || hidden.has(c.identity))
      .map((c) => ({
        identity: c.identity,
        name: c.name,
        top3Points: c.metrics.top3Points,
        atrp: c.metrics.atrp,
        foundPoints: c.metrics.foundPoints,
        state: pinned.has(c.identity) ? "pinned" : hidden.has(c.identity) ? "hidden" : shown.has(c.identity) ? "shown" : "available",
      })),
    excluded,
    unmatchedResults,
  };
}
