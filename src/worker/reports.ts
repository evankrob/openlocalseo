// White-label client reports: a revocable public link to a tracker's latest
// scan, history and (optionally) competitor view, rendered with the
// workspace's own branding. The public payload carries no costs, ids of the
// workspace, error text or scan settings beyond what a client needs to read it.
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { AppError } from "@/shared/errors";
import type { BrandingInput } from "@/shared/schemas";
import type { Db } from "./db";
import { businesses, reportShares, scans, trackers, workspaceBranding, workspaces } from "./db/schema";
import { newId, randomToken, sha256Hex } from "./lib";
import { getScanDetail, getPointResults } from "./scans/queries";

export const SHARE_TOKEN_PREFIX = "olrep_";

export async function getBranding(db: Db, workspaceId: string) {
  const [row] = await db.select().from(workspaceBranding).where(eq(workspaceBranding.workspaceId, workspaceId));
  return {
    brandName: row?.brandName ?? null,
    logoUrl: row?.logoUrl ?? null,
    primaryColor: row?.primaryColor ?? null,
    footerText: row?.footerText ?? null,
    contactUrl: row?.contactUrl ?? null,
    hideAttribution: row?.hideAttribution ?? false,
  };
}

export async function saveBranding(db: Db, workspaceId: string, input: BrandingInput) {
  const current = await getBranding(db, workspaceId);
  const next = {
    brandName: input.brandName === undefined ? current.brandName : input.brandName,
    logoUrl: input.logoUrl === undefined ? current.logoUrl : input.logoUrl,
    primaryColor: input.primaryColor === undefined ? current.primaryColor : input.primaryColor,
    footerText: input.footerText === undefined ? current.footerText : input.footerText,
    contactUrl: input.contactUrl === undefined ? current.contactUrl : input.contactUrl,
    hideAttribution: input.hideAttribution ?? current.hideAttribution,
  };
  await db
    .insert(workspaceBranding)
    .values({ workspaceId, ...next })
    .onConflictDoUpdate({ target: workspaceBranding.workspaceId, set: next });
  return next;
}

export async function createShare(
  db: Db,
  workspaceId: string,
  trackerId: string,
  input: { label?: string | null; showCompetitors: boolean; expiresAt?: string | null },
) {
  const [tracker] = await db
    .select({ id: trackers.id })
    .from(trackers)
    .where(and(eq(trackers.id, trackerId), eq(trackers.workspaceId, workspaceId), isNull(trackers.archivedAt)));
  if (!tracker) throw new AppError("NOT_FOUND", "Tracker not found");
  const token = `${SHARE_TOKEN_PREFIX}${randomToken(24)}`;
  const id = newId();
  await db.insert(reportShares).values({
    id,
    workspaceId,
    trackerId,
    tokenHash: await sha256Hex(token),
    label: input.label ?? null,
    showCompetitors: input.showCompetitors,
    expiresAt: input.expiresAt ?? null,
  });
  // The token is only ever returned here.
  return { id, token };
}

export async function listShares(db: Db, workspaceId: string, trackerId: string) {
  return db
    .select({
      id: reportShares.id,
      label: reportShares.label,
      showCompetitors: reportShares.showCompetitors,
      expiresAt: reportShares.expiresAt,
      revokedAt: reportShares.revokedAt,
      viewCount: reportShares.viewCount,
      createdAt: reportShares.createdAt,
    })
    .from(reportShares)
    .where(and(eq(reportShares.workspaceId, workspaceId), eq(reportShares.trackerId, trackerId)))
    .orderBy(desc(reportShares.createdAt));
}

export async function revokeShare(db: Db, workspaceId: string, shareId: string) {
  const rows = await db
    .update(reportShares)
    .set({ revokedAt: new Date().toISOString() })
    .where(and(eq(reportShares.id, shareId), eq(reportShares.workspaceId, workspaceId), isNull(reportShares.revokedAt)))
    .returning({ id: reportShares.id });
  if (rows.length === 0) throw new AppError("NOT_FOUND", "Share link not found");
}

async function resolveShare(db: Db, token: string, now: Date) {
  if (!token.startsWith(SHARE_TOKEN_PREFIX)) throw new AppError("NOT_FOUND", "Report not found");
  const [share] = await db
    .select()
    .from(reportShares)
    .where(eq(reportShares.tokenHash, await sha256Hex(token)));
  // Same error for unknown, revoked and expired links: nothing to probe.
  if (!share || share.revokedAt || (share.expiresAt && share.expiresAt <= now.toISOString())) {
    throw new AppError("NOT_FOUND", "Report not found");
  }
  return share;
}

export async function getPublicReport(db: Db, token: string, options: { scanId?: string; now?: Date; retentionDays?: number } = {}) {
  const share = await resolveShare(db, token, options.now ?? new Date());
  const [row] = await db
    .select({ tracker: trackers, business: businesses })
    .from(trackers)
    .innerJoin(businesses, eq(businesses.id, trackers.businessId))
    .where(and(eq(trackers.id, share.trackerId), isNull(trackers.archivedAt)));
  if (!row) throw new AppError("NOT_FOUND", "Report not found");

  const history = await db
    .select({
      id: scans.id,
      createdAt: scans.createdAt,
      arp: scans.arp,
      atrp: scans.atrp,
      solv: scans.solv,
      foundPoints: scans.foundPoints,
      totalPoints: scans.totalPoints,
    })
    .from(scans)
    .where(and(eq(scans.trackerId, share.trackerId), eq(scans.status, "completed")))
    .orderBy(desc(scans.createdAt))
    .limit(60);
  const selected = options.scanId ? history.find((h) => h.id === options.scanId) : history[0];
  if (options.scanId && !selected) throw new AppError("NOT_FOUND", "Scan not found");

  await db
    .update(reportShares)
    .set({ viewCount: sql`${reportShares.viewCount} + 1` })
    .where(eq(reportShares.id, share.id));

  const branding = await getBranding(db, share.workspaceId);
  const [workspace] = await db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, share.workspaceId));
  const detail = selected
    ? await getScanDetail(db, selected.id, { trackerId: share.trackerId }, { competitors: share.showCompetitors })
    : null;

  return {
    branding: { ...branding, brandName: branding.brandName ?? workspace?.name ?? null },
    label: share.label,
    showCompetitors: share.showCompetitors,
    business: { name: row.business.name, address: row.business.address },
    keyword: row.tracker.keyword,
    searchType: row.tracker.searchType,
    history: history.reverse(),
    scan: detail && {
      id: detail.scan.id,
      createdAt: detail.scan.createdAt,
      gridSize: detail.scan.gridSize,
      radiusKm: detail.scan.radiusKm,
      zoom: detail.scan.zoom,
      centerLat: detail.scan.centerLat,
      centerLng: detail.scan.centerLng,
      searchType: detail.scan.searchType,
      keyword: detail.scan.keyword,
      points: detail.points.map((p) => ({ id: p.id, row: p.row, col: p.col, lat: p.lat, lng: p.lng, rank: p.rank, status: p.status })),
      metrics: detail.metrics,
      business: { lat: detail.business.lat, lng: detail.business.lng, name: detail.business.name },
    },
    competitors: share.showCompetitors ? (detail?.competitors.slice(0, 15) ?? []) : [],
    // Retention pruned this scan's competitor rows: the map and metrics are intact.
    competitorsExpired: share.showCompetitors && (detail?.competitorsExpired ?? false),
    retentionDays: options.retentionDays ?? null,
  };
}

export async function getPublicPointResults(db: Db, token: string, scanId: string, pointId: string) {
  const share = await resolveShare(db, token, new Date());
  if (!share.showCompetitors) throw new AppError("NOT_FOUND", "Report not found");
  return getPointResults(db, scanId, pointId, { trackerId: share.trackerId });}
