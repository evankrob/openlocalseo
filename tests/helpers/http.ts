import { createApp, type AppOptions } from "@/worker/app";
import type { Env } from "@/worker/env";
import { at } from "@/shared/assert";
import type { Harness } from "./harness";

export const origin = "http://localhost:5173";
export const business = { name: "Maple & Ember Coffee Roasters", placeId: "ChIJdemo0000000000000001", domain: "mapleember.example", lat: 35.7796, lng: -78.6382 };

/** A cookie-keeping HTTP client over the Hono app, wired to the harness deps. */
export function client(h: Harness, env: Partial<Env> = {}, defaults: Record<string, string> = {}, accessKeys?: AppOptions["accessKeys"]) {
  const app = createApp({ resolveDeps: () => h.deps, accessKeys });
  let cookie = "";
  const call = async (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
    const res = await app.request(
      `${origin}${path}`,
      {
        method,
        headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...defaults, ...extra },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      env as Env,
    );
    const set = res.headers.get("set-cookie");
    if (set) cookie = at(set.split(";"), 0);
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
  };
  return { call };
}

/** One JSON-RPC call to the MCP endpoint with an API key. */
export async function mcpCall(h: Harness, key: string, method: string, params: Record<string, unknown> = {}) {
  const app = createApp({ resolveDeps: () => h.deps });
  const res = await app.request(
    `${origin}/mcp`,
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${key}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    },
    {} as Env,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, json: (res.status === 200 ? await res.json() : await res.text()) as any };
}
