// Grid builder map: click or drag the center marker to place the grid, and
// see the exact scan points (same buildGrid the worker uses).
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useRef } from "react";
import { buildGrid, validateGridInput } from "@/shared/grid";
import { circleShape } from "@/shared/skip/geo";
import { SKIP_REASON_LABEL, type Exclusion, type PlannedPoint } from "@/shared/skip/plan";
import { OSM_ATTRIBUTION, OSM_TILES } from "./RankMap";

const SKIP_SHORT = { water: "water", outside_area: "outside area", user: "user" } as const;

function planPinHtml(p: PlannedPoint): string {
  const skipped = p.skip !== null;
  const label = p.skip ? `<span class="pin-skip-label">skipped:<br>${SKIP_SHORT[p.skip]}</span>` : "";
  const hint = skipped
    ? `${SKIP_REASON_LABEL[p.skip ?? "user"]}. Click to scan this point anyway.`
    : p.override === "include"
      ? "Scanned (you switched it back on). Click to undo."
      : "Will be scanned. Click to skip this point.";
  return `<div class="plan-pin" data-skip="${skipped}" data-override="${p.override ?? ""}" title="${hint}">${skipped ? "&ndash;" : ""}${label}</div>`;
}

export function GridPreview({
  center,
  size,
  radiusKm,
  onCenterChange,
  plan,
  onTogglePoint,
  exclusion,
  className,
}: {
  center: { lat: number; lng: number };
  size: number;
  radiusKm: number;
  onCenterChange: (c: { lat: number; lng: number }) => void;
  /** The skip plan for this grid (from the server). Without it, plain dots are drawn. */
  plan?: PlannedPoint[];
  /** Click on a planned point: switch it between scanned and skipped. */
  onTogglePoint?: (p: PlannedPoint) => void;
  /** User-drawn exclusion shapes, drawn as outlines when enabled. */
  exclusion?: Exclusion;
  className?: string;
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const centerMarker = useRef<L.Marker | null>(null);
  const cb = useRef(onCenterChange);
  cb.current = onCenterChange;
  const toggleRef = useRef(onTogglePoint);
  toggleRef.current = onTogglePoint;
  const fittedFor = useRef("");

  useEffect(() => {
    if (!el.current) return;
    const instance = L.map(el.current, { scrollWheelZoom: false });
    L.tileLayer(OSM_TILES, { maxZoom: 19, attribution: OSM_ATTRIBUTION }).addTo(instance);
    layer.current = L.layerGroup().addTo(instance);
    instance.on("click", (e: L.LeafletMouseEvent) => cb.current({ lat: e.latlng.lat, lng: e.latlng.lng }));
    instance.setView([center.lat, center.lng], 12);
    map.current = instance;
    fittedFor.current = "";
    return () => {
      instance.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const instance = map.current;
    const group = layer.current;
    if (!instance || !group) return;
    group.clearLayers();
    centerMarker.current = L.marker([center.lat, center.lng], {
      draggable: true,
      title: "Drag to move the grid center",
      icon: L.divIcon({ className: "", html: '<div class="business-marker" style="width:20px;height:20px"></div>', iconSize: [20, 20], iconAnchor: [10, 10] }),
    })
      .on("dragend", (e) => {
        const ll = (e.target as L.Marker).getLatLng();
        cb.current({ lat: ll.lat, lng: ll.lng });
      })
      .addTo(group);
    const input = { centerLat: center.lat, centerLng: center.lng, size, radiusKm };
    if (validateGridInput(input)) return;
    const points = buildGrid(input);
    // The server's plan is only drawn while it still matches the grid on screen.
    const planned = plan && plan.length === points.length ? plan : null;
    if (planned) {
      for (const p of planned) {
        L.marker([p.lat, p.lng], {
          icon: L.divIcon({ className: "", html: planPinHtml(p), iconSize: [22, 22], iconAnchor: [11, 11] }),
          keyboard: false,
        })
          .on("click", () => toggleRef.current?.(p))
          .addTo(group);
      }
    } else {
      for (const p of points) {
        L.circleMarker([p.lat, p.lng], { radius: 4, weight: 1, color: "#104281", fillColor: "#5598e7", fillOpacity: 0.9, bubblingMouseEvents: false }).addTo(group);
      }
    }
    if (exclusion?.enabled) {
      for (const shape of exclusion.shapes) {
        const ring = shape.type === "circle" ? (circleShape(shape.lat, shape.lng, shape.radiusKm).coordinates[0] ?? []) : shape.points;
        L.polygon(ring.map(([lng, lat]) => [lat, lng] as [number, number]), { color: "#b91c1c", weight: 2, dashArray: "6 4", fillOpacity: 0.08, interactive: false }).addTo(group);
      }
    }
    const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lng] as [number, number])).pad(0.15);
    // Refit when the grid's extent changes, not while the user drags the center.
    const key = `${size}:${radiusKm}`;
    if (fittedFor.current !== key) {
      fittedFor.current = key;
      instance.fitBounds(bounds);
    } else if (!instance.getBounds().contains(bounds.getCenter())) {
      instance.panTo([center.lat, center.lng]);
    }
  }, [center.lat, center.lng, size, radiusKm, plan, exclusion]);

  return <div ref={el} className={className ?? "h-[420px] w-full overflow-hidden rounded-xl border border-border"} />;
}
