// MCP server (Streamable HTTP, stateless) following open-seo's pattern: tools
// are thin wrappers over the same services the REST API uses, each call is
// scoped to the API key's workspace, and tools that spend money take an
// explicit approved cost ceiling.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { AppError } from "@/shared/errors";
import type { AuthContext } from "../auth/accounts";
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
      const { scanId, quote } = await createScan(deps, ws, args.trackerId, {
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
      const grid: Array<Array<number | null>> = Array.from({ length: size }, () => Array<number | null>(size).fill(null));
      for (const p of detail.points) grid[p.row][p.col] = p.rank;
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
