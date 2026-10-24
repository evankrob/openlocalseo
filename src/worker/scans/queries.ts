// Read models for the UI, the public report and MCP.
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { summarizeCompetitors, type CompetitorSummary, type ScanMetrics } from "@/shared/metrics";
import { AppError } from "@/shared/errors";
import type { Db } from "../db";
import { businesses, scanPoints, scanResults, scans, trackers } from "../db/schema";

type ScanRow = typeof scans.$inferSelect;

export type ScanListItem = {
  id: string;
  status: ScanRow["status"];
  trigger: ScanRow["trigger"];
  createdAt: string;
  completedAt: string | null;
  arp: number | null;
  atrp: number | null;
  solv: number | null;
  foundPoints: number | null;
  top3Points: number | null;
  totalPoints: number;
  gridSize: number;
  queueMode: ScanRow["queueMode"];
  searchType: ScanRow["searchType"];
  costUsd: number;
  error: string | null;
};

const listColumns = {
  id: scans.id,
  status: scans.status,
  trigger: scans.trigger,
  createdAt: scans.createdAt,
  completedAt: scans.completedAt,
  arp: scans.arp,
  atrp: scans.atrp,
  solv: scans.solv,
  foundPoints: scans.foundPoints,
  top3Points: scans.top3Points,
  totalPoints: scans.totalPoints,
  gridSize: scans.gridSize,
  queueMode: scans.queueMode,
  searchType: scans.searchType,
  costUsd: scans.costUsd,
  error: scans.error,
};

/** Scan history for a tracker, newest first. */
export async function listTrackerScans(db: Db, workspaceId: string, trackerId: string, limit = 120): Promise<ScanListItem[]> {
  return db
    .select(listColumns)
    .from(scans)
    .where(and(eq(scans.workspaceId, workspaceId), eq(scans.trackerId, trackerId)))
    .orderBy(desc(scans.createdAt))
    .limit(limit);
}

/** Recent scans across the workspace (MCP list_scans, dashboard). */
export async function listWorkspaceScans(
  db: Db,
  workspaceId: string,
  options: { trackerId?: string; limit?: number } = {},
) {
  const where = options.trackerId
    ? and(eq(scans.workspaceId, workspaceId), eq(scans.trackerId, options.trackerId))
    : eq(scans.workspaceId, workspaceId);
  return db
    .select({ ...listColumns, trackerId: scans.trackerId, keyword: scans.keyword, businessName: businesses.name })
    .from(scans)
    .innerJoin(trackers, eq(trackers.id, scans.trackerId))
    .innerJoin(businesses, eq(businesses.id, trackers.businessId))
    .where(where)
    .orderBy(desc(scans.createdAt))
    .limit(Math.min(options.limit ?? 20, 100));
}

export type TrackerSummary = {
  id: string;
  keyword: string;
  business: { id: string; name: string };
  gridSize: number;
  radiusKm: number;
  radiusUnit: "km" | "mi";
  zoom: number;
  searchType: "maps" | "local_finder";
  queueMode: "standard" | "priority" | "live";
  device: "desktop" | "mobile";
  languageCode: string;
  centerLat: number;
  centerLng: number;
  depth: number;
  scheduleFrequency: "none" | "monthly";
  scheduleDay: number;
  nextRunAt: string | null;
  latestScan: ScanListItem | null;
  lastCompleted: ScanListItem | null;
};

/** One row per rank per tracker, via a window function over this workspace's scans. */
async function latestScanIds(db: Db, workspaceId: string, onlyCompleted: boolean): Promise<string[]> {
  const rows = await db.all<{ id: string }>(sql`
    SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY tracker_id ORDER BY created_at DESC) AS rn
      FROM scans
      WHERE workspace_id = ${workspaceId} ${onlyCompleted ? sql`AND status = 'completed'` : sql``}
    ) WHERE rn = 1`);
  return rows.map((r) => r.id);
}

export async function listTrackerSummaries(db: Db, workspaceId: string): Promise<TrackerSummary[]> {
  const rows = await db
    .select({ tracker: trackers, business: { id: businesses.id, name: businesses.name } })
    .from(trackers)
    .innerJoin(businesses, eq(businesses.id, trackers.businessId))
    .where(and(eq(trackers.workspaceId, workspaceId), sql`${trackers.archivedAt} IS NULL`))
    .orderBy(desc(trackers.createdAt));
  if (rows.length === 0) return [];

  const [latestIds, completedIds] = await Promise.all([latestScanIds(db, workspaceId, false), latestScanIds(db, workspaceId, true)]);
  const ids = [...new Set([...latestIds, ...completedIds])];
  const scanRows = ids.length
    ? (
        await Promise.all(
          Array.from({ length: Math.ceil(ids.length / 50) }, (_, i) =>
            db
              .select({ ...listColumns, trackerId: scans.trackerId })
              .from(scans)
              .where(inArray(scans.id, ids.slice(i * 50, i * 50 + 50))),
          ),
        )
      ).flat()
    : [];
  const byId = new Map(scanRows.map((s) => [s.id, s]));
  const latestByTracker = new Map<string, ScanListItem>();
  const completedByTracker = new Map<string, ScanListItem>();
  for (const id of latestIds) {
    const s = byId.get(id);
    if (s) latestByTracker.set(s.trackerId, s);
  }
  for (const id of completedIds) {
    const s = byId.get(id);
    if (s) completedByTracker.set(s.trackerId, s);
  }

  return rows.map(({ tracker: t, business }) => ({
    id: t.id,
    keyword: t.keyword,
    business,
    gridSize: t.gridSize,
    radiusKm: t.radiusKm,
    radiusUnit: t.radiusUnit,
    zoom: t.zoom,
    searchType: t.searchType,
    queueMode: t.queueMode,
    device: t.device,
    languageCode: t.languageCode,
    centerLat: t.centerLat,
    centerLng: t.centerLng,
    depth: t.depth,
    scheduleFrequency: t.scheduleFrequency,
    scheduleDay: t.scheduleDay,
    nextRunAt: t.nextRunAt,
    latestScan: latestByTracker.get(t.id) ?? null,
    lastCompleted: completedByTracker.get(t.id) ?? null,
  }));
}

export type ScanDetail = {
  scan: ScanListItem & {
    keyword: string;
    centerLat: number;
    centerLng: number;
    radiusKm: number;
    zoom: number;
    device: ScanRow["device"];
    languageCode: string;
    trackerId: string;
    estimatedCostUsd: number;
    billedCredits: number;
  };
  business: { id: string; name: string; lat: number; lng: number; address: string | null };
  points: Array<{
    id: string;
    row: number;
    col: number;
    lat: number;
    lng: number;
    status: string;
    rank: number | null;
    error: string | null;
  }>;
  metrics: ScanMetrics | null;
  /** True once retention pruned this scan's competitor rows; `competitors` is then empty by design. */
  competitorsExpired: boolean;
  /** Days the app keeps competitor rows; added by GET /api/scans/:id for the "expired" message. */
  retentionDays?: number;
  competitors: CompetitorSummary[];
  /** Listings with the tracked website that are not the tracked place (e.g. a different/duplicate Google listing). */
  otherListings: Array<{ name: string; placeId: string | null; points: number; bestRank: number }>;
};

export async function getScanDetail(
  db: Db,
  scanId: string,
  scope: { workspaceId: string } | { trackerId: string },
  options: { competitors: boolean } = { competitors: true },
): Promise<ScanDetail> {
  const [row] = await db
    .select({ scan: scans, business: businesses })
    .from(scans)
    .innerJoin(trackers, eq(trackers.id, scans.trackerId))
    .innerJoin(businesses, eq(businesses.id, trackers.businessId))
    .where(
      "workspaceId" in scope
        ? and(eq(scans.id, scanId), eq(scans.workspaceId, scope.workspaceId))
        : and(eq(scans.id, scanId), eq(scans.trackerId, scope.trackerId)),
    );
  if (!row) throw new AppError("NOT_FOUND", "Scan not found");
  const { scan, business } = row;

  const points = await db
    .select({
      id: scanPoints.id,
      row: scanPoints.row,
      col: scanPoints.col,
      lat: scanPoints.lat,
      lng: scanPoints.lng,
      status: scanPoints.status,
      rank: scanPoints.rank,
      error: scanPoints.error,
    })
    .from(scanPoints)
    .where(eq(scanPoints.scanId, scanId))
    .orderBy(scanPoints.row, scanPoints.col);

  const completedPoints = points.filter((p) => p.status === "completed");
  const metrics: ScanMetrics | null =
    scan.status === "completed" && scan.atrp !== null
      ? {
          arp: scan.arp,
          atrp: scan.atrp,
          solv: scan.solv,
          foundPoints: scan.foundPoints ?? 0,
          top3Points: scan.top3Points ?? 0,
          totalPoints: completedPoints.length,
        }
      : null;

  return {
    scan: {
      id: scan.id,
      status: scan.status,
      trigger: scan.trigger,
      createdAt: scan.createdAt,
      completedAt: scan.completedAt,
      arp: scan.arp,
      atrp: scan.atrp,
      solv: scan.solv,
      foundPoints: scan.foundPoints,
      top3Points: scan.top3Points,
      totalPoints: scan.totalPoints,
      gridSize: scan.gridSize,
      queueMode: scan.queueMode,
      searchType: scan.searchType,
      costUsd: scan.costUsd,
      error: scan.error,
      keyword: scan.keyword,
      centerLat: scan.centerLat,
      centerLng: scan.centerLng,
      radiusKm: scan.radiusKm,
      zoom: scan.zoom,
      device: scan.device,
      languageCode: scan.languageCode,
      trackerId: scan.trackerId,
      estimatedCostUsd: scan.estimatedCostUsd,
      billedCredits: scan.billedCredits,
    },
    business: { id: business.id, name: business.name, lat: business.lat, lng: business.lng, address: business.address },
    points,
    metrics,
    // Retention pruned the per-point competitor rows; the grid and metrics above remain.
    competitorsExpired: scan.resultsPrunedAt !== null,
    competitors:
      options.competitors && scan.status === "completed" && scan.resultsPrunedAt === null
        ? await getCompetitors(db, scanId, completedPoints.map((p) => p.id))
        : [],
    otherListings: scan.resultsPrunedAt === null ? await getOtherListings(db, scanId, business.domain) : [],
  };
}

const bareDomain = (d: string) => d.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");

/** Results showing the tracked website under a listing that was not matched as the tracked business. */
export async function getOtherListings(db: Db, scanId: string, domain: string | null) {
  if (!domain) return [];
  const want = bareDomain(domain);
  const rows = await db
    .select({ pointId: scanResults.pointId, key: scanResults.businessKey, name: scanResults.name, placeId: scanResults.placeId, domain: scanResults.domain, rank: scanResults.rank, isTarget: scanResults.isTarget })
    .from(scanResults)
    .where(eq(scanResults.scanId, scanId));
  const byKey = new Map<string, { name: string; placeId: string | null; points: Set<string>; bestRank: number }>();
  for (const r of rows) {
    if (r.isTarget || !r.domain || bareDomain(r.domain) !== want) continue;
    const e = byKey.get(r.key) ?? { name: r.name, placeId: r.placeId, points: new Set<string>(), bestRank: r.rank };
    e.points.add(r.pointId);
    e.bestRank = Math.min(e.bestRank, r.rank);
    byKey.set(r.key, e);
  }
  return [...byKey.values()].map((e) => ({ name: e.name, placeId: e.placeId, points: e.points.size, bestRank: e.bestRank }));
}

/** Per-business ARP / ATRP / SoLV from the SERPs this scan already collected. */
export async function getCompetitors(db: Db, scanId: string, completedPointIds: string[]): Promise<CompetitorSummary[]> {
  const rows = await db
    .select({
      pointId: scanResults.pointId,
      key: scanResults.businessKey,
      name: scanResults.name,
      rank: scanResults.rank,
      rating: scanResults.rating,
      ratingCount: scanResults.ratingCount,
      category: scanResults.category,
      address: scanResults.address,
    })
    .from(scanResults)
    .where(eq(scanResults.scanId, scanId));
  const byPoint = new Map<string, typeof rows>(completedPointIds.map((id) => [id, []]));
  for (const row of rows) byPoint.get(row.pointId)?.push(row);
  return summarizeCompetitors([...byPoint.values()]);
}

export async function getPointResults(
  db: Db,
  scanId: string,
  pointId: string,
  scope: { workspaceId: string } | { trackerId: string },
) {
  const [owner] = await db
    .select({ id: scans.id, resultsPrunedAt: scans.resultsPrunedAt })
    .from(scans)
    .where(
      "workspaceId" in scope
        ? and(eq(scans.id, scanId), eq(scans.workspaceId, scope.workspaceId))
        : and(eq(scans.id, scanId), eq(scans.trackerId, scope.trackerId)),
    );
  if (!owner) throw new AppError("NOT_FOUND", "Scan not found");
  const [point] = await db
    .select()
    .from(scanPoints)
    .where(and(eq(scanPoints.id, pointId), eq(scanPoints.scanId, scanId)));
  if (!point) throw new AppError("NOT_FOUND", "Point not found");
  const expired = owner.resultsPrunedAt !== null;
  const results = expired
    ? []
    : await db
        .select({
          rank: scanResults.rank,
          name: scanResults.name,
          rating: scanResults.rating,
          ratingCount: scanResults.ratingCount,
          category: scanResults.category,
          address: scanResults.address,
          isTarget: scanResults.isTarget,
        })
        .from(scanResults)
        .where(eq(scanResults.pointId, pointId))
        .orderBy(scanResults.rank);
  return {
    point: { id: point.id, row: point.row, col: point.col, lat: point.lat, lng: point.lng, rank: point.rank, status: point.status },
    results,
    // Retention pruned the competitor rows; the point's own rank above remains.
    competitorsExpired: expired,
  };
}
