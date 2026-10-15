import { and, desc, eq, gte, sql } from "drizzle-orm";
import { creditsToUsd } from "@/shared/pricing";
import type { Db } from "../db";
import { apiCalls, creditLedger, scans } from "../db/schema";
import { getBalance } from "./credits";

/** Cost tracking summary for the Usage page: provider spend, scans, balance. */
export async function getUsageSummary(db: Db, workspaceId: string, billingMode: "byok" | "hosted", now = new Date()) {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const [month] = await db
    .select({
      calls: sql<number>`count(*)`,
      tasks: sql<number>`coalesce(sum(${apiCalls.taskCount}), 0)`,
      costUsd: sql<number>`coalesce(sum(${apiCalls.costUsd}), 0)`,
    })
    .from(apiCalls)
    .where(and(eq(apiCalls.workspaceId, workspaceId), eq(apiCalls.mode, "live"), gte(apiCalls.createdAt, monthStart)));
  const [mock] = await db
    .select({ costUsd: sql<number>`coalesce(sum(${apiCalls.costUsd}), 0)` })
    .from(apiCalls)
    .where(and(eq(apiCalls.workspaceId, workspaceId), eq(apiCalls.mode, "mock"), gte(apiCalls.createdAt, monthStart)));
  const [scanCount] = await db
    .select({ n: sql<number>`count(*)` })
    .from(scans)
    .where(and(eq(scans.workspaceId, workspaceId), gte(scans.createdAt, monthStart)));

  const recentCalls = await db
    .select({
      id: apiCalls.id,
      scanId: apiCalls.scanId,
      mode: apiCalls.mode,
      path: apiCalls.path,
      taskCount: apiCalls.taskCount,
      costUsd: apiCalls.costUsd,
      createdAt: apiCalls.createdAt,
    })
    .from(apiCalls)
    .where(eq(apiCalls.workspaceId, workspaceId))
    .orderBy(desc(apiCalls.createdAt))
    .limit(25);

  const hosted = billingMode === "hosted";
  const ledger = hosted
    ? await db
        .select({ id: creditLedger.id, delta: creditLedger.delta, reason: creditLedger.reason, scanId: creditLedger.scanId, createdAt: creditLedger.createdAt })
        .from(creditLedger)
        .where(eq(creditLedger.workspaceId, workspaceId))
        .orderBy(desc(creditLedger.createdAt))
        .limit(25)
    : [];
  const balance = hosted ? await getBalance(db, workspaceId) : null;

  return {
    billingMode,
    monthStart,
    /** Real DataForSEO spend this month (live calls only). */
    providerCostUsd: Number(month.costUsd),
    providerCalls: Number(month.calls),
    providerTasks: Number(month.tasks),
    /** Simulated cost from the mock provider; never real money. */
    simulatedCostUsd: Number(mock.costUsd),
    scans: Number(scanCount.n),
    credits: hosted ? { balance, balanceUsd: creditsToUsd(balance ?? 0), ledger } : null,
    recentCalls,
  };
}
