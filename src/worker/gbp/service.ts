// Google Business Profile snapshots: quoting, creation (hold credits, queue the
// job), the opt-in monthly schedule and the tracking toggle.
import { and, eq, isNull, lte } from "drizzle-orm";
import { AppError } from "@/shared/errors";
import { asBusinessId, asWorkspaceId, type BusinessId, type WorkspaceId } from "@/shared/ids";
import {
  GBP_REVIEWS_DEPTH,
  applyMarkupUsd,
  creditsForProviderUsd,
  estimateGbpSnapshotCostUsd,
} from "@/shared/pricing";
import { withCreditHold } from "../billing/spend";
import { getBusiness } from "../catalog";
import type { AppConfig } from "../config";
import { businesses, gbpSnapshots } from "../db/schema";
import { newId, nowIso } from "../lib";
import type { ProcessDeps } from "../scans/process";
import { nextMonthlyRun } from "../scans/schedule";

export type GbpQuote = {
  reviewsDepth: number;
  /** What DataForSEO will charge (upper bound), in USD. */
  providerCostUsd: number;
  /** What this workspace pays: provider cost, plus markup in hosted mode. */
  chargedUsd: number;
  /** Hosted only: credits held for the snapshot; 0 in BYOK mode. */
  credits: number;
};

export function quoteGbpSnapshot(config: Pick<AppConfig, "billingMode" | "markup">): GbpQuote {
  const providerCostUsd = estimateGbpSnapshotCostUsd(GBP_REVIEWS_DEPTH);
  const hosted = config.billingMode === "hosted";
  return {
    reviewsDepth: GBP_REVIEWS_DEPTH,
    providerCostUsd,
    chargedUsd: hosted ? applyMarkupUsd(providerCostUsd, config.markup) : providerCostUsd,
    credits: hosted ? creditsForProviderUsd(providerCostUsd, config.markup) : 0,
  };
}

export type CreateGbpSnapshotOptions = {
  trigger: "manual" | "schedule";
  /** Refuse to start if the estimated charge (USD) is above this. */
  maxCostUsd?: number;
};

/** Day of the month monthly snapshots run on (same cadence as the default scan schedule). */
export const GBP_SCHEDULE_DAY = 1;

/** Creates a snapshot for a business, holds credits (hosted) and queues it. */
export async function createGbpSnapshot(
  deps: ProcessDeps,
  workspaceId: WorkspaceId,
  businessId: BusinessId,
  options: CreateGbpSnapshotOptions,
): Promise<{ snapshotId: string; quote: GbpQuote }> {
  const { db, queue, config } = deps;
  const business = await getBusiness(db, workspaceId, businessId);
  if (!business.placeId) {
    throw new AppError("VALIDATION_ERROR", "Profile tracking needs the business's Google place ID.");
  }
  const quote = quoteGbpSnapshot(config);
  if (options.maxCostUsd !== undefined && quote.chargedUsd > options.maxCostUsd) {
    throw new AppError(
      "COST_CEILING_EXCEEDED",
      `Estimated cost $${quote.chargedUsd} is above the approved maximum of $${options.maxCostUsd}`,
    );
  }

  const snapshotId = newId();
  try {
    await db.insert(gbpSnapshots).values({
      id: snapshotId,
      workspaceId,
      businessId,
      trigger: options.trigger,
      takenAt: nowIso(deps.now?.()),
      status: "queued",
      reservedCredits: quote.credits,
    });
  } catch (error) {
    // The partial unique index allows one active snapshot per business.
    if (String(error).includes("UNIQUE") || String((error as Error).cause).includes("UNIQUE")) {
      throw new AppError("SCAN_IN_PROGRESS", "A profile refresh is already running for this business");
    }
    throw error;
  }

  let held = false;
  try {
    await withCreditHold(
      db,
      workspaceId,
      { billingMode: config.billingMode, credits: quote.credits, scope: "gbp", refId: snapshotId },
      async () => {
        held = true;
        await queue.send({ type: "gbp_snapshot", snapshotId });
      },
    );
  } catch (error) {
    // Nothing was charged yet (the hold failed): remove the half-created snapshot.
    // Once the credits are held the row stays so the failure path can refund them.
    if (!held) await db.delete(gbpSnapshots).where(eq(gbpSnapshots.id, snapshotId));
    throw error;
  }
  return { snapshotId, quote };
}

/** Turns monthly tracking on or off. Enabling schedules the next run for the 1st; it does not spend anything now. */
export async function setGbpTracking(db: ProcessDeps["db"], workspaceId: WorkspaceId, businessId: BusinessId, enabled: boolean, now = new Date()) {
  const business = await getBusiness(db, workspaceId, businessId);
  if (enabled && !business.placeId) {
    throw new AppError("VALIDATION_ERROR", "Profile tracking needs the business's Google place ID.");
  }
  if (enabled === business.gbpTracking) return business;
  await db
    .update(businesses)
    .set({
      gbpTracking: enabled,
      gbpNextRunAt: enabled ? nextMonthlyRun(now, GBP_SCHEDULE_DAY).toISOString() : null,
    })
    .where(and(eq(businesses.id, businessId), eq(businesses.workspaceId, workspaceId)));
  return getBusiness(db, workspaceId, businessId);
}

export type GbpScheduleSummary = { started: number; failed: number };

/** Cron: starts a snapshot for every opted-in business whose monthly run is due. */
export async function runDueGbpSnapshots(deps: ProcessDeps): Promise<GbpScheduleSummary> {
  const now = deps.now?.() ?? new Date();
  const due = await deps.db
    .select()
    .from(businesses)
    .where(
      and(
        eq(businesses.gbpTracking, true),
        isNull(businesses.archivedAt),
        lte(businesses.gbpNextRunAt, now.toISOString()),
      ),
    );

  let started = 0;
  let failed = 0;
  for (const business of due) {
    // Advance first, conditioned on the value we read: an overlapping cron
    // invocation that lost the race gets no rows and skips this business.
    const advanced = await deps.db
      .update(businesses)
      .set({ gbpNextRunAt: nextMonthlyRun(now, GBP_SCHEDULE_DAY).toISOString() })
      .where(and(eq(businesses.id, business.id), eq(businesses.gbpNextRunAt, business.gbpNextRunAt!)))
      .returning({ id: businesses.id });
    if (advanced.length === 0) continue;

    try {
      await createGbpSnapshot(deps, asWorkspaceId(business.workspaceId), asBusinessId(business.id), { trigger: "schedule" });
      started++;
    } catch (error) {
      failed++;
      const reason = error instanceof AppError ? `${error.code}: ${error.message}` : "Could not start scheduled profile snapshot";
      console.warn("gbp.schedule-not-started", { businessId: business.id, reason });
      await recordFailedSnapshot(deps, business, reason);
    }
  }
  return { started, failed };
}

/** Leaves a visible failed snapshot in the history instead of skipping silently. */
async function recordFailedSnapshot(deps: ProcessDeps, business: typeof businesses.$inferSelect, reason: string) {
  const at = nowIso(deps.now?.());
  try {
    await deps.db.insert(gbpSnapshots).values({
      id: newId(),
      workspaceId: business.workspaceId,
      businessId: business.id,
      trigger: "schedule",
      takenAt: at,
      status: "failed",
      error: reason,
      completedAt: at,
    });
  } catch (error) {
    console.error("gbp.record-failed-snapshot", error);
  }
}
