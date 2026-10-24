import { createApp, defaultResolveDeps } from "./app";
import type { Env } from "./env";
import { reapStaleGbpSnapshots } from "./gbp/process";
import { runDueGbpSnapshots } from "./gbp/service";
import { handleQueueBatch } from "./queue";
import { runRetention } from "./retention";
import type { ScanJob } from "./scans/jobs";
import { runDueSchedules } from "./scans/schedule";

const app = createApp();

export default {
  fetch: app.fetch,

  // Queue consumer for openlocalseo-scans (one message per scan step, see
  // scans/process.ts) and its dead-letter queue (see queue.ts).
  async queue(batch: MessageBatch<ScanJob>, env: Env, ctx: ExecutionContext): Promise<void> {
    await handleQueueBatch(defaultResolveDeps(env, ctx), batch);
  },

  // Daily Cron: start due monthly scans and profile snapshots, reap stuck ones,
  // then prune old rows (see retention.ts).
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const deps = defaultResolveDeps(env);
    const summary = await runDueSchedules(deps);
    console.log("schedule.tick", summary);
    const gbp = await runDueGbpSnapshots(deps);
    console.log("schedule.gbp-tick", { ...gbp, reaped: await reapStaleGbpSnapshots(deps) });
    try {
      console.log("retention.tick", await runRetention(deps));
    } catch (error) {
      // Pruning is housekeeping: a failure must not fail the tick; it retries tomorrow.
      console.error("retention.failed", { error: error instanceof Error ? error.message : "unknown error" });
    }
  },
} satisfies ExportedHandler<Env, ScanJob>;
