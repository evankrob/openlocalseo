// Smoke tests against the real app: `vite dev` (Worker in workerd + the SPA) with
// the mock DataForSEO provider and local_noauth (both are the wrangler.jsonc
// defaults). No network beyond localhost; map tiles are blocked in the tests.
// Not part of `npm run check` / vitest: run with `npm run test:e2e`.
import { defineConfig, devices } from "@playwright/test";

const PORT = 5199;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
  webServer: {
    // Migrations are idempotent; the specs use unique names, so local dev data is left alone.
    command: `npx wrangler d1 migrations apply DB --local && npx vite dev --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    // Set E2E_SERVER_LOGS=1 to see the dev server's output.
    stdout: process.env.E2E_SERVER_LOGS ? "pipe" : "ignore",
    stderr: process.env.E2E_SERVER_LOGS ? "pipe" : "ignore",
    env: {
      AUTH_MODE: "local_noauth",
      BILLING_MODE: "byok",
      DATAFORSEO_MODE: "mock",
      // Fast, deterministic mock: tasks are ready after 1s and polled every second.
      MOCK_STANDARD_DELAY_SECONDS: "1",
      MOCK_PRIORITY_DELAY_SECONDS: "1",
      POLL_INTERVAL_SECONDS: "1",
      CLOUDFLARE_INCLUDE_PROCESS_ENV: "true",
    },
  },
});
