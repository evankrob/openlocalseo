// Generates .wrangler/seed.sql: a fictional demo business ("Maple & Ember
// Coffee Roasters", Fictionville NC) with four months of scan history, built
// through the real services against the mock provider, so seed data has the
// exact shape real scans produce. Run via `npm run db:seed:local`.
import { mkdirSync, writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { queryRows } from "@/worker/db/raw";
import { must } from "@/shared/assert";
import { asTrackerId } from "@/shared/ids";
import { createTestDb } from "../tests/helpers/db";
import { FakeQueue, MemoryRaw } from "../tests/helpers/harness";
import { loadConfig } from "@/worker/config";
import { createBusiness, createTracker } from "@/worker/catalog";
import { ensureSharedWorkspaceMember } from "@/worker/auth/accounts";
import { MockDataForSeo } from "@/worker/dataforseo/mock";
import type { DataForSeoProvider, ProviderScope } from "@/worker/dataforseo/types";
import { createScan } from "@/worker/scans/service";
import { saveBranding, createShare } from "@/worker/reports";
import { reportShares, trackers } from "@/worker/db/schema";
import { sha256Hex } from "@/worker/lib";
import { eq } from "drizzle-orm";
import type { ProcessDeps } from "@/worker/scans/process";

export const DEMO_SHARE_TOKEN = "olrep_demo_maple_ember_fictional";

const TABLES = ["users", "workspaces", "memberships", "businesses", "trackers", "scans", "scan_points", "scan_results", "api_calls", "workspace_branding", "report_shares"];

function literal(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "bigint") return value.toString();
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function main() {
  const db = await createTestDb();
  const clock = { now: Date.UTC(2026, 6, 1, 6, 15) };
  let prominence = 0.4;
  // Wraps the mock so each month's scan sees the business a little stronger.
  const build = (scope?: ProviderScope) =>
    new MockDataForSeo({ now: () => clock.now, delaysMs: { standard: 1000, priority: 1000 }, target: scope && { ...scope, prominence } });
  const provider: DataForSeoProvider = build();
  const queue = new FakeQueue(clock);
  const deps: ProcessDeps = { db, queue, provider, scopeProvider: build, raw: new MemoryRaw(), config: loadConfig({ DATAFORSEO_MODE: "mock", POLL_INTERVAL_SECONDS: "5" }), now: () => new Date(clock.now) };

  const member = await ensureSharedWorkspaceMember(db, "admin@localhost");
  const ws = member.workspaceId;
  const business = await createBusiness(db, ws, {
    name: "Maple & Ember Coffee Roasters",
    placeId: "ChIJdemoMapleEmber0001",
    domain: "mapleember.example",
    address: "101 Fictional Ave, Fictionville, NC 27999",
    category: "Coffee shop",
    lat: 35.7796,
    lng: -78.6382,
  });
  const keywords = [
    { keyword: "coffee shop", gridSize: 9, base: 0.4 },
    { keyword: "espresso near me", gridSize: 7, base: 0.3 },
  ];
  for (const k of keywords) {
    const tracker = await createTracker(db, ws, {
      businessId: business.id,
      keyword: k.keyword,
      gridSize: k.gridSize,
      radius: { value: 4, unit: "mi" },
      zoom: 15,
      searchType: "maps",
      queueMode: "standard",
      device: "mobile",
      languageCode: "en",
      depth: 20,
      schedule: { frequency: "monthly", day: 1 },
    }, new Date(clock.now));
    // Four monthly scans (Jul-Oct 2026), the business gaining ground each time.
    for (let month = 0; month < 4; month++) {
      clock.now = Date.UTC(2026, 6 + month, 1, 6, 15);
      prominence = k.base + month * 0.09;
      await createScan(deps, ws, asTrackerId(tracker.id), { trigger: "schedule" });
      await queue.drain(deps);
    }
    await db.update(trackers).set({ nextRunAt: "2026-11-01T00:00:00.000Z" }).where(eq(trackers.id, tracker.id));
  }

  await saveBranding(db, ws, {
    brandName: "Harbor Lane Marketing",
    primaryColor: "#0f766e",
    footerText: "Prepared by Harbor Lane Marketing. Questions? hello@harborlane.example",
    contactUrl: "https://harborlane.example",
    hideAttribution: false,
  });
  const [firstTracker] = await db.select().from(trackers).limit(1);
  const share = await createShare(db, ws, asTrackerId(must(firstTracker, "seeded tracker").id), { label: "Demo client report", showCompetitors: true });
  // Swap the random token for a fixed, documented one so the README can link to it.
  await db.update(reportShares).set({ tokenHash: await sha256Hex(DEMO_SHARE_TOKEN) }).where(eq(reportShares.id, share.id));

  const lines: string[] = ["PRAGMA defer_foreign_keys = ON;"];
  for (const table of TABLES) {
    const rows = await queryRows(db, sql.raw(`SELECT * FROM ${table}`), z.record(z.string(), z.unknown()));
    if (rows.length === 0) continue;
    const cols = Object.keys(must(rows[0], "non-empty table"));
    for (let i = 0; i < rows.length; i += 40) {
      const values = rows.slice(i, i + 40).map((r) => `(${cols.map((c) => literal(r[c])).join(",")})`);
      lines.push(`INSERT OR IGNORE INTO ${table} (${cols.map((c) => `"${c}"`).join(",")}) VALUES\n${values.join(",\n")};`);
    }
  }
  mkdirSync(".wrangler", { recursive: true });
  writeFileSync(".wrangler/seed.sql", lines.join("\n") + "\n");
  console.log(`Wrote .wrangler/seed.sql (${lines.length - 1} statements). Demo report token: ${DEMO_SHARE_TOKEN}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
