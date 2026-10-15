// The grid builder: business + keyword, grid size (3x3 to 13x13), radius,
// fixed zoom, data source and queue, schedule, and a live cost estimate.
import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link, useNavigate, useOutletContext, useSearchParams } from "react-router-dom";
import { GRID_DEFAULT_ZOOM, GRID_MAX_SIZE, GRID_MAX_ZOOM, GRID_MIN_SIZE, GRID_MIN_ZOOM, toKm } from "@/shared/grid";
import { applyMarkupUsd, creditsForProviderUsd, estimateScanCostUsd, type QueueMode } from "@/shared/pricing";
import { get, post } from "../lib/api";
import type { Me } from "../lib/types";
import { GridPreview } from "../components/GridPreview";
import { Button, Card, CardHeader, EmptyState, ErrorNote, Field, Input, Select } from "../components/ui";
import { PageHeader } from "./shell";

type Business = { id: string; name: string; lat: number; lng: number };

const QUEUES: Array<{ value: QueueMode; label: string; note: string }> = [
  { value: "standard", label: "Standard", note: "Cheapest. Results in minutes. Best for scheduled scans." },
  { value: "priority", label: "Priority", note: "2x the price. Results in under a minute." },
  { value: "live", label: "Live", note: "3.3x the price. Results immediately." },
];

export function TrackerNew() {
  const me = useOutletContext<Me>();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const businesses = useQuery({ queryKey: ["businesses"], queryFn: () => get<Business[]>("/businesses") });
  const [businessId, setBusinessId] = useState(params.get("business") ?? "");
  const [keyword, setKeyword] = useState("");
  const [size, setSize] = useState(7);
  const [radius, setRadius] = useState(5);
  const [unit, setUnit] = useState<"km" | "mi">("mi");
  const [zoom, setZoom] = useState(GRID_DEFAULT_ZOOM);
  const [searchType, setSearchType] = useState<"maps" | "local_finder">("maps");
  const [queueMode, setQueueMode] = useState<QueueMode>("standard");
  const [device, setDevice] = useState<"mobile" | "desktop">("mobile");
  const [monthly, setMonthly] = useState(true);
  const [day, setDay] = useState(1);
  const [override, setOverride] = useState<{ lat: number; lng: number } | null>(null);

  const business = businesses.data?.find((b) => b.id === (businessId || businesses.data?.[0]?.id));
  const center = override ?? (business ? { lat: business.lat, lng: business.lng } : null);

  const quote = useMemo(() => {
    const points = size * size;
    const raw = estimateScanCostUsd(points, queueMode);
    const hosted = me.config.billingMode === "hosted";
    return { points, raw, charged: hosted ? applyMarkupUsd(raw, me.config.markup) : raw, credits: hosted ? creditsForProviderUsd(raw, me.config.markup) : 0 };
  }, [size, queueMode, me.config]);

  const save = useMutation({
    mutationFn: async (runNow: boolean) => {
      const tracker = await post<{ id: string }>("/trackers", {
        businessId: business!.id,
        keyword,
        centerLat: center!.lat,
        centerLng: center!.lng,
        gridSize: size,
        radius: { value: radius, unit },
        zoom,
        searchType,
        queueMode,
        device,
        schedule: { frequency: monthly ? "monthly" : "none", day },
      });
      if (runNow) await post(`/trackers/${tracker.id}/scans`, { maxCostUsd: quote.charged });
      return tracker.id;
    },
    onSuccess: (id) => nav(`/trackers/${id}`),
  });

  if (businesses.data?.length === 0) {
    return (
      <>
        <PageHeader title="New grid scan" />
        <Card><EmptyState title="Add a business first"><Link className="text-primary underline" to="/businesses">Go to Businesses</Link></EmptyState></Card>
      </>
    );
  }

  const radiusKm = toKm(radius, unit);
  const ready = !!business && !!center && keyword.trim().length > 0 && radius > 0 && radiusKm <= 80;

  return (
    <>
      <PageHeader title="New grid scan" description="Pick a business and keyword, shape the grid, and see what it will cost before anything runs." />
      <div className="grid gap-6 lg:grid-cols-[400px_1fr]">
        <Card>
          <CardHeader title="Grid settings" />
          <form className="space-y-4 p-5" onSubmit={(e) => { e.preventDefault(); if (ready) save.mutate(true); }}>
            <Field label="Business">
              <Select value={business?.id ?? ""} onChange={(e) => { setBusinessId(e.target.value); setOverride(null); }}>
                {businesses.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </Select>
            </Field>
            <Field label="Keyword" hint="What a customer would search, e.g. &ldquo;coffee shop&rdquo;.">
              <Input required value={keyword} onChange={(e) => setKeyword(e.target.value)} />
            </Field>
            <Field label={`Grid size: ${size} x ${size} (${size * size} points)`}>
              <input type="range" className="w-full" min={GRID_MIN_SIZE} max={GRID_MAX_SIZE} value={size} onChange={(e) => setSize(Number(e.target.value))} aria-label="Grid size" />
            </Field>
            <Field label="Radius" hint="Distance from the center to the outer edge of the grid.">
              <div className="flex gap-2">
                <Input type="number" min={0.5} step={0.5} value={radius} onChange={(e) => setRadius(Number(e.target.value))} />
                <Select className="w-24" value={unit} onChange={(e) => setUnit(e.target.value as "km" | "mi")}><option value="mi">miles</option><option value="km">km</option></Select>
              </div>
              {radiusKm > 80 && <p className="text-xs text-destructive">Maximum radius is 80 km (50 mi).</p>}
            </Field>
            <Field label="Map zoom" hint="Fixed for every scan of this grid so results stay comparable over time. Lower zoom = wider viewport per point.">
              <Select value={zoom} onChange={(e) => setZoom(Number(e.target.value))}>
                {Array.from({ length: GRID_MAX_ZOOM - GRID_MIN_ZOOM + 1 }, (_, i) => GRID_MIN_ZOOM + i).map((z) => <option key={z} value={z}>{z}z{z === GRID_DEFAULT_ZOOM ? " (default)" : ""}</option>)}
              </Select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Source" hint="Which result list counts as truth.">
                <Select value={searchType} onChange={(e) => setSearchType(e.target.value as "maps" | "local_finder")}><option value="maps">Google Maps</option><option value="local_finder">Local Finder</option></Select>
              </Field>
              <Field label="Device"><Select value={device} onChange={(e) => setDevice(e.target.value as "mobile" | "desktop")}><option value="mobile">Mobile</option><option value="desktop">Desktop</option></Select></Field>
            </div>
            <Field label="Queue" hint={QUEUES.find((q) => q.value === queueMode)?.note}>
              <Select value={queueMode} onChange={(e) => setQueueMode(e.target.value as QueueMode)}>{QUEUES.map((q) => <option key={q.value} value={q.value}>{q.label}</option>)}</Select>
            </Field>
            <Field label="Schedule">
              <div className="flex items-center gap-3 text-sm">
                <label className="flex items-center gap-2"><input type="checkbox" checked={monthly} onChange={(e) => setMonthly(e.target.checked)} /> Scan monthly on day</label>
                <Select className="w-20" disabled={!monthly} value={day} onChange={(e) => setDay(Number(e.target.value))}>{Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <option key={d}>{d}</option>)}</Select>
              </div>
            </Field>

            <div className="rounded-lg border border-border bg-muted p-3 text-sm" aria-live="polite">
              <div className="flex justify-between"><span>{quote.points} searches &times; {queueMode}</span><strong className="tabular-nums">${quote.charged.toFixed(4)}</strong></div>
              <p className="mt-1 text-xs text-muted-foreground">
                {me.config.billingMode === "hosted"
                  ? `${quote.credits} credits (DataForSEO cost $${quote.raw.toFixed(4)} + ${Math.round((me.config.markup - 1) * 100)}%).`
                  : `Billed by DataForSEO to your own account. ${me.config.dataMode === "mock" ? "Mock mode: nothing is actually charged." : ""}`}
              </p>
            </div>
            <ErrorNote error={save.error} />
            <div className="flex gap-2">
              <Button type="submit" disabled={!ready || save.isPending}>Save &amp; run scan</Button>
              <Button type="button" variant="outline" disabled={!ready || save.isPending} onClick={() => save.mutate(false)}>Save only</Button>
            </div>
          </form>
        </Card>
        <Card className="self-start p-3">
          {center ? (
            <>
              <GridPreview center={center} size={size} radiusKm={Math.min(radiusKm, 80)} onCenterChange={setOverride} />
              <p className="px-1 pt-2 text-xs text-muted-foreground">Click the map or drag the marker to move the grid center. Each dot is one search, as a customer standing there would see it.</p>
            </>
          ) : <EmptyState title="Choose a business" />}
        </Card>
      </div>
    </>
  );
}
