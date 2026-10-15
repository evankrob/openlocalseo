// Grid geometry. Pure functions shared by the worker (scan creation) and the
// client (builder preview), so the preview is exactly what gets scanned.

export const GRID_MIN_SIZE = 3;
export const GRID_MAX_SIZE = 13;
export const GRID_MIN_ZOOM = 10;
export const GRID_MAX_ZOOM = 18;
/** Fixed per tracker so history stays comparable (see SCOPE.md section 6). */
export const GRID_DEFAULT_ZOOM = 15;
export const GRID_MAX_RADIUS_KM = 80;

const KM_PER_MILE = 1.609344;
const KM_PER_DEGREE_LAT = 111.32;

export type DistanceUnit = "km" | "mi";

export type GridInput = {
  centerLat: number;
  centerLng: number;
  /** Points per side: 3 means a 3x3 grid. */
  size: number;
  /** Distance from the center to the outer edge of the grid. */
  radiusKm: number;
};

export type GridPoint = {
  /** 0 is the northern row. */
  row: number;
  /** 0 is the western column. */
  col: number;
  lat: number;
  lng: number;
};

export function toKm(value: number, unit: DistanceUnit): number {
  return unit === "mi" ? value * KM_PER_MILE : value;
}

export function fromKm(km: number, unit: DistanceUnit): number {
  return unit === "mi" ? km / KM_PER_MILE : km;
}

export function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function validateGridInput(input: GridInput): string | null {
  if (!Number.isInteger(input.size))
    return "Grid size must be a whole number";
  if (input.size < GRID_MIN_SIZE || input.size > GRID_MAX_SIZE)
    return `Grid size must be between ${GRID_MIN_SIZE}x${GRID_MIN_SIZE} and ${GRID_MAX_SIZE}x${GRID_MAX_SIZE}`;
  if (!(input.radiusKm > 0) || input.radiusKm > GRID_MAX_RADIUS_KM)
    return `Radius must be between 0 and ${GRID_MAX_RADIUS_KM} km`;
  if (Math.abs(input.centerLat) > 85 || Math.abs(input.centerLng) > 180)
    return "Center coordinates are out of range";
  return null;
}

/**
 * Points are laid out on an even square lattice around the center. Latitude
 * and longitude offsets come from a local flat-earth projection, which is
 * accurate to well under 1% at the radii we allow (up to 80 km).
 */
export function buildGrid(input: GridInput): GridPoint[] {
  const error = validateGridInput(input);
  if (error) throw new Error(error);

  const { size, radiusKm, centerLat, centerLng } = input;
  const stepKm = (2 * radiusKm) / (size - 1);
  const kmPerDegreeLng = KM_PER_DEGREE_LAT * Math.cos((centerLat * Math.PI) / 180);
  const points: GridPoint[] = [];
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const northKm = radiusKm - row * stepKm;
      const eastKm = -radiusKm + col * stepKm;
      points.push({
        row,
        col,
        lat: round6(centerLat + northKm / KM_PER_DEGREE_LAT),
        lng: round6(centerLng + eastKm / kmPerDegreeLng),
      });
    }
  }
  return points;
}

/** DataForSEO `location_coordinate`: "latitude,longitude,zoom" with a z suffix. */
export function formatLocationCoordinate(
  point: { lat: number; lng: number },
  zoom: number,
): string {
  return `${point.lat.toFixed(6)},${point.lng.toFixed(6)},${zoom}z`;
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
