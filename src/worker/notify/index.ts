// Outbound notifications. With dataforseo/ this is the only place that may
// call fetch. A webhook is a Slack-compatible incoming webhook: POST {text}.
// Best effort by design: one attempt, a short timeout, never retried.
import { AppError } from "@/shared/errors";

export const WEBHOOK_TIMEOUT_MS = 5000;

export type WebhookPayload = { text: string };

/** Sends one notification. Injected into the pipeline so tests use a fake. */
export type WebhookSender = (url: string, payload: WebhookPayload) => Promise<void>;

const BLOCKED_HOST = /^(localhost|.*\.(local|localhost|internal|lan))$/i;

/** Returns the reason a webhook URL is unacceptable, or null when it is fine. */
export function webhookUrlProblem(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Webhook URL is not a valid URL";
  }
  if (url.protocol !== "https:") return "Webhook URL must use https";
  if (url.username || url.password) return "Webhook URL must not contain credentials";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  // Bare IPs (v4 or v6) and internal names are never a Slack-style endpoint.
  if (/^[\d.]+$/.test(host) || host.includes(":") || BLOCKED_HOST.test(host)) return "Webhook URL must use a public hostname";
  return null;
}

export function assertWebhookUrl(value: string): void {
  const problem = webhookUrlProblem(value);
  if (problem) throw new AppError("VALIDATION_ERROR", problem);
}

/** Real sender. Throws on a bad URL, timeout, network error or non-2xx answer. */
export function createWebhookSender(fetchImpl: typeof fetch = (...args) => fetch(...args)): WebhookSender {
  return async (url, payload) => {
    const problem = webhookUrlProblem(url);
    if (problem) throw new Error(problem);
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      // A redirect could point somewhere the URL check never saw.
      redirect: "manual",
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    if (res.status < 200 || res.status >= 300) throw new Error(`Webhook answered HTTP ${res.status}`);
  };
}
