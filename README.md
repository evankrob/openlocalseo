# OpenLocalSEO

An open-source **local SEO map-grid rank tracker**: see where a business shows up in Google Maps, point by point across its service area, the way Local Falcon or Local Dominator do, on infrastructure you control.

![Heatmap](docs/screenshots/heatmap.png)

- **Grid builder**: business + keyword, 3x3 to 13x13 grid, radius in miles or km, fixed zoom, live cost estimate.
- **Scans** through DataForSEO's Google Maps and Local Finder endpoints. The Standard queue is the default (cheapest); Priority and Live are options.
- **Heatmap** on OpenStreetMap + Leaflet (no Google Maps API). Click any pin to see who ranks there.
- **Metrics**: ARP, ATRP, SoLV. **Competitor view** scored from the same SERPs, at no extra cost.
- **History**: scan list, ATRP/SoLV trend charts, side-by-side comparison of two scans.
- **Monthly scheduled scans** via Cron.
- **White-label client reports**: revocable public links with your logo, colour and footer; print to PDF.
- **MCP server** (`run_scan`, `list_scans`, `get_scan`, `list_trackers`) for AI assistants.
- **Bring your own key** (you pay DataForSEO directly) or **hosted cost-plus billing** (credits, DataForSEO cost + 28%). Per-call cost is recorded either way.

> **Safe by default.** Out of the box the app uses a **mock DataForSEO provider** with realistic fixtures: no API key, no network calls, no cost. Real scanning is an explicit opt-in (`DATAFORSEO_MODE=live`).

| | |
|---|---|
| ![Dashboard](docs/screenshots/dashboard.png) | ![Builder](docs/screenshots/grid-builder.png) |
| ![Trends](docs/screenshots/trends.png) | ![Client report](docs/screenshots/client-report.png) |

## Quick start (local, mock data)

Requires **Node 22+** (Wrangler's requirement).

```bash
npm install
cp .env.example .env          # defaults: mock data, local_noauth, BYOK
npm run db:reset:local        # create the local D1 database, apply migrations, load demo data
npm run dev                   # http://localhost:5173
```

The seed loads a **fictional** business ("Maple & Ember Coffee Roasters") with four months of history, branding for a fictional agency, and a public report link:
`http://localhost:5173/r/olrep_demo_maple_ember_fictional`

(The demo's map backdrop is a real city because it needs real coordinates; the business and every competitor are invented.)

Try it: **New grid scan** -> pick the business, type a keyword -> *Save & run scan*. With mock data a Standard scan finishes in about 15 seconds. Everything runs on local Wrangler/Miniflare state in `.wrangler/`. Nothing is deployed and no Cloudflare resources are created.

Other commands:

| | |
|---|---|
| `npm test` | Unit and integration tests (Vitest, real SQL against the real migrations) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | Production build (`vite build` + typecheck) |
| `npm run db:migrate:local` | Apply migrations to the local D1 database |
| `npm run db:seed:local` | (Re)generate and load the demo data |

Trigger the monthly-schedule Cron locally while `npm run dev` is running:

```bash
curl -X POST "http://localhost:5173/cdn-cgi/local/explorer/api/local/scheduled?worker=openlocalseo" \
  -H 'content-type: application/json' -d '{"cron":"15 6 * * *"}'
```

## How scans work

```
UI / MCP / Cron  ->  createScan  ->  D1 (scan + points)  ->  Queue "post"
Queue "post":     one task_post per 100 points (Standard/Priority), or fan out live searches
Queue "collect":  task_get for up to 25 points, re-queues itself while tasks are pending
last point done:  metrics, credit settlement, scan = completed
```

- Every grid point is one SERP. DataForSEO bills at `task_post` time; collecting results is free.
- Every step is idempotent (queue messages can be delivered twice). A partial unique index allows only one active scan per tracker. A daily Cron also stops scans stuck in an active state and returns held credits.
- If some points fail the scan still completes: metrics cover the points that finished and the history shows a note.
- Raw SERP JSON is archived to R2 (one object per collect job); normalized results live in D1 for the heatmap and competitor view.
- The **source** (Maps or Local Finder) and **zoom** are fixed per tracker and snapshotted onto each scan, so history stays comparable (see *Accuracy* below).

### Metrics

| | Definition |
|---|---|
| **ARP** | average rank over the points where the business was found (top 20) |
| **ATRP** | average rank over all points, not-found counted as 21 |
| **SoLV** | share of points where the business ranks in the top 3 |

### Cost (DataForSEO list prices per SERP, depth <= 100)

| | Standard | Priority | Live |
|---|---|---|---|
| price per point | $0.0006 | $0.0012 | $0.002 |
| 7x7 (49 pts) | $0.0294 | $0.0588 | $0.098 |
| 13x13 (169 pts) | $0.1014 | $0.2028 | $0.338 |

These are upper-bound estimates; the real cost of each call is read from DataForSEO's response and stored in `api_calls` (Usage page). Re-check [DataForSEO pricing](https://dataforseo.com/pricing) before budgeting.

## Configuration

See [`.env.example`](.env.example) for every variable.

**Auth modes** (`AUTH_MODE`)

- `local_noauth`: local development only. The Worker refuses any non-loopback hostname in this mode, so a deployed copy left on the default is not open to the internet.
- `cloudflare_access` (default when unset): validates Cloudflare Access JWTs (`TEAM_DOMAIN`, `POLICY_AUD`). Everyone behind the Access app shares one workspace; the first person is owner.
- `hosted`: email + password accounts (PBKDF2, session cookies), multiple workspaces, member roles.

**Billing modes** (`BILLING_MODE`)

- `byok`: you pay DataForSEO directly. Costs are tracked, nothing is charged.
- `hosted`: prepaid credits (1000 credits = $1). A scan holds its marked-up estimate when created and settles on the real cost when finished (unused credits return). New workspaces get `HOSTED_FREE_CREDITS`. Top-ups use `POST /api/admin/credits` with `ADMIN_TOKEN` until a payment provider is connected.

## Self-hosting on Cloudflare

This repo never deploys or creates resources on its own. To run your own copy, do these steps yourself with your own Cloudflare account (check current Cloudflare plan limits for Queues; jobs are chunked to stay under per-invocation subrequest limits):

```bash
npx wrangler login

# 1. Create resources, then put the D1 database_id into wrangler.jsonc
npx wrangler d1 create openlocalseo
npx wrangler r2 bucket create openlocalseo
npx wrangler queues create openlocalseo-scans
npx wrangler queues create openlocalseo-scans-dlq

# 2. Protect the app with Cloudflare Access (Zero Trust -> Access -> Applications),
#    then set in wrangler.jsonc "vars":
#      "AUTH_MODE": "cloudflare_access",
#      "TEAM_DOMAIN": "https://<your-team>.cloudflareaccess.com",
#      "POLICY_AUD": "<application AUD tag>"

# 3. Go live with DataForSEO (optional; stay on mock until you are ready)
#      "DATAFORSEO_MODE": "live"
npx wrangler secret put DATAFORSEO_API_KEY     # base64 of login:password

# 4. Migrate and deploy
npm run build
npx wrangler d1 migrations apply DB --remote
npx wrangler deploy
```

The Cron (`15 6 * * *`) starts due monthly scans. MCP clients must reach `/mcp` with a bearer API key, so exclude `/mcp` from the Access policy (API keys authenticate it) or use an Access service token.

## MCP

Create an API key under **Settings -> API keys & MCP**, then:

```bash
claude mcp add --transport http openlocalseo http://localhost:5173/mcp \
  --header "Authorization: Bearer olseo_..."
```

| Tool | |
|---|---|
| `list_trackers` | saved grids with their latest result |
| `run_scan` | starts a scan; **requires `maxCostUsd`**, the amount the user approved, and refuses if the estimate is higher |
| `list_scans` | recent scans with ARP / ATRP / SoLV |
| `get_scan` | status, metrics, a rank grid (rows north to south) and top competitors |

## Mocked vs real

| Mocked by default | Real |
|---|---|
| DataForSEO (`src/worker/dataforseo/mock.ts`) behind the `DataForSeoProvider` interface | Everything else: D1, Queues, Cron, R2 (local emulation), auth, billing ledger, MCP |

The live client (`http.ts`) is complete but has **never been run against the real API** in this repository's tests; its tests use recorded-shape fixtures with a stubbed `fetch`. Do a small first scan (3x3) and check the Usage page before relying on it.

## Accuracy notes

- Coordinate-based SERPs simulate a searcher at each point. They can differ from a real phone because of personalization and history. Zoom changes results, so it is fixed per tracker.
- Maps, Local Finder and the 3-pack can rank differently. Reports state which source was used.
- Standard-queue turnaround is minutes; use Priority or Live for on-demand scans.

## Architecture

```
src/shared/     grid math, metrics, pricing, rank tiers, zod schemas (used by worker + UI)
src/worker/     Hono API, queue consumer, cron, MCP, D1 (Drizzle), auth, billing, DataForSEO
src/client/     React SPA (Vite, Tailwind, TanStack Query, Leaflet, Recharts)
migrations/     D1 SQL (generated by drizzle-kit from src/worker/db/schema.ts)
tests/          integration tests on in-memory SQLite with the real migrations
scripts/seed.ts demo data generator
```

## Credits and license

OpenLocalSEO is MIT-licensed. It is based on **[open-seo](https://github.com/every-app/open-seo)** by Ben Senescu (MIT, Copyright (c) 2026 Ben Senescu), and keeps its copyright notice in [LICENSE](LICENSE). What it reuses or adapts from open-seo:

- the Cloudflare Worker setup (wrangler config, Vite plugin, D1/R2/Queues layout);
- the DataForSEO client: authenticated transport with retry rules, response-envelope status ladder, and per-call cost metadata (`src/worker/dataforseo/envelope.ts`, `http.ts`);
- bring-your-own-key vs hosted cost-plus billing: cost per call recorded, +28% markup, reserve-then-settle credit holds (`src/shared/pricing.ts`, `src/worker/billing/`);
- the auth modes (`local_noauth`, `cloudflare_access`, `hosted`), accounts and workspaces;
- the MCP server pattern (stateless Streamable HTTP, per-workspace tools, explicit cost approval);
- the UI theme tokens and component style.

open-seo's general SEO tools (keyword research, backlinks, site audits) are not included. This project is independent and not affiliated with open-seo or DataForSEO. Map data (c) OpenStreetMap contributors.
