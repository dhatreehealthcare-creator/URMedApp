CREATE TABLE IF NOT EXISTS `dosage_forms` (
	`id` integer PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`sort_order` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `dosage_forms_code_uidx` ON `dosage_forms` (`code`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `dosage_forms_slug_uidx` ON `dosage_forms` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `dosage_forms_name_uidx` ON `dosage_forms` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `dosage_forms_sort_order_uidx` ON `dosage_forms` (`sort_order`);--> statement-breakpoint
INSERT INTO `dosage_forms` (`id`, `code`, `slug`, `name`, `status`, `sort_order`) VALUES
	(1, 'TAB', 'tablet', 'Tablet', 'active', 10),
	(2, 'CAP', 'capsule', 'Capsule', 'active', 20),
	(3, 'INJ', 'injection', 'Injection', 'active', 30),
	(4, 'OINT', 'ointment', 'Ointment', 'active', 40),
	(5, 'CRM', 'cream', 'Cream', 'active', 50),
	(6, 'AER', 'aerosol', 'Aerosol', 'active', 60),
	(7, 'TDP', 'transdermal-patch', 'Transdermal Patch', 'active', 70),
	(8, 'SYR', 'syrup', 'Syrup', 'active', 80)
ON CONFLICT (`id`) DO UPDATE SET
	`code` = excluded.`code`,
	`slug` = excluded.`slug`,
	`name` = excluded.`name`,
	`status` = excluded.`status`,
	`sort_order` = excluded.`sort_order`,
	`updated_at` = CURRENT_TIMESTAMP;--> statement-breakpoint
PRAGMA optimize;
