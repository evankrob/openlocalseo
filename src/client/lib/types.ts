import type { CompetitorSummary, ScanMetrics } from "@/shared/metrics";
export type { ScanDetail, ScanListItem, TrackerSummary } from "@/worker/scans/queries";
export type { CompetitorSummary, ScanMetrics };
import type { AlertSettingsValues } from "@/shared/alerts";
import type { AlertListItem } from "@/worker/alerts";
export type { AlertListItem };
export type AlertList = { unreadCount: number; alerts: AlertListItem[] };
export type AlertSettings = AlertSettingsValues & { webhookConfigured: boolean };

import type { FailedJob } from "@/worker/ops";
export type { FailedJob };
import type { GbpQuote } from "@/worker/gbp/service";
import type { GbpSnapshotView, ReviewView, getGbpOverview } from "@/worker/gbp/queries";
export type { GbpQuote, GbpSnapshotView, ReviewView };
export type GbpOverview = Awaited<ReturnType<typeof getGbpOverview>> & { quote: GbpQuote; monthlyCostUsd: number };
export type ReviewPage = { reviews: ReviewView[]; nextCursor: string | null };

export type Me = {
  user: { id: string; email: string };
  workspace: { id: string; name: string; role: "owner" | "admin" | "member" };
  workspaces: Array<{ id: string; name: string; role: string }>;
  config: { authMode: string; billingMode: "byok" | "hosted"; dataMode: "mock" | "live"; markup: number };
};

export type PointResults = {
  point: { id: string; row: number; col: number; lat: number; lng: number; rank: number | null; status: string };
  results: Array<{ rank: number; name: string; rating: number | null; ratingCount: number | null; category: string | null; address: string | null; isTarget: boolean }>;
  /** Retention pruned this scan's competitor rows. */
  competitorsExpired?: boolean;
};

export type FailedJobs = { since: string; jobs: FailedJob[] };

/** What the map + tables need; both the app and the public report map onto it. */
export type ScanViewData = {
  id: string;
  keyword: string;
  createdAt: string;
  gridSize: number;
  radiusKm: number;
  zoom: number;
  searchType: "maps" | "local_finder";
  business: { name: string; lat: number; lng: number };
  points: Array<{ id: string; row: number; col: number; lat: number; lng: number; rank: number | null; status?: string }>;
  metrics: ScanMetrics | null;
  competitors: CompetitorSummary[];
  /** True once retention pruned the competitor rows (the grid and metrics remain). */
  competitorsExpired?: boolean;
  retentionDays?: number | null;
};
