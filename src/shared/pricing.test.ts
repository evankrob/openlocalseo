import { describe, expect, it } from "vitest";
import { applyMarkupUsd, creditsForProviderUsd, estimateScanCostUsd } from "./pricing";

describe("scan cost estimates (SCOPE.md section 3 cost math)", () => {
  it("matches the published per-scan figures", () => {
    expect(estimateScanCostUsd(49, "standard")).toBe(0.0294);
    expect(estimateScanCostUsd(169, "standard")).toBe(0.1014);
    expect(estimateScanCostUsd(49, "priority")).toBe(0.0588);
    expect(estimateScanCostUsd(169, "priority")).toBe(0.2028);
    expect(estimateScanCostUsd(49, "live")).toBe(0.098);
    expect(estimateScanCostUsd(169, "live")).toBe(0.338);
  });
});

describe("hosted cost-plus billing", () => {
  it("applies the 28% markup and ceils to whole credits (1000 credits = $1)", () => {
    expect(applyMarkupUsd(0.1014)).toBe(0.129792);
    expect(creditsForProviderUsd(0.1014)).toBe(130);
    expect(creditsForProviderUsd(0.1014, 1)).toBe(102);
  });
});
