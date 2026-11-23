// Before/after comparison of two grid scans: pure helpers for the Compare tab.
// Points are matched by grid position (row, col); ranks come from `scan_points`.
import { normalizeRank, type ScanMetrics } from "./metrics";

export type ComparePoint = { row: number; col: number; rank: number | null; status?: string };

export type GridShape = {
  gridSize: number;
  radiusKm: number;
  zoom: number;
  searchType: string;
  keyword: string;
};

/** Returns the names of the shape fields that differ (empty when comparable). */
export function shapeMismatches(a: GridShape, b: GridShape): string[] {
  const fields: Array<[keyof GridShape, string]> = [
    ["gridSize", "grid size"],
    ["radiusKm", "radius"],
    ["zoom", "zoom"],
    ["searchType", "search type"],
    ["keyword", "keyword"],
  ];
  return fields.filter(([key]) => a[key] !== b[key]).map(([, label]) => label);
}

export type PointChangeKind =
  | "improved" // found in both, better rank
  | "declined" // found in both, worse rank
  | "unchanged" // same rank (including not found in both)
  | "new" // not found before, found now
  | "lost" // found before, not found now
  | "unknown"; // a point failed, was skipped or is missing on one side

export type PointChange = {
  row: number;
  col: number;
  before: number | null;
  after: number | null;
  kind: PointChangeKind;
  /** Positive = moved up (better), negative = moved down. Only set when both ranks are found. */
  delta: number | null;
};

const key = (row: number, col: number) => `${row}:${col}`;

/** A completed point's normalized rank, or `undefined` when the point has no usable result. */
function usableRank(point: ComparePoint | undefined): number | null | undefined {
  if (!point || (point.status !== undefined && point.status !== "completed")) return undefined;
  return normalizeRank(point.rank);
}

/** Per-position change over the union of both scans' grid cells, sorted north-west first. */
export function comparePoints(before: ComparePoint[], after: ComparePoint[]): PointChange[] {
  const beforeBy = new Map(before.map((p) => [key(p.row, p.col), p]));
  const afterBy = new Map(after.map((p) => [key(p.row, p.col), p]));
  const cells = new Map<string, { row: number; col: number }>();
  for (const p of [...before, ...after]) cells.set(key(p.row, p.col), { row: p.row, col: p.col });

  const changes: PointChange[] = [];
  for (const [k, { row, col }] of cells) {
    const b = usableRank(beforeBy.get(k));
    const a = usableRank(afterBy.get(k));
    if (b === undefined || a === undefined) {
      changes.push({ row, col, before: b ?? null, after: a ?? null, kind: "unknown", delta: null });
    } else if (b === null && a === null) {
      changes.push({ row, col, before: null, after: null, kind: "unchanged", delta: null });
    } else if (b === null) {
      changes.push({ row, col, before: null, after: a, kind: "new", delta: null });
    } else if (a === null) {
      changes.push({ row, col, before: b, after: null, kind: "lost", delta: null });
    } else {
      const delta = b - a;
      changes.push({ row, col, before: b, after: a, kind: delta > 0 ? "improved" : delta < 0 ? "declined" : "unchanged", delta });
    }
  }
  return changes.sort((x, y) => x.row - y.row || x.col - y.col);
}

export type ChangeCounts = {
  /** Includes `new`. */
  improved: number;
  /** Includes `lost`. */
  declined: number;
  unchanged: number;
  newlyFound: number;
  lost: number;
  /** Points that could not be compared (failed or missing on one side). */
  unknown: number;
};

export function countChanges(changes: PointChange[]): ChangeCounts {
  const n = (kinds: PointChangeKind[]) => changes.filter((c) => kinds.includes(c.kind)).length;
  return {
    improved: n(["improved", "new"]),
    declined: n(["declined", "lost"]),
    unchanged: n(["unchanged"]),
    newlyFound: n(["new"]),
    lost: n(["lost"]),
    unknown: n(["unknown"]),
  };
}

export type FoundCounts = { top3: number; top10: number; notFound: number; total: number; failed: number };

/** Found-band counts over completed points. Not found = rank 21+ or null; failed points are separate; skipped points are left out. */
export function foundCounts(points: ComparePoint[]): FoundCounts {
  const counts: FoundCounts = { top3: 0, top10: 0, notFound: 0, total: 0, failed: 0 };
  for (const p of points) {
    // Skipped points (water / outside area / user) were never searched: not a result and not a failure.
    if (p.status === "skipped") continue;
    if (usableRank(p) === undefined) {
      counts.failed++;
      continue;
    }
    const rank = normalizeRank(p.rank);
    counts.total++;
    if (rank === null) counts.notFound++;
    else {
      if (rank <= 3) counts.top3++;
      if (rank <= 10) counts.top10++;
    }
  }
  return counts;
}

export type MetricKey = "atrp" | "arp" | "solv";
export type MetricRow = {
  key: MetricKey;
  label: string;
  unit: "rank" | "pct";
  lowerIsBetter: boolean;
  before: number | null;
  after: number | null;
  /** after - before, null when either side is missing. */
  delta: number | null;
  verdict: "better" | "worse" | "same" | null;
};

const METRIC_DEFS: Array<Pick<MetricRow, "key" | "label" | "unit" | "lowerIsBetter">> = [
  { key: "atrp", label: "ATRP", unit: "rank", lowerIsBetter: true },
  { key: "arp", label: "ARP", unit: "rank", lowerIsBetter: true },
  { key: "solv", label: "SoLV", unit: "pct", lowerIsBetter: false },
];

export function metricRows(before: ScanMetrics | null, after: ScanMetrics | null): MetricRow[] {
  return METRIC_DEFS.map((def) => {
    const b = before?.[def.key] ?? null;
    const a = after?.[def.key] ?? null;
    const delta = a === null || b === null ? null : Math.round((a - b) * 100) / 100;
    const verdict = delta === null ? null : delta === 0 ? "same" : (delta < 0) === def.lowerIsBetter ? "better" : "worse";
    return { ...def, before: b, after: a, delta, verdict };
  });
}

/** Compact label for a point change: ▲3, ▼2, =, new, lost, or - when unknown. */
export function changeLabel(change: PointChange): string {
  switch (change.kind) {
    case "improved": return `▲${change.delta}`;
    case "declined": return `▼${Math.abs(change.delta ?? 0)}`;
    case "unchanged": return "=";
    case "new": return "new";
    case "lost": return "lost";
    case "unknown": return "-";
  }
}

const rankText = (rank: number | null) => (rank === null ? "not in top 20" : `rank ${rank}`);

/** Tooltip text: "rank 7 → rank 4" (or "failed" when a side has no usable result). */
export function changeTitle(change: PointChange): string {
  if (change.kind === "unknown") return "Not comparable (a search failed, was skipped or is missing)";
  return `${rankText(change.before)} → ${rankText(change.after)}`;
}
