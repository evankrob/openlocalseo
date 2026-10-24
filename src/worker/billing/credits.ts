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

type Reason = "grant" | "topup" | "scan_hold" | "scan_refund" | "gbp_hold" | "gbp_refund";

/** What a hold pays for: a grid scan, or a Google Business Profile snapshot (no scan row to link). */
export type ChargeScope = "scan" | "gbp";
const HOLD: Record<ChargeScope, Reason> = { scan: "scan_hold", gbp: "gbp_hold" };
const REFUND: Record<ChargeScope, Reason> = { scan: "scan_refund", gbp: "gbp_refund" };

async function addLedger(db: Db, workspaceId: string, delta: number, reason: Reason, scanId?: string) {
  await db.insert(creditLedger).values({ id: newId(), workspaceId, scanId: scanId ?? null, delta, reason });
}

// credit_ledger.scan_id is a foreign key to scans, so GBP charges are not linked to a row.
const ledgerScanId = (scope: ChargeScope, scanId: string) => (scope === "scan" ? scanId : undefined);

export async function getBalance(db: Db, workspaceId: string): Promise<number> {
  const [row] = await db.select({ b: workspaces.creditBalance }).from(workspaces).where(eq(workspaces.id, workspaceId));
  return row?.b ?? 0;
}

export async function holdCredits(db: Db, workspaceId: string, credits: number, scanId: string, scope: ChargeScope = "scan") {
  if (credits <= 0) return;
  const updated = await db
    .update(workspaces)
    .set({ creditBalance: sql`${workspaces.creditBalance} - ${credits}` })
    .where(sql`${workspaces.id} = ${workspaceId} AND ${workspaces.creditBalance} >= ${credits}`)
    .returning({ id: workspaces.id });
  if (updated.length === 0) {
    throw new AppError("INSUFFICIENT_CREDITS", `This ${scope === "scan" ? "scan" : "profile refresh"} needs ${credits} credits. Top up to continue.`);
  }
  await addLedger(db, workspaceId, -credits, HOLD[scope], ledgerScanId(scope, scanId));
}

/** Returns held credits that the scan did not end up costing. */
export async function refundCredits(db: Db, workspaceId: string, credits: number, scanId: string, scope: ChargeScope = "scan") {
  if (credits <= 0) return;
  await db
    .update(workspaces)
    .set({ creditBalance: sql`${workspaces.creditBalance} + ${credits}` })
    .where(eq(workspaces.id, workspaceId));
  await addLedger(db, workspaceId, credits, REFUND[scope], ledgerScanId(scope, scanId));
}

/**
 * Charges cost above the hold (the estimate is an upper bound, so this is
 * rare). Admitted work is never discarded: the balance may go negative and
 * blocks the next scan until topped up.
 */
export async function chargeOverage(db: Db, workspaceId: string, credits: number, scanId: string, scope: ChargeScope = "scan") {
  if (credits <= 0) return;
  await db
    .update(workspaces)
    .set({ creditBalance: sql`${workspaces.creditBalance} - ${credits}` })
    .where(eq(workspaces.id, workspaceId));
  await addLedger(db, workspaceId, -credits, HOLD[scope], ledgerScanId(scope, scanId));
}

export async function grantCredits(db: Db, workspaceId: string, credits: number, reason: "grant" | "topup") {
  if (credits <= 0) return;
  await db
    .update(workspaces)
    .set({ creditBalance: sql`${workspaces.creditBalance} + ${credits}` })
    .where(eq(workspaces.id, workspaceId));
  await addLedger(db, workspaceId, credits, reason);
}
