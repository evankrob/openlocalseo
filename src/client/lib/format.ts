export const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
export const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
export const fmtNum = (n: number | null | undefined, digits = 1) => (n == null ? "-" : n.toFixed(digits));
export const fmtUsd = (n: number, digits = 4) => `$${n.toFixed(digits)}`;
export const fmtPct = (n: number | null | undefined) => (n == null ? "-" : `${n.toFixed(1)}%`);

// `points` = points that will be scanned and charged; `gridPoints`/`skippedPoints` come from the
// skip-aware tracker quote (build 2). Skipped points are free, so they are never in `points`.
type ChargeQuote = { points: number; queueMode: string; chargedUsd: number; credits: number; gridPoints?: number; skippedPoints?: number };

/** Hosted: credits plus marked-up USD; BYOK: the upper-bound DataForSEO USD estimate. */
export const chargeLabel = (q: Pick<ChargeQuote, "chargedUsd" | "credits">, billingMode: "byok" | "hosted") =>
  billingMode === "hosted" ? `${q.credits} credits (${fmtUsd(q.chargedUsd)})` : `~${fmtUsd(q.chargedUsd)}`;

/** Muted line under the run button: points x queue, what is charged, and the hosted balance when known. */
export function scanBreakdown(q: ChargeQuote, billingMode: "byok" | "hosted", balance?: number | null, dataMode?: "mock" | "live"): string {
  const mock = billingMode === "byok" && dataMode === "mock" ? " Mock data: nothing is charged." : "";
  const grid = q.gridPoints ?? q.points;
  const side = Math.round(Math.sqrt(grid));
  const skipped = q.skippedPoints ?? 0;
  const base = skipped > 0
    ? `${q.points} of ${grid} points (${side}x${side}) on the ${q.queueMode} queue; ${skipped} skipped and not charged`
    : `${q.points} points (${side}x${side}) on the ${q.queueMode} queue`;
  if (billingMode === "hosted") {
    const bal = balance == null ? "" : ` Balance: ${balance.toLocaleString()} credits.`;
    return `${base}. Held now, settled at the real cost.${bal}${mock}`;
  }
  return `${base}. Upper-bound DataForSEO estimate; the real cost is recorded per call.${mock}`;
}
