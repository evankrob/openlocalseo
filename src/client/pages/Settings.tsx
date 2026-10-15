import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { del, get, post, put } from "../lib/api";
import { fmtDateTime } from "../lib/format";
import type { Me } from "../lib/types";
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
          <BrandingCard />
          <KeysCard />
        </>
      ) : (
        <Card><EmptyState title="Branding and API keys are managed by workspace admins" /></Card>
      )}
    </>
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
      <CardHeader title="API keys &amp; MCP" description="Let an AI assistant run and read scans. Tools: list_trackers, run_scan, list_scans, get_scan." />
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
