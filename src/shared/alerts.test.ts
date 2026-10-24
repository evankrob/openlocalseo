import { describe, expect, it } from "vitest";
import { alertSettingsSchema, evaluateAlerts, isComparable, DEFAULT_ALERT_RULES, type ScanSnapshot } from "./alerts";

const base: ScanSnapshot = {
  gridSize: 5,
  radiusKm: 6,
  zoom: 15,
  searchType: "maps",
  keyword: "coffee shop",
  atrp: 4,
  solv: 50,
  foundPoints: 20,
  totalPoints: 25,
  centerRank: 2,
  centerKnown: true,
};
const scan = (over: Partial<ScanSnapshot> = {}): ScanSnapshot => ({ ...base, ...over });
const run = (current: Partial<ScanSnapshot>, previous: Partial<ScanSnapshot> | null = {}, failedPoints = 0) =>
  evaluateAlerts({ current: scan(current), previous: previous && scan(previous), failedPoints });

describe("rank-drop rules", () => {
  it("raises nothing for a first scan, an unchanged scan or an improvement", () => {
    expect(run({}, null)).toEqual([]);
    expect(run({}, {})).toEqual([]);
    expect(run({ atrp: 2, solv: 80, foundPoints: 25, centerRank: 1 }, {})).toEqual([]);
  });

  it("ATRP worse by 2.0 or more, not by less", () => {
    expect(run({ atrp: 5.9 })).toEqual([]);
    const [alert] = run({ atrp: 6 });
    expect(alert).toMatchObject({ kind: "rank_drop", severity: "warning" });
    expect(alert.metrics.reasons).toEqual(["atrp"]);
    expect(alert.metrics.before).toMatchObject({ atrp: 4 });
    expect(alert.metrics.after).toMatchObject({ atrp: 6 });
  });

  it("SoLV down by 15 points or more", () => {
    expect(run({ solv: 36 })).toEqual([]);
    expect(run({ solv: 35 })[0].metrics.reasons).toEqual(["solv"]);
  });

  it("found points down by 25% of the total points", () => {
    // 25 points: a drop of 6 is 24%, a drop of 7 is 28%
    expect(run({ foundPoints: 14 }, { foundPoints: 20 })).toEqual([]);
    expect(run({ foundPoints: 13 }, { foundPoints: 20 })[0].metrics.reasons).toEqual(["found_points"]);
  });

  it("lost the top 3 at the center point", () => {
    expect(run({ centerRank: 4 }, { centerRank: 3 })[0].metrics.reasons).toEqual(["center_top3"]);
    expect(run({ centerRank: null }, { centerRank: 1 })[0].metrics.reasons).toEqual(["center_top3"]);
    expect(run({ centerRank: 3 }, { centerRank: 1 })).toEqual([]);
    // was not top 3 before: nothing to lose
    expect(run({ centerRank: null }, { centerRank: 6 })).toEqual([]);
  });

  it("does not guess when the center point is unknown (even grid or failed point)", () => {
    expect(run({ centerRank: null, centerKnown: false }, { centerRank: 1 })).toEqual([]);
    expect(run({ centerRank: null }, { centerRank: 1, centerKnown: false })).toEqual([]);
  });

  it("honours thresholds and the center toggle from the workspace rules", () => {
    const rules = { ...DEFAULT_ALERT_RULES, atrpWorse: 0.5, centerTop3: false };
    const out = evaluateAlerts({ current: scan({ atrp: 4.5, centerRank: null }), previous: scan({ centerRank: 1 }), failedPoints: 0, rules });
    expect(out[0].metrics.reasons).toEqual(["atrp"]);
  });

  it("reports every rule that fired in one alert", () => {
    const [alert] = run({ atrp: 7, solv: 10, foundPoints: 10, centerRank: null });
    expect(alert.metrics.reasons).toEqual(["atrp", "solv", "found_points", "center_top3"]);
  });

  it("severity is critical at ATRP +5 or SoLV -30, warning below", () => {
    expect(run({ atrp: 8.9 })[0].severity).toBe("warning");
    expect(run({ atrp: 9 })[0].severity).toBe("critical");
    expect(run({ solv: 21 })[0].severity).toBe("warning");
    expect(run({ solv: 20 })[0].severity).toBe("critical");
  });

  it("ignores metrics that are missing instead of alerting", () => {
    expect(run({ atrp: null, solv: null, foundPoints: null })).toEqual([]);
    expect(run({}, { atrp: null, solv: null, foundPoints: null })).toEqual([]);
  });
});

describe("comparability", () => {
  it.each([
    ["grid size", { gridSize: 7 }],
    ["radius", { radiusKm: 8 }],
    ["zoom", { zoom: 14 }],
    ["search type", { searchType: "local_finder" }],
    ["keyword", { keyword: "espresso" }],
  ])("no alert when the %s changed, however bad the drop", (_name, change) => {
    expect(isComparable(scan(), scan(change))).toBe(false);
    expect(run({ atrp: 15, solv: 0, foundPoints: 0, centerRank: null }, change)).toEqual([]);
  });

  it("compares scans with identical settings", () => {
    expect(isComparable(scan(), scan())).toBe(true);
  });
});

describe("failed points", () => {
  it("raises a data_problem alert (not a rank drop) when more than half the points failed", () => {
    const out = run({ atrp: 15, solv: 0 }, {}, 13);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "data_problem", severity: "warning" });
    expect(out[0].metrics.after.failedPoints).toBe(13);
    expect(out[0].metrics.reasons).toEqual(["failed_points"]);
  });

  it("raises it on a first scan too, but not at exactly half", () => {
    expect(run({}, null, 13)[0].kind).toBe("data_problem");
    expect(run({}, null, 12)).toEqual([]);
  });
});

describe("alert settings schema", () => {
  it("keeps an omitted webhook as undefined and turns empty into null", () => {
    expect(alertSettingsSchema.parse({}).webhookUrl).toBeUndefined();
    expect(alertSettingsSchema.parse({ webhookUrl: "" }).webhookUrl).toBeNull();
    expect(alertSettingsSchema.parse({ webhookUrl: null }).webhookUrl).toBeNull();
  });
  it("rejects negative or absurd thresholds", () => {
    expect(alertSettingsSchema.safeParse({ atrpWorse: -1 }).success).toBe(false);
    expect(alertSettingsSchema.safeParse({ solvDown: 500 }).success).toBe(false);
  });
});
