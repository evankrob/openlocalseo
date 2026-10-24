// Google Business Profile snapshot pipeline, run by the queue consumer:
//   queued -> running -> completed | failed
// "gbp_snapshot" makes the profile call and posts the reviews task (the only
// billed task_post, never replayed), "gbp_reviews_collect" polls it with
// backoff, and whichever job finishes the snapshot settles the credits and
// raises alerts. Every step is idempotent: queue messages can be delivered twice.
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { UNANSWERED_WINDOW, reviewVelocity } from "@/shared/gbp";
import { GBP_REVIEWS_DEPTH, creditsForProviderUsd, roundUsd } from "@/shared/pricing";
import { createGbpAlertsSafely } from "../alerts";
import { chargeOverage, refundCredits } from "../billing/credits";
import type { MockHints, ReviewsOutcome } from "../dataforseo/types";
import { apiCalls, businesses, gbpSnapshots, reviews } from "../db/schema";
import { newId, nowIso } from "../lib";
import type { GbpJob } from "../scans/jobs";
import type { ProcessDeps } from "../scans/process";
import { upsertReviews } from "./sql";

type SnapshotRow = typeof gbpSnapshots.$inferSelect;
type BusinessRow = typeof businesses.$inferSelect;

const ACTIVE = ["queued", "running"] as const;

export async function handleGbpJob(deps: ProcessDeps, job: GbpJob): Promise<void> {
  switch (job.type) {
    case "gbp_snapshot":
      return handleSnapshot(deps, job.snapshotId);
    case "gbp_reviews_collect":
      return handleCollect(deps, job.snapshotId, job.attempt);
  }
}

async function loadSnapshot(deps: ProcessDeps, snapshotId: string) {
  const [row] = await deps.db.select().from(gbpSnapshots).where(eq(gbpSnapshots.id, snapshotId));
  return row;
}

async function loadBusiness(deps: ProcessDeps, snapshot: SnapshotRow): Promise<BusinessRow | undefined> {
  const [row] = await deps.db
    .select()
    .from(businesses)
    .where(and(eq(businesses.id, snapshot.businessId), eq(businesses.workspaceId, snapshot.workspaceId)));
  return row;
}

function mockHints(deps: ProcessDeps, business: BusinessRow): MockHints | undefined {
  if (deps.provider.mode !== "mock") return undefined;
  return {
    target: {
      name: business.name,
      placeId: business.placeId,
      domain: business.domain,
      category: business.category,
      lat: business.lat,
      lng: business.lng,
    },
  };
}

/** Records one billed call in api_calls and adds it to the snapshot's cost. */
async function recordCall(deps: ProcessDeps, snapshot: SnapshotRow, path: string[], costUsd: number) {
  await deps.db.insert(apiCalls).values({
    id: newId(),
    workspaceId: snapshot.workspaceId,
    scanId: null,
    provider: "dataforseo",
    mode: deps.provider.mode,
    path: path.join("/"),
    taskCount: 1,
    costUsd,
  });
  await deps.db
    .update(gbpSnapshots)
    .set({ costUsd: sql`round(${gbpSnapshots.costUsd} + ${costUsd}, 6)` })
    .where(eq(gbpSnapshots.id, snapshot.id));
}

/** A call DataForSEO billed even though it then failed still carries its cost. */
async function recordChargedFailure(deps: ProcessDeps, snapshot: SnapshotRow, error: unknown) {
  const charged = (error as { billing?: { path: string[]; costUsd: number } }).billing;
  if (charged) await recordCall(deps, snapshot, charged.path, charged.costUsd);
}

const messageOf = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);

// ---- snapshot: profile + reviews post -------------------------------------------

async function handleSnapshot(deps: ProcessDeps, snapshotId: string) {
  const { db, queue, provider, config } = deps;
  // Claim the snapshot; a redelivered message finds it already claimed.
  const claimed = await db
    .update(gbpSnapshots)
    .set({ status: "running" })
    .where(and(eq(gbpSnapshots.id, snapshotId), eq(gbpSnapshots.status, "queued")))
    .returning({ id: gbpSnapshots.id });
  if (claimed.length === 0) {
    // Redelivered after the task was posted but before collection was queued:
    // finish that step. Never re-post (it would bill twice).
    const existing = await loadSnapshot(deps, snapshotId);
    if (existing?.status === "running" && existing.reviewsTaskId) {
      await queue.send({ type: "gbp_reviews_collect", snapshotId, attempt: 0 }, { delaySeconds: config.pollDelaySeconds.standard });
    }
    return;
  }

  const snapshot = (await loadSnapshot(deps, snapshotId))!;
  const business = await loadBusiness(deps, snapshot);
  if (!business || business.archivedAt || !business.placeId) {
    await failSnapshot(deps, snapshotId, "Business not found or has no Google place ID");
    return;
  }
  const hints = mockHints(deps, business);

  let profile;
  try {
    profile = await provider.getBusinessProfile({ placeId: business.placeId, mockHints: hints });
  } catch (error) {
    await recordChargedFailure(deps, snapshot, error);
    console.warn("gbp.profile-failed", { snapshotId, message: messageOf(error, "profile lookup failed") });
    await failSnapshot(deps, snapshotId, `Profile lookup failed: ${messageOf(error, "unknown error")}`);
    return;
  }
  await recordCall(deps, snapshot, profile.billing.path, profile.billing.costUsd);
  const p = profile.profile;
  if (!p) {
    await failSnapshot(deps, snapshotId, "Google has no business profile for this place ID");
    return;
  }
  await db
    .update(gbpSnapshots)
    .set({
      rating: p.rating,
      reviewCount: p.reviewCount,
      ratingDistribution: p.ratingDistribution ? JSON.stringify(p.ratingDistribution) : null,
      isClaimed: p.isClaimed,
      totalPhotos: p.totalPhotos,
      primaryCategory: p.category,
      additionalCategories: JSON.stringify(p.additionalCategories),
      phone: p.phone,
      domain: p.domain,
    })
    .where(eq(gbpSnapshots.id, snapshotId));

  let posted;
  try {
    posted = await provider.postReviewsTask({ placeId: business.placeId, depth: GBP_REVIEWS_DEPTH, mockHints: hints });
  } catch (error) {
    // Never replayed: a failed post may still have been billed upstream.
    await recordChargedFailure(deps, snapshot, error);
    console.warn("gbp.reviews-post-failed", { snapshotId, message: messageOf(error, "reviews post failed") });
    await failSnapshot(deps, snapshotId, `Submitting the reviews task failed: ${messageOf(error, "unknown error")}`);
    return;
  }
  await recordCall(deps, snapshot, posted.billing.path, posted.billing.costUsd);
  await db.update(gbpSnapshots).set({ reviewsTaskId: posted.taskId }).where(eq(gbpSnapshots.id, snapshotId));
  await queue.send({ type: "gbp_reviews_collect", snapshotId, attempt: 0 }, { delaySeconds: config.pollDelaySeconds.standard });
}

// ---- collect ----------------------------------------------------------------------

async function handleCollect(deps: ProcessDeps, snapshotId: string, attempt: number) {
  const { queue, provider, config } = deps;
  const snapshot = await loadSnapshot(deps, snapshotId);
  if (!snapshot || snapshot.status !== "running" || !snapshot.reviewsTaskId) return;

  let outcome: ReviewsOutcome;
  try {
    outcome = await provider.getReviewsTask(snapshot.reviewsTaskId);
  } catch (error) {
    // Transient (rate limit, upstream 5xx): treat as pending, try next round.
    console.warn("gbp.collect-error", { snapshotId, message: messageOf(error, "collect failed") });
    outcome = { status: "pending" };
  }

  if (outcome.status === "failed") {
    await failSnapshot(deps, snapshotId, outcome.message);
  } else if (outcome.status === "pending") {
    const waitedSeconds = ((deps.now?.() ?? new Date()).getTime() - new Date(snapshot.takenAt).getTime()) / 1000;
    if (waitedSeconds > config.maxGbpSeconds) {
      await failSnapshot(deps, snapshotId, "Timed out waiting for DataForSEO");
      return;
    }
    // Backoff: the first poll waits 1x the poll delay, then 1.5x, 2.25x ... capped at 5 minutes.
    const delay = Math.min(300, Math.ceil(config.pollDelaySeconds.standard * 1.5 ** (attempt + 1)));
    await queue.send({ type: "gbp_reviews_collect", snapshotId, attempt: attempt + 1 }, { delaySeconds: delay });
  } else {
    await completeSnapshot(deps, snapshot, outcome);
  }
}

async function completeSnapshot(deps: ProcessDeps, snapshot: SnapshotRow, outcome: Extract<ReviewsOutcome, { status: "completed" }>) {
  const { db } = deps;
  const ctx = { workspaceId: snapshot.workspaceId, businessId: snapshot.businessId, snapshotId: snapshot.id };
  // Upsert first, then the status flip: a retry after a crash in between
  // updates the same rows and keeps first_seen on this snapshot.
  await upsertReviews(db, ctx, outcome.reviews);

  const [previous] = await db
    .select({ id: gbpSnapshots.id })
    .from(gbpSnapshots)
    .where(
      and(
        eq(gbpSnapshots.businessId, snapshot.businessId),
        eq(gbpSnapshots.workspaceId, snapshot.workspaceId),
        eq(gbpSnapshots.status, "completed"),
        lt(gbpSnapshots.takenAt, snapshot.takenAt),
      ),
    )
    .orderBy(desc(gbpSnapshots.takenAt))
    .limit(1);

  // The first snapshot is a baseline: every review in it would look "new".
  let newReviews: number | null = null;
  let newReviewsAvgRating: number | null = null;
  if (previous) {
    const fresh = await db
      .select({ rating: reviews.rating })
      .from(reviews)
      .where(and(eq(reviews.businessId, snapshot.businessId), eq(reviews.firstSeenSnapshotId, snapshot.id)));
    newReviews = fresh.length;
    newReviewsAvgRating = fresh.length ? Math.round((fresh.reduce((a, r) => a + r.rating, 0) / fresh.length) * 100) / 100 : null;
  }

  const latest = await db
    .select({ publishedAt: reviews.publishedAt, ownerAnswered: reviews.ownerAnswered })
    .from(reviews)
    .where(and(eq(reviews.businessId, snapshot.businessId), eq(reviews.workspaceId, snapshot.workspaceId)))
    .orderBy(desc(reviews.publishedAt))
    .limit(UNANSWERED_WINDOW);

  const won = await db
    .update(gbpSnapshots)
    .set({
      status: "completed",
      completedAt: nowIso(deps.now?.()),
      error: null,
      // The reviews result backs up the profile call when it lacked a number.
      rating: snapshot.rating ?? outcome.rating,
      reviewCount: snapshot.reviewCount ?? outcome.reviewCount,
      newReviews,
      newReviewsAvgRating,
      velocity30d: reviewVelocity(outcome.reviews.map((r) => r.publishedAt), new Date(snapshot.takenAt)),
      unansweredLast20: latest.filter((r) => !r.ownerAnswered).length,
    })
    .where(and(eq(gbpSnapshots.id, snapshot.id), eq(gbpSnapshots.status, "running")))
    .returning({ costUsd: gbpSnapshots.costUsd });
  if (won.length === 0) return;
  await settleCredits(deps, snapshot, won[0].costUsd);
  // Inside the same once-only step as settlement; never fails the snapshot.
  await createGbpAlertsSafely(deps, snapshot.id);
}

/** Fails an active snapshot and settles credits on what was actually spent (nothing spent = full refund). */
async function failSnapshot(deps: ProcessDeps, snapshotId: string, error: string): Promise<boolean> {
  const won = await deps.db
    .update(gbpSnapshots)
    .set({ status: "failed", error, completedAt: nowIso(deps.now?.()) })
    .where(and(eq(gbpSnapshots.id, snapshotId), inArray(gbpSnapshots.status, [...ACTIVE])))
    .returning({ costUsd: gbpSnapshots.costUsd });
  if (won.length === 0) return false;
  const snapshot = (await loadSnapshot(deps, snapshotId))!;
  await settleCredits(deps, snapshot, won[0].costUsd);
  return true;
}

/** Bills the real cost against the hold: refund the unused part, or charge the overage. */
async function settleCredits(deps: ProcessDeps, snapshot: SnapshotRow, costUsd: number) {
  if (deps.config.billingMode !== "hosted" || snapshot.reservedCredits === 0) return;
  const billed = creditsForProviderUsd(roundUsd(costUsd), deps.config.markup);
  await deps.db.update(gbpSnapshots).set({ billedCredits: billed }).where(eq(gbpSnapshots.id, snapshot.id));
  const { workspaceId, reservedCredits, id } = snapshot;
  if (billed < reservedCredits) await refundCredits(deps.db, workspaceId, reservedCredits - billed, id, "gbp");
  else if (billed > reservedCredits) await chargeOverage(deps.db, workspaceId, billed - reservedCredits, id, "gbp");
}

/**
 * Cron safety net: fails snapshots stuck in an active state (a crashed
 * consumer, a message that exhausted its retries) and returns unspent credits.
 */
export async function reapStaleGbpSnapshots(deps: ProcessDeps, olderThanSeconds = 6 * 3600): Promise<number> {
  const cutoff = new Date((deps.now?.() ?? new Date()).getTime() - olderThanSeconds * 1000).toISOString();
  const stale = await deps.db
    .select({ id: gbpSnapshots.id })
    .from(gbpSnapshots)
    .where(and(inArray(gbpSnapshots.status, [...ACTIVE]), lt(gbpSnapshots.takenAt, cutoff)));
  let reaped = 0;
  for (const { id } of stale) {
    if (await failSnapshot(deps, id, "Snapshot timed out and was stopped")) reaped++;
  }
  return reaped;
}
