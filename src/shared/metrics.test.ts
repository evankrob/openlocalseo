import { describe, expect, it } from "vitest";
import { computeMetrics, diffMetrics, summarizeCompetitors } from "./metrics";

describe("computeMetrics", () => {
  it("computes ARP over found points, ATRP counting not-found as 21, SoLV as top-3 share", () => {
    const m = computeMetrics([1, 2, 3, 10, null, null, null, null]);
    expect(m.arp).toBe(4); // (1+2+3+10)/4
    expect(m.atrp).toBe(((1 + 2 + 3 + 10 + 21 * 4) / 8)); // 15
    expect(m.solv).toBe(37.5); // 3 of 8
    expect(m).toMatchObject({ foundPoints: 4, top3Points: 3, totalPoints: 8 });
  });

  it("treats ranks beyond 20 as not found", () => {
    const m = computeMetrics([21, 35, 5]);
    expect(m.foundPoints).toBe(1);
    expect(m.arp).toBe(5);
    expect(m.atrp).toBeCloseTo((21 + 21 + 5) / 3, 2);
  });

  it("returns null ARP when the business is nowhere, and empty metrics for no points", () => {
    expect(computeMetrics([null, null])).toMatchObject({ arp: null, atrp: 21, solv: 0 });
    expect(computeMetrics([])).toMatchObject({ arp: null, atrp: null, totalPoints: 0 });
  });
});

describe("summarizeCompetitors", () => {
  const biz = (key: string, rank: number) => ({ key, name: key.toUpperCase(), rank });

  it("scores each business over every point, counting absence as not found, best first", () => {
    const summary = summarizeCompetitors([
      [biz("a", 1), biz("b", 2)],
      [biz("a", 1), biz("b", 3)],
      [biz("b", 1)],
      [biz("c", 1)],
    ]);
    // ATRP: b 6.75, a 11, c 16
    expect(summary.map((s) => s.key)).toEqual(["b", "a", "c"]);
    const a = summary.find((s) => s.key === "a")!;
    const b = summary.find((s) => s.key === "b")!;
    expect(a).toMatchObject({ foundPoints: 2, totalPoints: 4, solv: 50, arp: 1 });
    expect(a.atrp).toBe((1 + 1 + 21 + 21) / 4);
    expect(b.solv).toBe(75);
  });

  it("keeps the better rank when a SERP lists a business twice", () => {
    const [only] = summarizeCompetitors([[biz("a", 5), biz("a", 2)]]);
    expect(only.arp).toBe(2);
  });
});

describe("diffMetrics", () => {
  it("returns per-metric deltas and null when a side is missing", () => {
    const cur = computeMetrics([1, 2, 3, 4]);
    const prev = computeMetrics([5, 6, null, null]);
    const d = diffMetrics(cur, prev);
    expect(d.atrp).toBeLessThan(0); // lower ATRP is better
    expect(d.solv).toBeGreaterThan(0);
    expect(diffMetrics(computeMetrics([null]), computeMetrics([1])).arp).toBeNull();
  });
});
