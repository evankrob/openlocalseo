import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { get } from "../lib/api";
import { fmtDateTime, fmtUsd } from "../lib/format";
import type { ScanDetail } from "../lib/types";
import { ScanView, OtherListingsNote } from "../components/ScanView";
import { Badge, ErrorNote, Spinner } from "../components/ui";
import { statusTone } from "./Dashboard";
import { PageHeader } from "./shell";
import { loadScanPoint, toViewData } from "./TrackerDetail";

export function ScanPage() {
  const { id = "" } = useParams();
  const q = useQuery({
    queryKey: ["scan", id],
    queryFn: () => get<ScanDetail>(`/scans/${id}`),
    refetchInterval: (query) => (query.state.data && ["queued", "posting", "polling"].includes(query.state.data.scan.status) ? 3000 : false),
  });
  if (q.isLoading) return <Spinner />;
  if (!q.data) return <ErrorNote error={q.error} />;
  const { scan, business } = q.data;
  return (
    <>
      <PageHeader
        title={<>{business.name} <span className="font-normal text-muted-foreground">&ldquo;{scan.keyword}&rdquo;</span></>}
        description={<>Scan from {fmtDateTime(scan.createdAt)} &middot; <Badge tone={statusTone(scan.status)}>{scan.status}</Badge> &middot; {scan.queueMode} queue &middot; cost {fmtUsd(scan.costUsd)} &middot; <Link className="underline" to={`/trackers/${scan.trackerId}`}>tracker</Link></>}
      />
      {scan.error && <ErrorNote error={new Error(scan.error)} />}
      {scan.status === "completed" || q.data.points.some((p) => p.status === "completed") ? (
        <>
          <OtherListingsNote listings={q.data.otherListings} />
          <ScanView data={toViewData(q.data)} loadPoint={loadScanPoint(id)} queryKey={["scan", id]} />
        </>
      ) : (
        <p className="text-sm text-muted-foreground">Results appear when the scan finishes.</p>
      )}
    </>
  );
}
