import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { scans, trackers } from "@/worker/db/schema";
import { nextMonthlyRun, runDueSchedules } from "@/worker/scans/schedule";
import { createHarness, seedTracker, seedWorkspace, type Harness } from "./helpers/harness";

describe("nextMonthlyRun", () => {
  it("returns the next occurrence of the day strictly after now", () => {
    expect(nextMonthlyRun(new Date("2026-10-14T12:00:00Z"), 20).toISOString()).toBe("2026-10-20T00:00:00.000Z");
    expect(nextMonthlyRun(new Date("2026-10-20T00:00:00Z"), 20).toISOString()).toBe("2026-11-20T00:00:00.000Z");
    expect(nextMonthlyRun(new Date("2026-12-30T00:00:00Z"), 1).toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("clamps the day to 1-28 so every month has it", () => {
    expect(nextMonthlyRun(new Date("2026-01-30T00:00:00Z"), 31).toISOString()).toBe("2026-02-28T00:00:00.000Z");
  });
});

describe("runDueSchedules (the Cron tick)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });

  const monthly = (nextRunAt: string | null) => ({ scheduleFrequency: "monthly" as const, scheduleDay: 14, nextRunAt });

  it("starts due monthly trackers, advances next_run_at and ignores the rest", async () => {
    const ws = await seedWorkspace(h.db);
    const due = await seedTracker(h.db, ws, monthly("2026-10-14T00:00:00.000Z"));
    const later = await seedTracker(h.db, ws, monthly("2026-11-14T00:00:00.000Z"));
    const off = await seedTracker(h.db, ws, { scheduleFrequency: "none" });

    const summary = await runDueSchedules(h.deps);
    expect(summary).toMatchObject({ started: 1, failed: 0 });

    const dueScans = await h.db.select().from(scans).where(eq(scans.trackerId, due.trackerId));
    expect(dueScans).toHaveLength(1);
    expect(dueScans[0].trigger).toBe("schedule");
    expect(await h.db.select().from(scans).where(eq(scans.trackerId, later.trackerId))).toHaveLength(0);
    expect(await h.db.select().from(scans).where(eq(scans.trackerId, off.trackerId))).toHaveLength(0);

    const [row] = await h.db.select().from(trackers).where(eq(trackers.id, due.trackerId));
    expect(row.nextRunAt).toBe("2026-11-14T00:00:00.000Z");

    // a second tick the same day does nothing
    expect(await runDueSchedules(h.deps)).toMatchObject({ started: 0 });
    await h.queue.drain(h.deps);
    expect((await h.db.select().from(scans).where(eq(scans.trackerId, due.trackerId)))[0].status).toBe("completed");
  });

  it("records a visible failed scan when a scheduled run cannot start (no credits)", async () => {
    h = await createHarness({ env: { BILLING_MODE: "hosted" } });
    const ws = await seedWorkspace(h.db, 0);
    const t = await seedTracker(h.db, ws, monthly("2026-10-14T00:00:00.000Z"));
    expect(await runDueSchedules(h.deps)).toMatchObject({ started: 0, failed: 1 });
    const [scan] = await h.db.select().from(scans).where(eq(scans.trackerId, t.trackerId));
    expect(scan).toMatchObject({ status: "failed", trigger: "schedule" });
    expect(scan.error).toContain("INSUFFICIENT_CREDITS");
    const [row] = await h.db.select().from(trackers).where(eq(trackers.id, t.trackerId));
    expect(row.nextRunAt).toBe("2026-11-14T00:00:00.000Z"); // still moves on to next month
  });

  it("skips archived trackers", async () => {
    const ws = await seedWorkspace(h.db);
    await seedTracker(h.db, ws, { ...monthly("2026-10-01T00:00:00.000Z"), archivedAt: "2026-10-02T00:00:00.000Z" });
    expect(await runDueSchedules(h.deps)).toMatchObject({ started: 0, failed: 0 });
  });
});
