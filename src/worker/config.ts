import { DEFAULT_BILLING_MARKUP, type QueueMode } from "@/shared/pricing";
import type { Env } from "./env";

export type AppConfig = {
  authMode: "local_noauth" | "cloudflare_access" | "hosted";
  billingMode: "byok" | "hosted";
  dataMode: "mock" | "live";
  markup: number;
  hostedFreeCredits: number;
  /** Seconds between collection attempts for a queued task, per queue. */
  pollDelaySeconds: Record<Exclude<QueueMode, "live">, number>;
  /** Give up on a queued scan after this long. */
  maxScanSeconds: Record<QueueMode, number>;
  /** Give up on a Google Business Profile reviews task after this long. */
  maxGbpSeconds: number;
};

export function loadConfig(env: Partial<Env>): AppConfig {
  const authMode =
    env.AUTH_MODE === "local_noauth" || env.AUTH_MODE === "hosted" ? env.AUTH_MODE : "cloudflare_access";
  const dataMode = env.DATAFORSEO_MODE === "live" ? "live" : "mock";
  const markup = Number(env.BILLING_MARKUP);
  const poll = Number(env.POLL_INTERVAL_SECONDS);
  const hasPoll = env.POLL_INTERVAL_SECONDS !== undefined && Number.isFinite(poll) && poll > 0;
  return {
    authMode,
    billingMode: env.BILLING_MODE === "hosted" ? "hosted" : "byok",
    dataMode,
    markup: Number.isFinite(markup) && markup >= 1 ? markup : DEFAULT_BILLING_MARKUP,
    hostedFreeCredits: Number(env.HOSTED_FREE_CREDITS ?? 100) || 0,
    // Standard queue turnaround is minutes; priority is tens of seconds.
    // The mock answers in seconds, so poll quickly while developing.
    pollDelaySeconds: hasPoll
      ? { standard: poll, priority: poll }
      : dataMode === "mock"
        ? { standard: 5, priority: 3 }
        : { standard: 60, priority: 15 },
    maxScanSeconds: { standard: 3 * 3600, priority: 30 * 60, live: 15 * 60 },
    maxGbpSeconds: 3600,
  };
}
