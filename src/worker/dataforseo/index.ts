import { AppError } from "@/shared/errors";
import { HttpDataForSeo } from "./http";
import { MockDataForSeo, type MockOptions } from "./mock";
import type { DataForSeoProvider, ProviderScope } from "./types";

export type DataForSeoEnv = {
  DATAFORSEO_MODE?: string;
  DATAFORSEO_API_KEY?: string;
  MOCK_STANDARD_DELAY_SECONDS?: string;
  MOCK_PRIORITY_DELAY_SECONDS?: string;
};

/**
 * Defaults to the mock. Live mode needs both DATAFORSEO_MODE=live and an API
 * key, and fails loudly rather than silently falling back to mock data.
 */
export function createDataForSeo(env: DataForSeoEnv): DataForSeoProvider {
  if (env.DATAFORSEO_MODE === "live") {
    if (!env.DATAFORSEO_API_KEY) {
      throw new AppError(
        "DATAFORSEO_AUTH_FAILED",
        "DATAFORSEO_MODE=live requires DATAFORSEO_API_KEY (base64 of login:password)",
      );
    }
    return new HttpDataForSeo(normalizeDataForSeoKey(env.DATAFORSEO_API_KEY));
  }
  return new MockDataForSeo(mockOptions(env));
}

/**
 * Per-business provider for local development: the simulated market is built
 * around the business being tracked. Undefined in live mode, where every
 * call goes through the one real client.
 */
export function createScopedDataForSeo(env: DataForSeoEnv): ((scope: ProviderScope) => DataForSeoProvider) | undefined {
  if (env.DATAFORSEO_MODE === "live") return undefined;
  return (scope) => new MockDataForSeo({ ...mockOptions(env), target: scope });
}

function mockOptions(env: DataForSeoEnv): MockOptions {
  const seconds = (value: string | undefined, fallback: number) => {
    const parsed = Number(value);
    return value && Number.isFinite(parsed) && parsed >= 0 ? parsed * 1000 : fallback;
  };
  return {
    delaysMs: {
      standard: seconds(env.MOCK_STANDARD_DELAY_SECONDS, 12_000),
      priority: seconds(env.MOCK_PRIORITY_DELAY_SECONDS, 4_000),
    },
  };
}

export type { DataForSeoProvider } from "./types";

/**
 * Accepts the key as base64("login:password") or as raw "login:password" and
 * returns the base64 form sent in the Basic auth header. Trims whitespace.
 */
export function normalizeDataForSeoKey(value: string): string {
  const key = value.trim();
  if (key.includes(":")) return btoa(key);
  try {
    if (atob(key).includes(":")) return key;
  } catch {
    // not base64; fall through
  }
  throw new AppError(
    "DATAFORSEO_AUTH_FAILED",
    "The saved DataForSEO API key is not in a usable form. Save it as login:password (or its base64).",
  );
}
