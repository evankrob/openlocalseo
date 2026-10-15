export const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
export const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
export const fmtNum = (n: number | null | undefined, digits = 1) => (n == null ? "-" : n.toFixed(digits));
export const fmtUsd = (n: number, digits = 4) => `$${n.toFixed(digits)}`;
export const fmtPct = (n: number | null | undefined) => (n == null ? "-" : `${n.toFixed(1)}%`);
