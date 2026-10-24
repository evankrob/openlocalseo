import { eq } from "drizzle-orm";
import { loadConfig, type AppConfig } from "@/worker/config";
import type { Db } from "@/worker/db";
import { businesses, scans, trackers, workspaces } from "@/worker/db/schema";
import type { ScanJob, ScanQueue } from "@/worker/scans/jobs";
import { handleScanJob, type ProcessDeps, type RawStore } from "@/worker/scans/process";
import { MockDataForSeo, type MockOptions } from "@/worker/dataforseo/mock";
import type { DataForSeoProvider } from "@/worker/dataforseo/types";
import { createTestDb } from "./db";

/** In-memory queue with delivery times, driven by a virtual clock. */
export class FakeQueue implements ScanQueue {
  messages: Array<{ job: ScanJob; at: number }> = [];
  delivered: ScanJob[] = [];
  constructor(private readonly clock: { now: number }) {}
  async send(job: ScanJob, options?: { delaySeconds?: number }) {
    this.messages.push({ job, at: this.clock.now + (options?.delaySeconds ?? 0) * 1000 });
  }
  async sendBatch(jobs: Array<{ body: ScanJob; delaySeconds?: number }>) {
    for (const j of jobs) await this.send(j.body, { delaySeconds: j.delaySeconds });
  }
  /** Runs every message in delivery order, advancing the clock as needed. */
  async drain(deps: ProcessDeps, maxSteps = 5000) {
    for (let step = 0; step < maxSteps && this.messages.length; step++) {
      this.messages.sort((a, b) => a.at - b.at);
      const next = this.messages.shift()!;
      if (next.at > this.clock.now) this.clock.now = next.at;
      this.delivered.push(next.job);
      await handleScanJob(deps, next.job);
    }
    if (this.messages.length) throw new Error("queue did not drain");
  }
}

export class MemoryRaw implements RawStore {
  objects = new Map<string, string>();
  async put(key: string, body: string) {
    this.objects.set(key, body);
  }
  async deletePrefix(prefix: string, limit: number) {
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).slice(0, limit);
    for (const key of keys) this.objects.delete(key);
    return keys.length;
  }
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;

export async function createHarness(opts: {
  env?: Parameters<typeof loadConfig>[0];
  mock?: MockOptions;
  provider?: (clock: { now: number }) => DataForSeoProvider;
} = {}) {
  const db = await createTestDb();
  const clock = { now: Date.UTC(2026, 9, 14, 12, 0, 0) };
  const queue = new FakeQueue(clock);
  const config: AppConfig = loadConfig({ DATAFORSEO_MODE: "mock", ...opts.env });
  const provider = opts.provider?.(clock) ?? new MockDataForSeo({ now: () => clock.now, ...opts.mock });
  const raw = new MemoryRaw();
  const deps: ProcessDeps = { db, queue, config, provider, raw, now: () => new Date(clock.now) };
  return { db, clock, queue, config, provider, raw, deps };
}

export async function seedWorkspace(db: Db, credits = 0, id = "ws-1") {
  await db.insert(workspaces).values({ id, name: "Test Workspace", slug: id, creditBalance: credits });
  return id;
}

export async function seedTracker(
  db: Db,
  workspaceId: string,
  overrides: Partial<typeof trackers.$inferInsert> & { business?: Partial<typeof businesses.$inferInsert> } = {},
) {
  const { business, ...trackerOverrides } = overrides;
  const businessId = `biz-${Math.random().toString(36).slice(2, 8)}`;
  await db.insert(businesses).values({
    id: businessId,
    workspaceId,
    name: "Maple & Ember Coffee Roasters",
    placeId: "ChIJdemo0000000000000001",
    domain: "mapleember.example",
    lat: 35.7796,
    lng: -78.6382,
    ...business,
  });
  const id = trackerOverrides.id ?? `trk-${Math.random().toString(36).slice(2, 8)}`;
  await db.insert(trackers).values({
    id,
    workspaceId,
    businessId,
    keyword: "coffee shop",
    centerLat: 35.7796,
    centerLng: -78.6382,
    gridSize: 5,
    radiusKm: 6,
    zoom: 15,
    ...trackerOverrides,
  });
  return { trackerId: id, businessId };
}

export async function getScan(db: Db, id: string) {
  const [scan] = await db.select().from(scans).where(eq(scans.id, id));
  return scan;
}
