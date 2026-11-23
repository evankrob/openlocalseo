// Business type and service area. A storefront is never skipped for being out of
// area. A service-area business lists where it works; points outside the listed
// areas are skipped only when every listed area has a boundary (0.5 mi buffer).
// The app ships no boundaries: they come from the user (e.g. US Census TIGER).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { isValidShape, type GeoMultiPolygon, type GeoShape } from "@/shared/skip/geo";
import { SERVICE_AREA_BUFFER_M, SERVICE_AREA_KINDS, type BusinessType, type ServiceAreaKind } from "@/shared/skip/plan";
import { get, patch, put } from "../lib/api";
import type { ServiceAreaOverview } from "../lib/types";
import { Badge, Button, Card, CardHeader, ErrorNote, Field, Input, Select, Spinner } from "./ui";

/** Pulls one Polygon/MultiPolygon out of a GeoJSON geometry, Feature or FeatureCollection. */
export function extractShape(value: unknown): GeoShape | null {
  const polygons: GeoMultiPolygon["coordinates"] = [];
  const visit = (node: unknown) => {
    if (typeof node !== "object" || node === null) return;
    const n = node as { type?: string; coordinates?: unknown; geometry?: unknown; features?: unknown[]; geometries?: unknown[] };
    if (n.type === "FeatureCollection") n.features?.forEach(visit);
    else if (n.type === "GeometryCollection") n.geometries?.forEach(visit);
    else if (n.type === "Feature") visit(n.geometry);
    else if (n.type === "Polygon") polygons.push(n.coordinates as GeoMultiPolygon["coordinates"][number]);
    else if (n.type === "MultiPolygon") polygons.push(...(n.coordinates as GeoMultiPolygon["coordinates"]));
  };
  visit(value);
  const shape: GeoShape | null = polygons.length === 0 ? null : { type: "MultiPolygon", coordinates: polygons };
  return shape && isValidShape(shape) ? shape : null;
}

export function ServiceAreaPanel({ businessId }: { businessId: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["service-area", businessId], queryFn: () => get<ServiceAreaOverview>(`/businesses/${businessId}/service-area`) });
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ServiceAreaKind>("city");
  const [shape, setShape] = useState<GeoShape | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["service-area", businessId] });
    qc.invalidateQueries({ queryKey: ["businesses"] });
    qc.invalidateQueries({ queryKey: ["tracker"] });
  };
  const setType = useMutation({ mutationFn: (businessType: BusinessType) => patch(`/businesses/${businessId}`, { businessType }), onSuccess: refresh });
  const save = useMutation({
    mutationFn: (areas: Array<{ name: string; kind: ServiceAreaKind; polygon?: GeoShape }>) => put(`/businesses/${businessId}/service-area`, { areas }),
    onSuccess: () => { setName(""); setShape(null); refresh(); },
  });

  if (!q.data) return <Card><div className="p-6"><Spinner /></div></Card>;
  const o = q.data;
  // Existing entries are sent by name only: the server keeps their stored boundaries.
  const current = o.areas.map((a) => ({ name: a.name, kind: a.kind }));

  async function onFile(file: File | undefined) {
    setFileError(null);
    setShape(null);
    if (!file) return;
    try {
      const extracted = extractShape(JSON.parse(await file.text()));
      if (!extracted) setFileError("No usable Polygon or MultiPolygon found in that file.");
      else setShape(extracted);
    } catch {
      setFileError("That file is not valid GeoJSON.");
    }
  }

  return (
    <Card>
      <CardHeader
        title="Business type & service area"
        description="Storefronts are never skipped for being out of area. Service-area businesses can skip grid points that fall outside the areas they serve."
      />
      <div className="space-y-4 p-5 text-sm">
        <Field label="Business type">
          <Select className="max-w-xs" value={o.businessType} onChange={(e) => setType.mutate(e.target.value as BusinessType)} disabled={setType.isPending}>
            <option value="storefront">Storefront (customers come to you)</option>
            <option value="service_area">Service-area business (you go to customers)</option>
          </Select>
        </Field>
        <ErrorNote error={setType.error} />
        {o.businessType === "service_area" ? (
          <>
            {o.areas.length === 0 ? (
              <p className="text-muted-foreground">No service area listed, so no points are skipped for being out of area. List the cities, ZIP codes or counties you serve below.</p>
            ) : (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {o.areas.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                    <span>
                      <span className="font-medium">{a.name}</span> <span className="text-xs text-muted-foreground">{a.kind}</span>
                    </span>
                    <span className="flex items-center gap-2">
                      {a.hasBoundary ? <Badge tone="success">Boundary on file</Badge> : <Badge tone="warning">No boundary data</Badge>}
                      <Button type="button" size="sm" variant="ghost" disabled={save.isPending} onClick={() => save.mutate(current.filter((c) => !(c.name === a.name && c.kind === a.kind)))}>Remove</Button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div
              className={o.status.applied ? "rounded-lg border border-success/40 bg-success/10 p-3" : "rounded-lg border border-border bg-muted p-3"}
              data-testid="service-area-status"
            >
              {o.status.applied ? (
                <>Applied: points more than {SERVICE_AREA_BUFFER_M} m (0.5 mi) outside the listed areas are skipped.</>
              ) : o.areas.length === 0 ? (
                <>Not applied: nothing listed.</>
              ) : (
                <>
                  <strong>Not applied: no boundary data</strong> for {o.status.missing.join(", ")}. Until every listed area has a boundary, no points are skipped for being out of area.
                </>
              )}
              {!o.status.applied && <p className="mt-1 text-xs text-muted-foreground">{o.boundarySource}</p>}
            </div>
            <form
              className="grid gap-3 md:grid-cols-[1fr_140px]"
              onSubmit={(e) => { e.preventDefault(); if (name.trim()) save.mutate([...current, { name: name.trim(), kind, ...(shape ? { polygon: shape } : {}) }]); }}
            >
              <Field label="City, ZIP or county"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Cary, NC" /></Field>
              <Field label="Type"><Select value={kind} onChange={(e) => setKind(e.target.value as ServiceAreaKind)}>{SERVICE_AREA_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}</Select></Field>
              <Field className="md:col-span-2" label="Boundary (optional)" hint="A GeoJSON file with this area's Polygon or MultiPolygon, for example exported from US Census TIGER/Line. Without it the name is saved but not applied.">
                <input type="file" accept=".json,.geojson,application/geo+json,application/json" className="text-sm" onChange={(e) => onFile(e.target.files?.[0])} />
                {shape && <p className="text-xs text-success">Boundary loaded ({shape.type === "MultiPolygon" ? shape.coordinates.length : 1} polygon).</p>}
                {fileError && <p className="text-xs text-destructive">{fileError}</p>}
              </Field>
              <div className="md:col-span-2 space-y-2">
                <ErrorNote error={save.error} />
                <Button type="submit" disabled={!name.trim() || save.isPending}>Add to service area</Button>
              </div>
            </form>
          </>
        ) : (
          <p className="text-muted-foreground">Switch to a service-area business to list the places you serve.</p>
        )}
      </div>
    </Card>
  );
}
