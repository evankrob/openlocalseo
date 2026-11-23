// Water lookup over the compact Natural Earth (ocean + lakes, 10m) dataset that
// scripts/build-water.ts writes to src/worker/skip/water-data.ts.
//
// The world is cut into 2 degree cells. A cell is land (no water polygon
// reaches it), open water (water everywhere, with a margin around the cell), or
// mixed: then it carries the water polygon pieces clipped to the cell plus a
// margin, as delta-coded integer rings. A point query touches one cell, so the
// cost per grid point is one small point-in-polygon plus one nearest-edge pass.
//
// The format lives here (encoder and decoder together) so a round trip is unit
// tested and the build script cannot drift from the reader.
import { distanceToRingsM, pointInRings, type LngLat, type Ring } from "./geo";

/** Cell edge in degrees. */
export const WATER_CELL_DEG = 2;
/** Water polygons are clipped to the cell grown by this margin, so edges just outside a cell still count. */
export const WATER_MARGIN_DEG = 0.05;
/** Coordinates are stored as integers of 1/WATER_COORD_SCALE degree (about 110 m). */
export const WATER_COORD_SCALE = 1e3;
export const WATER_COLS = 360 / WATER_CELL_DEG;
export const WATER_ROWS = 180 / WATER_CELL_DEG;
const FORMAT_VERSION = 1;

/**
 * A point on water is only skipped when it is farther than this from the
 * nearest shoreline polygon edge. Natural Earth 10m is drawn for 1:10,000,000
 * maps, so its coastline can be off by hundreds of metres and our simplification
 * adds up to ~250 m more; 500 m keeps every point a customer could stand at on
 * the shore (a beach, a pier, a causeway, a boat ramp) in the scan.
 */
export const SHORE_TOLERANCE_M = 750;

export const CELL_LAND = 0;
export const CELL_WATER = 1;
export const CELL_MIXED = 2;
export type CellState = typeof CELL_LAND | typeof CELL_WATER | typeof CELL_MIXED;

export type WaterCell = { state: CellState; rings?: number[][][] };

// ---- byte helpers -------------------------------------------------------------

class ByteWriter {
  private bytes: number[] = [];
  varint(value: number) {
    let v = value;
    while (v >= 0x80) {
      this.bytes.push((v % 0x80) | 0x80);
      v = Math.floor(v / 0x80);
    }
    this.bytes.push(v);
  }
  zigzag(value: number) {
    this.varint(value >= 0 ? value * 2 : -value * 2 - 1);
  }
  append(other: Uint8Array) {
    for (const b of other) this.bytes.push(b);
  }
  toBytes() {
    return Uint8Array.from(this.bytes);
  }
}

class ByteReader {
  pos = 0;
  constructor(private readonly bytes: Uint8Array) {}
  varint(): number {
    let result = 0;
    let scale = 1;
    for (;;) {
      const byte = this.bytes[this.pos++];
      if (byte === undefined) throw new Error("water data: unexpected end");
      result += (byte & 0x7f) * scale;
      if (byte < 0x80) return result;
      scale *= 0x80;
    }
  }
  zigzag(): number {
    const v = this.varint();
    return v % 2 === 0 ? v / 2 : -(v + 1) / 2;
  }
}

export const cellOrigin = (row: number, col: number) => ({
  x: Math.round((-180 + col * WATER_CELL_DEG) * WATER_COORD_SCALE),
  y: Math.round((-90 + row * WATER_CELL_DEG) * WATER_COORD_SCALE),
});

function encodeCell(row: number, col: number, rings: number[][][]): Uint8Array {
  const w = new ByteWriter();
  const origin = cellOrigin(row, col);
  w.varint(rings.length);
  for (const ring of rings) {
    w.varint(ring.length);
    let px = origin.x;
    let py = origin.y;
    for (const p of ring) {
      const x = p[0] ?? 0;
      const y = p[1] ?? 0;
      w.zigzag(x - px);
      w.zigzag(y - py);
      px = x;
      py = y;
    }
  }
  return w.toBytes();
}

/** Packs cells (keyed by row * WATER_COLS + col; missing = land) into the binary format. */
export function encodeWater(cells: ReadonlyMap<number, WaterCell>): Uint8Array {
  const runs: Array<[CellState, number]> = [];
  const data = new ByteWriter();
  const total = WATER_ROWS * WATER_COLS;
  for (let index = 0; index < total; index++) {
    const cell = cells.get(index);
    const state = cell?.state ?? CELL_LAND;
    const last = runs[runs.length - 1];
    if (last && last[0] === state) last[1]++;
    else runs.push([state, 1]);
    if (state === CELL_MIXED) {
      const payload = encodeCell(Math.floor(index / WATER_COLS), index % WATER_COLS, cell?.rings ?? []);
      data.varint(payload.length);
      data.append(payload);
    }
  }
  const out = new ByteWriter();
  out.varint(FORMAT_VERSION);
  out.varint(runs.length);
  for (const [state, count] of runs) {
    out.varint(state);
    out.varint(count);
  }
  out.append(data.toBytes());
  return out.toBytes();
}

// ---- reading --------------------------------------------------------------------

export type WaterClass = "land" | "shore" | "water";

export type WaterIndex = {
  /** `water` = on water and farther than `shoreToleranceM` from the shore: safe to skip. `shore` = on water but near the shore. */
  classify(point: { lat: number; lng: number }, shoreToleranceM?: number): WaterClass;
};

export function createWaterIndex(bytes: Uint8Array): WaterIndex {
  const reader = new ByteReader(bytes);
  if (reader.varint() !== FORMAT_VERSION) throw new Error("water data: unsupported version");
  const runCount = reader.varint();
  const runStart: number[] = [];
  const runState: CellState[] = [];
  const runMixedBefore: number[] = [];
  let cell = 0;
  let mixed = 0;
  for (let i = 0; i < runCount; i++) {
    const state = reader.varint() as CellState;
    const count = reader.varint();
    runStart.push(cell);
    runState.push(state);
    runMixedBefore.push(mixed);
    cell += count;
    if (state === CELL_MIXED) mixed += count;
  }
  if (cell !== WATER_ROWS * WATER_COLS) throw new Error("water data: cell count mismatch");

  // Byte offset of each mixed cell's payload, found by walking the length prefixes once.
  const offsets = new Uint32Array(mixed);
  const lengths = new Uint32Array(mixed);
  for (let i = 0; i < mixed; i++) {
    const length = reader.varint();
    offsets[i] = reader.pos;
    lengths[i] = length;
    reader.pos += length;
  }

  const cache = new Map<number, Ring[]>();
  const decode = (mixedIndex: number, row: number, col: number): Ring[] => {
    const cached = cache.get(mixedIndex);
    if (cached) return cached;
    const r = new ByteReader(bytes);
    r.pos = offsets[mixedIndex] ?? 0;
    const origin = cellOrigin(row, col);
    const rings: Ring[] = [];
    const ringCount = r.varint();
    for (let i = 0; i < ringCount; i++) {
      const n = r.varint();
      const ring: LngLat[] = [];
      let x = origin.x;
      let y = origin.y;
      for (let k = 0; k < n; k++) {
        x += r.zigzag();
        y += r.zigzag();
        ring.push([x / WATER_COORD_SCALE, y / WATER_COORD_SCALE]);
      }
      rings.push(ring);
    }
    cache.set(mixedIndex, rings);
    return rings;
  };

  const runAt = (cellIndex: number): number => {
    let lo = 0;
    let hi = runStart.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((runStart[mid] ?? 0) <= cellIndex) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  return {
    classify(point, shoreToleranceM = SHORE_TOLERANCE_M) {
      const row = Math.min(WATER_ROWS - 1, Math.max(0, Math.floor((point.lat + 90) / WATER_CELL_DEG)));
      const col = Math.min(WATER_COLS - 1, Math.max(0, Math.floor((point.lng + 180) / WATER_CELL_DEG)));
      const index = row * WATER_COLS + col;
      const run = runAt(index);
      const state = runState[run];
      if (state === CELL_LAND) return "land";
      if (state === CELL_WATER) return "water";
      const mixedIndex = (runMixedBefore[run] ?? 0) + (index - (runStart[run] ?? 0));
      const rings = decode(mixedIndex, row, col);
      if (!pointInRings(point.lng, point.lat, rings)) return "land";
      return distanceToRingsM(point, rings, shoreToleranceM) <= shoreToleranceM ? "shore" : "water";
    },
  };
}

export function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
