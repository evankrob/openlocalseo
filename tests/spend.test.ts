// Spending needs a hold: billed provider calls are only reachable through
// provider.billed(authorization), and authorizations come from billing/spend.ts.
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { AppError } from "@/shared/errors";
import { billedProviderFor, withCreditHold } from "@/worker/billing/spend";
import { getBalance } from "@/worker/billing/credits";
import { creditLedger, scans } from "@/worker/db/schema";
import type { BilledProvider, DataForSeoProvider } from "@/worker/dataforseo/types";
import { createScan } from "@/worker/scans/service";
import { MockDataForSeo } from "@/worker/dataforseo/mock";
import { wrapProvider } from "./helpers/gbp";
import { createHarness, seedTracker, seedWorkspace } from "./helpers/harness";

// Compile-time: the provider interface itself exposes no billed call.
type Billed = keyof BilledProvider;
type ExposesBilledCall = Extract<Billed, keyof DataForSeoProvider> extends never ? false : true;
const noBilledCallOnProvider: ExposesBilledCall = false;

describe("spend authorization", () => {
  it("the provider interface exposes no billed method directly", () => {
    expect(noBilledCallOnProvider).toBe(false);
  });

  it("withCreditHold holds first in hosted mode and refuses before running fn when credits are short", async () => {
    const h = await createHarness({ env: { BILLING_MODE: "hosted" } });
    const ws = await seedWorkspace(h.db, 10);
    const { trackerId } = await seedTracker(h.db, ws);
    let ran = false;
    await expect(
      withCreditHold(h.db, ws, { billingMode: "hosted", credits: 50, scope: "scan", refId: "scan-x" }, async () => {
        ran = true;
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_CREDITS" });
    expect(ran).toBe(false);
    expect(await getBalance(h.db, ws)).toBe(10);
    // the same shortfall stops createScan, and leaves no half-created scan behind
    await expect(createScan(h.deps, ws, trackerId, { trigger: "manual" })).rejects.toBeInstanceOf(AppError);
    expect(await h.db.select().from(scans)).toEqual([]);
  });

  it("withCreditHold in BYOK mode spends nothing from the ledger", async () => {
    const h = await createHarness();
    const ws = await seedWorkspace(h.db, 10);
    let ran = false;
    await withCreditHold(h.db, ws, { billingMode: "byok", credits: 0, scope: "scan", refId: "scan-x" }, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(await h.db.select().from(creditLedger)).toEqual([]);
  });

  it("a hosted job with no recorded hold cannot reach the billed provider", async () => {
    const h = await createHarness({ env: { BILLING_MODE: "hosted" } });
    expect(() => billedProviderFor(h.deps, { reservedCredits: 0 })).toThrow(/No credits were held/);
    expect(() => billedProviderFor(h.deps, { reservedCredits: 20 })).not.toThrow();
    const byok = await createHarness();
    expect(() => billedProviderFor(byok.deps, { reservedCredits: 0 })).not.toThrow();
  });

  it("a hosted scan whose hold was lost fails its points without posting anything", async () => {
    let posts = 0;
    const h = await createHarness({
      env: { BILLING_MODE: "hosted" },
      provider: (clock, target) => {
        const inner = new MockDataForSeo({ now: () => clock.now, target });
        return wrapProvider(inner, { postTasks: async (input) => (posts++, inner.postTasks(input)) });
      },
    });
    const ws = await seedWorkspace(h.db, 500);
    const { trackerId } = await seedTracker(h.db, ws);
    const { scanId } = await createScan(h.deps, ws, trackerId, { trigger: "manual" });
    await h.db.update(scans).set({ reservedCredits: 0 }).where(eq(scans.id, scanId));
    await h.queue.drain(h.deps);
    expect(posts).toBe(0);
    const [scan] = await h.db.select().from(scans).where(eq(scans.id, scanId));
    expect(scan?.status).toBe("failed");
  });
});
