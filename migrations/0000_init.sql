CREATE TABLE `api_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`scan_id` text,
	`provider` text NOT NULL,
	`mode` text NOT NULL,
	`path` text NOT NULL,
	`task_count` integer DEFAULT 1 NOT NULL,
	`cost_usd` real NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`scan_id`) REFERENCES `scans`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `api_calls_workspace_idx` ON `api_calls` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `api_calls_scan_idx` ON `api_calls` (`scan_id`);--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`created_by` text,
	`name` text NOT NULL,
	`prefix` text NOT NULL,
	`key_hash` text NOT NULL,
	`last_used_at` text,
	`revoked_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_key_hash_unique` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE INDEX `api_keys_workspace_idx` ON `api_keys` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `businesses` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`place_id` text,
	`cid` text,
	`domain` text,
	`address` text,
	`category` text,
	`lat` real NOT NULL,
	`lng` real NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`archived_at` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `businesses_workspace_idx` ON `businesses` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `credit_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`scan_id` text,
	`delta` integer NOT NULL,
	`reason` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`scan_id`) REFERENCES `scans`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `credit_ledger_workspace_idx` ON `credit_ledger` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `memberships` (
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`workspace_id`, `user_id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memberships_user_idx` ON `memberships` (`user_id`);--> statement-breakpoint
CREATE TABLE `report_shares` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`tracker_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`label` text,
	`show_competitors` integer DEFAULT true NOT NULL,
	`expires_at` text,
	`revoked_at` text,
	`view_count` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tracker_id`) REFERENCES `trackers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `report_shares_token_hash_unique` ON `report_shares` (`token_hash`);--> statement-breakpoint
CREATE INDEX `report_shares_tracker_idx` ON `report_shares` (`tracker_id`);--> statement-breakpoint
CREATE TABLE `scan_points` (
	`id` text PRIMARY KEY NOT NULL,
	`scan_id` text NOT NULL,
	`row` integer NOT NULL,
	`col` integer NOT NULL,
	`lat` real NOT NULL,
	`lng` real NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`task_id` text,
	`rank` integer,
	`error` text,
	FOREIGN KEY (`scan_id`) REFERENCES `scans`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scan_points_cell_idx` ON `scan_points` (`scan_id`,`row`,`col`);--> statement-breakpoint
CREATE TABLE `scan_results` (
	`id` text PRIMARY KEY NOT NULL,
	`scan_id` text NOT NULL,
	`point_id` text NOT NULL,
	`rank` integer NOT NULL,
	`business_key` text NOT NULL,
	`name` text NOT NULL,
	`place_id` text,
	`cid` text,
	`domain` text,
	`rating` real,
	`rating_count` integer,
	`category` text,
	`address` text,
	`is_target` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`scan_id`) REFERENCES `scans`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`point_id`) REFERENCES `scan_points`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `scan_results_scan_idx` ON `scan_results` (`scan_id`);--> statement-breakpoint
CREATE INDEX `scan_results_point_idx` ON `scan_results` (`point_id`);--> statement-breakpoint
CREATE TABLE `scans` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`tracker_id` text NOT NULL,
	`status` text NOT NULL,
	`trigger` text NOT NULL,
	`keyword` text NOT NULL,
	`center_lat` real NOT NULL,
	`center_lng` real NOT NULL,
	`grid_size` integer NOT NULL,
	`radius_km` real NOT NULL,
	`zoom` integer NOT NULL,
	`search_type` text NOT NULL,
	`queue_mode` text NOT NULL,
	`device` text NOT NULL,
	`language_code` text NOT NULL,
	`depth` integer NOT NULL,
	`arp` real,
	`atrp` real,
	`solv` real,
	`found_points` integer,
	`top3_points` integer,
	`total_points` integer NOT NULL,
	`estimated_cost_usd` real NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`reserved_credits` integer DEFAULT 0 NOT NULL,
	`billed_credits` integer DEFAULT 0 NOT NULL,
	`error` text,
	`raw_r2_key` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tracker_id`) REFERENCES `trackers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `scans_tracker_idx` ON `scans` (`tracker_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `scans_workspace_idx` ON `scans` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `scans_one_active_per_tracker_idx` ON `scans` (`tracker_id`) WHERE "scans"."status" IN ('queued','posting','polling');--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `trackers` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`business_id` text NOT NULL,
	`keyword` text NOT NULL,
	`center_lat` real NOT NULL,
	`center_lng` real NOT NULL,
	`grid_size` integer NOT NULL,
	`radius_km` real NOT NULL,
	`radius_unit` text DEFAULT 'km' NOT NULL,
	`zoom` integer NOT NULL,
	`search_type` text DEFAULT 'maps' NOT NULL,
	`queue_mode` text DEFAULT 'standard' NOT NULL,
	`device` text DEFAULT 'mobile' NOT NULL,
	`language_code` text DEFAULT 'en' NOT NULL,
	`depth` integer DEFAULT 20 NOT NULL,
	`schedule_frequency` text DEFAULT 'none' NOT NULL,
	`schedule_day` integer DEFAULT 1 NOT NULL,
	`next_run_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`archived_at` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `trackers_workspace_idx` ON `trackers` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `trackers_business_idx` ON `trackers` (`business_id`);--> statement-breakpoint
CREATE INDEX `trackers_next_run_idx` ON `trackers` (`next_run_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`password_hash` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `workspace_branding` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`brand_name` text,
	`logo_url` text,
	`primary_color` text,
	`footer_text` text,
	`contact_url` text,
	`hide_attribution` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`credit_balance` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_slug_unique` ON `workspaces` (`slug`);