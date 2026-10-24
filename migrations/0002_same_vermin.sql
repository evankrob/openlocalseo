CREATE TABLE `gbp_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`business_id` text NOT NULL,
	`trigger` text NOT NULL,
	`taken_at` text NOT NULL,
	`status` text NOT NULL,
	`rating` real,
	`review_count` integer,
	`rating_distribution` text,
	`is_claimed` integer,
	`total_photos` integer,
	`primary_category` text,
	`additional_categories` text,
	`phone` text,
	`domain` text,
	`reviews_task_id` text,
	`new_reviews` integer,
	`new_reviews_avg_rating` real,
	`velocity_30d` real,
	`unanswered_last_20` integer,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`reserved_credits` integer DEFAULT 0 NOT NULL,
	`billed_credits` integer DEFAULT 0 NOT NULL,
	`error` text,
	`completed_at` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `gbp_snapshots_business_idx` ON `gbp_snapshots` (`business_id`,`taken_at`);--> statement-breakpoint
CREATE INDEX `gbp_snapshots_workspace_idx` ON `gbp_snapshots` (`workspace_id`,`taken_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `gbp_snapshots_one_active_idx` ON `gbp_snapshots` (`business_id`) WHERE "gbp_snapshots"."status" IN ('queued','running');--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`business_id` text NOT NULL,
	`review_id` text NOT NULL,
	`reviewer_name` text,
	`rating` integer NOT NULL,
	`text` text,
	`published_at` text NOT NULL,
	`owner_answered` integer DEFAULT false NOT NULL,
	`owner_answered_at` text,
	`first_seen_snapshot_id` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`first_seen_snapshot_id`) REFERENCES `gbp_snapshots`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reviews_business_review_idx` ON `reviews` (`business_id`,`review_id`);--> statement-breakpoint
CREATE INDEX `reviews_business_published_idx` ON `reviews` (`business_id`,`published_at`);--> statement-breakpoint
ALTER TABLE `alerts` ADD `business_id` text REFERENCES businesses(id);--> statement-breakpoint
ALTER TABLE `alerts` ADD `snapshot_id` text REFERENCES gbp_snapshots(id);--> statement-breakpoint
CREATE UNIQUE INDEX `alerts_snapshot_kind_idx` ON `alerts` (`snapshot_id`,`kind`);--> statement-breakpoint
ALTER TABLE `businesses` ADD `gbp_tracking` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `businesses` ADD `gbp_next_run_at` text;--> statement-breakpoint
CREATE INDEX `businesses_gbp_next_run_idx` ON `businesses` (`gbp_next_run_at`);