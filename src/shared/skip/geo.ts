// Small planar geometry helpers for the skip rules. Everything works on
// [lng, lat] pairs (GeoJSON order) and measures distances in metres with a
// local equirectangular projection around the query point, which is accurate to
// well under 1% over the few kilometres these checks look at.

export type LngLat = readonly [number, number];
export type Ring = readonly LngLat[];

const METRES_PER_DEGREE_LAT = 111_320;

export type GeoPolygon = { type: "Polygon"; coordinates: LngLat[][] };
export type GeoMultiPolygon = { type: "MultiPolygon"; coordinates: LngLat[][][] };
export type GeoShape = GeoPolygon | GeoMultiPolygon;

/** Metres east / north of `origin` for a nearby coordinate. */
export function toLocalMetres(origin: { lat: number; lng: number }, lng: number, lat: number): [number, number] {
  const metresPerDegreeLng = METRES_PER_DEGREE_LAT * Math.cos((origin.lat * Math.PI) / 180);
  return [(lng - origin.lng) * metresPerDegreeLng, (lat - origin.lat) * METRES_PER_DEGREE_LAT];
}

/** Even-odd ray cast against every ring of one polygon (outer ring and holes together). */
export function pointInRings(lng: number, lat: number, rings: readonly Ring[]): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i];
      const b = ring[j];
      if (!a || !b) continue;
      if (a[1] > lat !== b[1] > lat && lng < ((b[0] - a[0]) * (lat - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
  }
  return inside;
}

/** Distance in metres from the origin to the segment a-b (both already in local metres). */
function distanceToSegment(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSquared));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

/** Shortest distance in metres from `point` to any edge of the rings (Infinity for no edges). */
export function distanceToRingsM(point: { lat: number; lng: number }, rings: readonly Ring[], stopBelowM = 0): number {
  let best = Infinity;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i];
      const b = ring[j];
      if (!a || !b) continue;
      const [ax, ay] = toLocalMetres(point, a[0], a[1]);
      const [bx, by] = toLocalMetres(point, b[0], b[1]);
      const d = distanceToSegment(ax, ay, bx, by);
      if (d < best) {
        best = d;
        if (best <= stopBelowM) return best;
      }
    }
  }
  return best;
}

export function polygonsOf(shape: GeoShape): LngLat[][][] {
  return shape.type === "Polygon" ? [shape.coordinates] : shape.coordinates;
}

/** Inside the shape, or within `bufferM` metres of its boundary. */
export function insideWithBuffer(point: { lat: number; lng: number }, shape: GeoShape, bufferM: number): boolean {
  for (const rings of polygonsOf(shape)) {
    if (pointInRings(point.lng, point.lat, rings)) return true;
    if (bufferM > 0 && distanceToRingsM(point, rings, bufferM) <= bufferM) return true;
  }
  return false;
}

export function insideShape(point: { lat: number; lng: number }, shape: GeoShape): boolean {
  return insideWithBuffer(point, shape, 0);
}

/** Rough sanity check of untrusted GeoJSON: closed-enough rings of finite lng/lat pairs. */
export function isValidShape(value: unknown): value is GeoShape {
  if (typeof value !== "object" || value === null) return false;
  const shape = value as { type?: unknown; coordinates?: unknown };
  const polygons = shape.type === "Polygon" ? [shape.coordinates] : shape.type === "MultiPolygon" ? shape.coordinates : null;
  if (!Array.isArray(polygons) || polygons.length === 0) return false;
  return polygons.every(
    (rings) =>
      Array.isArray(rings) &&
      rings.length > 0 &&
      rings.every(
        (ring) =>
          Array.isArray(ring) &&
          ring.length >= 4 &&
          ring.every(
            (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90,
          ),
      ),
  );
}

/** A circle as a 64-gon polygon (user-drawn exclusion circles); radius in km. */
export function circleShape(lat: number, lng: number, radiusKm: number, steps = 64): GeoPolygon {
  const ring: LngLat[] = [];
  const dLat = radiusKm / (METRES_PER_DEGREE_LAT / 1000);
  const dLng = dLat / Math.max(0.01, Math.cos((lat * Math.PI) / 180));
  for (let i = 0; i < steps; i++) {
    const angle = (2 * Math.PI * i) / steps;
    ring.push([lng + dLng * Math.cos(angle), lat + dLat * Math.sin(angle)]);
  }
  const start = ring[0];
  if (start) ring.push(start);
  return { type: "Polygon", coordinates: [ring] };
}
