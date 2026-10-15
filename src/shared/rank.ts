// Rank -> display tier. Shared by the app and public report so colors agree.
export type RankTier = "1" | "2" | "3" | "4" | "none";

export const RANK_TIERS: Array<{ tier: RankTier; label: string }> = [
  { tier: "1", label: "1-3" },
  { tier: "2", label: "4-7" },
  { tier: "3", label: "8-12" },
  { tier: "4", label: "13-20" },
  { tier: "none", label: "Not in top 20" },
];

export function rankTier(rank: number | null | undefined): RankTier {
  if (rank == null || rank < 1 || rank > 20) return "none";
  if (rank <= 3) return "1";
  if (rank <= 7) return "2";
  if (rank <= 12) return "3";
  return "4";
}

export function rankLabel(rank: number | null | undefined): string {
  return rank == null || rank < 1 || rank > 20 ? "20+" : String(rank);
}
