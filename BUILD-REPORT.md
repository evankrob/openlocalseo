# BUILD-REPORT: OpenLocalSEO Phase 1 (MVP)

Built in `/workspace/local-grid/app` from SCOPE.md, with `/workspace/local-grid/open-seo-ref` (open-seo, MIT) as the reference. 7 commits on `master`. Nothing was deployed, no Cloudflare resources were created, and no DataForSEO or other paid API was called.

## What is done

| Requirement | Status |
|---|---|
| Grid builder: business + keyword, 3x3 to 13x13, radius (mi/km), fixed zoom, live cost estimate, click/drag center on an OSM map | Done (`TrackerNew.tsx`, `shared/grid.ts`) |
| Scans via DataForSEO Maps **and** Local Finder, Standard queue by default (Priority, Live selectable) | Done. Queue-driven pipeline: post -> collect -> finalize (`worker/scans/process.ts`) |
| Heatmap on OpenStreetMap/Leaflet, no Google Maps API | Done. Numbered pins, 4-tier blue ordinal ramp + gray not-found (palette validated with the dataviz script) |
| Average rank | ARP, ATRP, SoLV (definitions from SCOPE.md section 4) |
| Competitor view | Done. Per-business ARP/ATRP/SoLV computed from the same SERPs (no extra cost), plus per-point result list |
| Scan history and trends | Done. History table, ATRP and SoLV charts (separate charts, table toggle), before/after compare |
| Monthly scheduled scans via Cron | Done. Daily Cron tick starts due trackers, advances `next_run_at` atomically, records a visible failed scan if it can't start (e.g. no credits), reaps stuck scans |
| White-label shareable client reports | Done. Revocable/expiring token links, branding (name, logo, colour, footer, hide attribution), competitors toggle, print-to-PDF. Public payload carries no costs/workspace ids |
| MCP tools `run_scan`, `list_scans`, `get_scan` | Done, plus `list_trackers` (needed to discover ids). `run_scan` requires an approved `maxCostUsd` |
| Reused from open-seo | Cloudflare setup, DataForSEO transport/envelope/per-call cost metadata, BYOK vs hosted +28% cost-plus billing with reserve-then-settle holds, `local_noauth`/`cloudflare_access`/`hosted` auth modes, accounts + workspaces + roles, MCP pattern, UI theme tokens. open-seo's copyright is kept in `LICENSE` and credited in the README |
| Dropped from open-seo | Keyword research, backlinks, site audits, AI visibility, SAM agent, GSC/GA4, Postgres path |
| Mock DataForSEO behind an interface | `DataForSeoProvider` with `MockDataForSeo` (default) and `HttpDataForSeo` (live) |
| Fictional demo data | "Maple & Ember Coffee Roasters" and invented competitors; 2 trackers x 4 monthly scans |
| Tests, README with self-host steps, `.env.example` | Done |

## How to run it

Needs **Node 22+** (Wrangler refuses Node 20).

```bash
npm install
cp .env.example .env
npm run db:reset:local     # local D1 + migrations + demo data
npm run dev                # http://localhost:5173
```

Demo client report: `http://localhost:5173/r/olrep_demo_maple_ember_fictional`. Full steps, config and the Cloudflare self-host commands (documented, not executed) are in `README.md`.

## Test results

- `npm test`: **10 files, 75 tests, all passing** (about 2 s).
- `npm run typecheck` and `npm run build`: clean.
- What the tests cover: grid geometry, metrics and competitor scoring, pricing/markup math against the SCOPE.md cost tables, rank tiers; the DataForSEO live client against recorded-shape fixtures with a stubbed `fetch` (task_post tag mapping, cost summing, pending/no-results/failed statuses, no replay of billed POSTs on 5xx, 401/429); the mock provider (delays, determinism, failure injection); the full scan pipeline on in-memory SQLite using the **real migrations** (Standard/Priority/Live, 13x13 chunking, redelivery idempotency, one active scan per tracker, tenant isolation, cost ceiling, partial failure, timeout, reaper, credit hold/settle/refund, concurrent-spend race); monthly scheduler; REST API over HTTP in all three auth modes (incl. Cloudflare Access JWTs with a local JWKS, session logout, cross-origin blocking, role gating); public report privacy; MCP tools over JSON-RPC.
- **Manual verification beyond unit tests** (not automated in the repo):
  - Real local runtime (`vite dev` -> workerd/Miniflare): migrations applied with `wrangler d1 migrations apply --local`; a 13x13 (169-point) scan ran through the real local Queue and D1 to completion; MCP `initialize`/`list_trackers`/`run_scan`/`list_scans` worked over HTTP; the Cron handler ran via the dev explorer endpoint; `.env` overrides take effect.
  - Headless Chromium (Playwright) walked the dashboard, builder, heatmap with point drill-down, history/trends, compare and the public report with no console errors; screenshots are in `docs/screenshots/`.

## What is mocked

- **DataForSEO only.** `DATAFORSEO_MODE=mock` is the default. The mock builds responses in DataForSEO's real envelope shape from fixtures in `src/worker/dataforseo/fixtures/` and runs them through the same parser as live. It simulates queue latency, deterministic rankings (proximity + prominence + noise), and cost at the real per-task prices. Mock cost rows are tagged `mock` and shown separately from real spend.
- The **live client has never been run against the real API.** Its request shapes follow open-seo's working client and the endpoints in SCOPE.md, but treat the first real scan (3x3) as a verification step.
- Not mocked but worth knowing: the map uses real OpenStreetMap tiles, and the business form's address search calls OSM's Nominatim from the browser. Both only happen at runtime in the browser. Neither is a paid API, and none of the tests or the build touch them.

## Deviations from the brief (and why)

- **Not a literal fork.** open-seo is ~1,900 files tightly coupled to Autumn billing, Better Auth, TanStack Start and its agent/audit workers, so I wrote a lean app and ported the relevant pieces and patterns. Stack differs: **Vite SPA + Hono Worker** instead of TanStack Start, hand-written shadcn-style primitives instead of Base UI.
- **Billing is a D1 credit ledger**, not Autumn/Stripe, so it can run with no external service. There is no checkout: top-ups use an `ADMIN_TOKEN`-guarded endpoint.
- **Hosted accounts use a built-in email/password + session implementation** (PBKDF2, hashed session ids), not Better Auth. No email verification or password reset.
- **MCP auth is API keys only** (no OAuth flow).
- **PDF/PNG export is browser print-to-PDF**; no Browser Rendering Worker, no PNG export.
- **Default zoom is 15** (SCOPE.md notes DataForSEO's own default is 17z); range 10-18, fixed per tracker. Grid max is 13x13 as requested (SCOPE.md lists 21x21 as a later goal). Rank depth is 20.
- **Heatmap uses a blue ordinal ramp, not green-to-red**, following the dataviz guidance (status colors are reserved; each pin also prints its rank, so colour is never the only signal).
- Dark-mode CSS tokens exist but there is no theme toggle and dark mode was not visually checked.

## Environment notes

- The sandbox had Node 20; I installed Node 22 from npm into `/tmp` (outside the repo) to run Wrangler. `package.json` now declares `engines.node >= 22`.
- No git identity was configured. I set a placeholder **repo-local** identity (`OpenLocalSEO Builder <builder@openlocalseo.invalid>`) so commits could be made. Change it (and consider rewriting authorship) before publishing.
- `SCOPE.md` was committed as-is in the first commit.
- The wrangler config uses placeholder resource ids (as open-seo's does for local dev). Deploying requires creating your own D1/R2/Queues and replacing them.

## Known limitations / risks

- No rate limiting or bot protection on signup, login or the public report endpoint.
- Competitor summaries are computed on read from `scan_results` (about 3,400 rows for a 13x13 scan). Fine at this scale; cache or precompute at finalize if it grows.
- `scan_results` keeps every business at every point forever; add a retention policy before heavy hosted use.
- A failed `task_post` is never replayed (it may have been billed). The point is marked failed and the user re-runs. After a crash mid-post, the stuck scan is stopped by the daily reaper (6 h) and held credits are returned.
- Mock "target" hints leak a test-only concept (`MockHints`) into the provider interface; live ignores it.
- Seed `api_calls` rows carry real creation times, not the historical scan dates.
- Browser-side Nominatim lookups follow OSM's light-use policy; heavy hosted use needs a proper geocoder.
- Cloudflare plan limits for Queues, D1 and subrequests were designed around (chunked jobs, `json_each` bulk writes) but not verified against a real account.

## Next steps

1. Run one real 3x3 scan against DataForSEO with a funded key; compare the recorded `api_calls` cost with the estimate and fix any request-shape differences.
2. Phase 2 features from SCOPE.md: alerts (rank drops), GBP info and review tracking, bigger grids (up to 21x21), PNG export / server-side PDF via Browser Rendering.
3. Hosted product: real checkout (Stripe or Autumn), email verification/reset (Better Auth), team invitations, OAuth for MCP, abuse limits/usage caps on a free tier.
4. Rate limiting, audit log, retention jobs, error alerting (the DLQ has no consumer yet).
5. Playwright smoke tests in CI against `vite dev`; dark-mode pass.
6. Precompute competitor summaries; add per-point delta shading on the compare view.
7. Decide on a git identity, remote and first-release process; propose the local-grid module to open-seo as an issue/demo (they are not merging external PRs).
