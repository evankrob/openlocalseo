// Hosted usage credits (1000 credits = $1 of marked-up DataForSEO cost).
// A scan places a hold for its upper-bound cost when created and settles on
// the real cost when it finishes. The hold is one conditional UPDATE, so
// concurrent scans cannot overspend a stale balance reading. Pattern from
// open-seo's reserve/settle metering (MIT), minus the Autumn dependency.
import { eq, sql } from "drizzle-orm";
import { AppError } from "@/shared/errors";
import type { Db } from "../db";
import { creditLedger, workspaces } from "../db/schema";
import { newId } from "../lib";

type Reason = "grant" | "topup" | "scan_hold" | "scan_refund";

async function addLedger(db: Db, workspaceId: string, delta: number, reason: Reason, scanId?: string) {
  await db.insert(creditLedger).values({ id: newId(), workspaceId, scanId: scanId ?? null, delta, reason });
}

export async function getBalance(db: Db, workspaceId: string): Promise<number> {
  const [row] = await db.select({ b: workspaces.creditBalance }).from(workspaces).where(eq(workspaces.id, workspaceId));
  return row?.b ?? 0;
}

export async function holdCredits(db: Db, workspaceId: string, credits: number, scanId: string) {
  if (credits <= 0) return;
  const updated = await db
    .update(workspaces)
    .set({ creditBalance: sql`${workspaces.creditBalance} - ${credits}` })
    .where(sql`${workspaces.id} = ${workspaceId} AND ${workspaces.creditBalance} >= ${credits}`)
    .returning({ id: workspaces.id });
  if (updated.length === 0) {
    throw new AppError("INSUFFICIENT_CREDITS", `This scan needs ${credits} credits. Top up to continue.`);
  }
  await addLedger(db, workspaceId, -credits, "scan_hold", scanId);
}

/** Returns held credits that the scan did not end up costing. */
export async function refundCredits(db: Db, workspaceId: string, credits: number, scanId: string) {
  if (credits <= 0) return;
  await db
    .update(workspaces)
    .set({ creditBalance: sql`${workspaces.creditBalance} + ${credits}` })
    .where(eq(workspaces.id, workspaceId));
  await addLedger(db, workspaceId, credits, "scan_refund", scanId);
}

/**
 * Charges cost above the hold (the estimate is an upper bound, so this is
 * rare). Admitted work is never discarded: the balance may go negative and
 * blocks the next scan until topped up.
 */
export async function chargeOverage(db: Db, workspaceId: string, credits: number, scanId: string) {
  if (credits <= 0) return;
  await db
    .update(workspaces)
    .set({ creditBalance: sql`${workspaces.creditBalance} - ${credits}` })
    .where(eq(workspaces.id, workspaceId));
  await addLedger(db, workspaceId, -credits, "scan_hold", scanId);
}

export async function grantCredits(db: Db, workspaceId: string, credits: number, reason: "grant" | "topup") {
  if (credits <= 0) return;
  await db
    .update(workspaces)
    .set({ creditBalance: sql`${workspaces.creditBalance} + ${credits}` })
    .where(eq(workspaces.id, workspaceId));
  await addLedger(db, workspaceId, credits, reason);
}
