import { describe, expect, it } from "vitest";
import { businessKey, isTargetBusiness } from "./match";
import type { MapResult } from "../dataforseo/types";

const item = (over: Partial<MapResult> = {}): MapResult => ({
  rank: 1, name: "Maple & Ember Coffee Roasters", placeId: "p1", cid: "c1", domain: "mapleember.example",
  rating: 4.8, ratingCount: 10, category: null, address: null, ...over,
});

describe("isTargetBusiness", () => {
  it("uses place id / cid exactly when known, even if the name matches another listing", () => {
    const biz = { name: "Maple & Ember Coffee Roasters", placeId: "p1", cid: null, domain: null };
    expect(isTargetBusiness(item(), biz)).toBe(true);
    // same name and domain, different location (a chain): not the tracked business
    expect(isTargetBusiness(item({ placeId: "p2", cid: "c2" }), biz)).toBe(false);
    expect(isTargetBusiness(item({ placeId: null, cid: "c9" }), { ...biz, placeId: null, cid: "c9" })).toBe(true);
  });

  it("falls back to domain, ignoring www and scheme, then to a punctuation-insensitive name", () => {
    const base = { placeId: null, cid: null };
    expect(isTargetBusiness(item({ placeId: "x", domain: "www.MapleEmber.example" }), { ...base, name: "Other", domain: "https://mapleember.example/" })).toBe(true);
    expect(isTargetBusiness(item({ domain: null }), { ...base, name: "maple ember coffee roasters", domain: null })).toBe(true);
    expect(isTargetBusiness(item({ domain: "else.example", name: "Else Cafe" }), { ...base, name: "Maple Ember", domain: "mapleember.example" })).toBe(false);
  });
});

describe("businessKey", () => {
  it("prefers place id, then cid, then a normalized name", () => {
    expect(businessKey(item())).toBe("p1");
    expect(businessKey(item({ placeId: null }))).toBe("c1");
    expect(businessKey(item({ placeId: null, cid: null }))).toBe("name:mapleembercoffeeroasters");
  });
});
