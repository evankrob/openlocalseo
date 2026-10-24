// Rank-drop alerts: settings, creation (called when a scan is finalized) and
// the read model behind /api/alerts. Rules themselves live in shared/alerts.ts.
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import {
  DEFAULT_ALERT_SETTINGS,
  evaluateAlerts,
  type AlertMetrics,
  type AlertSettingsValues,
  type ScanSnapshot,
} from "@/shared/alerts";
import { AppError } from "@/shared/errors";
import { NEGATIVE_REVIEW_MAX_STARS, evaluateGbpAlerts, type GbpAlertMetrics } from "@/shared/gbp";
import type { Db } from "./db";
import { alertSettings, alerts, businesses, gbpSnapshots, reviews, scanPoints, scans, trackers } from "./db/schema";
import { newId, nowIso } from "./lib";
import { assertWebhookUrl, type WebhookSender } from "./notify";

export type AlertDeps = {
  db: Db;
  now?: () => Date;
  /** Outbound webhook sender; absent = never notify (tests, local dev). */
  notify?: WebhookSender;
  /** Keeps a fire-and-forget promise alive after the response (Workers ExecutionContext). */
  waitUntil?: (promise: Promise<unknown>) => void;
};

// ---- settings ---------------------------------------------------------------------

export async function getAlertSettings(db: Db, workspaceId: string): Promise<AlertSettingsValues> {
  const [row] = await db.select().from(alertSettings).where(eq(alertSettings.workspaceId, workspaceId));
  if (!row) return { ...DEFAULT_ALERT_SETTINGS };
  return {
    enabled: row.enabled,
    atrpWorse: row.atrpWorse,
    solvDown: row.solvDown,
    foundDropPct: row.foundDropPct,
    centerTop3: row.centerTop3,
    criticalAtrp: row.criticalAtrp,
    criticalSolv: row.criticalSolv,
    webhookUrl: row.webhookUrl,
  };
}

export async function saveAlertSettings(db: Db, workspaceId: string, input: Partial<AlertSettingsValues>): Promise<AlertSettingsValues> {
  const current = await getAlertSettings(db, workspaceId);
  const next: AlertSettingsValues = {
    enabled: input.enabled ?? current.enabled,
    atrpWorse: input.atrpWorse ?? current.atrpWorse,
    solvDown: input.solvDown ?? current.solvDown,
    foundDropPct: input.foundDropPct ?? current.foundDropPct,
    centerTop3: input.centerTop3 ?? current.centerTop3,
    criticalAtrp: input.criticalAtrp ?? current.criticalAtrp,
    criticalSolv: input.criticalSolv ?? current.criticalSolv,
    webhookUrl: input.webhookUrl === undefined ? current.webhookUrl : input.webhookUrl,
  };
  if (next.webhookUrl) assertWebhookUrl(next.webhookUrl);
  await db
    .insert(alertSettings)
    .values({ workspaceId, ...next })
    .onConflictDoUpdate({ target: alertSettings.workspaceId, set: next });
  return next;
}

// ---- creation ---------------------------------------------------------------------

type ScanRow = typeof scans.$inferSelect;

const centerIndex = (gridSize: number) => (gridSize % 2 === 1 ? (gridSize - 1) / 2 : null);

async function snapshot(db: Db, scan: ScanRow): Promise<ScanSnapshot> {
  const c = centerIndex(scan.gridSize);
  let centerRank: number | null = null;
  let centerKnown = false;
  if (c !== null) {
    const [point] = await db
      .select({ status: scanPoints.status, rank: scanPoints.rank })
      .from(scanPoints)
      .where(and(eq(scanPoints.scanId, scan.id), eq(scanPoints.row, c), eq(scanPoints.col, c)));
    centerKnown = point?.status === "completed";
    centerRank = centerKnown ? point.rank : null;
  }
  return {
    gridSize: scan.gridSize,
    radiusKm: scan.radiusKm,
    zoom: scan.zoom,
    searchType: scan.searchType,
    keyword: scan.keyword,
    atrp: scan.atrp,
    solv: scan.solv,
    foundPoints: scan.foundPoints,
    totalPoints: scan.totalPoints,
    centerRank,
    centerKnown,
  };
}

/**
 * Compares a just-completed scan with the tracker's previous completed scan
 * and stores any alerts. Idempotent: (scan, kind) is unique, and only alerts
 * that were actually inserted are announced to the webhook.
 */
export async function createAlertsForScan(deps: AlertDeps, scanId: string, failedPoints: number): Promise<void> {
  const { db } = deps;
  const [scan] = await db.select().from(scans).where(eq(scans.id, scanId));
  if (!scan || scan.status !== "completed") return;
  const settings = await getAlertSettings(db, scan.workspaceId);
  if (!settings.enabled) return;

  const [previous] = await db
    .select()
    .from(scans)
    .where(
      and(
        eq(scans.trackerId, scan.trackerId),
        eq(scans.workspaceId, scan.workspaceId),
        eq(scans.status, "completed"),
        lt(scans.createdAt, scan.createdAt),
      ),
    )
    .orderBy(desc(scans.createdAt))
    .limit(1);

  const candidates = evaluateAlerts({
    current: await snapshot(db, scan),
    previous: previous ? await snapshot(db, previous) : null,
    failedPoints,
    rules: settings,
  });
  if (candidates.length === 0) return;

  const [label] = await db
    .select({ business: businesses.name })
    .from(trackers)
    .innerJoin(businesses, eq(businesses.id, trackers.businessId))
    .where(eq(trackers.id, scan.trackerId));

  for (const candidate of candidates) {
    const inserted = await db
      .insert(alerts)
      .values({
        id: newId(),
        workspaceId: scan.workspaceId,
        trackerId: scan.trackerId,
        scanId: scan.id,
        previousScanId: previous?.id ?? null,
        kind: candidate.kind,
        severity: candidate.severity,
        metrics: JSON.stringify(candidate.metrics),
        createdAt: nowIso(deps.now?.()),
      })
      .onConflictDoNothing({ target: [alerts.scanId, alerts.kind] })
      .returning({ id: alerts.id });
    if (inserted.length === 0 || !settings.webhookUrl || !deps.notify) continue;
    sendWebhook(deps, settings.webhookUrl, inserted[0].id, alertText(label?.business ?? "Tracker", scan.keyword, candidate));
  }
}

/** Fire and forget: a slow or broken webhook must never hold up finalization. */
function sendWebhook(deps: AlertDeps, url: string, alertId: string, text: string) {
  const sent = deps.notify!(url, { text }).catch((error: unknown) => {
    // The URL is a secret, so it is not logged.
    console.warn("alert.webhook-failed", { alertId, message: error instanceof Error ? error.message : "unknown error" });
  });
  if (deps.waitUntil) deps.waitUntil(sent);
}

const fmt = (n: number | null | undefined, suffix = "") => (n == null ? "n/a" : `${n}${suffix}`);

export function alertText(business: string, keyword: string, candidate: { kind: string; severity: string; metrics: AlertMetrics }): string {
  const { before, after } = candidate.metrics;
  const head = `${candidate.severity === "critical" ? ":rotating_light: Critical" : ":warning: Warning"}: ${business} / "${keyword}"`;
  if (candidate.kind === "data_problem") {
    return `${head}: scan finished but ${after.failedPoints ?? 0} of ${after.totalPoints} points failed. This is a data problem, not a rank drop; run the scan again.`;
  }
  return `${head}: rankings dropped. ATRP ${fmt(before?.atrp)} -> ${fmt(after.atrp)}, SoLV ${fmt(before?.solv, "%")} -> ${fmt(after.solv, "%")}, found at ${fmt(before?.foundPoints)} -> ${fmt(after.foundPoints)} of ${after.totalPoints} points.`;
}

/** Wraps creation for the finalize step: a failure is logged, never thrown. */
export async function createAlertsSafely(deps: AlertDeps, scanId: string, failedPoints: number): Promise<void> {
  try {
    await createAlertsForScan(deps, scanId, failedPoints);
  } catch (error) {
    console.error("alert.create-failed", { scanId, message: error instanceof Error ? error.message : "unknown error" });
  }
}

// ---- GBP alerts ---------------------------------------------------------------------

/**
 * Compares a just-completed profile snapshot with the business's previous
 * completed one and stores rating_drop / negative_review alerts. Idempotent:
 * (snapshot, kind) is unique, and only inserted alerts reach the webhook.
 */
export async function createAlertsForSnapshot(deps: AlertDeps, snapshotId: string): Promise<void> {
  const { db } = deps;
  const [snap] = await db.select().from(gbpSnapshots).where(eq(gbpSnapshots.id, snapshotId));
  if (!snap || snap.status !== "completed") return;
  const settings = await getAlertSettings(db, snap.workspaceId);
  if (!settings.enabled) return;

  const [previous] = await db
    .select()
    .from(gbpSnapshots)
    .where(
      and(
        eq(gbpSnapshots.businessId, snap.businessId),
        eq(gbpSnapshots.workspaceId, snap.workspaceId),
        eq(gbpSnapshots.status, "completed"),
        lt(gbpSnapshots.takenAt, snap.takenAt),
      ),
    )
    .orderBy(desc(gbpSnapshots.takenAt))
    .limit(1);
  // The first snapshot is a baseline: nothing to compare, and every review in it looks new.
  if (!previous) return;

  const fresh = await db
    .select()
    .from(reviews)
    .where(and(eq(reviews.businessId, snap.businessId), eq(reviews.workspaceId, snap.workspaceId), eq(reviews.firstSeenSnapshotId, snap.id)));

  const candidates = evaluateGbpAlerts({
    current: { rating: snap.rating, reviewCount: snap.reviewCount },
    previous: { rating: previous.rating, reviewCount: previous.reviewCount },
    newReviews: fresh.map((r) => ({ reviewId: r.reviewId, rating: r.rating, publishedAt: r.publishedAt, text: r.text?.slice(0, 280) ?? null })),
  });
  if (candidates.length === 0) return;

  const [business] = await db
    .select({ name: businesses.name })
    .from(businesses)
    .where(and(eq(businesses.id, snap.businessId), eq(businesses.workspaceId, snap.workspaceId)));

  for (const candidate of candidates) {
    const inserted = await db
      .insert(alerts)
      .values({
        id: newId(),
        workspaceId: snap.workspaceId,
        businessId: snap.businessId,
        snapshotId: snap.id,
        kind: candidate.kind,
        severity: candidate.severity,
        metrics: JSON.stringify(candidate.metrics),
        createdAt: nowIso(deps.now?.()),
      })
      .onConflictDoNothing({ target: [alerts.snapshotId, alerts.kind] })
      .returning({ id: alerts.id });
    if (inserted.length === 0 || !settings.webhookUrl || !deps.notify) continue;
    sendWebhook(deps, settings.webhookUrl, inserted[0].id, gbpAlertText(business?.name ?? "Business", candidate));
  }
}

export function gbpAlertText(business: string, candidate: { kind: string; severity: string; metrics: GbpAlertMetrics }): string {
  const { rating, reviewCount, negativeReviews } = candidate.metrics;
  const head = `${candidate.severity === "critical" ? ":rotating_light: Critical" : ":warning: Warning"}: ${business}`;
  if (candidate.kind === "negative_review") {
    const n = negativeReviews?.count ?? 0;
    return `${head}: ${n} new ${n === 1 ? "review" : "reviews"} of ${NEGATIVE_REVIEW_MAX_STARS} stars or fewer on Google. Rating ${fmt(rating.before)} -> ${fmt(rating.after)}.`;
  }
  return `${head}: Google rating dropped ${fmt(rating.before)} -> ${fmt(rating.after)} (${fmt(reviewCount.before)} -> ${fmt(reviewCount.after)} reviews).`;
}

/** Wraps creation for the snapshot's finish step: a failure is logged, never thrown. */
export async function createGbpAlertsSafely(deps: AlertDeps, snapshotId: string): Promise<void> {
  try {
    await createAlertsForSnapshot(deps, snapshotId);
  } catch (error) {
    console.error("alert.create-failed", { snapshotId, message: error instanceof Error ? error.message : "unknown error" });
  }
}

// ---- failed jobs --------------------------------------------------------------------

export type FailedJobTarget = { type: "scan"; scanId: string } | { type: "gbp"; snapshotId: string };

/**
 * Raised by the dead-letter consumer (and permanent-error handling) when a job
 * is failed. Idempotent: (scan, kind) and (snapshot, kind) are unique, and only
 * an inserted alert reaches the webhook. Errors are logged, never thrown.
 */
export async function createJobFailedAlertSafely(deps: AlertDeps, target: FailedJobTarget, message: string): Promise<void> {
  try {
    const { db } = deps;
    let row: { workspaceId: string; trackerId: string | null; businessId: string; label: string; keyword: string | null };
    if (target.type === "scan") {
      const [found] = await db
        .select({ workspaceId: scans.workspaceId, trackerId: scans.trackerId, businessId: trackers.businessId, label: businesses.name, keyword: scans.keyword })
        .from(scans)
        .innerJoin(trackers, eq(trackers.id, scans.trackerId))
        .innerJoin(businesses, eq(businesses.id, trackers.businessId))
        .where(eq(scans.id, target.scanId));
      if (!found) return;
      row = found;
    } else {
      const [found] = await db
        .select({ workspaceId: gbpSnapshots.workspaceId, businessId: gbpSnapshots.businessId, label: businesses.name })
        .from(gbpSnapshots)
        .innerJoin(businesses, eq(businesses.id, gbpSnapshots.businessId))
        .where(eq(gbpSnapshots.id, target.snapshotId));
      if (!found) return;
      row = { ...found, trackerId: null, keyword: null };
    }
    const settings = await getAlertSettings(db, row.workspaceId);
    if (!settings.enabled) return;

    const inserted = await db
      .insert(alerts)
      .values({
        id: newId(),
        workspaceId: row.workspaceId,
        trackerId: row.trackerId,
        scanId: target.type === "scan" ? target.scanId : null,
        businessId: target.type === "gbp" ? row.businessId : null,
        snapshotId: target.type === "gbp" ? target.snapshotId : null,
        kind: "job_failed",
        severity: "warning",
        metrics: JSON.stringify({ message } satisfies JobFailedMetrics),
        createdAt: nowIso(deps.now?.()),
      })
      .onConflictDoNothing()
      .returning({ id: alerts.id });
    if (inserted.length === 0 || !settings.webhookUrl || !deps.notify) return;
    const what = target.type === "scan" ? `scan for "${row.keyword}"` : "Google profile refresh";
    sendWebhook(deps, settings.webhookUrl, inserted[0].id, `:warning: Warning: ${row.label}: the ${what} failed (${message}). Nothing is lost; run it again from the app.`);
  } catch (error) {
    console.error("alert.create-failed", { target, message: error instanceof Error ? error.message : "unknown error" });
  }
}

export type JobFailedMetrics = { message: string };

// ---- read model -------------------------------------------------------------------

type AlertBase = {
  id: string;
  severity: "warning" | "critical";
  businessName: string;
  createdAt: string;
  readAt: string | null;
};
export type AlertListItem =
  | (AlertBase & {
      source: "job";
      kind: "job_failed";
      jobType: "scan" | "gbp";
      trackerId: string | null;
      businessId: string | null;
      scanId: string | null;
      snapshotId: string | null;
      keyword: string | null;
      message: string;
    })
  | (AlertBase & {
      source: "scan";
      kind: "rank_drop" | "data_problem";
      trackerId: string;
      scanId: string;
      previousScanId: string | null;
      keyword: string;
      metrics: AlertMetrics;
    })
  | (AlertBase & {
      source: "gbp";
      kind: "rating_drop" | "negative_review";
      businessId: string;
      snapshotId: string;
      metrics: GbpAlertMetrics;
    });

export async function listAlerts(db: Db, workspaceId: string, options: { limit: number }) {
  const rows = await db
    .select({
      alert: alerts,
      keyword: scans.keyword,
      businessName: businesses.name,
    })
    .from(alerts)
    .leftJoin(scans, eq(scans.id, alerts.scanId))
    .leftJoin(trackers, eq(trackers.id, alerts.trackerId))
    // Scan alerts reach the business through their tracker, GBP alerts directly.
    .innerJoin(businesses, eq(businesses.id, sql`coalesce(${alerts.businessId}, ${trackers.businessId})`))
    .where(eq(alerts.workspaceId, workspaceId))
    .orderBy(sql`${alerts.readAt} is not null`, desc(alerts.createdAt))
    .limit(options.limit);
  const [{ unread }] = await db
    .select({ unread: sql<number>`count(*)` })
    .from(alerts)
    .where(and(eq(alerts.workspaceId, workspaceId), isNull(alerts.readAt)));
  const items: AlertListItem[] = [];
  for (const { alert, keyword, businessName } of rows) {
    const base = { id: alert.id, severity: alert.severity, businessName, createdAt: alert.createdAt, readAt: alert.readAt };
    if (alert.kind === "job_failed") {
      items.push({
        ...base,
        source: "job",
        kind: alert.kind,
        jobType: alert.snapshotId ? "gbp" : "scan",
        trackerId: alert.trackerId,
        businessId: alert.businessId,
        scanId: alert.scanId,
        snapshotId: alert.snapshotId,
        keyword: keyword ?? null,
        message: (JSON.parse(alert.metrics) as JobFailedMetrics).message,
      });
    } else if (alert.kind === "rating_drop" || alert.kind === "negative_review") {
      items.push({
        ...base,
        source: "gbp",
        kind: alert.kind,
        businessId: alert.businessId!,
        snapshotId: alert.snapshotId!,
        metrics: JSON.parse(alert.metrics) as GbpAlertMetrics,
      });
    } else {
      items.push({
        ...base,
        source: "scan",
        kind: alert.kind,
        trackerId: alert.trackerId!,
        scanId: alert.scanId!,
        previousScanId: alert.previousScanId,
        keyword: keyword ?? "",
        metrics: JSON.parse(alert.metrics) as AlertMetrics,
      });
    }
  }
  return { unreadCount: Number(unread), alerts: items };
}

export async function markAlertRead(db: Db, workspaceId: string, alertId: string, now?: Date): Promise<void> {
  const [row] = await db
    .select({ id: alerts.id })
    .from(alerts)
    .where(and(eq(alerts.id, alertId), eq(alerts.workspaceId, workspaceId)));
  if (!row) throw new AppError("NOT_FOUND", "Alert not found");
  await db
    .update(alerts)
    .set({ readAt: nowIso(now) })
    .where(and(eq(alerts.id, alertId), eq(alerts.workspaceId, workspaceId), isNull(alerts.readAt)));
}

export async function markAllAlertsRead(db: Db, workspaceId: string, now?: Date): Promise<number> {
  const updated = await db
    .update(alerts)
    .set({ readAt: nowIso(now) })
    .where(and(eq(alerts.workspaceId, workspaceId), isNull(alerts.readAt)))
    .returning({ id: alerts.id });
  return updated.length;
}
