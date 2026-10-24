CREATE TABLE `alert_settings` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`atrp_worse` real DEFAULT 2 NOT NULL,
	`solv_down` real DEFAULT 15 NOT NULL,
	`found_drop_pct` real DEFAULT 25 NOT NULL,
	`center_top3` integer DEFAULT true NOT NULL,
	`critical_atrp` real DEFAULT 5 NOT NULL,
	`critical_solv` real DEFAULT 30 NOT NULL,
	`webhook_url` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`tracker_id` text NOT NULL,
	`scan_id` text NOT NULL,
	`previous_scan_id` text,
	`kind` text NOT NULL,
	`severity` text NOT NULL,
	`metrics` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`read_at` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tracker_id`) REFERENCES `trackers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`scan_id`) REFERENCES `scans`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`previous_scan_id`) REFERENCES `scans`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alerts_scan_kind_idx` ON `alerts` (`scan_id`,`kind`);--> statement-breakpoint
CREATE INDEX `alerts_workspace_idx` ON `alerts` (`workspace_id`,`read_at`,`created_at`);