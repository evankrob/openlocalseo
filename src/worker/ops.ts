// Operator views: failed jobs (scans and Google profile snapshots) and retrying
// a failed scan. Everything is scoped to one workspace.
import { and, desc, eq, gte } from "drizzle-orm";
import { AppError } from "@/shared/errors";
import { asTrackerId, type ScanId, type WorkspaceId } from "@/shared/ids";
import type { Db } from "./db";
import { businesses, gbpSnapshots, scans, trackers } from "./db/schema";
import type { ProcessDeps } from "./scans/process";
import { createScan, type CreateScanOptions } from "./scans/service";

export const FAILED_JOBS_DAYS = 30;
const LIMIT = 100;

export type FailedJob = {
  kind: "scan" | "gbp";
  id: string;
  businessId: string;
  trackerId: string | null;
  businessName: string;
  keyword: string | null;
  error: string | null;
  costUsd: number;
  billedCredits: number;
  trigger: string;
  createdAt: string;
  completedAt: string | null;
};

/** Failed scans and snapshots of the last 30 days, newest first, with the error and what they cost. */
export async function listFailedJobs(db: Db, workspaceId: string, now: Date = new Date()) {
  const since = new Date(now.getTime() - FAILED_JOBS_DAYS * 86_400_000).toISOString();
  const scanRows = await db
    .select({ scan: scans, business: businesses })
    .from(scans)
    .innerJoin(trackers, eq(trackers.id, scans.trackerId))
    .innerJoin(businesses, eq(businesses.id, trackers.businessId))
    .where(and(eq(scans.workspaceId, workspaceId), eq(scans.status, "failed"), gte(scans.createdAt, since)))
    .orderBy(desc(scans.createdAt))
    .limit(LIMIT);
  const snapshotRows = await db
    .select({ snapshot: gbpSnapshots, business: businesses })
    .from(gbpSnapshots)
    .innerJoin(businesses, eq(businesses.id, gbpSnapshots.businessId))
    .where(and(eq(gbpSnapshots.workspaceId, workspaceId), eq(gbpSnapshots.status, "failed"), gte(gbpSnapshots.takenAt, since)))
    .orderBy(desc(gbpSnapshots.takenAt))
    .limit(LIMIT);

  const jobs: FailedJob[] = [
    ...scanRows.map(({ scan, business }): FailedJob => ({
      kind: "scan",
      id: scan.id,
      businessId: business.id,
      trackerId: scan.trackerId,
      businessName: business.name,
      keyword: scan.keyword,
      error: scan.error,
      costUsd: scan.costUsd,
      billedCredits: scan.billedCredits,
      trigger: scan.trigger,
      createdAt: scan.createdAt,
      completedAt: scan.completedAt,
    })),
    ...snapshotRows.map(({ snapshot, business }): FailedJob => ({
      kind: "gbp",
      id: snapshot.id,
      businessId: business.id,
      trackerId: null,
      businessName: business.name,
      keyword: null,
      error: snapshot.error,
      costUsd: snapshot.costUsd,
      billedCredits: snapshot.billedCredits,
      trigger: snapshot.trigger,
      createdAt: snapshot.takenAt,
      completedAt: snapshot.completedAt,
    })),
  ];
  jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { since, jobs };
}

/**
 * Starts a NEW scan for the failed scan's tracker: fresh quote, fresh credit
 * hold, new DataForSEO tasks. The failed scan's task ids are never reused (they
 * may already have been billed).
 */
export async function retryScan(deps: ProcessDeps, workspaceId: WorkspaceId, scanId: ScanId, options: Pick<CreateScanOptions, "maxCostUsd"> = {}) {
  const [scan] = await deps.db
    .select({ id: scans.id, status: scans.status, trackerId: scans.trackerId })
    .from(scans)
    .where(and(eq(scans.id, scanId), eq(scans.workspaceId, workspaceId)));
  if (!scan) throw new AppError("NOT_FOUND", "Scan not found");
  if (scan.status !== "failed") throw new AppError("VALIDATION_ERROR", "Only failed scans can be retried");
  const created = await createScan(deps, workspaceId, asTrackerId(scan.trackerId), { trigger: "manual", maxCostUsd: options.maxCostUsd });
  return { ...created, retriedScanId: scan.id };
}
