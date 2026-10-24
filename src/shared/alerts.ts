// Rank-drop alert rules. Pure functions: the worker feeds them two scans'
// stored metrics when a scan is finalized, the UI reuses the types/defaults.
import { z } from "zod";
import { TOP_3 } from "./metrics";

/** Raised from a scan (rank_drop, data_problem) or a GBP snapshot (rating_drop, negative_review). */
export const ALERT_KINDS = ["rank_drop", "data_problem", "rating_drop", "negative_review"] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];
export type ScanAlertKind = "rank_drop" | "data_problem";
export type GbpAlertKind = "rating_drop" | "negative_review";
export type AlertSeverity = "warning" | "critical";
export type AlertTrigger = "atrp" | "solv" | "found_points" | "center_top3" | "failed_points";

export type AlertRules = {
  /** Alert when ATRP is this much worse (higher). */
  atrpWorse: number;
  /** Alert when SoLV falls by this many percentage points. */
  solvDown: number;
  /** Alert when found points fall by this % of the total points. */
  foundDropPct: number;
  /** Alert when the business leaves the top 3 at the center point. */
  centerTop3: boolean;
  /** Severity becomes "critical" at these (larger) changes. */
  criticalAtrp: number;
  criticalSolv: number;
};

export type AlertSettingsValues = AlertRules & {
  enabled: boolean;
  /** Slack-compatible incoming webhook; null = notifications off. */
  webhookUrl: string | null;
};

export const DEFAULT_ALERT_RULES: AlertRules = {
  atrpWorse: 2,
  solvDown: 15,
  foundDropPct: 25,
  centerTop3: true,
  criticalAtrp: 5,
  criticalSolv: 30,
};

export const DEFAULT_ALERT_SETTINGS: AlertSettingsValues = { ...DEFAULT_ALERT_RULES, enabled: true, webhookUrl: null };

/** Share of failed points above which a completed scan is a data problem. */
export const FAILED_POINTS_SHARE = 0.5;

/** The scan settings that must match for two scans to be comparable. */
export type ComparableConfig = {
  gridSize: number;
  radiusKm: number;
  zoom: number;
  searchType: string;
  keyword: string;
};

export type ScanSnapshot = ComparableConfig & {
  atrp: number | null;
  solv: number | null;
  foundPoints: number | null;
  totalPoints: number;
  /** Rank at the center point; null = not found, or the point failed / no center. */
  centerRank: number | null;
  /** False when the center point is missing or did not complete (unknown, not "lost"). */
  centerKnown: boolean;
};

export type AlertMetricsSide = {
  atrp: number | null;
  solv: number | null;
  foundPoints: number | null;
  totalPoints: number;
  centerRank?: number | null;
  failedPoints?: number;
};

export type AlertMetrics = {
  before: AlertMetricsSide | null;
  after: AlertMetricsSide;
  reasons: AlertTrigger[];
};

export type AlertCandidate = {
  kind: ScanAlertKind;
  severity: AlertSeverity;
  metrics: AlertMetrics;
};

export function isComparable(a: ComparableConfig, b: ComparableConfig): boolean {
  return (
    a.gridSize === b.gridSize &&
    Math.abs(a.radiusKm - b.radiusKm) < 1e-9 &&
    a.zoom === b.zoom &&
    a.searchType === b.searchType &&
    a.keyword === b.keyword
  );
}

const side = (s: ScanSnapshot): AlertMetricsSide => ({
  atrp: s.atrp,
  solv: s.solv,
  foundPoints: s.foundPoints,
  totalPoints: s.totalPoints,
  centerRank: s.centerKnown ? s.centerRank : null,
});

const inTop3 = (rank: number | null) => rank !== null && rank <= TOP_3;

/**
 * Compares a freshly finalized scan with the previous completed one.
 * `failedPoints` is the number of points of the new scan that failed. A scan
 * with mostly failed points raises only the data-problem alert: its metrics
 * cover too little of the grid to call it a rank drop.
 */
export function evaluateAlerts(input: {
  current: ScanSnapshot;
  previous: ScanSnapshot | null;
  failedPoints: number;
  rules?: AlertRules;
}): AlertCandidate[] {
  const { current, previous, failedPoints } = input;
  const rules = input.rules ?? DEFAULT_ALERT_RULES;

  if (current.totalPoints > 0 && failedPoints / current.totalPoints > FAILED_POINTS_SHARE) {
    return [
      {
        kind: "data_problem",
        severity: "warning",
        metrics: {
          before: previous && isComparable(current, previous) ? side(previous) : null,
          after: { ...side(current), failedPoints },
          reasons: ["failed_points"],
        },
      },
    ];
  }

  if (!previous || !isComparable(current, previous)) return [];

  const reasons: AlertTrigger[] = [];
  let atrpWorse = 0;
  let solvDown = 0;
  if (current.atrp !== null && previous.atrp !== null) {
    atrpWorse = current.atrp - previous.atrp;
    if (atrpWorse >= rules.atrpWorse) reasons.push("atrp");
  }
  if (current.solv !== null && previous.solv !== null) {
    solvDown = previous.solv - current.solv;
    if (solvDown >= rules.solvDown) reasons.push("solv");
  }
  if (current.foundPoints !== null && previous.foundPoints !== null && current.totalPoints > 0) {
    const dropPct = ((previous.foundPoints - current.foundPoints) / current.totalPoints) * 100;
    if (dropPct >= rules.foundDropPct) reasons.push("found_points");
  }
  if (rules.centerTop3 && current.centerKnown && previous.centerKnown && inTop3(previous.centerRank) && !inTop3(current.centerRank)) {
    reasons.push("center_top3");
  }
  if (reasons.length === 0) return [];

  const critical = atrpWorse >= rules.criticalAtrp || solvDown >= rules.criticalSolv;
  return [
    {
      kind: "rank_drop",
      severity: critical ? "critical" : "warning",
      metrics: { before: side(previous), after: side(current), reasons },
    },
  ];
}

const threshold = (max: number) => z.number().finite().min(0).max(max);

export const alertSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  atrpWorse: threshold(20).optional(),
  solvDown: threshold(100).optional(),
  foundDropPct: threshold(100).optional(),
  centerTop3: z.boolean().optional(),
  criticalAtrp: threshold(20).optional(),
  criticalSolv: threshold(100).optional(),
  /** Empty string or null turns notifications off. */
  webhookUrl: z
    .string()
    .trim()
    .max(500)
    .nullable()
    .optional()
    .transform((v) => (v === undefined ? undefined : v || null)),
});
export type AlertSettingsInput = z.infer<typeof alertSettingsSchema>;
