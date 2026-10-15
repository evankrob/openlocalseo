// History charts. Two measures on different scales, so two charts (never a
// dual axis). One series each, so no legend box: the title names it. A table
// view is one toggle away.
import { useState } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { fmtDate, fmtNum } from "../lib/format";
import { Button, Card, CardHeader, Table, Td, Th } from "./ui";

export type TrendPoint = { id: string; createdAt: string; atrp: number | null; solv: number | null; arp?: number | null };

function Chart({ title, note, data, field, domain, unit, label }: {
  title: string;
  note: string;
  data: TrendPoint[];
  field: "atrp" | "solv";
  domain: [number, number];
  unit: string;
  label: string;
}) {
  const rows = data.filter((d) => d[field] !== null).map((d) => ({ date: fmtDate(d.createdAt), value: d[field] as number }));
  const last = rows[rows.length - 1];
  return (
    <div className="p-4">
      <div className="mb-1 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold">{title}</h3>
        {last && <span className="text-sm tabular-nums">{fmtNum(last.value)}{unit}</span>}
      </div>
      <p className="mb-2 text-xs text-muted-foreground">{note}</p>
      <div className="h-48" role="img" aria-label={`${title} over time: ${rows.map((r) => `${r.date} ${fmtNum(r.value)}`).join(", ")}`}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 8, right: 16, bottom: 0, left: -8 }}>
            <CartesianGrid stroke="var(--grid-line)" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="date" tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} tickLine={false} axisLine={false} />
            <YAxis domain={domain} tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} tickLine={false} axisLine={false} width={36} />
            <Tooltip
              formatter={(v) => [`${fmtNum(Number(v))}${unit}`, label]}
              contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
            />
            <Line type="monotone" dataKey="value" stroke="var(--series-1)" strokeWidth={2} dot={{ r: 4, stroke: "var(--card)", strokeWidth: 2, fill: "var(--series-1)" }} activeDot={{ r: 5 }} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function TrendCharts({ history }: { history: TrendPoint[] }) {
  const [table, setTable] = useState(false);
  const data = [...history].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (data.length === 0) return null;
  return (
    <Card>
      <CardHeader
        title="Trend"
        description={data.length < 2 ? "Run another scan to see a trend." : `${data.length} completed scans`}
        actions={<Button variant="outline" size="sm" className="no-print" onClick={() => setTable((t) => !t)}>{table ? "Show charts" : "Show table"}</Button>}
      />
      {table ? (
        <Table>
          <thead><tr><Th>Date</Th><Th className="text-right">ATRP</Th><Th className="text-right">ARP</Th><Th className="text-right">SoLV</Th></tr></thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.id}><Td>{fmtDate(d.createdAt)}</Td><Td className="text-right tabular-nums">{fmtNum(d.atrp)}</Td><Td className="text-right tabular-nums">{fmtNum(d.arp)}</Td><Td className="text-right tabular-nums">{fmtNum(d.solv)}%</Td></tr>
            ))}
          </tbody>
        </Table>
      ) : (
        <div className="grid md:grid-cols-2">
          <Chart title="ATRP" note="Average rank across all points. Lower is better." data={data} field="atrp" domain={[1, 21]} unit="" label="ATRP" />
          <Chart title="SoLV" note="Share of points ranking in the top 3. Higher is better." data={data} field="solv" domain={[0, 100]} unit="%" label="SoLV" />
        </div>
      )}
    </Card>
  );
}
