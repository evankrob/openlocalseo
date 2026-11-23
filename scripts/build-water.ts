// Builds src/worker/skip/water-data.ts, the bundled water dataset behind the
// "skip points on water" rule. Reproducible: run `npm run build:water`.
//
//   1. downloads Natural Earth 10m ocean + lakes + North America lakes (public
//      domain, https://www.naturalearthdata.com/) into build/water-src/ (git-ignored)
//   2. mapshaper merges them into one water polygon layer (dissolve = union) and
//      simplifies it (Douglas-Peucker, SIMPLIFY_M)
//   3. the polygons are cut into 2 degree cells with a margin, quantized to
//      1/10,000 degree and delta-coded (format and reader: src/shared/skip/water.ts)
//   4. the bytes are written base64-encoded so the Worker bundles them as one string
//
// Rivers: Natural Earth 10m rivers are centre lines, not polygons, so rivers are
// not part of the dataset: a narrow river never causes a skip.
// Lakes smaller than MIN_LAKE_KM2 are dropped: a point must be 500 m from the
// shore to be skipped, so a lake narrower than ~1 km can never skip anything.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  CELL_LAND,
  CELL_MIXED,
  CELL_WATER,
  WATER_CELL_DEG,
  WATER_COLS,
  WATER_COORD_SCALE,
  WATER_MARGIN_DEG,
  WATER_ROWS,
  encodeWater,
  type WaterCell,
} from "../src/shared/skip/water";

const SOURCES = ["ne_10m_ocean", "ne_10m_lakes", "ne_10m_lakes_north_america"] as const;
const BASE_URL = "https://naciscdn.org/naturalearth/10m/physical";
const SIMPLIFY_M = Number(process.env.SIMPLIFY_M ?? 500);
const MIN_LAKE_KM2 = 1;

const root = join(import.meta.dirname, "..");
const dir = join(root, "build", "water-src");
const mapshaper = join(root, "node_modules", ".bin", "mapshaper");

type Pt = [number, number];

function download(): Record<string, string> {
  mkdirSync(dir, { recursive: true });
  const hashes: Record<string, string> = {};
  for (const name of SOURCES) {
    const file = join(dir, `${name}.zip`);
    if (!existsSync(file)) execFileSync("curl", ["-fsSL", "--max-time", "300", "-o", file, `${BASE_URL}/${name}.zip`], { stdio: "inherit" });
    hashes[name] = createHash("sha256").update(readFileSync(file)).digest("hex");
  }
  return hashes;
}

function mergeAndSimplify(): Pt[][] {
  const out = join(dir, "water.json");
  const zip = (n: string) => join(dir, `${n}.zip`);
  execFileSync(
    mapshaper,
    [
      "-i", zip("ne_10m_ocean"), "name=ocean",
      "-i", zip("ne_10m_lakes"), "name=lakes",
      "-i", zip("ne_10m_lakes_north_america"), "name=lakes_na",
      "-filter", `$.area > ${MIN_LAKE_KM2 * 1e6}`, "target=lakes,lakes_na",
      "-filter-fields", "target=*",
      "-merge-layers", "target=*", "name=water",
      "-dissolve",
      "-simplify", "dp", `interval=${SIMPLIFY_M}m`, "keep-shapes",
      "-o", out, "format=geojson", "precision=0.0001", "force",
    ],
    { stdio: "inherit" },
  );
  type Geometry = { type: "Polygon" | "MultiPolygon"; coordinates: unknown };
  const geo = JSON.parse(readFileSync(out, "utf8")) as
    | { type: "FeatureCollection"; features: Array<{ geometry: Geometry }> }
    | { type: "GeometryCollection"; geometries: Geometry[] };
  const geometries = geo.type === "FeatureCollection" ? geo.features.map((f) => f.geometry) : geo.geometries;
  const rings: Pt[][] = [];
  for (const geometry of geometries) {
    const polygons = (geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates) as Pt[][][];
    for (const polygon of polygons) for (const ring of polygon) rings.push(ring.slice(0, -1));
  }
  return rings;
}

// ---- clipping -------------------------------------------------------------------

type Rect = { x0: number; y0: number; x1: number; y1: number };

/** Sutherland-Hodgman against one axis-aligned half plane. */
function clipEdge(ring: Pt[], inside: (p: Pt) => boolean, cut: (a: Pt, b: Pt) => Pt): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[(i + ring.length - 1) % ring.length] as Pt;
    const b = ring[i] as Pt;
    const aIn = inside(a);
    const bIn = inside(b);
    if (bIn) {
      if (!aIn) out.push(cut(a, b));
      out.push(b);
    } else if (aIn) out.push(cut(a, b));
  }
  return out;
}

function clipRing(ring: Pt[], r: Rect): Pt[] {
  let out = ring;
  const atX = (x: number) => (a: Pt, b: Pt): Pt => [x, a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0])];
  const atY = (y: number) => (a: Pt, b: Pt): Pt => [a[0] + ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]), y];
  out = clipEdge(out, (p) => p[0] >= r.x0, atX(r.x0));
  if (out.length) out = clipEdge(out, (p) => p[0] <= r.x1, atX(r.x1));
  if (out.length) out = clipEdge(out, (p) => p[1] >= r.y0, atY(r.y0));
  if (out.length) out = clipEdge(out, (p) => p[1] <= r.y1, atY(r.y1));
  return out;
}

const area = (ring: Pt[]) => {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i] as Pt;
    const b = ring[j] as Pt;
    sum += (b[0] + a[0]) * (b[1] - a[1]);
  }
  return Math.abs(sum / 2);
};

const cells = new Map<number, WaterCell>();
let landCells = 0;
let waterCells = 0;

function setRegion(c0: number, c1: number, r0: number, r1: number, state: typeof CELL_LAND | typeof CELL_WATER) {
  for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) if (state === CELL_WATER) cells.set(r * WATER_COLS + c, { state });
  if (state === CELL_WATER) waterCells += (c1 - c0) * (r1 - r0);
  else landCells += (c1 - c0) * (r1 - r0);
}

/** Cuts `rings` (already clipped to the parent's rect) down to the region's cells. */
function tile(rings: Pt[][], c0: number, c1: number, r0: number, r1: number) {
  const rect: Rect = {
    x0: -180 + c0 * WATER_CELL_DEG - WATER_MARGIN_DEG,
    x1: -180 + c1 * WATER_CELL_DEG + WATER_MARGIN_DEG,
    y0: -90 + r0 * WATER_CELL_DEG - WATER_MARGIN_DEG,
    y1: -90 + r1 * WATER_CELL_DEG + WATER_MARGIN_DEG,
  };
  const rectArea = (rect.x1 - rect.x0) * (rect.y1 - rect.y0);
  const clipped = rings.map((ring) => clipRing(ring, rect)).filter((ring) => ring.length >= 3 && area(ring) > 1e-10);
  // Rings that cover the whole rect flip the inside/outside parity; anything else is real edges.
  const full = clipped.filter((ring) => area(ring) >= rectArea * (1 - 1e-9));
  const partial = clipped.filter((ring) => area(ring) < rectArea * (1 - 1e-9));
  if (partial.length === 0) {
    setRegion(c0, c1, r0, r1, full.length % 2 === 1 ? CELL_WATER : CELL_LAND);
    return;
  }
  if (c1 - c0 === 1 && r1 - r0 === 1) {
    const quantized = partial
      .map((ring) => {
        const q: number[][] = [];
        for (const [x, y] of ring) {
          const p = [Math.round(x * WATER_COORD_SCALE), Math.round(y * WATER_COORD_SCALE)];
          const last = q[q.length - 1];
          if (!last || last[0] !== p[0] || last[1] !== p[1]) q.push(p);
        }
        const first = q[0];
        const end = q[q.length - 1];
        if (first && end && first[0] === end[0] && first[1] === end[1]) q.pop();
        return q;
      })
      .filter((ring) => ring.length >= 3);
    // Parity of full-rect rings is kept as an extra ring so even-odd stays right.
    if (full.length % 2 === 1) {
      const x0 = Math.round(rect.x0 * WATER_COORD_SCALE);
      const x1 = Math.round(rect.x1 * WATER_COORD_SCALE);
      const y0 = Math.round(rect.y0 * WATER_COORD_SCALE);
      const y1 = Math.round(rect.y1 * WATER_COORD_SCALE);
      quantized.push([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
    }
    cells.set(r0 * WATER_COLS + c0, { state: CELL_MIXED, rings: quantized });
    return;
  }
  // Keep the full-rect rings with the pieces: a child region may be fully inside or outside them.
  const all = [...full, ...partial];
  if (c1 - c0 >= r1 - r0) {
    const mid = Math.floor((c0 + c1) / 2);
    tile(all, c0, mid, r0, r1);
    tile(all, mid, c1, r0, r1);
  } else {
    const mid = Math.floor((r0 + r1) / 2);
    tile(all, c0, c1, r0, mid);
    tile(all, c0, c1, mid, r1);
  }
}

function main() {
  const hashes = download();
  const rings = mergeAndSimplify();
  console.log(`simplified water: ${rings.length} rings, ${rings.reduce((n, r) => n + r.length, 0)} vertices`);
  tile(rings, 0, WATER_COLS, 0, WATER_ROWS);
  const bytes = encodeWater(cells);
  let stored = 0;
  let storedRings = 0;
  for (const c of cells.values()) {
    for (const r of c.rings ?? []) {
      stored += r.length;
      storedRings++;
    }
  }
  console.log(`stored vertices: ${stored} in ${storedRings} rings (${(bytes.length / stored).toFixed(1)} bytes per vertex)`);
  const gz = gzipSync(bytes, { level: 9 });
  const b64 = Buffer.from(bytes).toString("base64");
  const mixed = [...cells.values()].filter((c) => c.state === CELL_MIXED).length;
  const header = [
    "// GENERATED by scripts/build-water.ts (npm run build:water). Do not edit by hand.",
    "// Source: Natural Earth 10m ocean, lakes and North America lakes (public domain, naturalearthdata.com).",
    ...Object.entries(hashes).map(([name, sha]) => `//   ${name}.zip sha256 ${sha}`),
    `// Simplified to ${SIMPLIFY_M} m, lakes under ${MIN_LAKE_KM2} km2 dropped, ${WATER_CELL_DEG} degree cells with a ${WATER_MARGIN_DEG} degree margin.`,
    `// ${bytes.length} bytes raw, ${gz.length} bytes gzipped; ${mixed} coastal cells, ${waterCells} open-water cells, ${landCells} land cells.`,
    "",
  ].join("\n");
  const file = join(root, "src", "worker", "skip", "water-data.ts");
  writeFileSync(file, `${header}export const WATER_DATA_B64 =\n  "${b64}";\n`);
  const tsBytes = Buffer.byteLength(readFileSync(file, "utf8"));
  console.log(`wrote ${file}`);
  console.log(`binary: ${bytes.length} bytes raw, ${gz.length} bytes gzipped; module text ${tsBytes} bytes, gzipped ${gzipSync(readFileSync(file), { level: 9 }).length}`);
  console.log(`cells: ${mixed} coastal, ${waterCells} open water, ${landCells} land`);
}

main();
