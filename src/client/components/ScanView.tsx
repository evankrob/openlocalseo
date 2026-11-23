import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { rankLabel } from "@/shared/rank";
import { cn } from "../lib/cn";
import { fmtNum, fmtPct } from "../lib/format";
import type { CompetitorSummary, PointResults, ScanMetrics, ScanViewData } from "../lib/types";
import { SKIP_REASON_LABEL } from "@/shared/skip/plan";
import { SHORE_TOLERANCE_M } from "@/shared/skip/water";
import { RankLegend, RankMap } from "./RankMap";
import { Badge, Card, CardHeader, EmptyState, Spinner, Stat, Table, Td, Th } from "./ui";

/** "x of y points scanned": skipped points are left out of every metric, so say how many counted. */
export function ScannedNote({ scanned, gridPoints, skipped }: { scanned: number; gridPoints: number; skipped: number }) {
  return (
    <div className="mt-1 text-xs font-medium text-foreground/80" title={skipped ? `${skipped} skipped point${skipped === 1 ? " is" : "s are"} not counted in any metric` : undefined}>
      {scanned} of {gridPoints} points scanned
    </div>
  );
}

export function MetricCards({ metrics, gridPoints, skipped = 0 }: { metrics: ScanMetrics | null; gridPoints?: number; skipped?: number }) {
  const note = metrics && gridPoints ? <ScannedNote scanned={metrics.totalPoints} gridPoints={gridPoints} skipped={skipped} /> : null;
  const hint = (text: string) => (
    <>
      {text}
      {note}
    </>
  );
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <Stat label="ATRP" value={fmtNum(metrics?.atrp)} hint={hint("Average rank, scanned points (not found = 21). Lower is better.")} />
      <Stat label="ARP" value={fmtNum(metrics?.arp)} hint={hint("Average rank where found.")} />
      <Stat label="SoLV" value={fmtPct(metrics?.solv)} hint={hint("Share of scanned points ranking top 3.")} />
      <Stat label="Found" value={metrics ? `${metrics.foundPoints}/${metrics.totalPoints}` : "-"} hint={hint("Scanned points where the business shows in the top 20.")} />
    </div>
  );
}

export function PointPanel({ loader, pointId, queryKey }: { loader?: (pointId: string) => Promise<PointResults>; pointId: string | null; queryKey: unknown[] }) {
  const q = useQuery({ queryKey: [...queryKey, pointId], queryFn: () => loader!(pointId!), enabled: !!loader && !!pointId });
  if (!loader) return null;
  if (!pointId) return <EmptyState title="Select a pin">See who ranks where a customer would be standing.</EmptyState>;
  if (q.isLoading) return <div className="p-6"><Spinner /></div>;
  if (!q.data) return <EmptyState title="Could not load this point" />;
  const { point, results, competitorsExpired } = q.data;
  if (point.status === "skipped") {
    const reason = point.skipReason ?? "user";
    return (
      <div className="px-4 py-3 text-sm">
        <div className="font-medium">
          Point {point.row + 1},{point.col + 1} <span className="text-muted-foreground">({point.lat.toFixed(4)}, {point.lng.toFixed(4)})</span>
        </div>
        <Badge tone="neutral" className="mt-2">{SKIP_REASON_LABEL[reason]}</Badge>
        <p className="mt-2 text-muted-foreground">
          This point was not searched and not charged, and it is left out of every metric on this scan.
          {reason === "water" && ` It sits on open water, more than ${SHORE_TOLERANCE_M} m from the nearest shore.`}
          {reason === "outside_area" && " It is outside the business's service area."}
          {reason === "user" && " It was switched off for this grid."}
        </p>
      </div>
    );
  }
  return (
    <div>
      <div className="border-b border-border px-4 py-3 text-sm">
        <div className="font-medium">
          Point {point.row + 1},{point.col + 1} <span className="text-muted-foreground">({point.lat.toFixed(4)}, {point.lng.toFixed(4)})</span>
        </div>
        <div className="text-muted-foreground">Your rank here: <strong className="text-foreground">{rankLabel(point.rank)}</strong></div>
      </div>
      {results.length === 0 ? (
        competitorsExpired ? <EmptyState title="Competitor detail expired">The list of businesses at this point is no longer stored. Your rank above is kept.</EmptyState> : <EmptyState title="No results at this point" />
      ) : (
        <ol className="max-h-[420px] divide-y divide-border/60 overflow-auto">
          {results.map((r) => (
            <li key={`${r.rank}-${r.name}`} className={cn("flex items-start gap-3 px-4 py-2 text-sm", r.isTarget && "bg-primary/10")}>
              <span className="w-6 shrink-0 text-right font-semibold tabular-nums">{r.rank}</span>
              <span className="min-w-0">
                <span className="block truncate font-medium">{r.name}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {[r.category, r.rating ? `${r.rating.toFixed(1)}★ (${r.ratingCount ?? 0})` : null].filter(Boolean).join(" · ")}
                </span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function CompetitorsTable({ competitors, targetName }: { competitors: CompetitorSummary[]; targetName: string }) {
  if (competitors.length === 0) return <EmptyState title="No competitor data yet" />;
  return (
    <Table>
      <thead>
        <tr>
          <Th>#</Th>
          <Th>Business</Th>
          <Th className="text-right">ATRP</Th>
          <Th className="text-right">ARP</Th>
          <Th className="text-right">SoLV</Th>
          <Th className="text-right">Points</Th>
          <Th className="text-right">Rating</Th>
        </tr>
      </thead>
      <tbody>
        {competitors.map((c, i) => (
          <tr key={c.key} className={cn(c.name === targetName && "bg-primary/10 font-medium")}>
            <Td className="tabular-nums text-muted-foreground">{i + 1}</Td>
            <Td>
              <div>{c.name}{c.name === targetName && <Badge tone="info" className="ml-2">You</Badge>}</div>
              {c.category && <div className="text-xs text-muted-foreground">{c.category}</div>}
            </Td>
            <Td className="text-right tabular-nums">{fmtNum(c.atrp)}</Td>
            <Td className="text-right tabular-nums">{fmtNum(c.arp)}</Td>
            <Td className="text-right tabular-nums">{fmtPct(c.solv)}</Td>
            <Td className="text-right tabular-nums">{c.foundPoints}/{c.totalPoints}</Td>
            <Td className="text-right tabular-nums">{c.rating ? `${c.rating.toFixed(1)} (${c.ratingCount ?? 0})` : "-"}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/** Heatmap + metrics + per-point drill-down + competitor table for one scan. */
export function ScanView({
  data,
  loadPoint,
  showCompetitors = true,
  queryKey,
}: {
  data: ScanViewData;
  loadPoint?: (pointId: string) => Promise<PointResults>;
  showCompetitors?: boolean;
  queryKey: unknown[];
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const sourceLabel = data.searchType === "maps" ? "Google Maps" : "Google Local Finder";
  return (
    <div className="space-y-4">
      <MetricCards metrics={data.metrics} gridPoints={data.gridSize * data.gridSize} skipped={data.skippedPoints} />
      <div className={cn("grid gap-4", loadPoint ? "lg:grid-cols-[1fr_340px]" : "")}>
        <Card className="p-3 print-break">
          <RankMap points={data.points} business={data.business} selectedId={selected} onSelect={setSelected} />
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 px-1">
            <RankLegend showSkipped={(data.skippedPoints ?? 0) > 0} />
            <span className="text-xs text-muted-foreground">
              {data.gridSize}x{data.gridSize} grid &middot; {sourceLabel} &middot; zoom {data.zoom}z
            </span>
          </div>
        </Card>
        {loadPoint && (
          <Card className="no-print self-start">
            <PointPanel loader={loadPoint} pointId={selected} queryKey={[...queryKey, "point"]} />
          </Card>
        )}
      </div>
      {showCompetitors && (
        <Card className="print-break">
          <CardHeader title="Competitors" description="Every business seen in this scan, scored over the same grid points. Computed from the same results, at no extra cost." />
          {data.competitorsExpired ? (
            <EmptyState title={data.retentionDays ? `Competitor detail expired after ${data.retentionDays} days` : "Competitor detail expired"}>
              The per-business results of this scan were removed to save space. The map and metrics above are kept.
            </EmptyState>
          ) : (
            <CompetitorsTable competitors={data.competitors} targetName={data.business.name} />
          )}
        </Card>
      )}
    </div>
  );
}

/** Warns when the tracked website ranked under a different Google listing than the tracked place ID. */
export function OtherListingsNote({ listings }: { listings?: Array<{ name: string; placeId: string | null; points: number; bestRank: number }> }) {
  if (!listings || listings.length === 0) return null;
  return (
    <Card className="border-amber-300 bg-amber-50 p-4 text-sm dark:bg-amber-950/30">
      <p className="font-medium">Your website showed up under a different Google listing</p>
      <ul className="mt-1 list-disc pl-5">
        {listings.map((l) => (
          <li key={l.placeId ?? l.name}>
            {l.name} (place ID <code>{l.placeId ?? "unknown"}</code>) at {l.points} point{l.points === 1 ? "" : "s"}, best rank #{l.bestRank}
          </li>
        ))}
      </ul>
      <p className="mt-1 text-muted-foreground">This scan only counts the place ID saved on the business. If that listing is the one you want, add a business with its place ID.</p>
    </Card>
  );
}
