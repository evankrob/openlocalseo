PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`tracker_id` text,
	`scan_id` text,
	`previous_scan_id` text,
	`business_id` text,
	`snapshot_id` text,
	`kind` text NOT NULL,
	`severity` text NOT NULL,
	`metrics` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`read_at` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tracker_id`) REFERENCES `trackers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`scan_id`) REFERENCES `scans`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`previous_scan_id`) REFERENCES `scans`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`snapshot_id`) REFERENCES `gbp_snapshots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_alerts`("id", "workspace_id", "tracker_id", "scan_id", "previous_scan_id", "business_id", "snapshot_id", "kind", "severity", "metrics", "created_at", "read_at") SELECT "id", "workspace_id", "tracker_id", "scan_id", "previous_scan_id", "business_id", "snapshot_id", "kind", "severity", "metrics", "created_at", "read_at" FROM `alerts`;--> statement-breakpoint
DROP TABLE `alerts`;--> statement-breakpoint
ALTER TABLE `__new_alerts` RENAME TO `alerts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `alerts_scan_kind_idx` ON `alerts` (`scan_id`,`kind`);--> statement-breakpoint
CREATE UNIQUE INDEX `alerts_snapshot_kind_idx` ON `alerts` (`snapshot_id`,`kind`);--> statement-breakpoint
CREATE INDEX `alerts_workspace_idx` ON `alerts` (`workspace_id`,`read_at`,`created_at`);