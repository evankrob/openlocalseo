import { useQuery } from "@tanstack/react-query";
import { useOutletContext } from "react-router-dom";
import { get } from "../lib/api";
import { fmtDateTime, fmtUsd } from "../lib/format";
import type { Me } from "../lib/types";
import { Badge, Card, CardHeader, EmptyState, Spinner, Stat, Table, Td, Th } from "../components/ui";
import { PageHeader } from "./shell";

type Usage = {
  billingMode: "byok" | "hosted";
  providerCostUsd: number; providerCalls: number; providerTasks: number; simulatedCostUsd: number; scans: number;
  credits: { balance: number; balanceUsd: number; ledger: Array<{ id: string; delta: number; reason: string; createdAt: string }> } | null;
  recentCalls: Array<{ id: string; mode: "mock" | "live"; path: string; taskCount: number; costUsd: number; createdAt: string }>;
};

export function UsagePage() {
  const me = useOutletContext<Me>();
  const q = useQuery({ queryKey: ["usage"], queryFn: () => get<Usage>("/usage") });
  if (!q.data) return <Spinner />;
  const u = q.data;
  return (
    <>
      <PageHeader title="Usage &amp; cost" description={u.billingMode === "hosted" ? `Hosted billing: DataForSEO cost plus ${Math.round((me.config.markup - 1) * 100)}%, charged in credits.` : "Bring your own key: DataForSEO bills your account directly. This page tracks what each scan cost."} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="DataForSEO spend (month)" value={fmtUsd(u.providerCostUsd)} hint={`${u.providerTasks} searches`} />
        <Stat label="Scans (month)" value={u.scans} />
        {u.simulatedCostUsd > 0 && <Stat label="Simulated (mock)" value={fmtUsd(u.simulatedCostUsd)} hint="Not real money" />}
        {u.credits && <Stat label="Credit balance" value={u.credits.balance.toLocaleString()} hint={`about ${fmtUsd(u.credits.balanceUsd, 2)}`} />}
      </div>
      <Card>
        <CardHeader title="Recent DataForSEO calls" description="The cost DataForSEO reported on each call, recorded as it happened." />
        {u.recentCalls.length === 0 ? <EmptyState title="No calls yet" /> : (
          <Table>
            <thead><tr><Th>When</Th><Th>Endpoint</Th><Th>Mode</Th><Th className="text-right">Searches</Th><Th className="text-right">Cost</Th></tr></thead>
            <tbody>{u.recentCalls.map((c) => (
              <tr key={c.id}><Td className="text-xs">{fmtDateTime(c.createdAt)}</Td><Td className="font-mono text-xs">{c.path}</Td><Td><Badge tone={c.mode === "mock" ? "warning" : "neutral"}>{c.mode}</Badge></Td><Td className="text-right tabular-nums">{c.taskCount}</Td><Td className="text-right tabular-nums">{fmtUsd(c.costUsd)}</Td></tr>
            ))}</tbody>
          </Table>
        )}
      </Card>
      {u.credits && (
        <Card>
          <CardHeader title="Credit ledger" />
          <Table>
            <thead><tr><Th>When</Th><Th>Reason</Th><Th className="text-right">Credits</Th></tr></thead>
            <tbody>{u.credits.ledger.map((l) => <tr key={l.id}><Td className="text-xs">{fmtDateTime(l.createdAt)}</Td><Td>{l.reason.replace("_", " ")}</Td><Td className="text-right tabular-nums">{l.delta > 0 ? "+" : ""}{l.delta}</Td></tr>)}</tbody>
          </Table>
        </Card>
      )}
    </>
  );
}
