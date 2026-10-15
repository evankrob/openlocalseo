// Deterministic simulated "market" for the mock provider: a set of fictional
// businesses around a center, and a ranking model where proximity and
// prominence decide who shows up first at a given searcher location. Same
// inputs always give the same results, so history, tests and screenshots
// are reproducible.
import { haversineKm } from "@/shared/grid";
import type { MockHints } from "./types";

export type WorldBusiness = {
  name: string;
  placeId: string;
  cid: string;
  domain: string;
  lat: number;
  lng: number;
  rating: number;
  ratingCount: number;
  category: string;
  address: string;
  /** 0-1: how strongly Google favors this business regardless of distance. */
  prominence: number;
};

export type DemoCenter = { lat: number; lng: number };

/** FNV-1a: a small stable string hash. */
export function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ADJECTIVES = ["Maple", "Copper", "Lantern", "Bluebird", "Juniper", "Harbor", "Willow", "Granite", "Saffron", "Cedar", "Marigold", "Foxglove", "Ironwood", "Pebble", "Sparrow", "Thistle", "Alder", "Ember", "Quartz", "Meadow"];
const NOUNS = ["Row", "& Pine", "Hollow", "Lane", "Works", "& Co.", "Street", "Corner", "House", "Yard", "Market", "Collective"];
const STREETS = ["Orchard St", "Mill Rd", "Harbor Ln", "Pine St", "Fictional Ave", "Station Way", "Birch Blvd", "Cooper Ct"];

function categoryFor(keyword: string): { category: string; noun: string } {
  const k = keyword.toLowerCase();
  if (/coffee|cafe|espresso|roast/.test(k)) return { category: "Coffee shop", noun: "Coffee" };
  if (/plumb/.test(k)) return { category: "Plumber", noun: "Plumbing" };
  if (/dent/.test(k)) return { category: "Dentist", noun: "Dental" };
  if (/pizza/.test(k)) return { category: "Pizza restaurant", noun: "Pizza" };
  if (/bak|bread/.test(k)) return { category: "Bakery", noun: "Bakery" };
  if (/lawyer|attorney/.test(k)) return { category: "Law firm", noun: "Legal" };
  return { category: "Business", noun: "Services" };
}

const WORLD_SIZE = 44;
const WORLD_RADIUS_KM = 14;

export function buildWorld(keyword: string, center: DemoCenter, hints?: MockHints): WorldBusiness[] {
  const { category, noun } = categoryFor(keyword);
  // Seed on keyword and a ~5 km cell so nearby centers share one market.
  const cell = `${Math.round(center.lat * 20)}:${Math.round(center.lng * 20)}`;
  const rand = mulberry32(hash32(`${keyword.toLowerCase().trim()}|${cell}`));
  const kmPerDegLng = 111.32 * Math.cos((center.lat * Math.PI) / 180);
  const world: WorldBusiness[] = [];
  const usedNames = new Set<string>();
  for (let i = 0; i < WORLD_SIZE; i++) {
    let name: string;
    do {
      name = `${ADJECTIVES[Math.floor(rand() * ADJECTIVES.length)]} ${NOUNS[Math.floor(rand() * NOUNS.length)]} ${noun}`;
    } while (usedNames.has(name));
    usedNames.add(name);
    // sqrt radius = uniform over the disc; slightly denser downtown via pow.
    const dist = WORLD_RADIUS_KM * Math.pow(rand(), 0.8);
    const angle = rand() * 2 * Math.PI;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const id = String(i + 1).padStart(4, "0");
    world.push({
      name,
      placeId: `ChIJdemo${cell.replace(/\W/g, "")}${id}`,
      cid: `${hash32(name)}${id}`.padEnd(19, "0"),
      domain: `${slug}.example`,
      lat: center.lat + (dist * Math.cos(angle)) / 111.32,
      lng: center.lng + (dist * Math.sin(angle)) / kmPerDegLng,
      rating: Math.round((3.6 + rand() * 1.3) * 10) / 10,
      ratingCount: Math.floor(20 + Math.pow(rand(), 2.2) * 1400),
      category,
      address: `${100 + Math.floor(rand() * 800)} ${STREETS[Math.floor(rand() * STREETS.length)]}, Fictionville, NC 27999`,
      prominence: 0.25 + rand() * 0.55,
    });
  }
  const target = hints?.target;
  if (target) {
    // Replace any generated business sharing the name or place id, then add the
    // tracked business with a fixed solid prominence.
    const filtered = world.filter((b) => b.name !== target.name && b.placeId !== target.placeId);
    filtered.push({
      name: target.name,
      placeId: target.placeId ?? `ChIJtarget${hash32(target.name)}`,
      cid: `${hash32(`cid:${target.name}`)}`.padEnd(19, "7"),
      domain: target.domain ?? `${target.name.toLowerCase().replace(/[^a-z0-9]+/g, "")}.example`,
      lat: target.lat,
      lng: target.lng,
      rating: 4.8,
      ratingCount: 412,
      category,
      address: "101 Fictional Ave, Fictionville, NC 27999",
      prominence: target.prominence ?? 0.62,
    });
    return filtered;
  }
  return world;
}

/** Businesses in the order Google would list them for a searcher at `point`. */
export function rankWorldAt(
  world: WorldBusiness[],
  point: { lat: number; lng: number },
  keyword: string,
  depth: number,
): WorldBusiness[] {
  const scored = world.map((b) => {
    const dist = haversineKm(point, b);
    const noise = (mulberry32(hash32(`${keyword}|${point.lat.toFixed(4)},${point.lng.toFixed(4)}|${b.placeId}`))() - 0.5) * 0.18;
    // Prominence matters, but distance decays the score quickly.
    const score = b.prominence - 0.16 * Math.pow(dist, 0.9) + noise;
    return { b, score, dist };
  });
  return scored
    .filter((s) => s.dist <= 12)
    .sort((a, b) => b.score - a.score)
    .slice(0, depth)
    .map((s) => s.b);
}
