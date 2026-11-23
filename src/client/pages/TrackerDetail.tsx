import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router-dom";
import { EMPTY_OVERRIDES, NO_EXCLUSION, SERVICE_AREA_BUFFER_M, setCellOverride, type Exclusion, type SkipOverrides } from "@/shared/skip/plan";
import { SHORE_TOLERANCE_M } from "@/shared/skip/water";
import { del, get, patch, post } from "../lib/api";
import { cn } from "../lib/cn";
import { chargeLabel, fmtDateTime, fmtNum, fmtPct, fmtUsd, scanBreakdown } from "../lib/format";
import type { Me, PointResults, ScanDetail, ScanListItem, ScanQuote, ScanViewData, ServiceAreaOverview, SkipPreview, TrackerSummary } from "../lib/types";
import { CompareView } from "../components/CompareView";
import { GridPreview } from "../components/GridPreview";
import { ScanView, OtherListingsNote } from "../components/ScanView";
import { TrendCharts } from "../components/TrendCharts";
import { Badge, Button, Card, CardHeader, EmptyState, ErrorNote, Field, Input, Select, Spinner, Table, Td, Th } from "../components/ui";
import { statusTone } from "./Dashboard";
import { PageHeader } from "./shell";

const ACTIVE = ["queued", "posting", "polling"];

export function toViewData(d: ScanDetail): ScanViewData {
  return {
    id: d.scan.id,
    keyword: d.scan.keyword,
    createdAt: d.scan.createdAt,
    gridSize: d.scan.gridSize,
    radiusKm: d.scan.radiusKm,
    zoom: d.scan.zoom,
    searchType: d.scan.searchType,
    business: { name: d.business.name, lat: d.business.lat, lng: d.business.lng },
    points: d.points,
    skippedPoints: d.scan.skippedPoints,
    metrics: d.metrics,
    competitors: d.competitors,
    competitorsExpired: d.competitorsExpired,
    retentionDays: d.retentionDays,
  };
}

export const loadScanPoint = (scanId: string) => (pointId: string) => get<PointResults>(`/scans/${scanId}/points/${pointId}`);

/** Banner while a scan is running: polls the scan and shows point progress. */
function ScanProgress({ scanId, onDone }: { scanId: string; onDone: () => void }) {
  const q = useQuery({
    queryKey: ["scan", scanId, "progress"],
    queryFn: () => get<ScanDetail>(`/scans/${scanId}`),
    refetchInterval: (query) => (query.state.data && !ACTIVE.includes(query.state.data.scan.status) ? false : 3000),
  });
  const status = q.data?.scan.status;
  useEffect(() => {
    if (status && !ACTIVE.includes(status)) onDone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);
  if (!q.data) return null;
  // Skipped points are never searched, so progress counts the scanned ones only.
  const done = q.data.points.filter((p) => p.status === "completed" || p.status === "failed").length;
  const total = q.data.points.filter((p) => p.status !== "skipped").length;
  return (
    <Card className="flex items-center gap-4 border-primary/40 px-5 py-4" role="status">
      <Spinner />
      <div className="flex-1">
        <div className="font-medium">Scan in progress ({status})</div>
        <div className="text-sm text-muted-foreground">
          {done} of {total} points collected{q.data.scan.skippedPoints > 0 ? ` (${q.data.scan.skippedPoints} skipped, not charged)` : ""}. The {q.data.scan.queueMode} queue can take {q.data.scan.queueMode === "standard" ? "a few minutes" : "under a minute"}; you can leave this page.
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary transition-all" style={{ width: `${total ? (done / total) * 100 : 0}%` }} /></div>
      </div>
    </Card>
  );
}

export function TrackerDetail() {
  const { id = "" } = useParams();
  const me = useOutletContext<Me>();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [tab, setTab] = useState<"latest" | "history" | "compare" | "points" | "share" | "settings">("latest");

  const tracker = useQuery({ queryKey: ["tracker", id], queryFn: () => get<TrackerSummary>(`/trackers/${id}`) });
  const scans = useQuery({
    queryKey: ["tracker", id, "scans"],
    queryFn: () => get<ScanListItem[]>(`/trackers/${id}/scans`),
    refetchInterval: (query) => (query.state.data?.some((s) => ACTIVE.includes(s.status)) ? 4000 : false),
  });
  const active = scans.data?.find((s) => ACTIVE.includes(s.status));
  const completed = useMemo(() => (scans.data ?? []).filter((s) => s.status === "completed"), [scans.data]);
  const latest = completed[0];

  const refresh = () => { qc.invalidateQueries({ queryKey: ["tracker", id] }); qc.invalidateQueries({ queryKey: ["trackers"] }); };
  const hosted = me.config.billingMode === "hosted";
  const gridSize = tracker.data?.gridSize;
  const queueMode = tracker.data?.queueMode;
  // Server quote for this tracker's next scan: the same skip plan + quoteScanPoints that createScan
  // uses for the hold, so skipped points (water, outside area, user) are never in the price.
  const quote = useQuery({
    queryKey: ["tracker", id, "skip-plan"],
    queryFn: () => get<SkipPreview>(`/trackers/${id}/skip-plan`),
    enabled: gridSize !== undefined && queueMode !== undefined,
    staleTime: 60_000,
    select: (plan): ScanQuote => plan.quote,
  });
  const usage = useQuery({ queryKey: ["usage"], queryFn: () => get<{ credits: { balance: number } | null }>("/usage"), enabled: hosted });
  // The quote the user sees is also the approved ceiling, so the charge cannot be higher.
  const run = useMutation({
    mutationFn: (maxCostUsd: number) => post(`/trackers/${id}/scans`, { maxCostUsd }),
    onSuccess: () => { refresh(); qc.invalidateQueries({ queryKey: ["usage"] }); },
  });

  if (tracker.isLoading) return <Spinner />;
  if (!tracker.data) return <ErrorNote error={tracker.error ?? new Error("Tracker not found")} />;
  const t = tracker.data;
  const q = quote.data;
  const balance = usage.data?.credits?.balance ?? null;

  return (
    <>
      <PageHeader
        title={<>{t.business.name} <span className="font-normal text-muted-foreground">&ldquo;{t.keyword}&rdquo;</span></>}
        description={`${t.gridSize}x${t.gridSize} grid, ${t.radiusKm.toFixed(1)} km radius, ${t.searchType === "maps" ? "Google Maps" : "Local Finder"}, ${t.queueMode} queue`}
        actions={
          <div className="flex w-full flex-col gap-1.5 sm:w-auto sm:items-end" data-testid="run-scan">
            <Button className="max-w-full whitespace-normal" disabled={!!active || run.isPending || !q} onClick={() => q && run.mutate(q.chargedUsd)}>
              {active ? "Scan running" : q ? `Run scan now · ${chargeLabel(q, me.config.billingMode)}` : "Run scan now"}
            </Button>
            <p className="max-w-sm text-xs text-muted-foreground sm:text-right" data-testid="run-scan-estimate">
              {q ? scanBreakdown(q, me.config.billingMode, balance, me.config.dataMode)
                : quote.isError ? `Cost unavailable (could not get a quote). ${t.gridSize * t.gridSize} points on the ${t.queueMode} queue; try again shortly.`
                : "Getting the cost estimate..."}
            </p>
          </div>
        }
      />
      <ErrorNote error={run.error} />
      {active && <ScanProgress scanId={active.id} onDone={refresh} />}
      {!active && scans.data?.[0]?.status === "failed" && (
        <Card className="border-destructive/40 px-5 py-3 text-sm"><Badge tone="danger" className="mr-2">Last scan failed</Badge>{scans.data[0].error}</Card>
      )}

      <div className="no-print flex gap-1 overflow-x-auto border-b border-border" role="tablist">
        {([["latest", "Latest scan"], ["history", "History & trends"], ["compare", "Compare"], ["points", "Grid points"], ["share", "Client report"], ["settings", "Schedule"]] as const).map(([key, label]) => (
          <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)} className={cn("-mb-px shrink-0 whitespace-nowrap border-b-2 px-4 py-2 text-sm", tab === key ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground")}>{label}</button>
        ))}
      </div>

      {tab === "latest" && (latest ? <LatestScan scanId={latest.id} /> : <Card><EmptyState title="No completed scan yet">Run a scan to see the heatmap.</EmptyState></Card>)}
      {tab === "history" && <History trackerId={id} scans={scans.data ?? []} />}
      {tab === "compare" && <CompareView scans={completed} />}
      {tab === "points" && <GridPoints tracker={t} onSaved={refresh} />}
      {tab === "share" && <Share trackerId={id} admin={me.workspace.role !== "member"} />}
      {tab === "settings" && <Schedule tracker={t} onSaved={refresh} onArchived={() => nav("/")} hosted={hosted} admin={me.workspace.role !== "member"} />}
    </>
  );
}

function LatestScan({ scanId }: { scanId: string }) {
  const q = useQuery({ queryKey: ["scan", scanId], queryFn: () => get<ScanDetail>(`/scans/${scanId}`) });
  if (!q.data) return <Spinner />;
  return (
    <>
      <p className="text-sm text-muted-foreground">Scanned {fmtDateTime(q.data.scan.createdAt)} &middot; <Link className="underline" to={`/scans/${scanId}`}>open scan</Link></p>
      <OtherListingsNote listings={q.data.otherListings} />
      <ScanView showOverlay data={toViewData(q.data)} loadPoint={loadScanPoint(scanId)} queryKey={["scan", scanId]} />
    </>
  );
}

function History({ trackerId, scans }: { trackerId: string; scans: ScanListItem[] }) {
  const completed = scans.filter((s) => s.status === "completed");
  return (
    <div className="space-y-4">
      <TrendCharts history={completed} />
      <Card>
        <CardHeader title="Scan history" />
        {scans.length === 0 ? <EmptyState title="No scans yet" /> : (
          <Table>
            <thead><tr><Th>Date</Th><Th>Status</Th><Th className="text-right">ATRP</Th><Th className="text-right">ARP</Th><Th className="text-right">SoLV</Th><Th>Trigger</Th><Th className="text-right">Cost</Th></tr></thead>
            <tbody>
              {scans.map((s) => (
                <tr key={s.id} className="hover:bg-accent/50">
                  <Td><Link className="text-primary underline" to={`/scans/${s.id}`}>{fmtDateTime(s.createdAt)}</Link></Td>
                  <Td><Badge tone={statusTone(s.status)}>{s.status}</Badge>{s.error && <div className="mt-1 max-w-xs text-xs text-muted-foreground">{s.error}</div>}</Td>
                  <Td className="text-right tabular-nums">{fmtNum(s.atrp)}</Td>
                  <Td className="text-right tabular-nums">{fmtNum(s.arp)}</Td>
                  <Td className="text-right tabular-nums">{fmtPct(s.solv)}</Td>
                  <Td className="text-xs">{s.trigger}</Td>
                  <Td className="text-right tabular-nums">{fmtUsd(s.costUsd)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <span hidden>{trackerId}</span>
    </div>
  );
}

/** Which grid points the next scan will skip, with the per-point and exclusion controls. Edits apply to future scans only. */
function GridPoints({ tracker, onSaved }: { tracker: TrackerSummary; onSaved: () => void }) {
  const qc = useQueryClient();
  const [skipWater, setSkipWater] = useState(tracker.autoSkipWater);
  const [overrides, setOverrides] = useState<SkipOverrides>(tracker.skipOverrides);
  const [exclusion, setExclusion] = useState<Exclusion>(tracker.exclusion);
  const [circle, setCircle] = useState({ lat: tracker.centerLat.toFixed(5), lng: tracker.centerLng.toFixed(5), radiusKm: "1" });
  const area = useQuery({ queryKey: ["service-area", tracker.business.id], queryFn: () => get<ServiceAreaOverview>(`/businesses/${tracker.business.id}/service-area`) });

  const body = { businessId: tracker.business.id, centerLat: tracker.centerLat, centerLng: tracker.centerLng, gridSize: tracker.gridSize, radius: { value: tracker.radiusKm, unit: "km" as const }, queueMode: tracker.queueMode, autoSkipWater: skipWater, skipOverrides: overrides, exclusion };
  const preview = useQuery({ queryKey: ["tracker", tracker.id, "skip-preview", body], queryFn: () => post<SkipPreview>("/skip-preview", body), placeholderData: keepPreviousData });
  const dirty = skipWater !== tracker.autoSkipWater || JSON.stringify(overrides) !== JSON.stringify(tracker.skipOverrides) || JSON.stringify(exclusion) !== JSON.stringify(tracker.exclusion);
  const save = useMutation({
    mutationFn: () => patch(`/trackers/${tracker.id}`, { autoSkipWater: skipWater, skipOverrides: overrides, exclusion }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["tracker", tracker.id] }); onSaved(); },
  });
  const summary = preview.data?.summary;
  const quote = preview.data?.quote;
  const addCircle = () => {
    const lat = Number(circle.lat), lng = Number(circle.lng), radiusKm = Number(circle.radiusKm);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !(radiusKm > 0) || radiusKm > 80) return;
    setExclusion((e) => ({ enabled: true, shapes: [...e.shapes, { type: "circle", lat, lng, radiusKm }] }));
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
      <Card className="self-start p-3">
        <GridPreview
          className="h-[480px] w-full overflow-hidden rounded-xl border border-border"
          center={{ lat: tracker.centerLat, lng: tracker.centerLng }}
          size={tracker.gridSize}
          radiusKm={tracker.radiusKm}
          onCenterChange={() => undefined}
          plan={preview.data?.points}
          onTogglePoint={(p) => setOverrides((o) => setCellOverride(o, p, p.skip ? "scan" : "skip"))}
          exclusion={exclusion}
        />
        <p className="px-1 pt-2 text-xs text-muted-foreground">Blue dots are scanned, grey dots are skipped. Click any dot to switch it. A point you switch back on keeps a blue ring.</p>
      </Card>
      <div className="space-y-4">
        <Card>
          <CardHeader title="Next scan" description="Skipped points are never searched, never charged and left out of every metric." />
          <div className="space-y-2 p-5 text-sm" aria-live="polite">
            {summary && quote ? (
              <>
                <div className="text-lg font-semibold tabular-nums">{summary.scannablePoints} of {summary.gridPoints} points will be scanned</div>
                <div className="text-muted-foreground">
                  {summary.skippedPoints} skipped: {summary.byReason.water} water, {summary.byReason.outside_area} outside area, {summary.byReason.user} user.
                </div>
                <div>Estimated cost <strong className="tabular-nums">${quote.chargedUsd.toFixed(4)}</strong> for {quote.points} searches.</div>
              </>
            ) : <Spinner />}
            <p className="text-xs text-muted-foreground">Changes apply to future scans. Scans already run keep the points they scanned and skipped.</p>
          </div>
        </Card>
        <Card>
          <CardHeader title="Rules" />
          <div className="space-y-4 p-5 text-sm">
            <label className="flex items-start gap-2"><input className="mt-1" type="checkbox" checked={skipWater} onChange={(e) => setSkipWater(e.target.checked)} /><span><strong>Skip points on open water.</strong> Only points more than {SHORE_TOLERANCE_M} m from the nearest shore are skipped, so points on a beach, pier or causeway are still scanned.</span></label>
            <div>
              <div className="font-medium">Service area</div>
              {area.data ? (
                <p className="mt-1 text-muted-foreground">
                  {area.data.status.applied
                    ? `Points more than ${SERVICE_AREA_BUFFER_M} m (0.5 mi) outside the ${area.data.status.total} listed area${area.data.status.total === 1 ? "" : "s"} are skipped.`
                    : area.data.status.reason === "storefront"
                      ? "This business is a storefront, so points are never skipped for being out of area."
                      : area.data.status.reason === "no_areas"
                        ? "No service area is listed for this service-area business, so nothing is skipped for being out of area."
                        : `Not applied: no boundary data for ${area.data.status.missing.join(", ")}.`}{" "}
                  <Link className="underline" to={`/businesses/${tracker.business.id}`}>Edit on the business page</Link>.
                </p>
              ) : null}
            </div>
            <div>
              <label className="flex items-center gap-2 font-medium"><input type="checkbox" checked={exclusion.enabled} onChange={(e) => setExclusion((x) => ({ ...x, enabled: e.target.checked }))} /> Exclude an area I draw (off by default)</label>
              <p className="mt-1 text-xs text-muted-foreground">Points inside a shape are skipped as &ldquo;outside area&rdquo;. Add a circle by its centre and radius.</p>
              {exclusion.shapes.length > 0 && (
                <ul className="mt-2 divide-y divide-border rounded-lg border border-border text-xs">
                  {exclusion.shapes.map((sh, i) => (
                    <li key={i} className="flex items-center justify-between gap-2 px-3 py-1.5">
                      <span className="tabular-nums">{sh.type === "circle" ? `Circle ${sh.radiusKm} km at ${sh.lat.toFixed(4)}, ${sh.lng.toFixed(4)}` : `Polygon, ${sh.points.length} points`}</span>
                      <Button type="button" size="sm" variant="ghost" onClick={() => setExclusion((x) => ({ ...x, shapes: x.shapes.filter((_, k) => k !== i) }))}>Remove</Button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-2 grid grid-cols-3 gap-2">
                <Input aria-label="Circle latitude" value={circle.lat} onChange={(e) => setCircle((c) => ({ ...c, lat: e.target.value }))} />
                <Input aria-label="Circle longitude" value={circle.lng} onChange={(e) => setCircle((c) => ({ ...c, lng: e.target.value }))} />
                <Input aria-label="Circle radius in km" value={circle.radiusKm} onChange={(e) => setCircle((c) => ({ ...c, radiusKm: e.target.value }))} />
              </div>
              <div className="mt-1 text-xs text-muted-foreground">latitude, longitude, radius (km)</div>
              <Button className="mt-2" type="button" size="sm" variant="outline" onClick={addCircle}>Add circle</Button>
            </div>
            <ErrorNote error={save.error} />
            <div className="flex flex-wrap gap-2">
              <Button type="button" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>Save for future scans</Button>
              <Button type="button" variant="outline" disabled={overrides.include.length + overrides.exclude.length === 0} onClick={() => setOverrides(EMPTY_OVERRIDES)}>Reset my point choices</Button>
              {exclusion.shapes.length === 0 && !exclusion.enabled ? null : <Button type="button" variant="ghost" onClick={() => setExclusion(NO_EXCLUSION)}>Clear drawn areas</Button>}
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

type Share = { id: string; label: string | null; showCompetitors: boolean; expiresAt: string | null; revokedAt: string | null; viewCount: number; createdAt: string };

function Share({ trackerId, admin }: { trackerId: string; admin: boolean }) {
  const qc = useQueryClient();
  const shares = useQuery({ queryKey: ["shares", trackerId], queryFn: () => get<Share[]>(`/trackers/${trackerId}/shares`), enabled: admin });
  const [label, setLabel] = useState("");
  const [competitors, setCompetitors] = useState(true);
  const [expiry, setExpiry] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => post<{ url: string }>(`/trackers/${trackerId}/shares`, { label: label || null, showCompetitors: competitors, expiresAt: expiry ? new Date(expiry).toISOString() : null }),
    onSuccess: (r) => { setCreated(r.url); setLabel(""); qc.invalidateQueries({ queryKey: ["shares", trackerId] }); },
  });
  const revoke = useMutation({ mutationFn: (id: string) => del(`/shares/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ["shares", trackerId] }) });
  if (!admin) return <Card><EmptyState title="Admins manage client report links" /></Card>;
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Create a client report link" description="A read-only page with your branding (set it under Settings). Anyone with the link can view it; revoke it any time." />
        <form className="grid gap-4 p-5 md:grid-cols-3" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <Field label="Label"><Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Acme Dental - monthly" /></Field>
          <Field label="Expires (optional)"><Input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} /></Field>
          <Field label="Include"><label className="flex items-center gap-2 pt-2 text-sm"><input type="checkbox" checked={competitors} onChange={(e) => setCompetitors(e.target.checked)} /> Competitor view</label></Field>
          <div className="md:col-span-3 space-y-2">
            <ErrorNote error={create.error} />
            <Button type="submit" disabled={create.isPending}>Create link</Button>
          </div>
        </form>
        {created && (
          <div className="mx-5 mb-5 rounded-lg border border-success/40 bg-success/10 p-3 text-sm">
            <div className="font-medium">Link created. Copy it now; it is not shown again.</div>
            <div className="mt-1 flex gap-2"><Input readOnly value={created} onFocus={(e) => e.currentTarget.select()} /><Button type="button" variant="outline" onClick={() => navigator.clipboard.writeText(created)}>Copy</Button><a href={created} target="_blank" rel="noreferrer"><Button type="button" variant="outline">Open</Button></a></div>
          </div>
        )}
      </Card>
      <Card>
        <CardHeader title="Links" />
        {shares.data?.length === 0 ? <EmptyState title="No links yet" /> : (
          <Table>
            <thead><tr><Th>Label</Th><Th>Created</Th><Th>Views</Th><Th>Status</Th><Th /></tr></thead>
            <tbody>
              {shares.data?.map((s) => (
                <tr key={s.id}>
                  <Td>{s.label ?? "Untitled"}<div className="text-xs text-muted-foreground">{s.showCompetitors ? "With competitors" : "No competitors"}</div></Td>
                  <Td className="text-xs">{fmtDateTime(s.createdAt)}</Td>
                  <Td className="tabular-nums">{s.viewCount}</Td>
                  <Td>{s.revokedAt ? <Badge tone="danger">Revoked</Badge> : s.expiresAt && s.expiresAt < new Date().toISOString() ? <Badge tone="warning">Expired</Badge> : <Badge tone="success">Active</Badge>}</Td>
                  <Td className="text-right">{!s.revokedAt && <Button size="sm" variant="ghost" onClick={() => revoke.mutate(s.id)}>Revoke</Button>}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

function Schedule({ tracker, onSaved, onArchived, hosted, admin }: { tracker: TrackerSummary; onSaved: () => void; onArchived: () => void; hosted: boolean; admin: boolean }) {
  const [monthly, setMonthly] = useState(tracker.scheduleFrequency === "monthly");
  const [day, setDay] = useState(tracker.scheduleDay);
  const [queue, setQueue] = useState(tracker.queueMode);
  const save = useMutation({ mutationFn: () => patch(`/trackers/${tracker.id}`, { schedule: { frequency: monthly ? "monthly" : "none", day }, queueMode: queue }), onSuccess: onSaved });
  const archive = useMutation({ mutationFn: () => del(`/trackers/${tracker.id}`), onSuccess: onArchived });
  return (
    <Card>
      <CardHeader title="Schedule" description="Monthly scans run from a daily Cron on the chosen day. Standard queue is the cheapest and fine for scheduled runs." />
      <form className="grid gap-4 p-5 md:grid-cols-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <Field label="Monthly scan"><label className="flex items-center gap-2 pt-2 text-sm"><input type="checkbox" checked={monthly} onChange={(e) => setMonthly(e.target.checked)} /> Enabled</label></Field>
        <Field label="Day of month"><Select disabled={!monthly} value={day} onChange={(e) => setDay(Number(e.target.value))}>{Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <option key={d}>{d}</option>)}</Select></Field>
        <Field label="Queue"><Select value={queue} onChange={(e) => setQueue(e.target.value as typeof queue)}><option value="standard">Standard</option><option value="priority">Priority</option><option value="live">Live</option></Select></Field>
        <div className="md:col-span-3 space-y-2">
          <p className="text-xs text-muted-foreground">{tracker.nextRunAt && monthly ? `Next run: ${fmtDateTime(tracker.nextRunAt)} (UTC).` : "Not scheduled."}{hosted ? " Scheduled scans use your credits; a failed run because of low credits shows in the history." : ""} Grid size, radius and zoom can&rsquo;t change on an existing tracker, so history stays comparable. Create a new grid for a different shape.</p>
          <ErrorNote error={save.error} />
          <div className="flex gap-2">
            <Button type="submit" disabled={save.isPending}>Save</Button>
            {admin && <Button type="button" variant="destructive" onClick={() => { if (confirm("Delete this tracker? Its scans are kept but it stops appearing.")) archive.mutate(); }}>Delete tracker</Button>}
          </div>
        </div>
      </form>
    </Card>
  );
}
