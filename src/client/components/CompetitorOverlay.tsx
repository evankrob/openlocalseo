// Competitor overlay: pick one competitor and see where they rank on the same
// grid, or switch to a client-vs-competitor view. Built from the results the
// scan already stored: no extra scan, no extra cost.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { classifyHeadToHead } from "@/shared/overlay";
import { rankLabel } from "@/shared/rank";
import { get, put } from "../lib/api";
import { cn } from "../lib/cn";
import { fmtNum, fmtPct } from "../lib/format";
import type { OverlayCompetitor, ScanOverlay, ScanViewData } from "../lib/types";
import { RankLegend, RankMap, VersusLegend, type MapPoint } from "./RankMap";
import { Badge, Button, Card, CardHeader, EmptyState, ErrorNote, Select, Spinner } from "./ui";

type Mode = "rank" | "versus";
type Choice = "pinned" | "hidden" | "default";

export function CompetitorOverlay({ scanId, data, canEdit = true }: { scanId: string; data: ScanViewData; canEdit?: boolean }) {
  const qc = useQueryClient();
  const queryKey = ["scan", scanId, "overlay"];
  const q = useQuery({ queryKey, queryFn: () => get<ScanOverlay>(`/scans/${scanId}/overlay`) });
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("rank");
  const [pickId, setPickId] = useState("");
  const overlay = q.data;
  const trackerId = overlay?.trackerId;

  const choose = useMutation({
    mutationFn: (body: { identity: string; name: string; status: Choice }) => put(`/trackers/${trackerId}/competitors`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey }),
  });

  const current = overlay?.competitors.find((c) => c.identity === selected) ?? overlay?.competitors[0] ?? null;
  // Keep the selection valid when the list changes (hide / unpin).
  useEffect(() => {
    if (overlay && current && current.identity !== selected) setSelected(current.identity);
  }, [overlay, current, selected]);

  const points = useMemo<MapPoint[]>(() => {
    if (!overlay || !current) return [];
    const index = new Map(overlay.pointIds.map((id, i) => [id, i]));
    return data.points.map((p) => {
      const i = index.get(p.id);
      if (i === undefined) return { id: p.id, lat: p.lat, lng: p.lng, rank: null, status: p.status, skipReason: p.skipReason };
      const yours = overlay.clientRanks[i] ?? null;
      const theirs = current.ranks[i] ?? null;
      const top = overlay.pointTop[i] ?? [];
      const card = {
        title: `Point ${p.row + 1},${p.col + 1}`,
        lines: [`You: ${rankLabel(yours)} · ${current.name}: ${rankLabel(theirs)}`, "Top at this point:"],
        list: top.map((t) => ({ rank: t.rank, name: t.name, you: t.isTarget })),
      };
      return mode === "versus"
        ? { id: p.id, lat: p.lat, lng: p.lng, rank: theirs, status: p.status, versus: classifyHeadToHead(yours, theirs), card }
        : { id: p.id, lat: p.lat, lng: p.lng, rank: theirs, status: p.status, card };
    });
  }, [overlay, current, data.points, mode]);

  if (q.isLoading) return <Card className="p-6"><Spinner /></Card>;
  if (!overlay) return <ErrorNote error={q.error} />;

  const header = (
    <CardHeader
      title="Competitor overlay"
      description="Pick a competitor to see where they rank across the same grid. Built from this scan's stored results: no extra scan, no extra cost."
    />
  );
  if (overlay.expired) {
    return (
      <Card>
        {header}
        <EmptyState title={data.retentionDays ? `Overlay expired after ${data.retentionDays} days` : "Overlay expired"}>
          The per-point results of this scan were removed to save space, so competitors can no longer be mapped. The map and metrics above are kept.
        </EmptyState>
      </Card>
    );
  }
  if (overlay.competitors.length === 0 || !current) {
    return (
      <Card>
        {header}
        <EmptyState title="No competitors to show">
          {overlay.settings.hidden.length > 0 ? "Every competitor is hidden. Restore one below." : "This scan has no other businesses with a place ID or CID."}
        </EmptyState>
        {overlay.settings.hidden.length > 0 && canEdit && <HiddenList overlay={overlay} onRestore={(c) => choose.mutate({ ...c, status: "default" })} busy={choose.isPending} />}
      </Card>
    );
  }

  const pinnedCount = overlay.settings.pinned.length;
  const pinFull = pinnedCount >= overlay.settings.maxPinned;
  const h2h = current.headToHead;
  const addable = overlay.candidates.filter((c) => c.state === "available");

  return (
    <Card className="print-break">
      {header}
      <div className="grid gap-4 p-4 lg:grid-cols-[340px_1fr]">
        <div className="space-y-3">
          <div role="radiogroup" aria-label="Competitor" className="max-h-80 space-y-1.5 overflow-auto pr-1">
            {overlay.competitors.map((c) => (
              <CompetitorRow
                key={c.identity}
                c={c}
                active={c.identity === current.identity}
                onSelect={() => setSelected(c.identity)}
                canEdit={canEdit}
                busy={choose.isPending}
                onChoose={(status) => choose.mutate({ identity: c.identity, name: c.name, status })}
              />
            ))}
          </div>
          {canEdit && (
            <div className="space-y-2 text-sm">
              <label className="block text-xs font-medium text-muted-foreground" htmlFor="overlay-pin">
                Pin another business ({pinnedCount}/{overlay.settings.maxPinned})
              </label>
              <div className="flex gap-2">
                <Select id="overlay-pin" value={pickId} onChange={(e) => setPickId(e.target.value)} disabled={pinFull}>
                  <option value="">{pinFull ? "Pin limit reached: unpin one first" : "Choose a business…"}</option>
                  {addable.map((c) => <option key={c.identity} value={c.identity}>{c.name} ({c.top3Points} top-3)</option>)}
                </Select>
                <Button
                  variant="outline"
                  size="default"
                  disabled={!pickId || pinFull || choose.isPending}
                  onClick={() => {
                    const pick = addable.find((c) => c.identity === pickId);
                    if (pick) choose.mutate({ identity: pick.identity, name: pick.name, status: "pinned" }, { onSuccess: () => setPickId("") });
                  }}
                >
                  Pin
                </Button>
              </div>
              {choose.error && <ErrorNote error={choose.error} />}
            </div>
          )}
          {canEdit && <HiddenList overlay={overlay} onRestore={(c) => choose.mutate({ ...c, status: "default" })} busy={choose.isPending} />}
          <Notes overlay={overlay} />
        </div>

        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">{current.name}</div>
              <div className="truncate text-xs text-muted-foreground">
                {[current.category, current.rating ? `${current.rating.toFixed(1)}★ (${current.ratingCount ?? 0})` : null, current.address].filter(Boolean).join(" · ")}
              </div>
            </div>
            <div role="group" aria-label="Map view" className="inline-flex overflow-hidden rounded-lg border border-input text-sm">
              {([["rank", "Competitor rank"], ["versus", "You vs competitor"]] as const).map(([key, label]) => (
                <button key={key} type="button" aria-pressed={mode === key} onClick={() => setMode(key)} className={cn("h-9 px-3", mode === key ? "bg-primary text-primary-foreground" : "bg-card hover:bg-accent")}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            <Metric label="ATRP" value={fmtNum(current.metrics.atrp)} hint="Avg rank, not found = 21" />
            <Metric label="SoLV" value={fmtPct(current.metrics.solv)} hint="Top-3 share of points" />
            <Metric label="Found" value={`${current.metrics.foundPoints}/${current.metrics.totalPoints}`} hint="Points in top 20" />
            <Metric label="ARP" value={fmtNum(current.metrics.arp)} hint="Avg rank where found" />
            <Metric label="You vs them" value={`${h2h.wins}W ${h2h.losses}L${h2h.ties ? ` ${h2h.ties}T` : ""}`} hint={`${h2h.neither} points: neither in top 20`} />
          </dl>

          <RankMap points={points} business={data.business} className="h-[420px] sm:h-[480px]" />
          <div className="flex flex-wrap items-center justify-between gap-2">
            {mode === "rank" ? <RankLegend /> : <VersusLegend />}
            <span className="text-xs text-muted-foreground">Hover or tap a point to see who ranks there.</span>
          </div>
          {mode === "versus" && (
            <p className="text-sm" aria-live="polite">
              You rank higher at <strong>{h2h.wins}</strong> points, {current.name} at <strong>{h2h.losses}</strong>
              {h2h.ties ? <>, tied at <strong>{h2h.ties}</strong></> : null}; neither is in the top 20 at <strong>{h2h.neither}</strong>.
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-lg border border-border px-3 py-2">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
      <div className="text-[11px] leading-tight text-muted-foreground">{hint}</div>
    </div>
  );
}

function CompetitorRow({ c, active, onSelect, canEdit, busy, onChoose }: { c: OverlayCompetitor; active: boolean; onSelect: () => void; canEdit: boolean; busy: boolean; onChoose: (status: Choice) => void }) {
  return (
    <div className={cn("rounded-lg border px-3 py-2 text-sm", active ? "border-primary bg-primary/5" : "border-border")}>
      <button type="button" role="radio" aria-checked={active} onClick={onSelect} className="block w-full cursor-pointer text-left">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium">{c.name}</span>
          {c.source === "pinned" && <Badge tone="info">Pinned</Badge>}
          {c.possibleDuplicateOf.length > 0 && (
            <Badge tone="warning" title={`Same phone and nearly the same name as ${c.possibleDuplicateOf.join(", ")}. Listed separately, never merged.`}>
              Possible duplicate
            </Badge>
          )}
        </span>
        <span className="mt-0.5 block text-xs text-muted-foreground tabular-nums">
          ATRP {fmtNum(c.metrics.atrp)} · SoLV {fmtPct(c.metrics.solv)} · {c.headToHead.wins}W {c.headToHead.losses}L
        </span>
        {c.possibleDuplicateOf.length > 0 && <span className="mt-0.5 block text-xs text-muted-foreground">May be the same business as {c.possibleDuplicateOf.join(", ")} (same phone).</span>}
      </button>
      {canEdit && (
        <div className="mt-1 flex gap-1">
          {c.source === "pinned" ? (
            <Button variant="ghost" size="sm" className="h-7 px-2" disabled={busy} onClick={() => onChoose("default")}>Unpin</Button>
          ) : (
            <Button variant="ghost" size="sm" className="h-7 px-2" disabled={busy} onClick={() => onChoose("pinned")}>Pin</Button>
          )}
          <Button variant="ghost" size="sm" className="h-7 px-2" disabled={busy} onClick={() => onChoose("hidden")}>Hide</Button>
        </div>
      )}
    </div>
  );
}

function HiddenList({ overlay, onRestore, busy }: { overlay: ScanOverlay; onRestore: (c: { identity: string; name: string }) => void; busy: boolean }) {
  if (overlay.settings.hidden.length === 0) return null;
  return (
    <div className="text-sm">
      <div className="text-xs font-medium text-muted-foreground">Hidden ({overlay.settings.hidden.length})</div>
      <ul className="mt-1 space-y-1">
        {overlay.settings.hidden.map((h) => (
          <li key={h.identity} className="flex items-center justify-between gap-2">
            <span className="truncate">{h.name}</span>
            <Button variant="ghost" size="sm" className="h-7 shrink-0 px-2" disabled={busy} onClick={() => onRestore(h)}>Restore</Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Notes({ overlay }: { overlay: ScanOverlay }) {
  const left = overlay.excluded;
  if (left.length === 0 && overlay.unmatchedResults === 0) return null;
  return (
    <div className="space-y-1 rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
      {left.length > 0 && (
        <p>
          Left out as your own business: {left.map((e) => e.name).join(", ")}
          {left.some((e) => e.reason !== "client") ? " (duplicate listings or the same website)" : ""}.
        </p>
      )}
      {overlay.unmatchedResults > 0 && (
        <p>{overlay.unmatchedResults} results had no place ID or CID. They show at their point but cannot be followed across points, so they are never merged by name.</p>
      )}
    </div>
  );
}
