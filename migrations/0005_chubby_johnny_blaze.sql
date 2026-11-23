CREATE TABLE `tracker_competitors` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`tracker_id` text NOT NULL,
	`identity` text NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tracker_id`) REFERENCES `trackers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tracker_competitors_identity_idx` ON `tracker_competitors` (`tracker_id`,`identity`);--> statement-breakpoint
ALTER TABLE `scan_results` ADD `phone` text;