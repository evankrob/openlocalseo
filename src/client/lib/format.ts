export const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
export const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
export const fmtNum = (n: number | null | undefined, digits = 1) => (n == null ? "-" : n.toFixed(digits));
export const fmtUsd = (n: number, digits = 4) => `$${n.toFixed(digits)}`;
export const fmtPct = (n: number | null | undefined) => (n == null ? "-" : `${n.toFixed(1)}%`);

type ChargeQuote = { points: number; queueMode: string; chargedUsd: number; credits: number };

/** Hosted: credits plus marked-up USD; BYOK: the upper-bound DataForSEO USD estimate. */
export const chargeLabel = (q: Pick<ChargeQuote, "chargedUsd" | "credits">, billingMode: "byok" | "hosted") =>
  billingMode === "hosted" ? `${q.credits} credits (${fmtUsd(q.chargedUsd)})` : `~${fmtUsd(q.chargedUsd)}`;

/** Muted line under the run button: points x queue, what is charged, and the hosted balance when known. */
export function scanBreakdown(q: ChargeQuote, billingMode: "byok" | "hosted", balance?: number | null, dataMode?: "mock" | "live"): string {
  const mock = billingMode === "byok" && dataMode === "mock" ? " Mock data: nothing is charged." : "";
  const base = `${q.points} points (${Math.round(Math.sqrt(q.points))}x${Math.round(Math.sqrt(q.points))}) on the ${q.queueMode} queue`;
  if (billingMode === "hosted") {
    const bal = balance == null ? "" : ` Balance: ${balance.toLocaleString()} credits.`;
    return `${base}. Held now, settled at the real cost.${bal}${mock}`;
  }
  return `${base}. Upper-bound DataForSEO estimate; the real cost is recorded per call.${mock}`;
}
