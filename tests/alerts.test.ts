import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { alertSettings, alerts, scanPoints, scans } from "@/worker/db/schema";
import type { Db } from "@/worker/db";
import { createAlertsForScan, createAlertsSafely, saveAlertSettings } from "@/worker/alerts";
import { createScan } from "@/worker/scans/service";
import { createHarness, getScan, seedTracker, seedWorkspace, type Harness } from "./helpers/harness";
import { at, first as firstRow } from "@/shared/assert";
import type { TrackerId, WorkspaceId } from "@/shared/ids";

let h: Harness;
let ws: WorkspaceId;
let trackerId: TrackerId;
let sent: Array<{ url: string; text: string }>;

beforeEach(async () => {
  h = await createHarness();
  ws = await seedWorkspace(h.db);
  ({ trackerId } = await seedTracker(h.db, ws));
  sent = [];
  h.deps.notify = async (url, payload) => void sent.push({ url, text: payload.text });
});

async function runScan() {
  const { scanId } = await createScan(h.deps, ws, trackerId, { trigger: "manual" });
  await h.queue.drain(h.deps);
  return scanId;
}

/** Rewrites a finished scan so it looks like a much better earlier result. */
async function makeGreat(scanId: string) {
  await h.db.update(scans).set({ atrp: 1, solv: 100, foundPoints: 25, top3Points: 25 }).where(eq(scans.id, scanId));
  await h.db.update(scanPoints).set({ rank: 1, status: "completed" }).where(eq(scanPoints.scanId, scanId));
}

const allAlerts = () => h.db.select().from(alerts);

describe("alerts when a scan is finalized", () => {
  it("raises nothing for the first scan", async () => {
    await runScan();
    expect(await allAlerts()).toEqual([]);
  });

  it("raises nothing when the second scan is as good as the first", async () => {
    await runScan();
    await runScan();
    expect(await allAlerts()).toEqual([]);
  });

  it("raises a rank_drop alert, with before/after metrics, when the next scan is much worse", async () => {
    const first = await runScan();
    await makeGreat(first);
    const second = await runScan();

    const rows = await allAlerts();
    expect(rows).toHaveLength(1);
    const scan = await getScan(h.db, second);
    expect(rows[0]).toMatchObject({
      workspaceId: ws,
      trackerId,
      scanId: second,
      previousScanId: first,
      kind: "rank_drop",
      readAt: null,
    });
    const metrics = JSON.parse(at(rows, 0).metrics);
    expect(metrics.before).toMatchObject({ atrp: 1, solv: 100, foundPoints: 25, centerRank: 1 });
    expect(metrics.after).toMatchObject({ atrp: scan.atrp, solv: scan.solv });
    expect(metrics.reasons).toContain("atrp");
    expect(["warning", "critical"]).toContain(at(rows, 0).severity);
  });

  it("compares with the latest completed scan, not an older one", async () => {
    const first = await runScan();
    await makeGreat(first);
    const second = await runScan(); // alert 1
    await h.db.update(scans).set({ atrp: 1, solv: 100, foundPoints: 25 }).where(eq(scans.id, second));
    await h.db.update(scanPoints).set({ rank: 1 }).where(eq(scanPoints.scanId, second));
    const third = await runScan();
    const rows = await allAlerts();
    expect(new Set(rows.map((r) => r.previousScanId))).toEqual(new Set([first, second]));
    expect(rows.find((r) => r.scanId === third)?.previousScanId).toBe(second);
  });

  it("does not compare scans taken with different tracker settings", async () => {
    const first = await runScan();
    await makeGreat(first);
    // a tracker edit changes what later scans snapshot
    await h.db.update(scans).set({ keyword: "old keyword" }).where(eq(scans.id, first));
    await runScan();
    expect(await allAlerts()).toEqual([]);
  });

  it("raises one data_problem alert when more than half of the points failed", async () => {
    const seen = new Set<string>();
    h = await createHarness({
      mock: {
        shouldFail: (c) => {
          if (!seen.has(c) && seen.size < 15) seen.add(c);
          return seen.has(c);
        },
      },
    });
    ws = await seedWorkspace(h.db);
    ({ trackerId } = await seedTracker(h.db, ws));
    sent = [];
    h.deps.notify = async (url, payload) => void sent.push({ url, text: payload.text });
    const scanId = await runScan();
    expect((await getScan(h.db, scanId)).status).toBe("completed");
    const rows = await allAlerts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "data_problem", severity: "warning", previousScanId: null });
    expect(JSON.parse(at(rows, 0).metrics).after).toMatchObject({ failedPoints: 15, totalPoints: 25 });
  });

  it("is idempotent: evaluating the same scan again (redelivery, re-finalize) adds no duplicate", async () => {
    await makeGreat(await runScan());
    const second = await runScan();
    expect(await allAlerts()).toHaveLength(1);
    await createAlertsForScan(h.deps, second, 0);
    await createAlertsForScan(h.deps, second, 0);
    expect(await allAlerts()).toHaveLength(1);
  });

  it("the unique index itself refuses a second alert of the same kind for a scan", async () => {
    await makeGreat(await runScan());
    await runScan();
    const row = firstRow(await allAlerts(), "the first alert");
    await expect(h.db.insert(alerts).values({ ...row, id: "dup" })).rejects.toThrow();
  });

  it("does nothing when alerts are switched off for the workspace", async () => {
    await saveAlertSettings(h.db, ws, { enabled: false });
    await makeGreat(await runScan());
    await runScan();
    expect(await allAlerts()).toEqual([]);
  });

  it("uses the workspace thresholds", async () => {
    await saveAlertSettings(h.db, ws, { atrpWorse: 20, solvDown: 100, foundDropPct: 100, centerTop3: false });
    await makeGreat(await runScan());
    await runScan();
    expect(await allAlerts()).toEqual([]);
  });

  it("never fails finalization: an error in alert evaluation is logged and swallowed", async () => {
    const broken = { select: () => { throw new Error("db exploded"); } } as unknown as Db;
    await expect(createAlertsSafely({ db: broken }, "scan-x", 0)).resolves.toBeUndefined();

    // and through the real pipeline: the sender throws, the scan still completes
    h.deps.notify = async () => { throw new Error("slack is down"); };
    await saveAlertSettings(h.db, ws, { webhookUrl: "https://hooks.example.com/a" });
    await makeGreat(await runScan());
    const second = await runScan();
    expect((await getScan(h.db, second)).status).toBe("completed");
    expect(await allAlerts()).toHaveLength(1);
  });
});

describe("webhook notification", () => {
  const url = "https://hooks.example.com/services/abc";

  it("is off by default: no webhook, nothing sent", async () => {
    await makeGreat(await runScan());
    await runScan();
    expect(await allAlerts()).toHaveLength(1);
    expect(sent).toEqual([]);
  });

  it("sends one Slack-style {text} message per new alert, never again on redelivery", async () => {
    await saveAlertSettings(h.db, ws, { webhookUrl: url });
    await makeGreat(await runScan());
    const second = await runScan();
    await Promise.resolve();
    expect(sent).toHaveLength(1);
    expect(at(sent, 0).url).toBe(url);
    expect(at(sent, 0).text).toContain("Maple & Ember Coffee Roasters");
    expect(at(sent, 0).text).toContain('"coffee shop"');
    expect(at(sent, 0).text).toMatch(/ATRP 1 -> \d/);
    await createAlertsForScan(h.deps, second, 0);
    expect(sent).toHaveLength(1);
  });

  it("hands the pending send to waitUntil when the runtime provides it", async () => {
    const waited: Array<Promise<unknown>> = [];
    h.deps.waitUntil = (p) => void waited.push(p);
    await saveAlertSettings(h.db, ws, { webhookUrl: url });
    await makeGreat(await runScan());
    await runScan();
    expect(waited).toHaveLength(1);
    await Promise.all(waited);
    expect(sent).toHaveLength(1);
  });

  it("does not send when no sender is configured (tests and local dev default)", async () => {
    h.deps.notify = undefined;
    await saveAlertSettings(h.db, ws, { webhookUrl: url });
    await makeGreat(await runScan());
    await runScan();
    expect(await allAlerts()).toHaveLength(1);
    expect(sent).toEqual([]);
  });

  it("only stores https webhook urls", async () => {
    await expect(saveAlertSettings(h.db, ws, { webhookUrl: "http://hooks.example.com/x" })).rejects.toThrow(/https/);
    const rows = await h.db.select().from(alertSettings).where(and(eq(alertSettings.workspaceId, ws)));
    expect(rows).toEqual([]);
  });
});
