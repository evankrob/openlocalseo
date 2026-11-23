import { describe, expect, it } from "vitest";
import { at } from "./assert";
import {
  MAX_PINNED,
  assignIdentities,
  buildCandidates,
  classifyHeadToHead,
  countHeadToHead,
  findPossibleDuplicates,
  nameSimilarity,
  normalizePhone,
  selectCompetitors,
  topPerPoint,
  type OverlayRow,
} from "./overlay";

let seq = 0;
const row = (pointId: string, rank: number, over: Partial<OverlayRow> = {}): OverlayRow => ({
  id: `r${++seq}`,
  pointId,
  rank,
  name: `Biz ${over.placeId ?? over.cid ?? seq}`,
  placeId: null,
  cid: null,
  domain: null,
  phone: null,
  rating: null,
  ratingCount: null,
  category: null,
  address: null,
  isTarget: false,
  ...over,
});
const client = { name: "Client Cafe", domain: "client.example" };
const POINTS = ["a", "b", "c", "d"];

/** Rows for one business: ranks per point (null = absent). */
const biz = (placeId: string, ranks: Array<number | null>, over: Partial<OverlayRow> = {}) =>
  ranks.flatMap((rank, i) => (rank === null ? [] : [row(at(POINTS, i), rank, { placeId, name: placeId, ...over })]));

describe("default top 5", () => {
  const rows = [
    ...biz("alpha", [1, 2, 3, 20]), // 3 top-3, atrp 6.5
    ...biz("bravo", [1, 1, 1, null]), // 3 top-3, atrp 6 -> beats alpha on the tie-break
    ...biz("charlie", [2, 2, null, null]), // 2 top-3
    ...biz("delta", [3, 3, 9, 9]), // 2 top-3, atrp 6 -> beats charlie
    ...biz("echo", [5, 6, 7, 8]), // 0
    ...biz("foxtrot", [4, 4, 4, 4]), // 0, atrp 4 -> beats echo
    ...biz("golf", [10, null, null, null]),
  ];
  const { candidates } = buildCandidates(rows, POINTS, client);
  const names = (list: Array<{ name: string }>) => list.map((c) => c.name);

  it("ranks by top-3 appearances, ties by average rank with not-found = 21", () => {
    expect(names(candidates)).toEqual(["bravo", "alpha", "delta", "charlie", "foxtrot", "echo", "golf"]);
    expect(at(candidates, 0).metrics).toMatchObject({ top3Points: 3, atrp: 6 });
    // alpha: (1+2+3+20)/4 = 6.5
    expect(candidates.find((c) => c.name === "alpha")?.metrics.atrp).toBe(6.5);
  });

  it("shows the top 5 by default", () => {
    const shown = selectCompetitors(candidates, { pinned: [], hidden: [] });
    expect(names(shown)).toEqual(["bravo", "alpha", "delta", "charlie", "foxtrot"]);
    expect(shown.every((s) => s.source === "default")).toBe(true);
  });

  it("hiding one lets the next best take its place; pinning adds beyond five", () => {
    const shown = selectCompetitors(candidates, { pinned: [{ identity: "p:golf", name: "golf" }], hidden: [{ identity: "p:alpha", name: "alpha" }] });
    expect(names(shown)).toEqual(["bravo", "delta", "charlie", "foxtrot", "echo", "golf"]);
    expect(shown.map((s) => s.source)).toEqual(["default", "default", "default", "default", "default", "pinned"]);
  });

  it("a pinned business stays shown even if it is also marked hidden", () => {
    const both = { identity: "p:golf", name: "golf" };
    expect(names(selectCompetitors(candidates, { pinned: [both], hidden: [both] }))).toContain("golf");
  });

  it("the pin limit constant is 10", () => expect(MAX_PINNED).toBe(10));
});

describe("excluding the client and its duplicates", () => {
  const rows = [
    ...biz("client-place", [1, 1, 2, 3], { name: "Client Cafe", phone: "(919) 555-0100", isTarget: true }),
    // a second listing of the client: same phone, nearly the same name
    ...biz("client-old", [2, 2, 1, 4], { name: "Client Café LLC", phone: "+1 919-555-0100" }),
    // same website as the client, different phone and name
    ...biz("client-web", [5, 5, 5, 5], { name: "Totally Different Name", domain: "www.client.example/menu" }),
    // same name as the client but another phone: a different shop, stays
    ...biz("namesake", [3, 3, 3, 5], { name: "Client Cafe", phone: "(919) 555-9999" }),
    ...biz("rival", [4, 4, 4, 2], { name: "Rival Roasters", phone: "(919) 555-0123" }),
  ];
  const set = buildCandidates(rows, POINTS, client);

  it("drops the client's own listing, its duplicate and its website", () => {
    expect(set.candidates.map((c) => c.name).sort()).toEqual(["Client Cafe", "Rival Roasters"]);
    expect(set.candidates.find((c) => c.name === "Client Cafe")?.identity).toBe("p:namesake");
    expect(set.excluded).toEqual([
      { name: "Client Cafe", reason: "client" },
      { name: "Client Café LLC", reason: "duplicate_of_client" },
      { name: "Totally Different Name", reason: "same_website" },
    ]);
  });
});

describe("matching across points", () => {
  it("matches by place id, and a cid-only row joins the place id of the same cid", () => {
    const rows = [
      row("a", 1, { placeId: "pp", cid: "cc", name: "Roasters" }),
      row("b", 2, { cid: "cc", name: "Roasters (cid only)" }),
      row("c", 3, { placeId: "pp", name: "Roasters" }),
      row("a", 4, { cid: "other", name: "Cid Only Shop" }),
      row("b", 5, { cid: "other", name: "Cid Only Shop" }),
    ];
    const ids = assignIdentities(rows);
    expect(rows.map((r) => ids.get(r.id))).toEqual(["p:pp", "p:pp", "p:pp", "c:other", "c:other"]);
    const { candidates } = buildCandidates(rows, POINTS, client);
    expect(candidates.find((c) => c.identity === "p:pp")?.ranks).toEqual([1, 2, 3, null]);
    expect(candidates.find((c) => c.identity === "c:other")?.metrics.foundPoints).toBe(2);
  });

  it("never merges by name: same-name results with no place id or cid stay separate and are not selectable", () => {
    const rows = [
      row("a", 1, { name: "Joe's Coffee" }),
      row("b", 1, { name: "Joe's Coffee" }),
      row("c", 1, { name: "Joe's Coffee" }),
      row("a", 2, { placeId: "real", name: "Joe's Coffee" }), // a real listing with that name is a different business
    ];
    const ids = [...assignIdentities(rows).values()];
    expect(new Set(ids).size).toBe(4);
    expect(ids.filter((i) => i.startsWith("r:"))).toHaveLength(3);
    const set = buildCandidates(rows, POINTS, client);
    expect(set.candidates.map((c) => c.identity)).toEqual(["p:real"]);
    expect(at(set.candidates, 0).metrics.foundPoints).toBe(1);
    expect(set.unmatchedResults).toBe(3);
  });

  it("keeps the best rank when one SERP lists a business twice", () => {
    const rows = [row("a", 7, { placeId: "dup" }), row("a", 3, { placeId: "dup" })];
    expect(at(buildCandidates(rows, POINTS, client).candidates, 0).ranks).toEqual([3, null, null, null]);
  });
});

describe("possible duplicates", () => {
  const l = (identity: string, name: string, phone: string | null) => ({ identity, name, phone });
  it("normalises names and phones", () => {
    expect(nameSimilarity("Appliance Workcenter", "Appliance Work Center")).toBe(1);
    expect(nameSimilarity("Appliance Workcenter", "Bluebird Bakery")).toBeLessThan(0.4);
    expect(normalizePhone("+1 (919) 555-0100")).toBe("9195550100");
    expect(normalizePhone("555-0100")).toBe("5550100");
    expect(normalizePhone("12")).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });

  it("flags near-identical names that share a phone, in both directions", () => {
    const flags = findPossibleDuplicates([
      l("p:1", "Appliance Workcenter", "(919) 555-0188"),
      l("p:2", "Appliance Work Center", "+19195550188"),
      l("p:3", "Appliance Work Centre Inc", "(919) 555-0188"),
    ]);
    expect(flags.get("p:1")).toEqual(["Appliance Work Center", "Appliance Work Centre Inc"]);
    expect(flags.get("p:2")).toContain("Appliance Workcenter");
  });

  it("does not flag a similar name with another phone, the same phone with a different name, or a missing phone", () => {
    const flags = findPossibleDuplicates([
      l("p:1", "Appliance Workcenter", "(919) 555-0188"),
      l("p:2", "Appliance Work Center", "(919) 555-0199"),
      l("p:3", "Pine Street Dental", "(919) 555-0188"),
      l("p:4", "Appliance Work Center", null),
    ]);
    expect(flags.size).toBe(0);
  });

  it("is a flag only: both listings stay separate competitors", () => {
    const rows = [
      ...biz("w1", [1, 1, 1, 1], { name: "Appliance Workcenter", phone: "(919) 555-0188" }),
      ...biz("w2", [2, 2, 2, 2], { name: "Appliance Work Center", phone: "(919) 555-0188" }),
    ];
    const { candidates } = buildCandidates(rows, POINTS, client);
    expect(candidates).toHaveLength(2);
    expect(candidates.map((c) => c.possibleDuplicateOf)).toEqual([["Appliance Work Center"], ["Appliance Workcenter"]]);
  });
});

describe("head to head", () => {
  it("classifies win / loss / tie / neither, not found counting as 21", () => {
    expect(classifyHeadToHead(2, 5)).toBe("win");
    expect(classifyHeadToHead(7, 3)).toBe("loss");
    expect(classifyHeadToHead(4, 4)).toBe("tie");
    expect(classifyHeadToHead(null, null)).toBe("neither");
    expect(classifyHeadToHead(25, 0)).toBe("neither"); // outside the tracked depth = not found
    expect(classifyHeadToHead(20, null)).toBe("win"); // found at 20 beats not found
    expect(classifyHeadToHead(null, 20)).toBe("loss");
  });

  it("counts per point and per-competitor metrics over the same points", () => {
    const clientRanks = [1, 5, null, 3, null];
    const competitorRanks = [2, 5, 4, null, null];
    expect(countHeadToHead(clientRanks, competitorRanks)).toEqual({ wins: 2, losses: 1, ties: 1, neither: 1 });

    const rows = biz("rival", [2, 5, 4, null], { name: "Rival" });
    const [rival] = buildCandidates(rows, POINTS, client).candidates;
    expect(rival?.metrics).toMatchObject({ arp: 3.67, atrp: 8, solv: 25, foundPoints: 3, top3Points: 1, totalPoints: 4 });
  });
});

describe("top businesses per point", () => {
  it("lists the best 5 per point by rank, aligned with the point order", () => {
    const rows = [1, 2, 3, 4, 5, 6, 7].map((rank) => row("b", rank, { placeId: `x${rank}`, name: `N${rank}` }));
    rows.push(row("a", 1, { placeId: "me", name: "Me", isTarget: true }));
    const top = topPerPoint(rows, ["a", "b", "c"]);
    expect(top[0]).toEqual([{ rank: 1, name: "Me", isTarget: true }]);
    expect(top[1]?.map((e) => e.name)).toEqual(["N1", "N2", "N3", "N4", "N5"]);
    expect(top[2]).toEqual([]);
  });
});
