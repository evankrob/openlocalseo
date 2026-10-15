# Local rank-grid tool scope (research only), 2026-10-14

## 1. open-seo
- Source: https://github.com/every-app/open-seo (README and package.json, fetched 2026-10-14). MIT license, TypeScript, about 23.6k stars, last push 2026-10-14.
- Features: keyword research, rank tracking, competitor insights, backlinks, site audits, AI visibility, an MCP server and agent skills. It is bring-your-own DataForSEO key and pay as you go. The hosted version is $10/mo and adds 28% to DataForSEO costs.
- Stack: TanStack Start (React), Tailwind, drizzle-orm, better-auth, recharts, and Cloudflare (agents, workers-oauth-provider). Its docs recommend Cloudflare self-hosting, which runs on the free plan. Docker is also an option.
- Can it go local? Yes. It already wraps DataForSEO SERP calls and rank tracking, so a "Local grid" module would add a grid generator, the Maps endpoint, a heatmap, and new tables. Forking it is the easiest route because MIT allows it. Its depth on local/maps is UNVERIFIED (I didn't read the code).

## 2. Open-source starting points (GitHub API, 2026-10-14)
| Repo | License | Stars | Last push | Notes |
|---|---|---|---|---|
| https://github.com/avalonreset/legends-geogrid | MIT | 16 | 2026-10-03 | Google Maps geogrid checker on DataForSEO, with PDF reports and cost estimates. Best reference. |
| https://github.com/orenagassy/geogrid | MIT | 0 | 2026-10-04 | Small, unreviewed |
| https://github.com/zygmanskimaksymilian-prog/geogrid-rank-tracker | MIT | 0 | 2026-07-31 | Unreviewed |
| https://github.com/IlluminatiCode/local-grid-rank-tracker | none | 1 | 2025-07-20 | No license, so we can't reuse it |
| https://github.com/local-falcon/mcp | MIT | 24 | 2026-10-06 | MCP client for Local Falcon's API, not a tracker |
I found no mature, popular OSS rank-grid tracker. Plan to build our own, using legends-geogrid as a reference.

## 3. DataForSEO endpoints and prices
- SERP Google Maps: /v3/serp/google/maps/task_post (standard/priority) or /live/advanced. `location_coordinate` = "latitude,longitude,zoom", and the default zoom is 17z. Docs: https://docs.dataforseo.com/v3/serp/google/maps/live/advanced/
- SERP Google Local Finder: /v3/serp/google/local_finder/... is the same idea and returns the "more places" list.
- Price per SERP (up to 100 results) is the same for Maps and Local Finder: Standard $0.0006, Priority $0.0012, Live $0.002. Location doesn't change the price. Sources: https://dataforseo.com/pricing/serp/google-maps-serp-api and https://dataforseo.com/pricing/serp/google-local-finder-serp-api
- Business Data, Google Reviews: Standard is $0.00075 per block of 10 reviews, Priority $0.0015. Extended reviews cost a base task fee plus a keyword surcharge of +$0.0015 or a place_id/cid surcharge of +$0.00075. Source: https://dataforseo.com/pricing/business-data/google-reviews-api
- Business Data, My Business Info: price UNVERIFIED, because the pricing page didn't parse. Check https://dataforseo.com/pricing before budgeting. It's a small cost either way, since we'd call it once per client per scan at most.

### Cost math (1 SERP per grid point, depth ≤100)
| | Standard $0.0006 | Priority $0.0012 | Live $0.002 |
|---|---|---|---|
| 7x7 = 49 pts, 1 scan | $0.0294 | $0.0588 | $0.098 |
| 13x13 = 169 pts, 1 scan | $0.1014 | $0.2028 | $0.338 |
Monthly volume: 5 clients x 5 keywords x 4.33 weeks = 108.25 scans/mo.
| Monthly | Standard | Priority | Live |
|---|---|---|---|
| 7x7 (108.25 x per-scan cost) | $3.18 | $6.37 | $10.61 |
| 13x13 | $10.98 | $21.95 | $36.59 |
Reviews and business info add very little on top. Example: weekly GMB info plus 20 reviews for 5 clients is well under $1/mo using the review prices above.

For comparison, Local Falcon charges 1 credit per grid point (their example: a 9x9 grid = 81 credits). Plans run $24.99/mo for 7,500 credits up to $199.99/mo for about 63k credits. Our 13x13 workload is 108.25 x 169 = about 18,294 points/mo, which would need their roughly $49.99 tier with 15,150 credits or higher. The exact tier is UNVERIFIED. Source: https://www.localfalcon.com/pricing

## 4. Must-have features vs Local Falcon
- Grid generator: 3x3 to 21x21 grid, radius in miles/km, centered on the business, with a configurable zoom.
- Heatmap on a map (Leaflet/MapLibre), with each pin colored by rank 1-20+.
- Metrics, using Local Falcon's definitions from its docs. ARP = average rank where found. ATRP = average rank across all points, with not-found counted as 21. SoLV = % of points ranking in the top 3. (Local Falcon's metric doc pages weren't fetched in this pass, so these definitions are UNVERIFIED.)
- Competitor view: every business at each point, with its own ARP/SoLV, taken from the same SERP response at no extra cost.
- History: scheduled scans, trend charts, and side-by-side heatmap comparisons.
- Shareable client reports: a public read-only link plus a PDF/PNG export, white-label.
- Nice to have: GBP info and review tracking, an MCP endpoint (open-seo already has this pattern), and alerts.

## 5. Suggested stack (Cloudflare-first)
- Pages/Workers (TanStack Start, the same as open-seo) for the UI and API.
- D1 for clients, keywords, scans, points, and results.
- Cron Triggers to start the weekly scans.
- Queues to fan out task_post calls. DataForSEO accepts up to 100 tasks per POST (UNVERIFIED in this pass). Use a pingback/postback URL to a Worker, or have a queue consumer poll tasks_ready.
- R2 for raw SERP JSON and rendered PNG/PDF reports.
- Browser Rendering (Workers) for PDF exports.
- Possible limitation: if D1's per-DB size limit or write volume becomes a problem, move heavy results to R2 and keep only aggregates in D1. At our volume (about 18k rows/mo) this is fine. I don't see anything that rules Cloudflare out.

## 6. Risks
- Accuracy: coordinate-based SERPs simulate a searcher standing at each point. Results can still differ from a real phone user because of personalization, search history, and device. Zoom also changes the results. Pick one zoom (Local Falcon-style tools also vary here) and keep it fixed so history stays comparable.
- Maps vs Local Finder vs the 3-pack can rank differently. Decide which one is the source of truth and label it in reports.
- Google terms: DataForSEO does the scraping, so the ToS exposure sits with them, not with us calling Google directly. We just depend on them as a vendor.
- Rate limits: DataForSEO reports per-endpoint per-minute limits in X-RateLimit-Limit headers (https://docs.dataforseo.com/v3/). The widely cited figure of 2,000 calls/min is UNVERIFIED. Our load of about 18k tasks/mo is small, so batch POSTs through Queues.
- Standard queue turnaround is slow (minutes or more), so on-demand scans should use Priority or Live, and weekly scans should use Standard.

## 7. Cost comparison vs Local Dominator ($99/mo, monthly scans)
- Local Dominator's pricing page (https://localdominator.co/pricing) renders with JavaScript. The only text I could read was its meta description: "pricing plans from $32.50/mo ... AI Tracker, Geo Grid Scans & GBP management". **What the $99 plan includes (scan or credit allowance) is UNVERIFIED.** Evan should check his plan's allowance in the account.
- **Assumption:** Local Dominator runs on DataForSEO (or similar) data. This is unconfirmed.
- Price per grid point, from section 3: Standard $0.0006, Priority $0.0012, Live $0.002 (https://dataforseo.com/pricing/serp/google-maps-serp-api).

**Formula:** monthly cost = locations × keywords × scans/month × grid points × price per point (+ fixed costs)

### What $99 buys on DataForSEO (single-keyword scans)
| Grid | Standard | Priority | Live |
|---|---|---|---|
| 7x7 ($0.0294 / $0.0588 / $0.098 per scan) | 3,367 | 1,683 | 1,010 |
| 13x13 ($0.1014 / $0.2028 / $0.338 per scan) | 976 | 488 | 292 |

### Break-even (location × keyword pairs where DIY = $99)
| Grid / tier | Monthly scans | Weekly scans (4.33/mo) | Monthly scans after $5 Cloudflare ($94 left) |
|---|---|---|---|
| 7x7 Standard | 3,367 | 778 | 3,197 |
| 7x7 Priority | 1,683 | 389 | 1,598 |
| 7x7 Live | 1,010 | 233 | 959 |
| 13x13 Standard | 976 | 225 | 927 |
| 13x13 Priority | 488 | 113 | 463 |
| 13x13 Live | 292 | 68 | 278 |

### Example monthly data cost (1 scan/month per location-keyword)
| Location-keywords | 7x7 S / P / L | 13x13 S / P / L |
|---|---|---|
| 10 | $0.29 / $0.59 / $0.98 | $1.01 / $2.03 / $3.38 |
| 25 | $0.74 / $1.47 / $2.45 | $2.54 / $5.07 / $8.45 |
| 50 | $1.47 / $2.94 / $4.90 | $5.07 / $10.14 / $16.90 |
| 100 | $2.94 / $5.88 / $9.80 | $10.14 / $20.28 / $33.80 |
For weekly scans, multiply by 4.33.

### Fixed costs
- Cloudflare Workers Paid has a $5/mo account minimum (https://developers.cloudflare.com/workers/platform/pricing/). The free plan may be enough at this volume (UNVERIFIED for Queues and Browser Rendering limits).
- DataForSEO's minimum account top-up is $50 (https://dataforseo.com/pricing FAQ). That's a prepaid balance, not a monthly fee.
- Dev time and maintenance aren't counted. They're the real cost.

## 8. Product and monetization (modeled on open-seo)
- **How open-seo makes money:** the core is MIT and self-hostable with your own DataForSEO key, for free. The hosted version is $10/mo, and the hosted service "charges 28% extra for every request we make to DataForSEO" (README, https://github.com/every-app/open-seo). Pricing page: https://openseo.so/pricing (not parsed; its details are UNVERIFIED).
- **Our model:** an open-source core (grid scans, heatmap, metrics) plus a paid hosted version for agencies. Paid features: white-label reports, client share links, scheduling, multiple users, and a markup on data usage like open-seo's.
- **Competitor price anchors:**
  - Local Falcon: $24.99 to $199.99/mo for 7,500 to about 63k credits, at 1 credit per grid point. Its on-demand API is $199/mo plus $0.0032 per request (https://www.localfalcon.com/pricing).
  - Local Viking (now branded LocalOptics): Single $39 (1 listing, 7,500 GeoGrid credits), Starter $59 (10 listings, 8,100), Pro $99 (20 listings, 16,200, white-label), Agency $149 (40 listings, 24,300), Enterprise $200 (70 listings, 32,400) (https://www.localviking.com/pricing).
  - Local Dominator: from $32.50/mo (meta description, https://localdominator.co/pricing).
  - BrightLocal: from $39/mo for the platform (https://www.brightlocal.com/pricing/). Its grid-tool pricing is UNVERIFIED.
  - Idea (not sourced): a free self-hosted version, a ~$19–29/mo hosted tier plus metered data, and a ~$79–99/mo agency white-label tier. This sits under the Local Viking and Local Falcon $99 tiers. Our raw data cost per grid point is $0.0006–0.002, versus about $0.0032 per request on Local Falcon's API.
- **Launch channels:** GitHub (MIT repo with a demo), Product Hunt, r/localseo, r/SEO, Local Search Forum, X (build in public, tag @bensenescu/open-seo), the open-seo Discord, and DataForSEO's affiliate or showcase program (UNVERIFIED).
- **Secondary benefit for the agency:** GitHub stars and backlinks to raleighdigital, authority in local SEO, and a free tool funnel that brings in leads for agency services.
- **Contributing to open-seo:** it's under the MIT license (Copyright 2026 Ben Senescu), and there's no CLA. However, CONTRIBUTING.md says they are **not merging external PRs right now** (AI and security reasons). They prefer issues, PRs as proofs of concept, and forks. So the realistic path is a fork or standalone add-on, plus an issue and demo PR to the maintainer. Forking is clean under MIT if we keep the copyright notice (https://github.com/every-app/open-seo/blob/main/docs/CONTRIBUTING.md).
- **Risks:**
  - Support burden from self-hosters.
  - DataForSEO price changes get passed through to us, and the $50 prepay plus abuse risk on a hosted free tier means we'd need a usage cap.
  - Crowded market (Local Falcon, Local Viking/LocalOptics, Local Dominator, BrightLocal), and open-seo may ship local tracking itself.
  - Google terms risk sits with the data vendor, but rankings depend on Google's layout and accuracy (section 6).
