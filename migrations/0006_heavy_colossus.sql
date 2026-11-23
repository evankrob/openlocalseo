CREATE TABLE `business_service_areas` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`business_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'other' NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`polygon` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `business_service_areas_business_idx` ON `business_service_areas` (`business_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `business_service_areas_name_idx` ON `business_service_areas` (`business_id`,`kind`,`name`);--> statement-breakpoint
ALTER TABLE `businesses` ADD `business_type` text DEFAULT 'storefront' NOT NULL;--> statement-breakpoint
ALTER TABLE `scan_points` ADD `skip_reason` text;--> statement-breakpoint
ALTER TABLE `scans` ADD `skipped_points` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `trackers` ADD `auto_skip_water` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `trackers` ADD `skip_overrides` text DEFAULT '{"include":[],"exclude":[]}' NOT NULL;--> statement-breakpoint
ALTER TABLE `trackers` ADD `skip_exclusion` text DEFAULT '{"enabled":false,"shapes":[]}' NOT NULL;