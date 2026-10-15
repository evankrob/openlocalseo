import { describe, expect, it } from "vitest";
import { rankLabel, rankTier } from "./rank";

describe("rank display", () => {
  it("buckets ranks into four tiers plus not-found, with no gaps", () => {
    expect([1, 3, 4, 7, 8, 12, 13, 20].map(rankTier)).toEqual(["1", "1", "2", "2", "3", "3", "4", "4"]);
    expect([null, undefined, 21, 0].map(rankTier)).toEqual(["none", "none", "none", "none"]);
  });
  it("prints 20+ for anything not found", () => {
    expect(rankLabel(null)).toBe("20+");
    expect(rankLabel(9)).toBe("9");
  });
});
