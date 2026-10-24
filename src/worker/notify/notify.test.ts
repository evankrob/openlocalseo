import { describe, expect, it, vi } from "vitest";
import { createWebhookSender, webhookUrlProblem } from "./index";

const URL_OK = "https://hooks.slack.com/services/T000/B000/XXXX";

describe("webhook url checks", () => {
  it("accepts a public https url", () => {
    expect(webhookUrlProblem(URL_OK)).toBeNull();
  });
  it.each([
    "http://hooks.slack.com/services/x",
    "ftp://example.com/x",
    "not a url",
    "https://user:pw@example.com/x",
    "https://localhost/hook",
    "https://127.0.0.1/hook",
    "https://169.254.169.254/latest",
    "https://[::1]/hook",
    "https://printer.local/hook",
    "https://db.internal/hook",
  ])("rejects %s", (value) => {
    expect(webhookUrlProblem(value)).not.toBeNull();
  });
});

describe("webhook sender", () => {
  it("POSTs {text} as JSON once, with a timeout signal and no redirects", async () => {
    const fetchStub = vi.fn(async () => new Response("ok", { status: 200 }));
    await createWebhookSender(fetchStub as unknown as typeof fetch)(URL_OK, { text: "hello" });
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [url, init] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(URL_OK);
    expect(init).toMatchObject({ method: "POST", redirect: "manual", body: JSON.stringify({ text: "hello" }) });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("throws on a non-2xx answer or a redirect, without retrying", async () => {
    for (const status of [500, 302]) {
      const fetchStub = vi.fn(async () => new Response("", { status }));
      await expect(createWebhookSender(fetchStub as unknown as typeof fetch)(URL_OK, { text: "x" })).rejects.toThrow(`HTTP ${status}`);
      expect(fetchStub).toHaveBeenCalledTimes(1);
    }
  });

  it("refuses a non-https url before any request is made", async () => {
    const fetchStub = vi.fn();
    await expect(createWebhookSender(fetchStub as unknown as typeof fetch)("http://example.com/x", { text: "x" })).rejects.toThrow(/https/);
    expect(fetchStub).not.toHaveBeenCalled();
  });
});
