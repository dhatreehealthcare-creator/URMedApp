CREATE TABLE `inventory_adjustment_reason_codes` (
	`code` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`direction` text NOT NULL,
	`requires_notes` integer DEFAULT true NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "inventory_adjustment_reasons_direction_check" CHECK("inventory_adjustment_reason_codes"."direction" IN ('increase', 'decrease', 'both'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inventory_adjustment_reasons_label_uidx` ON `inventory_adjustment_reason_codes` (`label`);--> statement-breakpoint
CREATE INDEX `inventory_adjustment_reasons_active_idx` ON `inventory_adjustment_reason_codes` (`active`,`sort_order`);--> statement-breakpoint
CREATE TABLE `inventory_adjustments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`adjustment_number` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`vendor_id` integer NOT NULL,
	`inventory_id` integer NOT NULL,
	`source_type` text NOT NULL,
	`source_id` integer,
	`reason_code` text NOT NULL,
	`reason_label` text NOT NULL,
	`expected_quantity` integer NOT NULL,
	`quantity_before` integer NOT NULL,
	`quantity_delta` integer NOT NULL,
	`balance_after` integer NOT NULL,
	`reserved_quantity_snapshot` integer NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`created_by_profile_id` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`inventory_id`) REFERENCES `pharmacy_inventory`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_id`) REFERENCES `inventory_count_sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reason_code`) REFERENCES `inventory_adjustment_reason_codes`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_profile_id`) REFERENCES `account_profiles`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "inventory_adjustments_quantity_check" CHECK("inventory_adjustments"."expected_quantity" >= 0 AND "inventory_adjustments"."quantity_before" = "inventory_adjustments"."expected_quantity" AND "inventory_adjustments"."quantity_delta" <> 0 AND "inventory_adjustments"."balance_after" = "inventory_adjustments"."quantity_before" + "inventory_adjustments"."quantity_delta" AND "inventory_adjustments"."balance_after" >= 0 AND "inventory_adjustments"."reserved_quantity_snapshot" >= 0),
	CONSTRAINT "inventory_adjustments_source_check" CHECK(("inventory_adjustments"."source_type" = 'manual' AND "inventory_adjustments"."source_id" IS NULL) OR ("inventory_adjustments"."source_type" = 'cycle_count' AND "inventory_adjustments"."source_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inventory_adjustments_number_uidx` ON `inventory_adjustments` (`adjustment_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `inventory_adjustments_vendor_key_uidx` ON `inventory_adjustments` (`vendor_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `inventory_adjustments_vendor_date_idx` ON `inventory_adjustments` (`vendor_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `inventory_adjustments_inventory_date_idx` ON `inventory_adjustments` (`inventory_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `inventory_adjustments_source_idx` ON `inventory_adjustments` (`source_type`,`source_id`);--> statement-breakpoint
CREATE TABLE `inventory_count_lines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`count_session_id` integer NOT NULL,
	`inventory_id` integer NOT NULL,
	`expected_quantity` integer NOT NULL,
	`counted_quantity` integer NOT NULL,
	`variance_quantity` integer NOT NULL,
	`reserved_quantity_snapshot` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`count_session_id`) REFERENCES `inventory_count_sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`inventory_id`) REFERENCES `pharmacy_inventory`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "inventory_count_lines_quantity_check" CHECK("inventory_count_lines"."expected_quantity" >= 0 AND "inventory_count_lines"."counted_quantity" >= 0 AND "inventory_count_lines"."reserved_quantity_snapshot" >= 0 AND "inventory_count_lines"."variance_quantity" = "inventory_count_lines"."counted_quantity" - "inventory_count_lines"."expected_quantity")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inventory_count_lines_session_inventory_uidx` ON `inventory_count_lines` (`count_session_id`,`inventory_id`);--> statement-breakpoint
CREATE INDEX `inventory_count_lines_inventory_idx` ON `inventory_count_lines` (`inventory_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `inventory_count_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_number` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`vendor_id` integer NOT NULL,
	`scope_label` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'completed' NOT NULL,
	`line_count` integer NOT NULL,
	`variance_line_count` integer NOT NULL,
	`net_variance_quantity` integer NOT NULL,
	`completed_by_profile_id` integer NOT NULL,
	`completed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`completed_by_profile_id`) REFERENCES `account_profiles`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "inventory_count_sessions_counts_check" CHECK("inventory_count_sessions"."line_count" > 0 AND "inventory_count_sessions"."variance_line_count" >= 0 AND "inventory_count_sessions"."variance_line_count" <= "inventory_count_sessions"."line_count")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inventory_count_sessions_number_uidx` ON `inventory_count_sessions` (`session_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `inventory_count_sessions_vendor_key_uidx` ON `inventory_count_sessions` (`vendor_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `inventory_count_sessions_vendor_date_idx` ON `inventory_count_sessions` (`vendor_id`,`completed_at`);--> statement-breakpoint

INSERT INTO `inventory_adjustment_reason_codes`
	(`code`, `label`, `direction`, `requires_notes`, `active`, `sort_order`)
VALUES
	('damage', 'Damaged stock', 'decrease', 1, 1, 10),
	('expiry_write_off', 'Expired stock write-off', 'decrease', 1, 1, 20),
	('theft_loss', 'Theft or unexplained loss', 'decrease', 1, 1, 30),
	('breakage', 'Breakage or spillage', 'decrease', 1, 1, 40),
	('found_stock', 'Found stock', 'increase', 1, 1, 50),
	('supplier_overage', 'Supplier delivery overage', 'increase', 1, 1, 60),
	('data_correction', 'Audited data correction', 'both', 1, 1, 70),
	('cycle_count_variance', 'Cycle-count variance', 'both', 0, 1, 100)
ON CONFLICT(`code`) DO NOTHING;--> statement-breakpoint

-- Adjustment evidence must describe the exact tenant-owned balance that is
-- about to change. D1 batches serialize these checks with the guarded update,
-- so stale or reservation-breaking writes abort the complete transaction.
CREATE TRIGGER IF NOT EXISTS `inventory_adjustment_insert_guard`
BEFORE INSERT ON `inventory_adjustments`
WHEN NEW.`vendor_id` <> COALESCE((SELECT `vendor_id` FROM `pharmacy_inventory` WHERE `id` = NEW.`inventory_id`), -1)
	OR NEW.`expected_quantity` <> COALESCE((SELECT `quantity` FROM `pharmacy_inventory` WHERE `id` = NEW.`inventory_id`), -1)
	OR NEW.`reserved_quantity_snapshot` <> COALESCE((SELECT `reserved_quantity` FROM `pharmacy_inventory` WHERE `id` = NEW.`inventory_id`), -1)
	OR NEW.`balance_after` < NEW.`reserved_quantity_snapshot`
	OR NOT EXISTS (
		SELECT 1 FROM `inventory_adjustment_reason_codes` reason
		WHERE reason.`code` = NEW.`reason_code` AND reason.`active` = 1
			AND reason.`label` = NEW.`reason_label`
			AND (reason.`direction` = 'both'
				OR (reason.`direction` = 'increase' AND NEW.`quantity_delta` > 0)
				OR (reason.`direction` = 'decrease' AND NEW.`quantity_delta` < 0))
			AND (reason.`requires_notes` = 0 OR length(trim(NEW.`notes`)) >= 5)
	)
	OR (NEW.`source_type` = 'manual' AND NEW.`reason_code` = 'cycle_count_variance')
	OR (NEW.`source_type` = 'cycle_count' AND (
		NEW.`reason_code` <> 'cycle_count_variance'
		OR NEW.`source_id` NOT IN (
			SELECT session.`id` FROM `inventory_count_sessions` session
			WHERE session.`vendor_id` = NEW.`vendor_id` AND session.`status` = 'completed'
		)
	))
BEGIN
	SELECT RAISE(ABORT, 'inventory_adjustment_invalid');
END;--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS `inventory_count_session_insert_guard`
BEFORE INSERT ON `inventory_count_sessions`
WHEN NEW.`status` <> 'completed'
	OR length(trim(NEW.`scope_label`)) < 3
	OR length(trim(NEW.`idempotency_key`)) < 8
BEGIN
	SELECT RAISE(ABORT, 'inventory_count_invalid');
END;--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS `inventory_count_line_insert_guard`
BEFORE INSERT ON `inventory_count_lines`
WHEN COALESCE((SELECT inventory.`vendor_id` FROM `pharmacy_inventory` inventory WHERE inventory.`id` = NEW.`inventory_id`), -1)
		<> COALESCE((SELECT session.`vendor_id` FROM `inventory_count_sessions` session WHERE session.`id` = NEW.`count_session_id`), -2)
	OR NEW.`expected_quantity` <> COALESCE((SELECT `quantity` FROM `pharmacy_inventory` WHERE `id` = NEW.`inventory_id`), -1)
	OR NEW.`reserved_quantity_snapshot` <> COALESCE((SELECT `reserved_quantity` FROM `pharmacy_inventory` WHERE `id` = NEW.`inventory_id`), -1)
	OR NEW.`counted_quantity` < NEW.`reserved_quantity_snapshot`
BEGIN
	SELECT RAISE(ABORT, 'inventory_count_stale');
END;--> statement-breakpoint

-- Count and adjustment records are evidence, not editable business records.
-- Corrections are represented by a new session/adjustment and ledger movement.
CREATE TRIGGER IF NOT EXISTS `inventory_adjustments_no_update`
BEFORE UPDATE ON `inventory_adjustments`
BEGIN
	SELECT RAISE(ABORT, 'inventory_adjustments_immutable');
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `inventory_adjustments_no_delete`
BEFORE DELETE ON `inventory_adjustments`
BEGIN
	SELECT RAISE(ABORT, 'inventory_adjustments_immutable');
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `inventory_count_sessions_no_update`
BEFORE UPDATE ON `inventory_count_sessions`
BEGIN
	SELECT RAISE(ABORT, 'inventory_count_sessions_immutable');
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `inventory_count_sessions_no_delete`
BEFORE DELETE ON `inventory_count_sessions`
BEGIN
	SELECT RAISE(ABORT, 'inventory_count_sessions_immutable');
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `inventory_count_lines_no_update`
BEFORE UPDATE ON `inventory_count_lines`
BEGIN
	SELECT RAISE(ABORT, 'inventory_count_lines_immutable');
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `inventory_count_lines_no_delete`
BEFORE DELETE ON `inventory_count_lines`
BEGIN
	SELECT RAISE(ABORT, 'inventory_count_lines_immutable');
END;
