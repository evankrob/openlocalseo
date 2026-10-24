import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import type { AlertMetricsSide } from "@/shared/alerts";
import { get, post } from "../lib/api";
import { fmtDateTime, fmtNum, fmtPct } from "../lib/format";
import type { AlertList, AlertListItem } from "../lib/types";
import { Badge, Button, Card, EmptyState, ErrorNote, Spinner, Table, Td, Th } from "../components/ui";
import { PageHeader } from "./shell";

export const ALERTS_KEY = ["alerts"] as const;

/** Unread count + list, shared by the nav badge, the dashboard banner and this page. */
export function useAlerts(enabled = true) {
  return useQuery({ queryKey: ALERTS_KEY, queryFn: () => get<AlertList>("/alerts?limit=100"), refetchInterval: 60_000, enabled });
}

const REASON_LABEL: Record<string, string> = {
  atrp: "ATRP worse",
  solv: "SoLV down",
  found_points: "Fewer points found",
  center_top3: "Lost top 3 at center",
  failed_points: "Most points failed",
};

function Change({ label, before, after, format }: { label: string; before: number | null | undefined; after: number | null | undefined; format: (n: number | null | undefined) => string }) {
  return (
    <div className="whitespace-nowrap tabular-nums">
      <span className="text-xs text-muted-foreground">{label} </span>
      {format(before)} &rarr; <span className="font-medium">{format(after)}</span>
    </div>
  );
}

function Metrics({ alert }: { alert: AlertListItem }) {
  const { before, after } = alert.metrics;
  if (alert.kind === "data_problem") {
    return <div className="tabular-nums">{after.failedPoints ?? 0} of {after.totalPoints} points failed</div>;
  }
  const found = (side: AlertMetricsSide | null) => (side?.foundPoints == null ? "-" : `${side.foundPoints}/${side.totalPoints}`);
  return (
    <>
      <Change label="ATRP" before={before?.atrp} after={after.atrp} format={(n) => fmtNum(n)} />
      <Change label="SoLV" before={before?.solv} after={after.solv} format={fmtPct} />
      <div className="whitespace-nowrap tabular-nums"><span className="text-xs text-muted-foreground">Found </span>{found(before)} &rarr; <span className="font-medium">{found(after)}</span></div>
    </>
  );
}

export function AlertsPage() {
  const qc = useQueryClient();
  const q = useAlerts();
  const refresh = () => qc.invalidateQueries({ queryKey: ALERTS_KEY });
  const markRead = useMutation({ mutationFn: (id: string) => post(`/alerts/${id}/read`), onSuccess: refresh });
  const markAll = useMutation({ mutationFn: () => post("/alerts/read-all"), onSuccess: refresh });
  const data = q.data;
  return (
    <>
      <PageHeader
        title="Alerts"
        description="Raised when a scan finishes noticeably worse than the previous one for the same tracker."
        actions={<Button variant="outline" disabled={!data?.unreadCount || markAll.isPending} onClick={() => markAll.mutate()}>Mark all read</Button>}
      />
      <ErrorNote error={q.error ?? markRead.error ?? markAll.error} />
      {q.isLoading && <Spinner />}
      {data && (
        <Card>
          {data.alerts.length === 0 ? (
            <EmptyState title="No alerts">A drop in ATRP, SoLV or found points between two scans of the same tracker will show up here. Thresholds are in <Link className="text-primary underline" to="/settings">Settings</Link>.</EmptyState>
          ) : (
            <Table>
              <thead><tr><Th>Alert</Th><Th>Tracker</Th><Th>Before &rarr; after</Th><Th>When</Th><Th /></tr></thead>
              <tbody>
                {data.alerts.map((a) => (
                  <tr key={a.id} className={a.readAt ? "text-muted-foreground" : undefined}>
                    <Td>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {!a.readAt && <span className="size-2 rounded-full bg-primary" aria-label="Unread" />}
                        <Badge tone={a.severity === "critical" ? "danger" : "warning"}>{a.severity === "critical" ? "Critical" : "Warning"}</Badge>
                      </div>
                      <div className="mt-1 text-xs">{a.metrics.reasons.map((r) => REASON_LABEL[r] ?? r).join(", ")}</div>
                    </Td>
                    <Td>
                      <Link className="font-medium hover:underline" to={`/trackers/${a.trackerId}`}>{a.businessName}</Link>
                      <div className="text-xs text-muted-foreground">&ldquo;{a.keyword}&rdquo;</div>
                    </Td>
                    <Td className="text-sm"><Metrics alert={a} /></Td>
                    <Td className="whitespace-nowrap text-xs">{fmtDateTime(a.createdAt)}</Td>
                    <Td className="whitespace-nowrap text-right">
                      <Link to={`/scans/${a.scanId}`}><Button size="sm" variant="outline">View scan</Button></Link>
                      {!a.readAt && <Button size="sm" variant="ghost" className="ml-1" disabled={markRead.isPending} onClick={() => markRead.mutate(a.id)}>Mark read</Button>}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}
    </>
  );
}
