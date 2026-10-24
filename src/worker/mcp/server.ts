// MCP server (Streamable HTTP, stateless) following open-seo's pattern: tools
// are thin wrappers over the same services the REST API uses, each call is
// scoped to the API key's workspace, and tools that spend money take an
// explicit approved cost ceiling.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { AppError } from "@/shared/errors";
import { emptyGrid, setCell } from "@/shared/grid";
import { asBusinessId, asTrackerId } from "@/shared/ids";
import { listAlerts } from "../alerts";
import type { AuthContext } from "../auth/accounts";
import { getGbpOverview, listReviews } from "../gbp/queries";
import { throttleScans } from "../ratelimit";
import { createScan } from "../scans/service";
import { getScanDetail, listTrackerSummaries, listWorkspaceScans } from "../scans/queries";
import type { ProcessDeps } from "../scans/process";

type Ctx = { auth: AuthContext; deps: ProcessDeps; baseUrl: string };

function ok(text: string, structuredContent: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent };
}

function fail(error: unknown): CallToolResult {
  const message = error instanceof AppError ? `${error.code}: ${error.message}` : "Unexpected error";
  if (!(error instanceof AppError)) console.error("mcp.tool-error", error);
  return { isError: true, content: [{ type: "text", text: message }] };
}

const guard =
  <A>(fn: (args: A) => Promise<CallToolResult>) =>
  async (args: A): Promise<CallToolResult> => {
    try {
      return await fn(args);
    } catch (error) {
      return fail(error);
    }
  };

export function buildMcpServer({ auth, deps, baseUrl }: Ctx): McpServer {
  const server = new McpServer({ name: "openlocalseo", version: "0.1.0" });
  const ws = auth.workspaceId;

  server.registerTool(
    "list_trackers",
    {
      title: "List trackers",
      description:
        "List saved rank-grid trackers (business + keyword + grid settings) with their latest scan result. Use the id with run_scan or list_scans.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    guard(async () => {
      const trackers = await listTrackerSummaries(deps.db, ws);
      const rows = trackers.map((t) => ({
        trackerId: t.id,
        businessId: t.business.id,
        business: t.business.name,
        keyword: t.keyword,
        grid: `${t.gridSize}x${t.gridSize}`,
        queue: t.queueMode,
        lastScan: t.latestScan && { scanId: t.latestScan.id, status: t.latestScan.status, at: t.latestScan.createdAt },
        lastCompleted: t.lastCompleted && {
          scanId: t.lastCompleted.id,
          atrp: t.lastCompleted.atrp,
          arp: t.lastCompleted.arp,
          solv: t.lastCompleted.solv,
        },
      }));
      return ok(
        rows.length
          ? rows.map((r) => `${r.trackerId}: ${r.business} / "${r.keyword}" (${r.grid}, ${r.queue})`).join("\n")
          : "No trackers yet. Create one in the web app first.",
        { trackers: rows },
      );
    }),
  );

  server.registerTool(
    "run_scan",
    {
      title: "Run scan",
      description:
        "Start a rank-grid scan for a tracker. This spends money (DataForSEO calls, plus markup in hosted mode): show the user the cost and pass the amount they approved as maxCostUsd. The scan is rejected if its estimated charge is higher. Standard-queue scans take minutes; poll get_scan until status is completed.",
      inputSchema: {
        trackerId: z.string().describe("Tracker id from list_trackers."),
        maxCostUsd: z.number().positive().describe("Maximum estimated charge in USD the user approved."),
      },
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false },
    },
    guard(async (args: { trackerId: string; maxCostUsd: number }) => {
      await throttleScans(deps, ws);
      const { scanId, quote } = await createScan(deps, ws, asTrackerId(args.trackerId), {
        trigger: "mcp",
        maxCostUsd: args.maxCostUsd,
      });
      return ok(
        `Scan ${scanId} started (${quote.points} points, ${quote.queueMode} queue, estimated $${quote.chargedUsd}). Poll get_scan until it completes.`,
        { scanId, status: "queued", estimatedCostUsd: quote.chargedUsd, points: quote.points, url: `${baseUrl}/scans/${scanId}` },
      );
    }),
  );

  server.registerTool(
    "list_scans",
    {
      title: "List scans",
      description: "List recent scans with their metrics (ARP, ATRP, SoLV), newest first. Optionally filter by tracker.",
      inputSchema: {
        trackerId: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async (args: { trackerId?: string; limit: number }) => {
      const rows = await listWorkspaceScans(deps.db, ws, { trackerId: args.trackerId, limit: args.limit });
      const scans = rows.map((s) => ({
        scanId: s.id,
        trackerId: s.trackerId,
        business: s.businessName,
        keyword: s.keyword,
        status: s.status,
        createdAt: s.createdAt,
        arp: s.arp,
        atrp: s.atrp,
        solv: s.solv,
        foundPoints: s.foundPoints,
        totalPoints: s.totalPoints,
      }));
      return ok(
        scans.length
          ? scans
              .map((s) => `${s.scanId} ${s.createdAt} ${s.status} ${s.business} / "${s.keyword}" ATRP ${s.atrp ?? "-"} SoLV ${s.solv ?? "-"}%`)
              .join("\n")
          : "No scans yet.",
        { scans },
      );
    }),
  );

  server.registerTool(
    "get_scan",
    {
      title: "Get scan",
      description:
        "Get one scan: status, metrics, a grid of ranks (rows north to south, columns west to east; null = not found in the top 20) and the top competitors.",
      inputSchema: {
        scanId: z.string(),
        competitors: z.number().int().min(0).max(25).default(10).describe("How many top competitors to include."),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async (args: { scanId: string; competitors: number }) => {
      const detail = await getScanDetail(deps.db, args.scanId, { workspaceId: ws });
      const size = detail.scan.gridSize;
      const grid = emptyGrid<number | null>(size, null);
      for (const p of detail.points) setCell(grid, p.row, p.col, p.rank);
      const competitors = detail.competitors.slice(0, args.competitors).map((c) => ({
        name: c.name, atrp: c.atrp, arp: c.arp, solv: c.solv, rating: c.rating, ratingCount: c.ratingCount,
      }));
      const s = detail.scan;
      const summary =
        s.status === "completed"
          ? `${detail.business.name} / "${s.keyword}": ATRP ${s.atrp}, ARP ${s.arp ?? "n/a"}, SoLV ${s.solv}% (found at ${s.foundPoints}/${s.totalPoints} points).`
          : `Scan is ${s.status}${s.error ? `: ${s.error}` : ""}.`;
      return ok(summary, {
        scanId: s.id,
        status: s.status,
        business: detail.business.name,
        keyword: s.keyword,
        createdAt: s.createdAt,
        metrics: detail.metrics,
        grid,
        competitors,
        error: s.error,
        url: `${baseUrl}/scans/${s.id}`,
      });
    }),
  );

  server.registerTool(
    "list_alerts",
    {
      title: "List alerts",
      description:
        "List rank-drop alerts (ATRP/SoLV/found-points drops, lost top-3 at the center, or scans with mostly failed points), failed jobs, Google profile rating drops and low-star reviews, unread first. Each shows the metrics before and after.",
      inputSchema: {
        unreadOnly: z.boolean().default(false),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async (args: { unreadOnly: boolean; limit: number }) => {
      const { alerts: all, unreadCount } = await listAlerts(deps.db, ws, { limit: args.unreadOnly ? 200 : args.limit });
      const rows = (args.unreadOnly ? all.filter((a) => a.readAt === null) : all).slice(0, args.limit).map((a) => {
        const common = { alertId: a.id, kind: a.kind, severity: a.severity, business: a.businessName, createdAt: a.createdAt, read: a.readAt !== null };
        const line = `${common.read ? "  " : "* "}${a.severity} ${a.kind} ${a.businessName}`;
        if (a.source === "job") {
          return {
            row: { ...common, jobType: a.jobType, trackerId: a.trackerId, businessId: a.businessId, scanId: a.scanId, snapshotId: a.snapshotId, keyword: a.keyword, message: a.message },
            text: `${line}${a.keyword ? ` / "${a.keyword}"` : ""}: job failed (${a.message})`,
          };
        }
        if (a.source === "gbp") {
          const { rating, reviewCount, negativeReviews } = a.metrics;
          return {
            row: { ...common, businessId: a.businessId, snapshotId: a.snapshotId, rating, reviewCount, negativeReviews: negativeReviews ?? null, url: `${baseUrl}/businesses` },
            text: `${line}: rating ${rating.before ?? "-"} -> ${rating.after ?? "-"}${negativeReviews ? `, ${negativeReviews.count} new low review(s)` : ""}`,
          };
        }
        return {
          row: {
            ...common,
            trackerId: a.trackerId,
            keyword: a.keyword,
            scanId: a.scanId,
            reasons: a.metrics.reasons,
            before: a.metrics.before,
            after: a.metrics.after,
            url: `${baseUrl}/scans/${a.scanId}`,
          },
          text: `${line} / "${a.keyword}": ATRP ${a.metrics.before?.atrp ?? "-"} -> ${a.metrics.after.atrp ?? "-"}, SoLV ${a.metrics.before?.solv ?? "-"} -> ${a.metrics.after.solv ?? "-"}%`,
        };
      });
      return ok(rows.length ? rows.map((r) => r.text).join("\n") : "No alerts.", { unreadCount, alerts: rows.map((r) => r.row) });
    }),
  );

  server.registerTool(
    "get_gbp_profile",
    {
      title: "Get Google Business Profile",
      description:
        "Latest tracked Google Business Profile snapshot for a business: rating, review count, review velocity (reviews per 30 days), unanswered reviews among the newest 20, claimed status, category, photo count, plus the rating/review-count history. Read-only: snapshots are taken monthly for businesses with tracking turned on, or from the web app.",
      inputSchema: { businessId: z.string().describe("Business id (list_trackers shows it).") },
      annotations: { readOnlyHint: true },
    },
    guard(async (args: { businessId: string }) => {
      const overview = await getGbpOverview(deps.db, ws, asBusinessId(args.businessId));
      const l = overview.latest;
      return ok(
        l
          ? `${overview.business.name}: ${l.rating ?? "n/a"} stars from ${l.reviewCount ?? "n/a"} reviews, ${l.velocity30d ?? "n/a"} new per 30 days, ${l.unansweredLast20 ?? "n/a"} of the newest 20 unanswered (${l.takenAt}).`
          : `${overview.business.name}: no profile snapshot yet. Turn on tracking or refresh from the web app.`,
        { ...overview, url: `${baseUrl}/businesses` },
      );
    }),
  );

  server.registerTool(
    "list_reviews",
    {
      title: "List reviews",
      description:
        "Stored Google reviews for a business, newest first, with star rating, date and whether the owner replied. Page with nextCursor. Read-only.",
      inputSchema: {
        businessId: z.string(),
        unansweredOnly: z.boolean().default(false),
        limit: z.number().int().min(1).max(100).default(20),
        cursor: z.string().max(200).optional().describe("nextCursor from the previous page."),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async (args: { businessId: string; unansweredOnly: boolean; limit: number; cursor?: string }) => {
      const page = await listReviews(deps.db, ws, asBusinessId(args.businessId), {
        limit: args.limit,
        cursor: args.cursor,
        unansweredOnly: args.unansweredOnly,
      });
      return ok(
        page.reviews.length
          ? page.reviews
              .map((r) => `${r.publishedAt.slice(0, 10)} ${r.rating}* ${r.ownerAnswered ? "answered" : "UNANSWERED"} ${r.text?.slice(0, 80) ?? ""}`)
              .join("\n")
          : "No reviews stored.",
        { ...page },
      );
    }),
  );

  return server;
}

/** Handles one stateless MCP request; a fresh server and transport per request. */
export async function handleMcpRequest(request: Request, ctx: Ctx): Promise<Response> {
  const server = buildMcpServer(ctx);
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    // Response is fully buffered in JSON mode, so the server can be released.
    void server.close();
  }
}
