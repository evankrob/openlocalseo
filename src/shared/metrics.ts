// Rank metrics, after Local Falcon's published definitions (SCOPE.md section 4):
//   ARP  = average rank over the points where the business was found
//   ATRP = average rank over all points, not-found counted as 21
//   SoLV = share of points where the business ranked in the top 3

/** A business must rank within this position to count as "found". */
export const MAX_TRACKED_RANK = 20;
export const NOT_FOUND_RANK = MAX_TRACKED_RANK + 1;
export const TOP_3 = 3;

export type ScanMetrics = {
  arp: number | null;
  atrp: number | null;
  /** Percentage 0-100. */
  solv: number | null;
  foundPoints: number;
  top3Points: number;
  totalPoints: number;
};

/** Ranks beyond the tracked depth are treated as not found. */
export function normalizeRank(rank: number | null | undefined): number | null {
  if (rank == null || !Number.isFinite(rank) || rank < 1) return null;
  return rank <= MAX_TRACKED_RANK ? Math.round(rank) : null;
}

export function computeMetrics(
  pointRanks: Array<number | null | undefined>,
): ScanMetrics {
  const ranks = pointRanks.map(normalizeRank);
  const total = ranks.length;
  if (total === 0) {
    return { arp: null, atrp: null, solv: null, foundPoints: 0, top3Points: 0, totalPoints: 0 };
  }
  const found = ranks.filter((r): r is number => r !== null);
  const sumAll = ranks.reduce<number>((sum, r) => sum + (r ?? NOT_FOUND_RANK), 0);
  const top3 = found.filter((r) => r <= TOP_3).length;
  return {
    arp: found.length ? round2(found.reduce((a, b) => a + b, 0) / found.length) : null,
    atrp: round2(sumAll / total),
    solv: round2((top3 / total) * 100),
    foundPoints: found.length,
    top3Points: top3,
    totalPoints: total,
  };
}

export type PointResult = {
  /** Stable identity of a business: place id, else cid, else lowercase name. */
  key: string;
  name: string;
  rank: number;
  [extra: string]: unknown;
};

export type CompetitorSummary = ScanMetrics & {
  key: string;
  name: string;
  rating: number | null;
  ratingCount: number | null;
  category: string | null;
  address: string | null;
};

type CompetitorInput = {
  key: string;
  name: string;
  rank: number;
  rating?: number | null;
  ratingCount?: number | null;
  category?: string | null;
  address?: string | null;
};

/**
 * Per-business metrics over the same scan, from the SERPs already collected:
 * no extra API calls. `totalPoints` is the number of grid points that
 * returned a result set, so a business missing from a point counts as
 * not-found there. Sorted best (lowest ATRP) first.
 */
export function summarizeCompetitors(
  pointResults: CompetitorInput[][],
): CompetitorSummary[] {
  const totalPoints = pointResults.length;
  const byKey = new Map<
    string,
    { meta: CompetitorInput; ranks: Map<number, number> }
  >();
  pointResults.forEach((results, pointIndex) => {
    for (const result of results) {
      const normalized = normalizeRank(result.rank);
      if (normalized === null) continue;
      const entry = byKey.get(result.key) ?? { meta: result, ranks: new Map() };
      // Keep the best (lowest) rank if a SERP lists a business twice.
      const existing = entry.ranks.get(pointIndex);
      if (existing === undefined || normalized < existing) entry.ranks.set(pointIndex, normalized);
      byKey.set(result.key, entry);
    }
  });

  const summaries: CompetitorSummary[] = [];
  for (const [key, { meta, ranks }] of byKey) {
    const perPoint = Array.from({ length: totalPoints }, (_, i) => ranks.get(i) ?? null);
    summaries.push({
      ...computeMetrics(perPoint),
      key,
      name: meta.name,
      rating: meta.rating ?? null,
      ratingCount: meta.ratingCount ?? null,
      category: meta.category ?? null,
      address: meta.address ?? null,
    });
  }
  return summaries.sort(
    (a, b) => (a.atrp ?? 99) - (b.atrp ?? 99) || (b.solv ?? 0) - (a.solv ?? 0) || a.name.localeCompare(b.name),
  );
}

/** Difference between two scans' metrics, for side-by-side comparison. */
export function diffMetrics(current: ScanMetrics, previous: ScanMetrics) {
  const delta = (a: number | null, b: number | null) =>
    a === null || b === null ? null : round2(a - b);
  return {
    arp: delta(current.arp, previous.arp),
    atrp: delta(current.atrp, previous.atrp),
    solv: delta(current.solv, previous.solv),
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
