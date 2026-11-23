// Before/after comparison of two scans of one tracker: summary table, side-by-side
// maps, and a per-point change grid. Pure maths lives in src/shared/compare.ts.
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { cellAt, emptyGrid, setCell } from "@/shared/grid";
import {
  changeLabel, changeTitle, comparePoints, countChanges, foundCounts, metricRows, shapeMismatches,
  type MetricRow, type PointChange,
} from "@/shared/compare";
import { get } from "../lib/api";
import { cn } from "../lib/cn";
import { fmtDateTime, fmtNum, fmtPct } from "../lib/format";
import type { ScanDetail, ScanListItem } from "../lib/types";
import { RankLegend, RankMap } from "./RankMap";
import { ScannedNote } from "./ScanView";
import { Card, CardHeader, EmptyState, Spinner } from "./ui";

type View = "side" | "change";

const KIND_CLASS: Record<PointChange["kind"], string> = {
  improved: "bg-success/20 text-success border-success/50",
  new: "bg-success/30 text-success border-success/60",
  declined: "bg-destructive/15 text-destructive border-destructive/50",
  lost: "bg-destructive/25 text-destructive border-destructive/60",
  unchanged: "bg-muted text-muted-foreground border-border",
  unknown: "bg-card text-muted-foreground border-dashed border-border",
};

const VERDICT_CLASS = { better: "text-success", worse: "text-destructive", same: "text-muted-foreground" } as const;

function fmtMetric(row: MetricRow, value: number | null) {
  return row.unit === "pct" ? fmtPct(value) : fmtNum(value);
}

function fmtDelta(row: MetricRow) {
  if (row.delta === null) return "-";
  const sign = row.delta > 0 ? "+" : "";
  return `${sign}${row.delta.toFixed(row.unit === "pct" ? 1 : 2)}${row.unit === "pct" ? " pts" : ""}`;
}

const scanLabel = (s: ScanListItem) => fmtDateTime(s.createdAt);

export function CompareView({ scans }: { scans: ScanListItem[] }) {
  // `scans` is newest first: default Before = second newest, After = newest.
  const [before, setBefore] = useState(scans[1]?.id ?? "");
  const [after, setAfter] = useState(scans[0]?.id ?? "");
  const [view, setView] = useState<View>("side");
  const qa = useQuery({ queryKey: ["scan", before], queryFn: () => get<ScanDetail>(`/scans/${before}`), enabled: !!before });
  const qb = useQuery({ queryKey: ["scan", after], queryFn: () => get<ScanDetail>(`/scans/${after}`), enabled: !!after });

  const same = before === after;
  const a = qa.data;
  const b = qb.data;
  const mismatch = a && b ? shapeMismatches({ ...a.scan }, { ...b.scan }) : [];
  const ready = !!a && !!b && !same && mismatch.length === 0;
  const changes = useMemo(() => (ready ? comparePoints(a.points, b.points) : []), [ready, a, b]);
  const anySkipped = [a, b].some((d) => (d?.scan.skippedPoints ?? 0) > 0);

  if (scans.length < 2) return <Card><EmptyState title="Need two completed scans to compare">Run another scan, or wait for the next scheduled one.</EmptyState></Card>;

  const pickers = ([["Before", before, setBefore, after], ["After", after, setAfter, before]] as const).map(([label, value, setter, other]) => (
    <label key={label} className="flex min-w-0 flex-1 items-center gap-2 text-sm">
      <span className="w-12 shrink-0 font-medium">{label}</span>
      <select
        data-testid={`compare-pick-${label.toLowerCase()}`}
        value={value}
        onChange={(e) => setter(e.target.value)}
        aria-invalid={value === other}
        className={cn("h-9 w-full min-w-0 rounded-lg border bg-card px-2 text-sm", value === other ? "border-destructive" : "border-input")}
      >
        {scans.map((s) => <option key={s.id} value={s.id}>{scanLabel(s)}</option>)}
      </select>
    </label>
  ));

  return (
    <div className="space-y-4" data-testid="compare">
      <Card className="flex flex-col gap-3 p-3 md:flex-row md:items-center">
        <div className="flex flex-1 flex-col gap-2 md:flex-row md:gap-4">{pickers}</div>
        <div className="flex items-center gap-2">
          <button type="button" data-testid="compare-swap" onClick={() => { setBefore(after); setAfter(before); }} className="h-9 rounded-lg border border-input px-3 text-sm hover:bg-accent" title="Swap Before and After">⇄ Swap</button>
          <div role="group" aria-label="Compare view" data-testid="compare-toggle" className="flex rounded-lg border border-input p-0.5 text-sm">
            {([["side", "Side by side"], ["change", "Change"]] as const).map(([key, label]) => (
              <button key={key} type="button" aria-pressed={view === key} data-testid={`compare-toggle-${key}`} onClick={() => setView(key)} className={cn("rounded-md px-3 py-1.5", view === key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}>{label}</button>
            ))}
          </div>
        </div>
      </Card>

      {same && <Card className="border-warning/60 px-5 py-3 text-sm" data-testid="compare-same-warning">Pick two different scans: Before and After are the same scan.</Card>}
      {!same && mismatch.length > 0 && (
        <Card className="border-warning/60 px-5 py-3 text-sm" data-testid="compare-shape-warning">
          These scans use a different {mismatch.join(", ")}, so their points can&apos;t be matched. Pick two scans with the same grid settings.
        </Card>
      )}
      {!same && mismatch.length === 0 && (!a || !b) && <Spinner />}

      {ready && (
        <>
          <Summary before={a} after={b} changes={changes} />
          {view === "side" ? (
            <div className="grid gap-4 md:grid-cols-2" data-testid="compare-side">
              {([["Before", a], ["After", b]] as const).map(([label, data]) => (
                <Card key={label} className="space-y-2 p-3">
                  <div className="px-1 text-sm"><span className="font-medium">{label}</span> <span className="text-muted-foreground">{fmtDateTime(data.scan.createdAt)}</span></div>
                  <RankMap className="h-[320px] md:h-[380px]" points={data.points} business={data.business} small={data.points.length > 100} />
                  {data.metrics && data.scan.skippedPoints > 0 && <div className="px-1"><ScannedNote scanned={data.metrics.totalPoints} gridPoints={data.scan.gridSize ** 2} skipped={data.scan.skippedPoints} /></div>}
                </Card>
              ))}
            </div>
          ) : (
            <Card className="space-y-3 p-3">
              <ChangeGrid changes={changes} gridSize={b.scan.gridSize} />
            </Card>
          )}
          {view === "side" ? <RankLegend showSkipped={anySkipped} /> : <ChangeLegend />}
          {anySkipped && <p className="text-xs text-muted-foreground">Skipped points are left out of both scans&rsquo; metrics, so the change compares the points each scan actually searched. A different set of skipped points between two scans means the two averages cover slightly different places.</p>}
        </>
      )}
    </div>
  );
}

function Summary({ before, after, changes }: { before: ScanDetail; after: ScanDetail; changes: PointChange[] }) {
  const rows = metricRows(before.metrics, after.metrics);
  const counts = countChanges(changes);
  const fb = foundCounts(before.points);
  const fa = foundCounts(after.points);
  const bands: Array<[string, number, number, boolean]> = [
    ["Points in top 3", fb.top3, fa.top3, true],
    ["Points in top 10", fb.top10, fa.top10, true],
    ["Not found (21+)", fb.notFound, fa.notFound, false],
  ];
  const pruned = [before, after].some((d) => d.competitorsExpired);
  return (
    <Card data-testid="compare-summary">
      <CardHeader title="What changed" description="Lower ATRP and ARP are better; higher SoLV is better (change in percentage points)." />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th className="px-4 py-2 font-medium">Metric</th><th className="px-3 py-2 text-right font-medium">Before</th><th className="px-3 py-2 text-right font-medium">After</th><th className="px-4 py-2 text-right font-medium">Change</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border tabular-nums">
            {rows.map((row) => (
              <tr key={row.key} data-testid={`compare-metric-${row.key}`}>
                <td className="px-4 py-2 font-medium">{row.label} <span className="text-xs font-normal text-muted-foreground">{row.lowerIsBetter ? "lower is better" : "higher is better"}</span></td>
                <td className="px-3 py-2 text-right">{fmtMetric(row, row.before)}</td>
                <td className="px-3 py-2 text-right">{fmtMetric(row, row.after)}</td>
                <td className={cn("px-4 py-2 text-right font-semibold", row.verdict && VERDICT_CLASS[row.verdict])}>{fmtDelta(row)}</td>
              </tr>
            ))}
            {bands.map(([label, b, a, higherIsBetter]) => {
              const d = a - b;
              const verdict = d === 0 ? "same" : (d > 0) === higherIsBetter ? "better" : "worse";
              return (
                <tr key={label}>
                  <td className="px-4 py-2">{label}</td>
                  <td className="px-3 py-2 text-right">{b}</td>
                  <td className="px-3 py-2 text-right">{a}</td>
                  <td className={cn("px-4 py-2 text-right font-semibold", VERDICT_CLASS[verdict])}>{d > 0 ? "+" : ""}{d}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-1 border-t border-border px-4 py-3 text-sm" data-testid="compare-counts">
        <span><b className="text-success">{counts.improved}</b> improved{counts.newlyFound > 0 && <span className="text-xs text-muted-foreground"> ({counts.newlyFound} newly found)</span>}</span>
        <span><b className="text-destructive">{counts.declined}</b> declined{counts.lost > 0 && <span className="text-xs text-muted-foreground"> ({counts.lost} lost)</span>}</span>
        <span><b>{counts.unchanged}</b> unchanged</span>
        {counts.unknown > 0 && <span className="text-muted-foreground"><b>{counts.unknown}</b> not comparable (failed or skipped)</span>}
      </div>
      {(!before.metrics || !after.metrics) && <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">Metrics are missing for one of these scans; per-point changes below still use the saved grid ranks.</p>}
      {pruned && <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">Competitor detail has expired for one of these scans. Grid ranks and metrics are kept, so this comparison is unaffected.</p>}
    </Card>
  );
}

function ChangeGrid({ changes, gridSize }: { changes: PointChange[]; gridSize: number }) {
  const grid = useMemo(() => {
    const g = emptyGrid<PointChange | null>(gridSize, null);
    for (const c of changes) if (c.row < gridSize && c.col < gridSize) setCell(g, c.row, c.col, c);
    return g;
  }, [changes, gridSize]);
  const dense = gridSize > 11;
  return (
    <div className="mx-auto w-full max-w-[640px]" data-testid="compare-delta-grid" role="grid" aria-label="Rank change per grid point, north at top">
      <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${gridSize}, minmax(0, 1fr))` }}>
        {Array.from({ length: gridSize * gridSize }, (_, i) => {
          const row = Math.floor(i / gridSize);
          const col = i % gridSize;
          const c = cellAt(grid, row, col);
          if (!c) return <div key={i} className="aspect-square rounded border border-dashed border-border" />;
          return (
            <button
              key={i}
              type="button"
              title={changeTitle(c)}
              aria-label={`Row ${row + 1}, column ${col + 1}: ${changeTitle(c)}`}
              data-testid="compare-delta-cell"
              data-kind={c.kind}
              className={cn("flex aspect-square flex-col items-center justify-center rounded border font-semibold leading-none", dense ? "text-[9px] sm:text-[11px]" : "text-[11px] sm:text-sm", KIND_CLASS[c.kind])}
            >
              {changeLabel(c)}
              {!dense && c.kind !== "unknown" && <span className="mt-0.5 hidden text-[10px] font-normal opacity-80 sm:block">{c.before ?? "20+"}→{c.after ?? "20+"}</span>}
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-center text-xs text-muted-foreground">North is up. Tap or hover a point to see before → after.</p>
    </div>
  );
}

function ChangeLegend() {
  const items: Array<[PointChange["kind"], string]> = [
    ["improved", "▲ moved up"], ["declined", "▼ moved down"], ["unchanged", "= same"], ["new", "new: now found"], ["lost", "lost: no longer found"], ["unknown", "- failed or skipped"],
  ];
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Change legend">
      {items.map(([kind, label]) => (
        <li key={kind} className="flex items-center gap-1.5"><span className={cn("inline-block size-3.5 rounded border", KIND_CLASS[kind])} />{label}</li>
      ))}
    </ul>
  );
}
