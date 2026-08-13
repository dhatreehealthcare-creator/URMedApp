CREATE TABLE `purchase_receipt_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`purchase_receipt_id` integer NOT NULL,
	`purchase_order_item_id` integer NOT NULL,
	`inventory_id` integer NOT NULL,
	`quantity` integer NOT NULL,
	`free_quantity` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`purchase_receipt_id`) REFERENCES `purchase_receipts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`purchase_order_item_id`) REFERENCES `purchase_order_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`inventory_id`) REFERENCES `pharmacy_inventory`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `purchase_receipt_items_receipt_order_item_uidx` ON `purchase_receipt_items` (`purchase_receipt_id`,`purchase_order_item_id`);--> statement-breakpoint
CREATE INDEX `purchase_receipt_items_order_item_idx` ON `purchase_receipt_items` (`purchase_order_item_id`);--> statement-breakpoint
CREATE TABLE `purchase_receipts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`receipt_number` text NOT NULL,
	`vendor_id` integer NOT NULL,
	`purchase_order_id` integer NOT NULL,
	`received_on` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`received_by_profile_id` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`purchase_order_id`) REFERENCES `purchase_orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`received_by_profile_id`) REFERENCES `account_profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `purchase_receipts_number_uidx` ON `purchase_receipts` (`receipt_number`);--> statement-breakpoint
CREATE INDEX `purchase_receipts_order_idx` ON `purchase_receipts` (`purchase_order_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `purchase_receipts_vendor_date_idx` ON `purchase_receipts` (`vendor_id`,`received_on`);--> statement-breakpoint
ALTER TABLE `purchase_order_items` ADD `received_quantity` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `purchase_order_items` ADD `received_free_quantity` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `purchase_orders` ADD `approved_by_profile_id` integer REFERENCES account_profiles(id);--> statement-breakpoint
ALTER TABLE `purchase_orders` ADD `approved_at` text;--> statement-breakpoint
ALTER TABLE `purchase_orders` ADD `cancelled_by_profile_id` integer REFERENCES account_profiles(id);--> statement-breakpoint
ALTER TABLE `purchase_orders` ADD `cancelled_at` text;--> statement-breakpoint
ALTER TABLE `purchase_orders` ADD `cancellation_reason` text DEFAULT '' NOT NULL;
--> statement-breakpoint

-- Existing P0/P1 purchase rows were created by the legacy immediate-receipt
-- path. Mark their ordered quantities as physically received so they retain
-- supplier-return eligibility after receipts become explicit.
UPDATE `purchase_order_items`
SET `received_quantity` = `quantity`,
	`received_free_quantity` = `free_quantity`
WHERE `purchase_order_id` IN (
	SELECT `id` FROM `purchase_orders` WHERE `status` IN ('received', 'posted')
);--> statement-breakpoint

-- A crashed legacy posting marker never represented posted stock. Recover it
-- as a draft that can be reviewed explicitly.
UPDATE `purchase_orders`
SET `status` = 'draft'
WHERE `status` = 'posting';--> statement-breakpoint

-- New writes use the explicit lifecycle. These guards also make lifecycle
-- application repeatable and reject accidental regression to legacy markers.
CREATE TRIGGER IF NOT EXISTS `purchase_orders_status_insert_guard`
BEFORE INSERT ON `purchase_orders`
WHEN NEW.`status` NOT IN ('draft', 'approved', 'partially_received', 'received', 'cancelled')
BEGIN
	SELECT RAISE(ABORT, 'invalid purchase lifecycle status');
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `purchase_orders_status_update_guard`
BEFORE UPDATE OF `status` ON `purchase_orders`
WHEN NEW.`status` NOT IN ('draft', 'approved', 'partially_received', 'received', 'cancelled')
BEGIN
	SELECT RAISE(ABORT, 'invalid purchase lifecycle status');
END;--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS `purchase_order_item_received_quantity_insert_guard`
BEFORE INSERT ON `purchase_order_items`
WHEN NEW.`received_quantity` < 0 OR NEW.`received_free_quantity` < 0
	OR NEW.`received_quantity` > NEW.`quantity`
	OR NEW.`received_free_quantity` > NEW.`free_quantity`
BEGIN
	SELECT RAISE(ABORT, 'purchase receipt quantity invalid');
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `purchase_order_item_received_quantity_update_guard`
BEFORE UPDATE OF `received_quantity`, `received_free_quantity` ON `purchase_order_items`
WHEN NEW.`received_quantity` < 0 OR NEW.`received_free_quantity` < 0
	OR NEW.`received_quantity` > NEW.`quantity`
	OR NEW.`received_free_quantity` > NEW.`free_quantity`
BEGIN
	SELECT RAISE(ABORT, 'purchase receipt quantity invalid');
END;--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS `purchase_receipt_vendor_guard`
BEFORE INSERT ON `purchase_receipts`
WHEN NEW.`vendor_id` <> COALESCE((SELECT `vendor_id` FROM `purchase_orders` WHERE `id` = NEW.`purchase_order_id`), -1)
	OR COALESCE((SELECT `status` FROM `purchase_orders` WHERE `id` = NEW.`purchase_order_id`), '')
		NOT IN ('approved', 'partially_received')
BEGIN
	SELECT RAISE(ABORT, 'purchase receipt scope invalid');
END;--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS `purchase_receipt_item_scope_guard`
BEFORE INSERT ON `purchase_receipt_items`
WHEN NEW.`purchase_order_item_id` NOT IN (
	SELECT item.`id` FROM `purchase_order_items` item
	JOIN `purchase_receipts` receipt ON receipt.`purchase_order_id` = item.`purchase_order_id`
	WHERE receipt.`id` = NEW.`purchase_receipt_id`
)
	OR NEW.`inventory_id` <> COALESCE((SELECT `inventory_id` FROM `purchase_order_items` WHERE `id` = NEW.`purchase_order_item_id`), -1)
	OR NEW.`quantity` < 0 OR NEW.`free_quantity` < 0
	OR NEW.`quantity` + NEW.`free_quantity` < 1
	OR NEW.`quantity` > (
		COALESCE((SELECT `received_quantity` FROM `purchase_order_items` WHERE `id` = NEW.`purchase_order_item_id`), 0)
		- COALESCE((SELECT SUM(`quantity`) FROM `purchase_receipt_items` WHERE `purchase_order_item_id` = NEW.`purchase_order_item_id`), 0)
	)
	OR NEW.`free_quantity` > (
		COALESCE((SELECT `received_free_quantity` FROM `purchase_order_items` WHERE `id` = NEW.`purchase_order_item_id`), 0)
		- COALESCE((SELECT SUM(`free_quantity`) FROM `purchase_receipt_items` WHERE `purchase_order_item_id` = NEW.`purchase_order_item_id`), 0)
	)
BEGIN
	SELECT RAISE(ABORT, 'purchase receipt item scope invalid');
END;--> statement-breakpoint

-- Returns are limited to quantities that have physically arrived. Replacing
-- the P0 guard keeps partially received purchase lines returnable without
-- permitting ordered-but-unreceived stock to be returned.
DROP TRIGGER IF EXISTS `supplier_return_quantity_guard`;--> statement-breakpoint
CREATE TRIGGER `supplier_return_quantity_guard`
BEFORE INSERT ON `supplier_return_items`
WHEN NEW.`quantity` < 1
	OR NEW.`inventory_id` <> COALESCE((SELECT `inventory_id` FROM `purchase_order_items` WHERE `id` = NEW.`purchase_order_item_id`), -1)
	OR NEW.`quantity` > COALESCE((SELECT `quantity` FROM `pharmacy_inventory` WHERE `id` = NEW.`inventory_id`), 0)
	OR NEW.`quantity` > (
		COALESCE((SELECT `received_quantity` + `received_free_quantity` FROM `purchase_order_items` WHERE `id` = NEW.`purchase_order_item_id`), 0)
		- COALESCE((SELECT SUM(items.`quantity`) FROM `supplier_return_items` items JOIN `supplier_returns` ret ON ret.`id` = items.`supplier_return_id` WHERE items.`purchase_order_item_id` = NEW.`purchase_order_item_id` AND ret.`status` <> 'cancelled'), 0)
	)
BEGIN
	SELECT RAISE(ABORT, 'supplier_return_quantity_invalid');
END;
