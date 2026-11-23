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
  /** Head-to-head view: replaces the rank colour and label with a symbol (client vs competitor). */
  versus?: "win" | "loss" | "tie" | "neither";
  /** Hover / tap card: a heading and optional lines, rendered as escaped text. */
  card?: { title: string; lines: string[]; list?: Array<{ rank: number; name: string; you: boolean }> };
};

export const VERSUS_SYMBOL = { win: "▲", loss: "▼", tie: "=", neither: "–" } as const;
const VERSUS_TIER = { win: "win", loss: "loss", tie: "even", neither: "even" } as const;
const VERSUS_TITLE = { win: "You rank higher", loss: "Competitor ranks higher", tie: "Tie", neither: "Neither in the top 20" } as const;

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function cardHtml(card: NonNullable<MapPoint["card"]>) {
  const list = card.list?.length
    ? `<ol class="point-card-list">${card.list.map((r) => `<li${r.you ? ' class="you"' : ""}><b>${r.rank}</b> ${escapeHtml(r.name)}${r.you ? " (you)" : ""}</li>`).join("")}</ol>`
    : "";
  return `<div class="point-card"><strong>${escapeHtml(card.title)}</strong>${card.lines.map((l) => `<div>${escapeHtml(l)}</div>`).join("")}${list}</div>`;
}

export const OSM_TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
export const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

function pinHtml(point: MapPoint, selected: boolean, small: boolean) {
  if (point.versus) {
    const label = VERSUS_TITLE[point.versus];
    return `<div class="rank-pin${small ? " small" : ""}" data-tier="${VERSUS_TIER[point.versus]}" data-versus="${point.versus}" data-selected="${selected}" role="img" aria-label="${label}" title="${label}">${VERSUS_SYMBOL[point.versus]}</div>`;
  }
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
  const refit = useRef<() => void>(() => {});
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
    // The container can settle after the first fit (grids, scrollbars, tabs): re-measure and fit again.
    const observer = new ResizeObserver(() => {
      instance.invalidateSize();
      fitted.current = "";
      refit.current();
    });
    observer.observe(el.current);
    return () => {
      observer.disconnect();
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
      if (point.card) {
        // Hover on desktop, tap (click) everywhere: a tooltip plus a popup that replaces it.
        const html = cardHtml(point.card);
        marker.bindTooltip(html, { direction: "top", offset: [0, -size / 2], className: "point-card-tip" });
        marker.bindPopup(html, { className: "point-card-popup", minWidth: 190, maxWidth: 260, autoPanPadding: [16, 16], offset: [0, -size / 2] });
        marker.on("popupopen", () => marker.closeTooltip());
        marker.on("tooltipopen", () => {
          if (marker.isPopupOpen()) marker.closeTooltip();
        });
      }
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
    // Fit once per point set (and again when the container resizes), so selecting a pin does not move the map.
    const key = points.map((p) => p.id).join(",");
    const fit = () => {
      if (key !== fitted.current && points.length) {
        fitted.current = key;
        instance.fitBounds(L.latLngBounds(points.map((p) => [p.lat, p.lng] as [number, number])).pad(0.12));
      }
    };
    refit.current = fit;
    fit();
  }, [points, business, selectedId, small]);

  return <div ref={el} className={cn("h-[520px] w-full overflow-hidden rounded-xl border border-border", className)} />;
}

/** Legend for the client-vs-competitor view: colour plus symbol plus words. */
export function VersusLegend({ className }: { className?: string }) {
  const items: Array<[keyof typeof VERSUS_SYMBOL, string]> = [
    ["win", "You rank higher"],
    ["loss", "Competitor ranks higher"],
    ["tie", "Tie"],
    ["neither", "Neither in top 20"],
  ];
  return (
    <ul className={cn("flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground", className)} aria-label="Head-to-head legend">
      {items.map(([key, label]) => (
        <li key={key} className="flex items-center gap-1.5">
          <span className="rank-pin small !cursor-default" data-tier={VERSUS_TIER[key]} aria-hidden="true">{VERSUS_SYMBOL[key]}</span>
          {label}
        </li>
      ))}
    </ul>
  );
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
