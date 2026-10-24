import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { rankLabel, rankTier } from "./rank";
import { at } from "@/shared/assert";

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

describe("heat map palette", () => {
  const css = readFileSync(new URL("../client/styles/app.css", import.meta.url), "utf8");
  const lum = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * at(c, 0) + 0.7152 * at(c, 1) + 0.0722 * at(c, 2);
  };
  const ratio = (a: string, b: string) => { const sorted = [lum(a), lum(b)].sort((m, n) => n - m); const x = at(sorted, 0); const y = at(sorted, 1); return (x + 0.05) / (y + 0.05); };
  const vars = Object.fromEntries([...css.matchAll(/--(rank-[\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));
  const textFor = (tier: string) => css.match(new RegExp(`data-tier="${tier}"\\] \\{ background: var\\(--rank-[\\w]+\\); color: var\\(--(rank-text-(?:dark|light))\\)`))?.[1];

  it("goes green to red and every tier's number meets WCAG AA contrast", () => {
    expect([vars["rank-1"], vars["rank-2"], vars["rank-3"], vars["rank-4"], vars["rank-none"]]).toEqual(["#15803d", "#84cc16", "#facc15", "#f97316", "#dc2626"]);
    for (const tier of ["1", "2", "3", "4", "none"]) {
      const text = textFor(tier);
      expect(text, `tier ${tier} text colour`).toBeTruthy();
      expect(ratio(vars[tier === "none" ? "rank-none" : `rank-${tier}`], vars[text!]), `tier ${tier}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
