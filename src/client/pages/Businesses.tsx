import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { del, get, post } from "../lib/api";
import { Button, Card, CardHeader, EmptyState, ErrorNote, Field, Input, Table, Td, Th } from "../components/ui";
import { PageHeader } from "./shell";

type Business = { id: string; name: string; placeId: string | null; domain: string | null; address: string | null; category: string | null; lat: number; lng: number };
type Geo = { display_name: string; lat: string; lon: string };

export function Businesses() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["businesses"], queryFn: () => get<Business[]>("/businesses") });
  const [form, setForm] = useState({ name: "", placeId: "", domain: "", category: "", address: "", lat: "", lng: "" });
  const [geo, setGeo] = useState<Geo[]>([]);
  const [geoBusy, setGeoBusy] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [needOne, setNeedOne] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const create = useMutation({
    mutationFn: () =>
      post("/businesses", {
        name: form.name,
        placeId: form.placeId || null,
        domain: form.domain || null,
        category: form.category || null,
        address: form.address || null,
        // Blank = let the server work it out from the place ID or address.
        lat: form.lat.trim() ? Number(form.lat) : null,
        lng: form.lng.trim() ? Number(form.lng) : null,
      }),
    onSuccess: () => {
      setForm({ name: "", placeId: "", domain: "", category: "", address: "", lat: "", lng: "" });
      setGeo([]);
      qc.invalidateQueries({ queryKey: ["businesses"] });
    },
  });
  const remove = useMutation({ mutationFn: (id: string) => del(`/businesses/${id}`), onSuccess: () => { qc.invalidateQueries(); } });

  // Address lookup uses OpenStreetMap's Nominatim from the browser (no Google
  // APIs). Its usage policy allows light interactive use only.
  async function search() {
    if (!form.address.trim()) return;
    setGeoBusy(true);
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(form.address)}`);
      setGeo(res.ok ? ((await res.json()) as Geo[]) : []);
    } finally {
      setGeoBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="Businesses" description="The locations whose rankings you track. Add the Google place ID if you have it for exact matching; otherwise the domain, then the name, is used." />
      <Card>
        <CardHeader title="Add a business" />
        <form
          className="grid gap-4 p-5 md:grid-cols-2"
          onSubmit={(e) => { e.preventDefault(); if (!form.placeId.trim() && !form.address.trim()) { setNeedOne(true); return; } setNeedOne(false); create.mutate(); }}
        >
          <Field label="Business name"><Input required value={form.name} onChange={set("name")} placeholder="Maple & Ember Coffee Roasters" /></Field>
          <Field label="Website domain" hint="Used to recognise the business in results if no place ID."><Input value={form.domain} onChange={set("domain")} placeholder="example.com" /></Field>
          <Field label="Google place ID" hint="Starts with ChIJ. Fills in the map location for you. Give this or an address."><Input value={form.placeId} onChange={set("placeId")} /></Field>
          <Field label="Category (optional)"><Input value={form.category} onChange={set("category")} placeholder="Coffee shop" /></Field>
          <Field className="md:col-span-2" label="Address" hint="Needed only if you have no place ID. The map location is found automatically when you add the business.">
            <div className="flex gap-2">
              <Input value={form.address} onChange={set("address")} placeholder="101 Main St, Raleigh, NC" onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); search(); } }} />
              <Button type="button" variant="outline" onClick={search} disabled={geoBusy}>{geoBusy ? "Searching" : "Find"}</Button>
            </div>
            {geo.length > 0 && (
              <ul className="mt-2 divide-y divide-border rounded-lg border border-border text-sm">
                {geo.map((g) => (
                  <li key={g.display_name}>
                    <button type="button" className="w-full px-3 py-2 text-left hover:bg-accent" onClick={() => { setForm((f) => ({ ...f, address: g.display_name, lat: Number(g.lat).toFixed(6), lng: Number(g.lon).toFixed(6) })); setGeo([]); }}>
                      {g.display_name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Field>
          <div className="md:col-span-2">
            <button type="button" className="text-sm text-muted-foreground underline" onClick={() => setAdvanced((a) => !a)}>{advanced ? "Hide advanced" : "Advanced: set exact coordinates"}</button>
          </div>
          {advanced && (
            <>
              <Field label="Latitude (optional)"><Input type="number" step="any" value={form.lat} onChange={set("lat")} /></Field>
              <Field label="Longitude (optional)"><Input type="number" step="any" value={form.lng} onChange={set("lng")} /></Field>
            </>
          )}
          <div className="md:col-span-2 space-y-2">
            {needOne && <p className="text-sm text-destructive">Add a Google place ID or an address so we can find the business on the map.</p>}
            <ErrorNote error={create.error} />
            <Button type="submit" disabled={create.isPending}>{create.isPending ? "Finding location..." : "Add business"}</Button>
          </div>
        </form>
      </Card>
      <Card>
        {list.data?.length === 0 ? (
          <EmptyState title="No businesses yet" />
        ) : (
          <Table>
            <thead><tr><Th>Name</Th><Th>Match on</Th><Th>Location</Th><Th /></tr></thead>
            <tbody>
              {list.data?.map((b) => (
                <tr key={b.id}>
                  <Td><Link to={`/businesses/${b.id}`} className="font-medium hover:underline">{b.name}</Link><div className="text-xs text-muted-foreground">{b.address}</div></Td>
                  <Td className="text-xs">{b.placeId ? "Place ID" : b.domain ? `Domain: ${b.domain}` : "Name"}</Td>
                  <Td className="text-xs tabular-nums">{b.lat.toFixed(4)}, {b.lng.toFixed(4)}</Td>
                  <Td className="space-x-2 text-right">
                    <Link to={`/businesses/${b.id}`}><Button size="sm" variant="outline">Profile &amp; reviews</Button></Link>
                    <Link to={`/trackers/new?business=${b.id}`}><Button size="sm" variant="outline">New grid</Button></Link>
                    <Button size="sm" variant="ghost" onClick={() => { if (confirm(`Remove ${b.name} and its trackers? Scan history is kept but hidden.`)) remove.mutate(b.id); }}>Remove</Button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
