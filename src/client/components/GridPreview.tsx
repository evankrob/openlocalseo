// Grid builder map: click or drag the center marker to place the grid, and
// see the exact scan points (same buildGrid the worker uses).
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useRef } from "react";
import { buildGrid, validateGridInput } from "@/shared/grid";
import { OSM_ATTRIBUTION, OSM_TILES } from "./RankMap";

export function GridPreview({
  center,
  size,
  radiusKm,
  onCenterChange,
}: {
  center: { lat: number; lng: number };
  size: number;
  radiusKm: number;
  onCenterChange: (c: { lat: number; lng: number }) => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const centerMarker = useRef<L.Marker | null>(null);
  const cb = useRef(onCenterChange);
  cb.current = onCenterChange;
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
    for (const p of points) {
      L.circleMarker([p.lat, p.lng], { radius: 4, weight: 1, color: "#104281", fillColor: "#5598e7", fillOpacity: 0.9 }).addTo(group);
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
  }, [center.lat, center.lng, size, radiusKm]);

  return <div ref={el} className="h-[420px] w-full overflow-hidden rounded-xl border border-border" />;
}
