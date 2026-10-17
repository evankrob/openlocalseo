// Address -> coordinates via OpenStreetMap Nominatim (free, light use only;
// the policy asks for an identifying User-Agent).
export type GeocodeResult = { lat: number; lng: number; address: string };
export type Geocoder = (address: string) => Promise<GeocodeResult | null>;

export const nominatimGeocoder: Geocoder = async (address) => {
  const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(address)}`, {
    headers: { "User-Agent": "OpenLocalSEO/1.0 (self-hosted rank tracker)", Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  const rows = (await res.json()) as Array<{ lat: string; lon: string; display_name: string }>;
  const first = rows[0];
  if (!first) return null;
  const lat = Number(first.lat);
  const lng = Number(first.lon);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng, address: first.display_name } : null;
};
