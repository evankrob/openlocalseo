// The white-label client report. No login; styled with the workspace's brand.
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useParams } from "react-router-dom";
import { get } from "../lib/api";
import { fmtDate } from "../lib/format";
import type { CompetitorSummary, PointResults, ScanMetrics } from "../lib/types";
import { ScanView } from "../components/ScanView";
import { TrendCharts } from "../components/TrendCharts";
import { Button, Card, EmptyState, Select, Spinner } from "../components/ui";

type Report = {
  branding: { brandName: string | null; logoUrl: string | null; primaryColor: string | null; footerText: string | null; contactUrl: string | null; hideAttribution: boolean };
  label: string | null;
  showCompetitors: boolean;
  business: { name: string; address: string | null };
  keyword: string;
  history: Array<{ id: string; createdAt: string; arp: number | null; atrp: number | null; solv: number | null }>;
  scan: null | {
    id: string; createdAt: string; gridSize: number; radiusKm: number; zoom: number; searchType: "maps" | "local_finder"; keyword: string;
    points: Array<{ id: string; row: number; col: number; lat: number; lng: number; rank: number | null; status: string }>;
    metrics: ScanMetrics | null;
    business: { lat: number; lng: number; name: string };
  };
  competitors: CompetitorSummary[];
};

export function PublicReport() {
  const { token = "" } = useParams();
  const [scanId, setScanId] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["public-report", token, scanId],
    queryFn: () => get<Report>(`/public/reports/${token}${scanId ? `?scan=${scanId}` : ""}`),
    retry: false,
  });
  if (q.isLoading) return <div className="grid h-full place-items-center"><Spinner className="size-6" /></div>;
  if (!q.data) return <div className="grid h-full place-items-center p-6"><EmptyState title="This report is not available">The link may have expired or been turned off. Ask the sender for a new one.</EmptyState></div>;
  const r = q.data;
  const accent = r.branding.primaryColor ?? undefined;

  return (
    <div className="h-full overflow-auto bg-background" style={accent ? ({ "--primary": accent } as React.CSSProperties) : undefined}>
      <div className="mx-auto max-w-6xl space-y-6 p-4 md:p-8">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b-4 pb-4" style={{ borderColor: accent ?? "var(--primary)" }}>
          <div className="flex items-center gap-3">
            {r.branding.logoUrl && <img src={r.branding.logoUrl} alt="" className="h-10 max-w-40 object-contain" referrerPolicy="no-referrer" />}
            <div className="text-lg font-semibold">{r.branding.brandName}</div>
          </div>
          <Button variant="outline" className="no-print" onClick={() => window.print()}>Print / save as PDF</Button>
        </header>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Local rank report: {r.business.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Keyword &ldquo;{r.keyword}&rdquo; &middot; {r.scan ? `scan from ${fmtDate(r.scan.createdAt)}` : "no completed scan yet"}
            {r.business.address ? ` · ${r.business.address}` : ""}
          </p>
          {r.history.length > 1 && (
            <div className="no-print mt-3 max-w-xs"><Select aria-label="Choose scan date" value={r.scan?.id ?? ""} onChange={(e) => setScanId(e.target.value)}>{[...r.history].reverse().map((h) => <option key={h.id} value={h.id}>{fmtDate(h.createdAt)}</option>)}</Select></div>
          )}
        </div>
        {r.scan ? (
          <ScanView
            queryKey={["public", token, r.scan.id]}
            showCompetitors={r.showCompetitors}
            loadPoint={r.showCompetitors ? (pointId: string) => get<PointResults>(`/public/reports/${token}/points/${pointId}?scan=${r.scan!.id}`) : undefined}
            data={{ ...r.scan, business: r.scan.business, competitors: r.competitors }}
          />
        ) : <Card><EmptyState title="No completed scan yet" /></Card>}
        <TrendCharts history={r.history} />
        <p className="text-xs text-muted-foreground">
          Each pin is a search as if a customer were standing at that spot, on a {r.scan?.searchType === "local_finder" ? "Google Local Finder" : "Google Maps"} results list at a fixed zoom. Rank 1 is the top result. Results can differ from what an individual sees because of personalization.
        </p>
        <footer className="space-y-1 border-t border-border pt-4 text-sm text-muted-foreground">
          {r.branding.footerText && <p>{r.branding.footerText}</p>}
          {r.branding.contactUrl && <p><a className="underline" href={r.branding.contactUrl} target="_blank" rel="noreferrer noopener">Contact {r.branding.brandName ?? "us"}</a></p>}
          {!r.branding.hideAttribution && <p className="text-xs">Powered by OpenLocalSEO &middot; Map data &copy; OpenStreetMap contributors</p>}
        </footer>
      </div>
    </div>
  );
}
