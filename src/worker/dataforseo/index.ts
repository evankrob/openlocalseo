import { AppError } from "@/shared/errors";
import { HttpDataForSeo } from "./http";
import { MockDataForSeo } from "./mock";
import type { DataForSeoProvider } from "./types";

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
    return new HttpDataForSeo(env.DATAFORSEO_API_KEY);
  }
  const seconds = (value: string | undefined, fallback: number) => {
    const parsed = Number(value);
    return value && Number.isFinite(parsed) && parsed >= 0 ? parsed * 1000 : fallback;
  };
  return new MockDataForSeo({
    delaysMs: {
      standard: seconds(env.MOCK_STANDARD_DELAY_SECONDS, 12_000),
      priority: seconds(env.MOCK_PRIORITY_DELAY_SECONDS, 4_000),
    },
  });
}

export type { DataForSeoProvider } from "./types";
