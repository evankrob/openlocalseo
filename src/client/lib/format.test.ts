import { describe, expect, it } from "vitest";
import { chargeLabel, scanBreakdown } from "./format";

const quote = { points: 49, queueMode: "standard", chargedUsd: 0.0753, credits: 49 };

describe("scan cost labels", () => {
  it("hosted shows credits and marked-up USD", () => {
    expect(chargeLabel(quote, "hosted")).toBe("49 credits ($0.0753)");
  });
  it("BYOK shows the USD estimate only", () => {
    expect(chargeLabel({ chargedUsd: 0.0294, credits: 0 }, "byok")).toBe("~$0.0294");
  });
  it("breakdown names points, queue and the hosted balance", () => {
    expect(scanBreakdown(quote, "hosted", 1200)).toBe("49 points (7x7) on the standard queue. Held now, settled at the real cost. Balance: 1,200 credits.");
    expect(scanBreakdown(quote, "hosted", null)).not.toContain("Balance");
  });
  it("BYOK breakdown is flagged as an upper bound", () => {
    expect(scanBreakdown(quote, "byok")).toContain("Upper-bound DataForSEO estimate");
  });
  it("BYOK wording does not claim the real cost is lower", () => {
    expect(scanBreakdown(quote, "byok")).toBe("49 points (7x7) on the standard queue. Upper-bound DataForSEO estimate; the real cost is recorded per call.");
  });
  it("mock data mode says nothing is charged", () => {
    expect(scanBreakdown(quote, "byok", null, "mock")).toMatch(/ Mock data: nothing is charged\.$/);
    expect(scanBreakdown(quote, "hosted", 5, "mock")).toMatch(/Balance: 5 credits\. Mock data: nothing is charged\.$/);
    expect(scanBreakdown(quote, "byok", null, "live")).not.toContain("Mock");
  });
});
