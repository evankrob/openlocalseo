// Competitor overlay: pure rules, shared by the Worker (read model, MCP) and
// the UI. Built on the per-point results a scan already stored; nothing here
// touches the network or the database.
//
// Identity. Listings are matched across points by place id, else by cid. A
// result with neither is NEVER merged with another one (names are not an
// identity); it stays a one-point result and is not selectable as a competitor.
// Two distinct listings with a near-identical name AND the same phone are
// flagged "possible duplicate", never merged.
import { MAX_TRACKED_RANK, NOT_FOUND_RANK, computeMetrics, normalizeRank, type ScanMetrics } from "./metrics";

export const DEFAULT_COMPETITORS = 5;
export const MAX_PINNED = 10;
/** Businesses shown when hovering or tapping a point. */
export const POINT_TOP_N = 5;
/** Name similarity (0-1) at or above which two listings with the same phone are flagged. */
export const NAME_SIMILARITY_THRESHOLD = 0.8;

/** One stored result row: a business at one grid point. */
export type OverlayRow = {
  id: string;
  pointId: string;
  rank: number;
  name: string;
  placeId: string | null;
  cid: string | null;
  domain: string | null;
  phone: string | null;
  rating: number | null;
  ratingCount: number | null;
  category: string | null;
  address: string | null;
  isTarget: boolean;
};

export type CompetitorSettings = {
  pinned: Array<{ identity: string; name: string }>;
  hidden: Array<{ identity: string; name: string }>;
};

export type HeadToHead = "win" | "loss" | "tie" | "neither";
export type HeadToHeadCounts = { wins: number; losses: number; ties: number; neither: number };

// ---- identity ---------------------------------------------------------------

/** Identity prefixes: `p:` place id, `c:` cid, `r:` a result with no id (never merged). */
export const isStableIdentity = (identity: string) => !identity.startsWith("r:");

/**
 * Identity of every row, by place id, else cid. A cid-only row joins the place
 * id of another row that carries the same cid, so one listing missing its place
 * id at some points is still one listing. Rows with neither id get their own.
 */
export function assignIdentities(rows: OverlayRow[]): Map<string, string> {
  const placeByCid = new Map<string, string>();
  for (const r of rows) if (r.placeId && r.cid && !placeByCid.has(r.cid)) placeByCid.set(r.cid, r.placeId);
  const identities = new Map<string, string>();
  for (const r of rows) {
    const placeId = r.placeId ?? (r.cid ? placeByCid.get(r.cid) : undefined);
    identities.set(r.id, placeId ? `p:${placeId}` : r.cid ? `c:${r.cid}` : `r:${r.id}`);
  }
  return identities;
}

// ---- names and phones -------------------------------------------------------

/** Lower case, accents and punctuation dropped, trailing legal suffix (LLC, Inc...) removed. */
export const normalizeListingName = (name: string) =>
  name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[,.\s]+(llc|inc|ltd|corp|co)[.\s]*$/, "")
    .replace(/[^a-z0-9]+/g, "");

/** Digits only, last 10 (drops a country code); null when fewer than 7 digits. */
export function normalizePhone(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/\D+/g, "");
  return digits.length >= 7 ? digits.slice(-10) : null;
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      next[j] = Math.min((prev[j] ?? 0) + 1, (next[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = next;
  }
  return prev[b.length] ?? 0;
}

/** 0-1 similarity of two names after dropping case, spaces and punctuation. */
export function nameSimilarity(a: string, b: string): number {
  const x = normalizeListingName(a);
  const y = normalizeListingName(b);
  const longest = Math.max(x.length, y.length);
  return longest === 0 ? 0 : 1 - editDistance(x, y) / longest;
}

export type Listing = { identity: string; name: string; phone: string | null };

/** Two different listings that look like one business: similar name and the same phone. */
export function arePossibleDuplicates(a: Listing, b: Listing): boolean {
  if (a.identity === b.identity) return false;
  const phoneA = normalizePhone(a.phone);
  if (!phoneA || phoneA !== normalizePhone(b.phone)) return false;
  return nameSimilarity(a.name, b.name) >= NAME_SIMILARITY_THRESHOLD;
}

/** identity -> names of the other listings it may duplicate. Flags only; nothing is merged. */
export function findPossibleDuplicates(listings: Listing[]): Map<string, string[]> {
  const byPhone = new Map<string, Listing[]>();
  for (const l of listings) {
    const phone = normalizePhone(l.phone);
    if (phone) byPhone.set(phone, [...(byPhone.get(phone) ?? []), l]);
  }
  const flags = new Map<string, string[]>();
  for (const group of byPhone.values()) {
    for (const a of group) {
      for (const b of group) {
        if (arePossibleDuplicates(a, b)) flags.set(a.identity, [...(flags.get(a.identity) ?? []), b.name]);
      }
    }
  }
  return flags;
}

// ---- head to head -----------------------------------------------------------

/**
 * One grid point, client vs competitor. A rank outside the top 20 (or none)
 * counts as not found. win = the client ranks higher, loss = the competitor
 * does, tie = same rank, neither = neither is in the top 20.
 */
export function classifyHeadToHead(clientRank: number | null | undefined, competitorRank: number | null | undefined): HeadToHead {
  const client = normalizeRank(clientRank);
  const competitor = normalizeRank(competitorRank);
  if (client === null && competitor === null) return "neither";
  const c = client ?? NOT_FOUND_RANK;
  const o = competitor ?? NOT_FOUND_RANK;
  return c < o ? "win" : c > o ? "loss" : "tie";
}

export function countHeadToHead(clientRanks: Array<number | null>, competitorRanks: Array<number | null>): HeadToHeadCounts {
  const counts: HeadToHeadCounts = { wins: 0, losses: 0, ties: 0, neither: 0 };
  clientRanks.forEach((client, i) => {
    const outcome = classifyHeadToHead(client, competitorRanks[i] ?? null);
    if (outcome === "win") counts.wins++;
    else if (outcome === "loss") counts.losses++;
    else if (outcome === "tie") counts.ties++;
    else counts.neither++;
  });
  return counts;
}

// ---- candidates and selection -----------------------------------------------

export type Candidate = {
  identity: string;
  name: string;
  placeId: string | null;
  cid: string | null;
  phone: string | null;
  rating: number | null;
  ratingCount: number | null;
  category: string | null;
  address: string | null;
  /** Rank per completed point (aligned with the point order), null = not in the top 20. */
  ranks: Array<number | null>;
  metrics: ScanMetrics;
  possibleDuplicateOf: string[];
};

/** Default order: most top-3 appearances first, ties by average rank (not found = 21), then name. */
export function compareCandidates(a: Candidate, b: Candidate): number {
  return (
    b.metrics.top3Points - a.metrics.top3Points ||
    (a.metrics.atrp ?? NOT_FOUND_RANK) - (b.metrics.atrp ?? NOT_FOUND_RANK) ||
    a.name.localeCompare(b.name)
  );
}

export type ExcludedListing = { name: string; reason: "client" | "duplicate_of_client" | "same_website" };

export type CandidateSet = {
  /** Stable-identity businesses other than the client, best first. */
  candidates: Candidate[];
  /** Listings left out because they are the client or look like the client. */
  excluded: ExcludedListing[];
  /** Results with no place id or cid: shown at their point, never matched across points. */
  unmatchedResults: number;
};

const bareDomain = (d: string) => d.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");

/**
 * Groups a scan's rows into businesses and drops the client's own listing and
 * its duplicates (same place id/cid as a client row, same phone + near-identical
 * name, or the client's website). `pointIds` are the completed points, in order.
 */
export function buildCandidates(
  rows: OverlayRow[],
  pointIds: string[],
  client: { name: string; domain: string | null; phone?: string | null },
): CandidateSet {
  const identities = assignIdentities(rows);
  const pointIndex = new Map(pointIds.map((id, i) => [id, i]));
  type Group = { rows: OverlayRow[]; ranks: Array<number | null> };
  const groups = new Map<string, Group>();
  let unmatchedResults = 0;
  for (const row of rows) {
    const index = pointIndex.get(row.pointId);
    const identity = identities.get(row.id);
    if (index === undefined || identity === undefined) continue;
    if (!isStableIdentity(identity)) {
      if (!row.isTarget) unmatchedResults++;
      continue;
    }
    const group = groups.get(identity) ?? { rows: [], ranks: pointIds.map(() => null) };
    group.rows.push(row);
    const rank = normalizeRank(row.rank);
    const existing = group.ranks[index] ?? null;
    // Keep the best rank if one SERP lists the same business twice.
    if (rank !== null && (existing === null || rank < existing)) group.ranks[index] = rank;
    groups.set(identity, group);
  }

  const clientIdentities = new Set<string>();
  const clientNames = new Set<string>([client.name]);
  const clientPhones = new Set<string>();
  const clientPhone = normalizePhone(client.phone);
  if (clientPhone) clientPhones.add(clientPhone);
  for (const row of rows) {
    if (!row.isTarget) continue;
    const identity = identities.get(row.id);
    if (identity && isStableIdentity(identity)) clientIdentities.add(identity);
    clientNames.add(row.name);
    const phone = normalizePhone(row.phone);
    if (phone) clientPhones.add(phone);
  }
  const looksLikeClient = (l: Listing) =>
    [...clientPhones].some((phone) => [...clientNames].some((name) => arePossibleDuplicates({ identity: "client", name, phone }, l)));
  const wantDomain = client.domain ? bareDomain(client.domain) : null;

  const listings = new Map<string, Listing & Group>();
  for (const [identity, group] of groups) {
    const first = group.rows[0];
    if (!first) continue;
    listings.set(identity, { identity, name: first.name, phone: group.rows.map((r) => r.phone).find((p) => normalizePhone(p)) ?? null, ...group });
  }

  const excluded: ExcludedListing[] = [];
  const kept: Candidate[] = [];
  const flags = findPossibleDuplicates([...listings.values()].filter((l) => !clientIdentities.has(l.identity)));
  for (const [identity, listing] of listings) {
    const first = listing.rows[0];
    if (!first) continue;
    if (clientIdentities.has(identity)) {
      excluded.push({ name: listing.name, reason: "client" });
      continue;
    }
    if (looksLikeClient(listing)) {
      excluded.push({ name: listing.name, reason: "duplicate_of_client" });
      continue;
    }
    if (wantDomain && listing.rows.some((r) => r.domain && bareDomain(r.domain) === wantDomain)) {
      excluded.push({ name: listing.name, reason: "same_website" });
      continue;
    }
    const firstText = (pick: (r: OverlayRow) => string | null) => listing.rows.map(pick).find((v) => v !== null) ?? null;
    const firstNumber = (pick: (r: OverlayRow) => number | null) => listing.rows.map(pick).find((v) => v !== null) ?? null;
    kept.push({
      identity,
      name: listing.name,
      placeId: first.placeId,
      cid: first.cid,
      phone: listing.phone,
      rating: firstNumber((r) => r.rating),
      ratingCount: firstNumber((r) => r.ratingCount),
      category: firstText((r) => r.category),
      address: firstText((r) => r.address),
      ranks: listing.ranks,
      metrics: computeMetrics(listing.ranks),
      possibleDuplicateOf: flags.get(identity) ?? [],
    });
  }
  kept.sort(compareCandidates);
  excluded.sort((a, b) => a.name.localeCompare(b.name));
  return { candidates: kept, excluded, unmatchedResults };
}

export type SelectedCompetitor = Candidate & { source: "default" | "pinned" };

/**
 * The competitors to show: the top `defaultCount` of the non-hidden candidates,
 * plus every pinned one (a pinned business is never hidden; pinning a hidden
 * one unhides it). A hidden default is replaced by the next best, so the
 * default list stays at five. Pinned businesses missing from this scan are
 * simply absent here (they stay pinned in the settings).
 */
export function selectCompetitors(candidates: Candidate[], settings: CompetitorSettings, defaultCount = DEFAULT_COMPETITORS): SelectedCompetitor[] {
  const pinned = new Set(settings.pinned.map((p) => p.identity));
  const hidden = new Set(settings.hidden.map((h) => h.identity));
  const selected: SelectedCompetitor[] = [];
  let defaults = 0;
  for (const c of candidates) {
    if (pinned.has(c.identity)) selected.push({ ...c, source: "pinned" });
    else if (!hidden.has(c.identity) && defaults < defaultCount) {
      defaults++;
      selected.push({ ...c, source: "default" });
    }
  }
  // defaults first (in rank order), then pins in rank order
  return [...selected.filter((s) => s.source === "default"), ...selected.filter((s) => s.source === "pinned")];
}

// ---- per point top list -----------------------------------------------------

export type PointTopEntry = { rank: number; name: string; isTarget: boolean };

/** The best `n` businesses at each point (aligned with `pointIds`), by listed rank. */
export function topPerPoint(rows: OverlayRow[], pointIds: string[], n = POINT_TOP_N): PointTopEntry[][] {
  const byPoint = new Map<string, OverlayRow[]>(pointIds.map((id) => [id, []]));
  for (const r of rows) byPoint.get(r.pointId)?.push(r);
  return pointIds.map((id) =>
    (byPoint.get(id) ?? [])
      .filter((r) => r.rank >= 1 && r.rank <= MAX_TRACKED_RANK)
      .sort((a, b) => a.rank - b.rank)
      .slice(0, n)
      .map((r) => ({ rank: r.rank, name: r.name, isTarget: r.isTarget })),
  );
}
