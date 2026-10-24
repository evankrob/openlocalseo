import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router-dom";
import { diffMetrics } from "@/shared/metrics";
import { del, get, patch, post } from "../lib/api";
import { cn } from "../lib/cn";
import { fmtDateTime, fmtNum, fmtPct, fmtUsd } from "../lib/format";
import type { Me, PointResults, ScanDetail, ScanListItem, ScanViewData, TrackerSummary } from "../lib/types";
import { RankLegend, RankMap } from "../components/RankMap";
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
  const done = q.data.points.filter((p) => p.status === "completed" || p.status === "failed").length;
  const total = q.data.points.length;
  return (
    <Card className="flex items-center gap-4 border-primary/40 px-5 py-4" role="status">
      <Spinner />
      <div className="flex-1">
        <div className="font-medium">Scan in progress ({status})</div>
        <div className="text-sm text-muted-foreground">
          {done} of {total} points collected. The {q.data.scan.queueMode} queue can take {q.data.scan.queueMode === "standard" ? "a few minutes" : "under a minute"}; you can leave this page.
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
  const [tab, setTab] = useState<"latest" | "history" | "compare" | "share" | "settings">("latest");

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
  const run = useMutation({ mutationFn: () => post(`/trackers/${id}/scans`, {}), onSuccess: refresh });

  if (tracker.isLoading) return <Spinner />;
  if (!tracker.data) return <ErrorNote error={tracker.error ?? new Error("Tracker not found")} />;
  const t = tracker.data;
  const hosted = me.config.billingMode === "hosted";

  return (
    <>
      <PageHeader
        title={<>{t.business.name} <span className="font-normal text-muted-foreground">&ldquo;{t.keyword}&rdquo;</span></>}
        description={`${t.gridSize}x${t.gridSize} grid, ${t.radiusKm.toFixed(1)} km radius, ${t.searchType === "maps" ? "Google Maps" : "Local Finder"}, ${t.queueMode} queue`}
        actions={<Button disabled={!!active || run.isPending} onClick={() => run.mutate()}>{active ? "Scan running" : "Run scan now"}</Button>}
      />
      <ErrorNote error={run.error} />
      {active && <ScanProgress scanId={active.id} onDone={refresh} />}
      {!active && scans.data?.[0]?.status === "failed" && (
        <Card className="border-destructive/40 px-5 py-3 text-sm"><Badge tone="danger" className="mr-2">Last scan failed</Badge>{scans.data[0].error}</Card>
      )}

      <div className="no-print flex gap-1 border-b border-border" role="tablist">
        {([["latest", "Latest scan"], ["history", "History & trends"], ["compare", "Compare"], ["share", "Client report"], ["settings", "Schedule"]] as const).map(([key, label]) => (
          <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)} className={cn("-mb-px border-b-2 px-4 py-2 text-sm", tab === key ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground")}>{label}</button>
        ))}
      </div>

      {tab === "latest" && (latest ? <LatestScan scanId={latest.id} /> : <Card><EmptyState title="No completed scan yet">Run a scan to see the heatmap.</EmptyState></Card>)}
      {tab === "history" && <History trackerId={id} scans={scans.data ?? []} />}
      {tab === "compare" && <Compare scans={completed} />}
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
      <ScanView data={toViewData(q.data)} loadPoint={loadScanPoint(scanId)} queryKey={["scan", scanId]} />
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

function Compare({ scans }: { scans: ScanListItem[] }) {
  const [a, setA] = useState(scans[1]?.id ?? scans[0]?.id ?? "");
  const [b, setB] = useState(scans[0]?.id ?? "");
  const qa = useQuery({ queryKey: ["scan", a], queryFn: () => get<ScanDetail>(`/scans/${a}`), enabled: !!a });
  const qb = useQuery({ queryKey: ["scan", b], queryFn: () => get<ScanDetail>(`/scans/${b}`), enabled: !!b });
  if (scans.length < 2) return <Card><EmptyState title="Need two completed scans to compare">Run another scan, or wait for the next scheduled one.</EmptyState></Card>;
  const diff = qa.data?.metrics && qb.data?.metrics ? diffMetrics(qb.data.metrics, qa.data.metrics) : null;
  const sign = (n: number | null, goodWhenNegative: boolean) =>
    n === null ? "-" : <span className={cn("font-semibold", n === 0 ? "" : (n < 0) === goodWhenNegative ? "text-success" : "text-destructive")}>{n > 0 ? "+" : ""}{n.toFixed(2)}</span>;
  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        {([["Before", a, setA, qa.data], ["After", b, setB, qb.data]] as const).map(([label, value, setter, data]) => (
          <Card key={label} className="space-y-3 p-3">
            <div className="flex items-center gap-3 px-1">
              <span className="text-sm font-medium">{label}</span>
              <Select value={value} onChange={(e) => setter(e.target.value)}>{scans.map((s) => <option key={s.id} value={s.id}>{fmtDateTime(s.createdAt)}</option>)}</Select>
            </div>
            {data ? <RankMap className="h-[380px]" points={data.points} business={data.business} small={data.points.length > 100} /> : <Spinner />}
            {data?.metrics && <div className="px-1 text-sm tabular-nums">ATRP {fmtNum(data.metrics.atrp)} &middot; ARP {fmtNum(data.metrics.arp)} &middot; SoLV {fmtPct(data.metrics.solv)}</div>}
          </Card>
        ))}
      </div>
      {diff && (
        <Card className="flex flex-wrap items-center gap-x-8 gap-y-2 px-5 py-4 text-sm">
          <span className="font-medium">Change</span>
          <span>ATRP {sign(diff.atrp, true)} <span className="text-xs text-muted-foreground">(lower is better)</span></span>
          <span>ARP {sign(diff.arp, true)}</span>
          <span>SoLV {sign(diff.solv, false)}<span className="text-xs text-muted-foreground"> pts</span></span>
        </Card>
      )}
      <RankLegend />
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
