import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { get } from "../lib/api";
import { fmtDate, fmtNum, fmtPct } from "../lib/format";
import type { TrackerSummary } from "../lib/types";
import { Badge, Button, Card, EmptyState, ErrorNote, Spinner } from "../components/ui";
import { PageHeader } from "./shell";

export const statusTone = (status: string) =>
  status === "completed" ? "success" : status === "failed" ? "danger" : "info";

export function Dashboard() {
  const q = useQuery({
    queryKey: ["trackers"],
    queryFn: () => get<TrackerSummary[]>("/trackers"),
    refetchInterval: (query) => (query.state.data?.some((t) => t.latestScan && ["queued", "posting", "polling"].includes(t.latestScan.status)) ? 4000 : false),
  });
  return (
    <>
      <PageHeader
        title="Rank grids"
        description="Where each client ranks in Google Maps, point by point across their service area."
        actions={<Link to="/trackers/new"><Button>New grid scan</Button></Link>}
      />
      <ErrorNote error={q.error} />
      {q.isLoading && <Spinner />}
      {q.data?.length === 0 && (
        <Card>
          <EmptyState title="No grid scans yet">
            <Link className="text-primary underline" to="/businesses">Add a business</Link>, then build a grid for a keyword.
            <div className="mt-2">Want to see it with data first? Run <code>npm run db:seed:local</code> to load the fictional demo business.</div>
          </EmptyState>
        </Card>
      )}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {q.data?.map((t) => {
          const done = t.lastCompleted;
          const active = t.latestScan && !["completed", "failed"].includes(t.latestScan.status);
          return (
            <Link key={t.id} to={`/trackers/${t.id}`}>
              <Card className="space-y-3 p-5 transition-shadow hover:shadow-md">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-semibold">{t.business.name}</div>
                    <div className="truncate text-sm text-muted-foreground">&ldquo;{t.keyword}&rdquo; &middot; {t.gridSize}x{t.gridSize}</div>
                  </div>
                  {active ? <Badge tone="info">Scanning</Badge> : t.latestScan?.status === "failed" ? <Badge tone="danger">Last scan failed</Badge> : null}
                </div>
                {done ? (
                  <div className="grid grid-cols-3 gap-2 text-sm">
                    <div><div className="text-xs text-muted-foreground">ATRP</div><div className="text-lg font-semibold tabular-nums">{fmtNum(done.atrp)}</div></div>
                    <div><div className="text-xs text-muted-foreground">ARP</div><div className="text-lg font-semibold tabular-nums">{fmtNum(done.arp)}</div></div>
                    <div><div className="text-xs text-muted-foreground">SoLV</div><div className="text-lg font-semibold tabular-nums">{fmtPct(done.solv)}</div></div>
                  </div>
                ) : (
                  <div className="text-sm text-muted-foreground">No completed scan yet.</div>
                )}
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>{done ? `Scanned ${fmtDate(done.createdAt)}` : ""}</span>
                  <span>{t.scheduleFrequency === "monthly" && t.nextRunAt ? `Next scan ${fmtDate(t.nextRunAt)}` : "Not scheduled"}</span>
                </div>
              </Card>
            </Link>
          );
        })}
      </div>
    </>
  );
}
