CREATE TABLE `vendor_public_locations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`vendor_id` integer NOT NULL,
	`label` text DEFAULT 'Pharmacy pickup point' NOT NULL,
	`address` text NOT NULL,
	`latitude` text NOT NULL,
	`longitude` text NOT NULL,
	`pickup_enabled` integer DEFAULT false NOT NULL,
	`service_enabled` integer DEFAULT false NOT NULL,
	`service_radius_km` integer DEFAULT 5 NOT NULL,
	`publication_status` text DEFAULT 'draft' NOT NULL,
	`publication_consent_at` text,
	`published_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vendor_public_locations_vendor_uidx` ON `vendor_public_locations` (`vendor_id`);--> statement-breakpoint
CREATE INDEX `vendor_public_locations_publication_idx` ON `vendor_public_locations` (`publication_status`,`vendor_id`);