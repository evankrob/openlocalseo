// OpenStreetMap + Leaflet heatmap: one numbered pin per grid point, colored by
// rank tier. No Google Maps API; tiles are OSM's (attribution is required).
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useRef } from "react";
import { rankLabel, rankTier } from "@/shared/rank";
import { cn } from "../lib/cn";

export type MapPoint = {
  id: string;
  lat: number;
  lng: number;
  rank: number | null;
  status?: string;
};

export const OSM_TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
export const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

function pinHtml(point: MapPoint, selected: boolean, small: boolean) {
  const failed = point.status === "failed";
  const tier = failed ? "failed" : rankTier(point.rank);
  const label = failed ? "!" : rankLabel(point.rank);
  const title = failed ? "Search failed" : point.rank ? `Rank ${point.rank}` : "Not in the top 20";
  return `<div class="rank-pin${small ? " small" : ""}" data-tier="${tier}" data-selected="${selected}" title="${title}">${label}</div>`;
}

export function RankMap({
  points,
  business,
  selectedId,
  onSelect,
  className,
  small,
}: {
  points: MapPoint[];
  business?: { lat: number; lng: number; name: string };
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  className?: string;
  small?: boolean;
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const fitted = useRef<string>("");
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    if (!el.current) return;
    const instance = L.map(el.current, { scrollWheelZoom: false, zoomControl: true, attributionControl: true });
    L.tileLayer(OSM_TILES, { maxZoom: 19, attribution: OSM_ATTRIBUTION }).addTo(instance);
    layer.current = L.layerGroup().addTo(instance);
    map.current = instance;
    // A fresh map has no view yet (StrictMode remounts reuse this ref).
    fitted.current = "";
    return () => {
      instance.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    const instance = map.current;
    const group = layer.current;
    if (!instance || !group) return;
    group.clearLayers();
    const size = small ? 22 : 30;
    for (const point of points) {
      const marker = L.marker([point.lat, point.lng], {
        icon: L.divIcon({ className: "", html: pinHtml(point, point.id === selectedId, !!small), iconSize: [size, size], iconAnchor: [size / 2, size / 2] }),
        keyboard: false,
      });
      marker.on("click", () => onSelectRef.current?.(point.id));
      marker.addTo(group);
    }
    if (business) {
      L.marker([business.lat, business.lng], {
        icon: L.divIcon({ className: "", html: '<div class="business-marker"></div>', iconSize: [14, 14], iconAnchor: [7, 7] }),
        title: business.name,
        interactive: false,
        zIndexOffset: -1000,
      }).addTo(group);
    }
    // Fit once per point set, so selecting a pin does not move the map.
    const key = points.map((p) => p.id).join(",");
    if (key !== fitted.current && points.length) {
      fitted.current = key;
      instance.fitBounds(L.latLngBounds(points.map((p) => [p.lat, p.lng] as [number, number])).pad(0.12));
    }
  }, [points, business, selectedId, small]);

  return <div ref={el} className={cn("h-[520px] w-full overflow-hidden rounded-xl border border-border", className)} />;
}

export function RankLegend({ className }: { className?: string }) {
  const tiers: Array<[string, string]> = [
    ["1", "Rank 1-3"],
    ["2", "4-7"],
    ["3", "8-12"],
    ["4", "13-20"],
    ["none", "Not in top 20"],
  ];
  return (
    <ul className={cn("flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground", className)} aria-label="Rank colour legend">
      {tiers.map(([tier, label]) => (
        <li key={tier} className="flex items-center gap-1.5">
          <span className="legend-swatch" style={{ background: `var(--rank-${tier})` }} />
          {label}
        </li>
      ))}
      <li className="flex items-center gap-1.5">
        <span className="business-marker !size-2.5 !border-2" /> Your business
      </li>
    </ul>
  );
}
