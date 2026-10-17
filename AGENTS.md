# AGENTS.md — OpenLocalSEO

Local-rank grid tracker (Google Maps) on Cloudflare: Worker (Hono, D1 via Drizzle, Queues, Cron) + React/Vite UI. Data from DataForSEO (mock by default).

## Commands (Node >= 22)
- `npm install` · `cp .env.example .env` · `npm run db:reset:local` · `npm run dev` (http://localhost:5173)
- `npm run check` = typecheck + lint (oxlint) + tests. **Run before every commit; CI runs the same.**
- Schema change: edit `src/worker/db/schema.ts` → `npm run db:generate` (never hand-edit `migrations/`).

## Map
- `src/worker/app.ts` REST routes. `auth/` three auth modes (`local_noauth`, `cloudflare_access` = default, `hosted`), API keys, sessions. `config.ts` env → typed `AppConfig`.
- `dataforseo/` **the only place that talks to DataForSEO**: `types.ts` provider interface, `http.ts` live client, `mock.ts`/`world.ts` deterministic mock, `parse.ts`/`envelope.ts` response parsing, fixtures + tests.
- `scans/` grid scan pipeline (service → jobs → process, schedule = Cron, sql.ts bulk writes). `billing/` credit hold/settle/refund + usage. `mcp/` MCP server. `reports.ts` public report links.
- `src/client/` React UI; `src/shared/` code shared by both (pricing, errors).
- Tests: `tests/*.test.ts` (API in all auth modes, scans on SQLite with real migrations), `src/worker/**/*.test.ts`.

## Invariants
1. All external HTTP to DataForSEO goes through `createDataForSeo()` / `DataForSeoProvider`. Live mode needs `DATAFORSEO_MODE=live` + key and must fail loudly, never fall back to mock.
2. **Never replay a billed `task_post`.** Failed posts mark the point failed; the user re-runs.
3. Credits: hold before spending, settle on finish, refund on failure. Respect the per-scan cost ceiling.
4. Tenant isolation: every query filters by workspace; one active scan per tracker; queue redelivery must be idempotent.
5. D1 caps 100 bound params per statement: bulk writes use the `json_each` helpers in `scans/sql.ts`.
6. Errors are `AppError` with a code from `src/shared/errors`; validate request bodies with zod.
7. Unknown `AUTH_MODE` falls back to `cloudflare_access`; `local_noauth` only on loopback hosts. Keep it that way.

## Verify
`npm run check`. New DataForSEO behavior → add a recorded-shape fixture + stubbed-fetch test in `dataforseo.test.ts`. New route → test in `tests/api.test.ts` incl. a cross-workspace request.

## Don'ts
- No `fetch` outside `dataforseo/` (except the browser geocoder). No `any`, no `@ts-ignore`.
- No real DataForSEO calls in tests or scripts. Never commit `.env`, `.dev.vars`, API keys, or `dist/`.
- Don't deploy or change wrangler resource ids.
