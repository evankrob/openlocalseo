import { describe, expect, it } from "vitest";
import { at, must } from "./assert";
import { changeLabel, changeTitle, comparePoints, countChanges, foundCounts, metricRows, shapeMismatches } from "./compare";
import { computeMetrics } from "./metrics";

const pts = (ranks: Array<number | null>, size = 2) =>
  ranks.map((rank, i) => ({ row: Math.floor(i / size), col: i % size, rank, status: "completed" }));

describe("comparePoints", () => {
  it("classifies each position by rank movement", () => {
    const changes = comparePoints(pts([5, 2, null, 8, 4, null]), pts([2, 4, 6, null, 4, null]));
    expect(changes.map((c) => c.kind)).toEqual(["improved", "declined", "new", "lost", "unchanged", "unchanged"]);
    expect(at(changes, 0).delta).toBe(3);
    expect(at(changes, 1).delta).toBe(-2);
    expect(countChanges(changes)).toEqual({ improved: 2, declined: 2, unchanged: 2, newlyFound: 1, lost: 1, unknown: 0 });
  });

  it("matches by position, not array order, and treats rank 21+ as not found", () => {
    const before = [{ row: 1, col: 1, rank: 3, status: "completed" }, { row: 0, col: 0, rank: 30, status: "completed" }];
    const after = [{ row: 0, col: 0, rank: 5, status: "completed" }, { row: 1, col: 1, rank: 1, status: "completed" }];
    const changes = comparePoints(before, after);
    expect(changes.map((c) => [c.row, c.col, c.kind])).toEqual([[0, 0, "new"], [1, 1, "improved"]]);
  });

  it("marks failed or missing points unknown and excludes them from counts", () => {
    const before = [{ row: 0, col: 0, rank: 3, status: "failed" }, { row: 0, col: 1, rank: 3, status: "completed" }];
    const after = [{ row: 0, col: 0, rank: 1, status: "completed" }];
    const changes = comparePoints(before, after);
    expect(changes.map((c) => c.kind)).toEqual(["unknown", "unknown"]);
    expect(countChanges(changes).unknown).toBe(2);
  });
});

describe("labels", () => {
  it("renders arrows and tooltips", () => {
    const [up, down, same, fresh, lost] = comparePoints(pts([5, 2, 4, null, 9]), pts([2, 4, 4, 6, null]));
    expect(changeLabel(must(up, "up"))).toBe("▲3");
    expect(changeLabel(must(down, "down"))).toBe("▼2");
    expect(changeLabel(must(same, "same"))).toBe("=");
    expect(changeLabel(must(fresh, "fresh"))).toBe("new");
    expect(changeLabel(must(lost, "lost"))).toBe("lost");
    expect(changeTitle(must(fresh, "fresh"))).toBe("not in top 20 → rank 6");
  });
});

describe("foundCounts", () => {
  it("counts bands and separates failed points", () => {
    const points = [...pts([1, 3, 8, 12, null, 25]), { row: 3, col: 3, rank: null, status: "failed" }];
    expect(foundCounts(points)).toEqual({ top3: 2, top10: 3, notFound: 2, total: 6, failed: 1 });
  });
});

describe("metricRows", () => {
  it("colours by direction: lower ATRP/ARP is better, higher SoLV is better", () => {
    const before = computeMetrics([5, 5, null, null]);
    const after = computeMetrics([2, 2, 2, null]);
    const [atrp, arp, solv] = metricRows(before, after);
    expect(must(atrp, "atrp").verdict).toBe("better");
    expect(must(arp, "arp").delta).toBe(-3);
    expect(must(solv, "solv")).toMatchObject({ before: 0, after: 75, delta: 75, verdict: "better" });
    expect(metricRows(after, before).map((r) => r.verdict)).toEqual(["worse", "worse", "worse"]);
  });

  it("handles missing metrics", () => {
    expect(metricRows(null, computeMetrics([1])).map((r) => r.delta)).toEqual([null, null, null]);
    const noneFound = computeMetrics([null, null]);
    expect(at(metricRows(noneFound, computeMetrics([3, null])), 1).delta).toBeNull(); // ARP null before
  });
});

describe("shapeMismatches", () => {
  const shape = { gridSize: 5, radiusKm: 2, zoom: 15, searchType: "maps", keyword: "dentist" };
  it("lists differing fields", () => {
    expect(shapeMismatches(shape, { ...shape })).toEqual([]);
    expect(shapeMismatches(shape, { ...shape, gridSize: 7, keyword: "x" })).toEqual(["grid size", "keyword"]);
  });
});

describe("skipped points in compare", () => {
  it("foundCounts leaves skipped points out (neither counted nor failed)", () => {
    const counts = foundCounts([
      { row: 0, col: 0, rank: 2, status: "completed" },
      { row: 0, col: 1, rank: null, status: "skipped" },
      { row: 1, col: 0, rank: null, status: "failed" },
    ]);
    expect(counts).toEqual({ top3: 1, top10: 1, notFound: 0, total: 1, failed: 1 });
  });
  it("a point skipped on one side is not comparable", () => {
    const [change] = comparePoints([{ row: 0, col: 0, rank: 4, status: "completed" }], [{ row: 0, col: 0, rank: null, status: "skipped" }]);
    expect(change?.kind).toBe("unknown");
  });
});
