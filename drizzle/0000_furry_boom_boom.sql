CREATE TABLE `categories` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `customers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`legacy_id` integer NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`mobile` text NOT NULL,
	`registered_at` text,
	`address` text DEFAULT '' NOT NULL,
	`city` text DEFAULT '' NOT NULL,
	`state` text DEFAULT '' NOT NULL,
	`pincode` text DEFAULT '' NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`mobile_verified` integer DEFAULT false NOT NULL,
	`password_reset_required` integer DEFAULT true NOT NULL,
	`source` text DEFAULT 'legacy_backup' NOT NULL,
	`migrated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customers_legacy_id_uidx` ON `customers` (`legacy_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `customers_email_uidx` ON `customers` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `customers_mobile_uidx` ON `customers` (`mobile`);--> statement-breakpoint
CREATE TABLE `manufacturers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`normalized_name` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `manufacturers_normalized_name_uidx` ON `manufacturers` (`normalized_name`);--> statement-breakpoint
CREATE TABLE `migration_audit` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_file` text NOT NULL,
	`source_sha256` text NOT NULL,
	`entity` text NOT NULL,
	`source_rows` integer NOT NULL,
	`imported_rows` integer NOT NULL,
	`rejected_rows` integer NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`completed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `products` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`legacy_id` integer NOT NULL,
	`category_id` integer,
	`display_category_id` integer,
	`name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`composition` text DEFAULT '' NOT NULL,
	`manufacturer` text DEFAULT '' NOT NULL,
	`prescription_required` integer DEFAULT false NOT NULL,
	`gst_percent` integer DEFAULT 0 NOT NULL,
	`hsn_code` text DEFAULT '' NOT NULL,
	`packaging` text DEFAULT '' NOT NULL,
	`source` text DEFAULT 'legacy_backup' NOT NULL,
	`migrated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `products_legacy_id_uidx` ON `products` (`legacy_id`);--> statement-breakpoint
CREATE INDEX `products_normalized_name_idx` ON `products` (`normalized_name`);--> statement-breakpoint
CREATE INDEX `products_category_idx` ON `products` (`category_id`);--> statement-breakpoint
CREATE INDEX `products_manufacturer_idx` ON `products` (`manufacturer`);