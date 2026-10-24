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
import type { Db } from "./db";
import { alertSettings, alerts, businesses, scanPoints, scans, trackers } from "./db/schema";
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

// ---- read model -------------------------------------------------------------------

export async function listAlerts(db: Db, workspaceId: string, options: { limit: number }) {
  const rows = await db
    .select({
      alert: alerts,
      keyword: scans.keyword,
      businessName: businesses.name,
    })
    .from(alerts)
    .innerJoin(scans, eq(scans.id, alerts.scanId))
    .innerJoin(trackers, eq(trackers.id, alerts.trackerId))
    .innerJoin(businesses, eq(businesses.id, trackers.businessId))
    .where(eq(alerts.workspaceId, workspaceId))
    .orderBy(sql`${alerts.readAt} is not null`, desc(alerts.createdAt))
    .limit(options.limit);
  const [{ unread }] = await db
    .select({ unread: sql<number>`count(*)` })
    .from(alerts)
    .where(and(eq(alerts.workspaceId, workspaceId), isNull(alerts.readAt)));
  return {
    unreadCount: Number(unread),
    alerts: rows.map(({ alert, keyword, businessName }) => ({
      id: alert.id,
      trackerId: alert.trackerId,
      scanId: alert.scanId,
      previousScanId: alert.previousScanId,
      kind: alert.kind,
      severity: alert.severity,
      businessName,
      keyword,
      metrics: JSON.parse(alert.metrics) as AlertMetrics,
      createdAt: alert.createdAt,
      readAt: alert.readAt,
    })),
  };
}

export type AlertListItem = Awaited<ReturnType<typeof listAlerts>>["alerts"][number];

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
