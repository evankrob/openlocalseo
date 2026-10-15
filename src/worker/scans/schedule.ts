// Monthly scheduled scans. A daily Cron tick calls runDueSchedules; each
// tracker with schedule_frequency=monthly carries its own next_run_at.
import { and, eq, isNull, lte } from "drizzle-orm";
import { AppError } from "@/shared/errors";
import { scans, trackers } from "../db/schema";
import { newId } from "../lib";
import { reapStaleScans, type ProcessDeps } from "./process";
import { createScan } from "./service";

export const MAX_SCHEDULE_DAY = 28;

/** First `day` of a month at 00:00 UTC strictly after `after`. Day is 1-28 so every month has it. */
export function nextMonthlyRun(after: Date, day: number): Date {
  const d = Math.min(Math.max(Math.floor(day), 1), MAX_SCHEDULE_DAY);
  const thisMonth = new Date(Date.UTC(after.getUTCFullYear(), after.getUTCMonth(), d));
  return thisMonth.getTime() > after.getTime()
    ? thisMonth
    : new Date(Date.UTC(after.getUTCFullYear(), after.getUTCMonth() + 1, d));
}

export type ScheduleRunSummary = { started: number; failed: number; reaped: number };

export async function runDueSchedules(deps: ProcessDeps): Promise<ScheduleRunSummary> {
  const now = deps.now?.() ?? new Date();
  const due = await deps.db
    .select()
    .from(trackers)
    .where(
      and(
        eq(trackers.scheduleFrequency, "monthly"),
        isNull(trackers.archivedAt),
        lte(trackers.nextRunAt, now.toISOString()),
      ),
    );

  let started = 0;
  let failed = 0;
  for (const tracker of due) {
    // Advance first, conditioned on the value we read: an overlapping cron
    // invocation that lost the race gets no rows and skips this tracker.
    const advanced = await deps.db
      .update(trackers)
      .set({ nextRunAt: nextMonthlyRun(now, tracker.scheduleDay).toISOString() })
      .where(and(eq(trackers.id, tracker.id), eq(trackers.nextRunAt, tracker.nextRunAt!)))
      .returning({ id: trackers.id });
    if (advanced.length === 0) continue;

    try {
      await createScan(deps, tracker.workspaceId, tracker.id, { trigger: "schedule" });
      started++;
    } catch (error) {
      failed++;
      const reason = error instanceof AppError ? `${error.code}: ${error.message}` : "Could not start scheduled scan";
      console.warn("schedule.scan-not-started", { trackerId: tracker.id, reason });
      // Leave a visible failed scan in the history instead of skipping silently.
      await recordFailedScheduledScan(deps, tracker, reason);
    }
  }

  const reaped = await reapStaleScans(deps);
  return { started, failed, reaped };
}

async function recordFailedScheduledScan(
  deps: ProcessDeps,
  tracker: typeof trackers.$inferSelect,
  reason: string,
) {
  try {
    await deps.db.insert(scans).values({
      id: newId(),
      workspaceId: tracker.workspaceId,
      trackerId: tracker.id,
      status: "failed",
      trigger: "schedule",
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
      totalPoints: tracker.gridSize * tracker.gridSize,
      estimatedCostUsd: 0,
      error: reason,
      createdAt: (deps.now?.() ?? new Date()).toISOString(),
      completedAt: (deps.now?.() ?? new Date()).toISOString(),
    });
  } catch (error) {
    console.error("schedule.record-failed-scan", error);
  }
}
