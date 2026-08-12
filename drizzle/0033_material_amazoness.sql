CREATE TABLE `inventory_reservation_recovery_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_key` text NOT NULL,
	`trigger_source` text DEFAULT 'scheduled' NOT NULL,
	`scheduled_at` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`attempts` integer DEFAULT 1 NOT NULL,
	`batch_size` integer NOT NULL,
	`max_batches` integer NOT NULL,
	`batches_processed` integer DEFAULT 0 NOT NULL,
	`orders_released` integer DEFAULT 0 NOT NULL,
	`reservations_released` integer DEFAULT 0 NOT NULL,
	`remaining_expired_orders` integer DEFAULT 0 NOT NULL,
	`started_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`completed_at` text,
	`error_message` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inventory_reservation_recovery_runs_key_uidx` ON `inventory_reservation_recovery_runs` (`run_key`);--> statement-breakpoint
CREATE INDEX `inventory_reservation_recovery_runs_started_idx` ON `inventory_reservation_recovery_runs` (`started_at`,`status`);--> statement-breakpoint
PRAGMA optimize;
