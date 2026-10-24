import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { del, get, post, put } from "../lib/api";
import { fmtDateTime, fmtUsd } from "../lib/format";
import type { AlertSettings, FailedJobs, Me } from "../lib/types";
import { Button, Card, CardHeader, EmptyState, ErrorNote, Field, Input, Table, Td, Textarea, Th } from "../components/ui";
import { PageHeader } from "./shell";

type Branding = { brandName: string | null; logoUrl: string | null; primaryColor: string | null; footerText: string | null; contactUrl: string | null; hideAttribution: boolean };
type Key = { id: string; name: string; prefix: string; lastUsedAt: string | null; createdAt: string };

export function Settings() {
  const me = useOutletContext<Me>();
  const admin = me.workspace.role !== "member";
  return (
    <>
      <PageHeader title="Settings" description={`Workspace: ${me.workspace.name}`} />
      {admin ? (
        <>
          <AlertSettingsCard />
          <FailedJobsCard />
          <BrandingCard />
          <KeysCard />
        </>
      ) : (
        <Card><EmptyState title="Branding and API keys are managed by workspace admins" /></Card>
      )}
    </>
  );
}

const THRESHOLDS = [
  { key: "atrpWorse", label: "ATRP worse by", hint: "Positions, e.g. 2 = from 4.0 to 6.0.", max: 20 },
  { key: "solvDown", label: "SoLV down by", hint: "Percentage points.", max: 100 },
  { key: "foundDropPct", label: "Found points down by", hint: "% of all grid points.", max: 100 },
  { key: "criticalAtrp", label: "Critical when ATRP worse by", hint: "Positions.", max: 20 },
  { key: "criticalSolv", label: "Critical when SoLV down by", hint: "Percentage points.", max: 100 },
] as const;

function AlertSettingsCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["alert-settings"], queryFn: () => get<AlertSettings>("/alert-settings") });
  const [f, setF] = useState<AlertSettings | null>(null);
  useEffect(() => { if (q.data) setF(q.data); }, [q.data]);
  const save = useMutation({
    mutationFn: () => {
      const { webhookConfigured: _configured, ...values } = f!;
      return put("/alert-settings", { ...values, webhookUrl: f!.webhookUrl ?? "" });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alert-settings"] }),
  });
  if (!f) return null;
  const set = <K extends keyof AlertSettings>(k: K, v: AlertSettings[K]) => setF({ ...f, [k]: v });
  return (
    <Card>
      <CardHeader title="Rank-drop alerts" description="After each scan, compare with the previous scan of the same tracker (same grid, radius, zoom, search type and keyword) and flag a meaningful drop." />
      <form className="grid gap-4 p-5 md:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <label className="flex items-center gap-2 text-sm md:col-span-2"><input type="checkbox" checked={f.enabled} onChange={(e) => set("enabled", e.target.checked)} /> Alerts on</label>
        {THRESHOLDS.map(({ key, label, hint, max }) => (
          <Field key={key} label={label} hint={hint}>
            <Input type="number" min={0} max={max} step="any" required value={f[key]} onChange={(e) => set(key, Number(e.target.value))} />
          </Field>
        ))}
        <label className="flex items-center gap-2 self-end text-sm"><input type="checkbox" checked={f.centerTop3} onChange={(e) => set("centerTop3", e.target.checked)} /> Alert when the business leaves the top 3 at the center point</label>
        <Field className="md:col-span-2" label="Webhook URL (optional)" hint="Slack-compatible incoming webhook (https). Receives a short text message for each new alert. Leave empty to turn off.">
          <Input type="url" value={f.webhookUrl ?? ""} onChange={(e) => set("webhookUrl", e.target.value)} placeholder="https://hooks.slack.com/services/..." />
        </Field>
        <div className="md:col-span-2 space-y-2"><ErrorNote error={save.error} /><Button type="submit" disabled={save.isPending}>{save.isSuccess ? "Saved" : "Save alert settings"}</Button></div>
      </form>
    </Card>
  );
}

function FailedJobsCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["failed-jobs"], queryFn: () => get<FailedJobs>("/ops/failed-jobs") });
  const retry = useMutation({
    mutationFn: (scanId: string) => post(`/scans/${scanId}/retry`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["failed-jobs"] }),
  });
  const jobs = q.data?.jobs ?? [];
  return (
    <Card>
      <CardHeader title="Failed jobs" description="Scans and Google profile refreshes that failed in the last 30 days. Held credits are returned automatically. Retrying starts a new scan with a fresh cost estimate; it never reuses the failed scan's DataForSEO tasks." />
      <div className="px-5 pb-1 pt-3"><ErrorNote error={q.error ?? retry.error} /></div>
      {jobs.length === 0 ? (
        <EmptyState title="No failed jobs" />
      ) : (
        <Table>
          <thead><tr><Th>What</Th><Th>Error</Th><Th>Cost</Th><Th>When</Th><Th /></tr></thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={`${j.kind}-${j.id}`}>
                <Td>{j.businessName}<div className="text-xs text-muted-foreground">{j.kind === "scan" ? `Scan “${j.keyword}”` : "Google profile"}</div></Td>
                <Td className="max-w-xs text-sm">{j.error ?? "Unknown error"}</Td>
                <Td className="whitespace-nowrap tabular-nums">{fmtUsd(j.costUsd)}{j.billedCredits > 0 && <div className="text-xs text-muted-foreground">{j.billedCredits} credits</div>}</Td>
                <Td className="whitespace-nowrap text-xs">{fmtDateTime(j.createdAt)}</Td>
                <Td className="whitespace-nowrap text-right">
                  {j.kind === "scan" && <Button size="sm" variant="outline" disabled={retry.isPending} onClick={() => retry.mutate(j.id)}>Retry</Button>}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function BrandingCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["branding"], queryFn: () => get<Branding>("/branding") });
  const [f, setF] = useState<Branding | null>(null);
  useEffect(() => { if (q.data) setF(q.data); }, [q.data]);
  const save = useMutation({
    mutationFn: () => put("/branding", { brandName: f!.brandName ?? "", logoUrl: f!.logoUrl ?? "", primaryColor: f!.primaryColor || null, footerText: f!.footerText ?? "", contactUrl: f!.contactUrl ?? "", hideAttribution: f!.hideAttribution }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["branding"] }),
  });
  if (!f) return null;
  const set = <K extends keyof Branding>(k: K, v: Branding[K]) => setF({ ...f, [k]: v });
  return (
    <Card>
      <CardHeader title="Client report branding" description="Shown on shared report links: your name, logo and colour instead of ours." />
      <form className="grid gap-4 p-5 md:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <Field label="Brand name"><Input value={f.brandName ?? ""} onChange={(e) => set("brandName", e.target.value)} placeholder="Your agency" /></Field>
        <Field label="Accent colour" hint="Hex, e.g. #0f766e"><div className="flex gap-2"><Input value={f.primaryColor ?? ""} onChange={(e) => set("primaryColor", e.target.value)} placeholder="#0f766e" /><input type="color" aria-label="Pick colour" className="h-9 w-12 rounded border border-input" value={/^#[0-9a-f]{6}$/i.test(f.primaryColor ?? "") ? f.primaryColor! : "#1f6feb"} onChange={(e) => set("primaryColor", e.target.value)} /></div></Field>
        <Field label="Logo URL" hint="Public https image."><Input value={f.logoUrl ?? ""} onChange={(e) => set("logoUrl", e.target.value)} placeholder="https://..." /></Field>
        <Field label="Contact link"><Input value={f.contactUrl ?? ""} onChange={(e) => set("contactUrl", e.target.value)} placeholder="https://..." /></Field>
        <Field className="md:col-span-2" label="Footer text"><Textarea value={f.footerText ?? ""} onChange={(e) => set("footerText", e.target.value)} /></Field>
        <label className="flex items-center gap-2 text-sm md:col-span-2"><input type="checkbox" checked={f.hideAttribution} onChange={(e) => set("hideAttribution", e.target.checked)} /> Hide the &ldquo;Powered by OpenLocalSEO&rdquo; line</label>
        <div className="md:col-span-2 space-y-2"><ErrorNote error={save.error} /><Button type="submit" disabled={save.isPending}>{save.isSuccess ? "Saved" : "Save branding"}</Button></div>
      </form>
    </Card>
  );
}

function KeysCard() {
  const qc = useQueryClient();
  const keys = useQuery({ queryKey: ["keys"], queryFn: () => get<Key[]>("/api-keys") });
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => post<{ key: string }>("/api-keys", { name }),
    onSuccess: (r) => { setFresh(r.key); setName(""); qc.invalidateQueries({ queryKey: ["keys"] }); },
  });
  const revoke = useMutation({ mutationFn: (id: string) => del(`/api-keys/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ["keys"] }) });
  const origin = window.location.origin;
  return (
    <Card>
      <CardHeader title="API keys &amp; MCP" description="Let an AI assistant run and read scans. Tools: list_trackers, run_scan, list_scans, get_scan, list_alerts." />
      <div className="space-y-4 p-5">
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <Input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Key name, e.g. Claude" />
          <Button type="submit" disabled={create.isPending}>Create key</Button>
        </form>
        <ErrorNote error={create.error} />
        {fresh && (
          <div className="rounded-lg border border-success/40 bg-success/10 p-3 text-sm">
            <div className="font-medium">Copy this key now; it is not shown again.</div>
            <Input readOnly className="mt-2 font-mono text-xs" value={fresh} onFocus={(e) => e.currentTarget.select()} />
            <p className="mt-3 font-medium">Connect Claude Code:</p>
            <pre className="mt-1 overflow-x-auto rounded bg-card p-2 text-xs">{`claude mcp add --transport http openlocalseo ${origin}/mcp \\\n  --header "Authorization: Bearer ${fresh}"`}</pre>
          </div>
        )}
        {keys.data?.length ? (
          <Table>
            <thead><tr><Th>Name</Th><Th>Key</Th><Th>Last used</Th><Th /></tr></thead>
            <tbody>{keys.data.map((k) => (
              <tr key={k.id}><Td>{k.name}</Td><Td className="font-mono text-xs">{k.prefix}&hellip;</Td><Td className="text-xs">{k.lastUsedAt ? fmtDateTime(k.lastUsedAt) : "never"}</Td><Td className="text-right"><Button size="sm" variant="ghost" onClick={() => revoke.mutate(k.id)}>Revoke</Button></Td></tr>
            ))}</tbody>
          </Table>
        ) : <p className="text-sm text-muted-foreground">No keys yet.</p>}
      </div>
    </Card>
  );
}
