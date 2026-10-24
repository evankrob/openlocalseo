import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

const createdAt = () =>
  text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);

// ---- accounts & workspaces -------------------------------------------------

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  // PBKDF2 hash, only set in AUTH_MODE=hosted.
  passwordHash: text("password_hash"),
  createdAt: createdAt(),
});

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  // Hosted usage credits (1000 credits = $1 of marked-up provider cost).
  // Unused in BILLING_MODE=byok. Changed only through billing/credits.ts.
  creditBalance: integer("credit_balance").notNull().default(0),
  createdAt: createdAt(),
});

export const memberships = sqliteTable(
  "memberships",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "admin", "member"] }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.userId] }),
    index("memberships_user_idx").on(t.userId),
  ],
);

export const sessions = sqliteTable(
  "sessions",
  {
    // SHA-256 of the session token; the token itself lives only in the cookie.
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: text("expires_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    // First characters of the key, shown in the UI to tell keys apart.
    prefix: text("prefix").notNull(),
    keyHash: text("key_hash").notNull().unique(),
    lastUsedAt: text("last_used_at"),
    revokedAt: text("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [index("api_keys_workspace_idx").on(t.workspaceId)],
);

// ---- businesses, trackers (saved grid configs), scans -----------------------

export const businesses = sqliteTable(
  "businesses",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Identity used to recognise the business in map results.
    placeId: text("place_id"),
    cid: text("cid"),
    domain: text("domain"),
    address: text("address"),
    category: text("category"),
    lat: real("lat").notNull(),
    lng: real("lng").notNull(),
    // Opt-in monthly Google Business Profile snapshot (costs money, so off by default).
    gbpTracking: integer("gbp_tracking", { mode: "boolean" }).notNull().default(false),
    gbpNextRunAt: text("gbp_next_run_at"),
    createdAt: createdAt(),
    archivedAt: text("archived_at"),
  },
  (t) => [index("businesses_workspace_idx").on(t.workspaceId), index("businesses_gbp_next_run_idx").on(t.gbpNextRunAt)],
);

export const trackers = sqliteTable(
  "trackers",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    businessId: text("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    keyword: text("keyword").notNull(),
    centerLat: real("center_lat").notNull(),
    centerLng: real("center_lng").notNull(),
    gridSize: integer("grid_size").notNull(),
    radiusKm: real("radius_km").notNull(),
    radiusUnit: text("radius_unit", { enum: ["km", "mi"] }).notNull().default("km"),
    // Fixed per tracker so scans stay comparable over time.
    zoom: integer("zoom").notNull(),
    searchType: text("search_type", { enum: ["maps", "local_finder"] }).notNull().default("maps"),
    queueMode: text("queue_mode", { enum: ["standard", "priority", "live"] }).notNull().default("standard"),
    device: text("device", { enum: ["desktop", "mobile"] }).notNull().default("mobile"),
    languageCode: text("language_code").notNull().default("en"),
    depth: integer("depth").notNull().default(20),
    scheduleFrequency: text("schedule_frequency", { enum: ["none", "monthly"] }).notNull().default("none"),
    // Day of month (1-28) the scheduled scan runs on.
    scheduleDay: integer("schedule_day").notNull().default(1),
    nextRunAt: text("next_run_at"),
    createdAt: createdAt(),
    archivedAt: text("archived_at"),
  },
  (t) => [
    index("trackers_workspace_idx").on(t.workspaceId),
    index("trackers_business_idx").on(t.businessId),
    index("trackers_next_run_idx").on(t.nextRunAt),
  ],
);

export const scans = sqliteTable(
  "scans",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    trackerId: text("tracker_id")
      .notNull()
      .references(() => trackers.id, { onDelete: "cascade" }),
    status: text("status", {
      enum: ["queued", "posting", "polling", "completed", "failed"],
    }).notNull(),
    trigger: text("trigger", { enum: ["manual", "schedule", "mcp"] }).notNull(),
    // Settings snapshot: a tracker can be edited later, history cannot change.
    keyword: text("keyword").notNull(),
    centerLat: real("center_lat").notNull(),
    centerLng: real("center_lng").notNull(),
    gridSize: integer("grid_size").notNull(),
    radiusKm: real("radius_km").notNull(),
    zoom: integer("zoom").notNull(),
    searchType: text("search_type", { enum: ["maps", "local_finder"] }).notNull(),
    queueMode: text("queue_mode", { enum: ["standard", "priority", "live"] }).notNull(),
    device: text("device", { enum: ["desktop", "mobile"] }).notNull(),
    languageCode: text("language_code").notNull(),
    depth: integer("depth").notNull(),
    // Metrics, filled when the scan completes.
    arp: real("arp"),
    atrp: real("atrp"),
    solv: real("solv"),
    foundPoints: integer("found_points"),
    top3Points: integer("top3_points"),
    totalPoints: integer("total_points").notNull(),
    // Cost tracking. estimated = upper bound at creation; cost = sum of the
    // per-call costs DataForSEO reported (see api_calls).
    estimatedCostUsd: real("estimated_cost_usd").notNull(),
    costUsd: real("cost_usd").notNull().default(0),
    reservedCredits: integer("reserved_credits").notNull().default(0),
    billedCredits: integer("billed_credits").notNull().default(0),
    error: text("error"),
    rawR2Key: text("raw_r2_key"),
    // Set by the retention job once this scan's per-point competitor rows
    // (scan_results) are pruned. The grid and metrics are kept forever.
    resultsPrunedAt: text("results_pruned_at"),
    createdAt: createdAt(),
    completedAt: text("completed_at"),
  },
  (t) => [
    index("scans_tracker_idx").on(t.trackerId, t.createdAt),
    index("scans_workspace_idx").on(t.workspaceId, t.createdAt),
    // At most one active scan per tracker, enforced by the database so two
    // concurrent "run scan" clicks cannot both be charged.
    uniqueIndex("scans_one_active_per_tracker_idx")
      .on(t.trackerId)
      .where(sql`${t.status} IN ('queued','posting','polling')`),
  ],
);

export const scanPoints = sqliteTable(
  "scan_points",
  {
    id: text("id").primaryKey(),
    scanId: text("scan_id")
      .notNull()
      .references(() => scans.id, { onDelete: "cascade" }),
    row: integer("row").notNull(),
    col: integer("col").notNull(),
    lat: real("lat").notNull(),
    lng: real("lng").notNull(),
    status: text("status", { enum: ["pending", "posted", "completed", "failed"] })
      .notNull()
      .default("pending"),
    taskId: text("task_id"),
    // Target business rank at this point; null = not found in the tracked depth.
    rank: integer("rank"),
    error: text("error"),
  },
  (t) => [
    uniqueIndex("scan_points_cell_idx").on(t.scanId, t.row, t.col),
  ],
);

// Every business returned at every point: the competitor view reads from here.
export const scanResults = sqliteTable(
  "scan_results",
  {
    id: text("id").primaryKey(),
    scanId: text("scan_id")
      .notNull()
      .references(() => scans.id, { onDelete: "cascade" }),
    pointId: text("point_id")
      .notNull()
      .references(() => scanPoints.id, { onDelete: "cascade" }),
    rank: integer("rank").notNull(),
    businessKey: text("business_key").notNull(),
    name: text("name").notNull(),
    placeId: text("place_id"),
    cid: text("cid"),
    domain: text("domain"),
    rating: real("rating"),
    ratingCount: integer("rating_count"),
    category: text("category"),
    address: text("address"),
    isTarget: integer("is_target", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [
    index("scan_results_scan_idx").on(t.scanId),
    index("scan_results_point_idx").on(t.pointId),
  ],
);

// ---- cost tracking & billing -------------------------------------------------

// One row per DataForSEO call (or task_post batch), with the cost the
// provider reported. The source of truth for spend in both billing modes.
export const apiCalls = sqliteTable(
  "api_calls",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    scanId: text("scan_id").references(() => scans.id, { onDelete: "set null" }),
    provider: text("provider").notNull(),
    // "mock" rows are simulated cost, never real spend.
    mode: text("mode", { enum: ["mock", "live"] }).notNull(),
    path: text("path").notNull(),
    taskCount: integer("task_count").notNull().default(1),
    costUsd: real("cost_usd").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("api_calls_workspace_idx").on(t.workspaceId, t.createdAt),
    index("api_calls_scan_idx").on(t.scanId),
  ],
);

export const creditLedger = sqliteTable(
  "credit_ledger",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    scanId: text("scan_id").references(() => scans.id, { onDelete: "set null" }),
    // Negative = spend/hold, positive = grant/top-up/refund.
    delta: integer("delta").notNull(),
    reason: text("reason", {
      enum: ["grant", "topup", "scan_hold", "scan_refund", "gbp_hold", "gbp_refund"],
    }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("credit_ledger_workspace_idx").on(t.workspaceId, t.createdAt)],
);

// ---- white-label reports ------------------------------------------------------

export const workspaceBranding = sqliteTable("workspace_branding", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  brandName: text("brand_name"),
  logoUrl: text("logo_url"),
  primaryColor: text("primary_color"),
  footerText: text("footer_text"),
  contactUrl: text("contact_url"),
  // Hide the "Powered by OpenLocalSEO" line on shared reports.
  hideAttribution: integer("hide_attribution", { mode: "boolean" }).notNull().default(false),
});

export const reportShares = sqliteTable(
  "report_shares",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    trackerId: text("tracker_id")
      .notNull()
      .references(() => trackers.id, { onDelete: "cascade" }),
    // SHA-256 of the URL token; the token is shown once at creation.
    tokenHash: text("token_hash").notNull().unique(),
    label: text("label"),
    showCompetitors: integer("show_competitors", { mode: "boolean" }).notNull().default(true),
    expiresAt: text("expires_at"),
    revokedAt: text("revoked_at"),
    viewCount: integer("view_count").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("report_shares_tracker_idx").on(t.trackerId)],
);

// ---- Google Business Profile tracking ----------------------------------------------

// One row per profile snapshot (monthly or on demand): the profile numbers plus
// what changed since the previous completed snapshot.
export const gbpSnapshots = sqliteTable(
  "gbp_snapshots",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    businessId: text("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    trigger: text("trigger", { enum: ["manual", "schedule"] }).notNull(),
    takenAt: text("taken_at").notNull(),
    status: text("status", { enum: ["queued", "running", "completed", "failed"] }).notNull(),
    rating: real("rating"),
    reviewCount: integer("review_count"),
    // JSON text: star ("1".."5") to number of reviews.
    ratingDistribution: text("rating_distribution"),
    isClaimed: integer("is_claimed", { mode: "boolean" }),
    totalPhotos: integer("total_photos"),
    primaryCategory: text("primary_category"),
    // JSON text array.
    additionalCategories: text("additional_categories"),
    phone: text("phone"),
    domain: text("domain"),
    // Reviews task: stored right after the billed post so it is never posted twice.
    reviewsTaskId: text("reviews_task_id"),
    // Derived when the snapshot completes (see gbp/process.ts).
    newReviews: integer("new_reviews"),
    newReviewsAvgRating: real("new_reviews_avg_rating"),
    velocity30d: real("velocity_30d"),
    unansweredLast20: integer("unanswered_last_20"),
    costUsd: real("cost_usd").notNull().default(0),
    reservedCredits: integer("reserved_credits").notNull().default(0),
    billedCredits: integer("billed_credits").notNull().default(0),
    error: text("error"),
    completedAt: text("completed_at"),
  },
  (t) => [
    index("gbp_snapshots_business_idx").on(t.businessId, t.takenAt),
    index("gbp_snapshots_workspace_idx").on(t.workspaceId, t.takenAt),
    // One refresh at a time per business, so two clicks cannot both be charged.
    uniqueIndex("gbp_snapshots_one_active_idx")
      .on(t.businessId)
      .where(sql`${t.status} IN ('queued','running')`),
  ],
);

export const reviews = sqliteTable(
  "reviews",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    businessId: text("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    // Google's review id. Reviewer profile links and images are never stored.
    reviewId: text("review_id").notNull(),
    reviewerName: text("reviewer_name"),
    rating: integer("rating").notNull(),
    text: text("text"),
    publishedAt: text("published_at").notNull(),
    ownerAnswered: integer("owner_answered", { mode: "boolean" }).notNull().default(false),
    ownerAnsweredAt: text("owner_answered_at"),
    firstSeenSnapshotId: text("first_seen_snapshot_id").references(() => gbpSnapshots.id, { onDelete: "set null" }),
  },
  (t) => [
    uniqueIndex("reviews_business_review_idx").on(t.businessId, t.reviewId),
    index("reviews_business_published_idx").on(t.businessId, t.publishedAt),
  ],
);

// ---- rank-drop alerts ------------------------------------------------------------

// Raised when a scan is finalized (rank_drop, data_problem) or a GBP snapshot
// completes (rating_drop, negative_review); see alerts.ts. At most one alert
// per scan (or snapshot) and kind, so queue redelivery cannot duplicate it.
// Scan alerts carry tracker_id + scan_id, GBP alerts business_id + snapshot_id.
export const alerts = sqliteTable(
  "alerts",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    trackerId: text("tracker_id").references(() => trackers.id, { onDelete: "cascade" }),
    scanId: text("scan_id").references(() => scans.id, { onDelete: "cascade" }),
    previousScanId: text("previous_scan_id").references(() => scans.id, { onDelete: "set null" }),
    businessId: text("business_id").references(() => businesses.id, { onDelete: "cascade" }),
    snapshotId: text("snapshot_id").references(() => gbpSnapshots.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["rank_drop", "data_problem", "rating_drop", "negative_review", "job_failed"] }).notNull(),
    severity: text("severity", { enum: ["warning", "critical"] }).notNull(),
    // JSON text, see AlertMetrics in shared/alerts.ts.
    metrics: text("metrics").notNull(),
    createdAt: createdAt(),
    readAt: text("read_at"),
  },
  (t) => [
    uniqueIndex("alerts_scan_kind_idx").on(t.scanId, t.kind),
    uniqueIndex("alerts_snapshot_kind_idx").on(t.snapshotId, t.kind),
    index("alerts_workspace_idx").on(t.workspaceId, t.readAt, t.createdAt),
  ],
);

// Per-workspace overrides of the alert rules (defaults in shared/alerts.ts)
// and the optional Slack-compatible webhook. No row = defaults, webhook off.
export const alertSettings = sqliteTable("alert_settings", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  atrpWorse: real("atrp_worse").notNull().default(2),
  solvDown: real("solv_down").notNull().default(15),
  foundDropPct: real("found_drop_pct").notNull().default(25),
  centerTop3: integer("center_top3", { mode: "boolean" }).notNull().default(true),
  criticalAtrp: real("critical_atrp").notNull().default(5),
  criticalSolv: real("critical_solv").notNull().default(30),
  // https only; the sender lives in notify/. Treated as a secret.
  webhookUrl: text("webhook_url"),
});

// ---- rate limiting -----------------------------------------------------------------

// Fixed-window counters, used when no Workers Rate Limiting binding applies
// (see ratelimit/). key = "<rule>:<subject>", window_start = epoch seconds.
// Old windows are pruned by the retention job.
export const rateLimits = sqliteTable(
  "rate_limits",
  {
    key: text("key").notNull(),
    windowStart: integer("window_start").notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.key, t.windowStart] }), index("rate_limits_window_idx").on(t.windowStart)],
);
