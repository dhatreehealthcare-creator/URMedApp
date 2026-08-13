CREATE TABLE IF NOT EXISTS `inventory_price_history` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `inventory_id` integer NOT NULL,
  `vendor_id` integer NOT NULL,
  `product_id` integer NOT NULL,
  `purchase_price_paise` integer NOT NULL,
  `sale_price_paise` integer NOT NULL,
  `mrp_paise` integer NOT NULL,
  `gst_percent` integer NOT NULL,
  `effective_from` text NOT NULL,
  `effective_until` text,
  `source` text NOT NULL DEFAULT 'system',
  `reason` text NOT NULL DEFAULT '',
  `created_by_profile_id` integer,
  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`inventory_id`) REFERENCES `pharmacy_inventory`(`id`),
  FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`),
  FOREIGN KEY (`product_id`) REFERENCES `products`(`id`),
  FOREIGN KEY (`created_by_profile_id`) REFERENCES `account_profiles`(`id`),
  CONSTRAINT `inventory_price_history_amount_check` CHECK (`purchase_price_paise` >= 0 AND `sale_price_paise` > 0 AND `mrp_paise` > 0 AND `sale_price_paise` <= `mrp_paise` AND `gst_percent` IN (0,5,12,18,28)),
  CONSTRAINT `inventory_price_history_dates_check` CHECK (`effective_until` IS NULL OR date(`effective_until`) > date(`effective_from`))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `inventory_price_history_inventory_effective_idx` ON `inventory_price_history` (`inventory_id`,`effective_from`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `inventory_price_history_vendor_product_idx` ON `inventory_price_history` (`vendor_id`,`product_id`,`effective_from`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `product_pack_conversions` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `product_id` integer NOT NULL,
  `presentation_uom` text NOT NULL,
  `base_uom` text NOT NULL DEFAULT 'unit',
  `base_units_per_presentation` integer NOT NULL,
  `governance_status` text NOT NULL DEFAULT 'pending',
  `submitted_vendor_id` integer,
  `reviewed_by_profile_id` integer,
  `review_reason` text NOT NULL DEFAULT '',
  `effective_from` text NOT NULL,
  `effective_until` text,
  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`product_id`) REFERENCES `products`(`id`),
  FOREIGN KEY (`submitted_vendor_id`) REFERENCES `vendors`(`id`),
  FOREIGN KEY (`reviewed_by_profile_id`) REFERENCES `account_profiles`(`id`),
  CONSTRAINT `product_pack_conversions_units_check` CHECK (`base_units_per_presentation` > 0 AND length(trim(`presentation_uom`)) BETWEEN 1 AND 40 AND length(trim(`base_uom`)) BETWEEN 1 AND 40),
  CONSTRAINT `product_pack_conversions_status_check` CHECK (`governance_status` IN ('pending','approved','rejected','inactive')),
  CONSTRAINT `product_pack_conversions_dates_check` CHECK (`effective_until` IS NULL OR date(`effective_until`) > date(`effective_from`))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `product_pack_conversions_product_uom_uidx` ON `product_pack_conversions` (`product_id`,`presentation_uom`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `product_pack_conversions_governance_idx` ON `product_pack_conversions` (`product_id`,`governance_status`,`effective_from`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `product_barcodes` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `product_id` integer NOT NULL,
  `code` text NOT NULL,
  `symbology` text NOT NULL DEFAULT 'GTIN-13',
  `status` text NOT NULL DEFAULT 'pending',
  `submitted_vendor_id` integer,
  `reviewed_by_profile_id` integer,
  `review_reason` text NOT NULL DEFAULT '',
  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`product_id`) REFERENCES `products`(`id`),
  FOREIGN KEY (`submitted_vendor_id`) REFERENCES `vendors`(`id`),
  FOREIGN KEY (`reviewed_by_profile_id`) REFERENCES `account_profiles`(`id`),
  CONSTRAINT `product_barcodes_code_check` CHECK (`code` GLOB '[0-9]*' AND length(`code`) IN (8,12,13,14)),
  CONSTRAINT `product_barcodes_status_check` CHECK (`status` IN ('pending','approved','rejected','inactive'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `product_barcodes_code_uidx` ON `product_barcodes` (`code`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `product_barcodes_product_status_idx` ON `product_barcodes` (`product_id`,`status`);--> statement-breakpoint
UPDATE `pharmacy_inventory`
SET `sale_price_paise` = CASE WHEN `sale_price_paise` > 0 THEN `sale_price_paise` ELSE MAX(`purchase_price_paise`, 1) END,
    `mrp_paise` = MAX(`mrp_paise`, CASE WHEN `sale_price_paise` > 0 THEN `sale_price_paise` ELSE MAX(`purchase_price_paise`, 1) END, 1)
WHERE `sale_price_paise` <= 0 OR `mrp_paise` <= 0;--> statement-breakpoint
INSERT INTO `inventory_price_history` (`inventory_id`,`vendor_id`,`product_id`,`purchase_price_paise`,`sale_price_paise`,`mrp_paise`,`gst_percent`,`effective_from`,`source`,`reason`)
SELECT `id`,`vendor_id`,`product_id`,`purchase_price_paise`,`sale_price_paise`,`mrp_paise`,`gst_percent`,date(COALESCE(`created_at`,CURRENT_TIMESTAMP)),'migration','Initial price snapshot'
FROM `pharmacy_inventory` inventory
WHERE `sale_price_paise` > 0 AND `mrp_paise` >= `sale_price_paise`
  AND NOT EXISTS (SELECT 1 FROM `inventory_price_history` history WHERE history.`inventory_id`=inventory.`id`);--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `pharmacy_inventory_price_guard`
BEFORE INSERT ON `pharmacy_inventory`
WHEN NEW.`sale_price_paise` <= 0 OR NEW.`mrp_paise` <= 0 OR NEW.`sale_price_paise` > NEW.`mrp_paise` OR NEW.`gst_percent` NOT IN (0,5,12,18,28)
BEGIN SELECT RAISE(ABORT,'invalid governed inventory price'); END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `pharmacy_inventory_price_update_guard`
BEFORE UPDATE OF `purchase_price_paise`,`sale_price_paise`,`mrp_paise`,`gst_percent` ON `pharmacy_inventory`
WHEN NEW.`sale_price_paise` <= 0 OR NEW.`mrp_paise` <= 0 OR NEW.`sale_price_paise` > NEW.`mrp_paise` OR NEW.`gst_percent` NOT IN (0,5,12,18,28)
BEGIN SELECT RAISE(ABORT,'invalid governed inventory price'); END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `inventory_price_history_no_update`
BEFORE UPDATE ON `inventory_price_history`
BEGIN SELECT RAISE(ABORT,'inventory price history is immutable'); END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `inventory_price_history_no_delete`
BEFORE DELETE ON `inventory_price_history`
BEGIN SELECT RAISE(ABORT,'inventory price history cannot be deleted'); END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `product_pack_conversion_insert_guard`
BEFORE INSERT ON `product_pack_conversions`
WHEN NEW.`base_units_per_presentation` <= 0 OR NEW.`governance_status` NOT IN ('pending','approved','rejected','inactive')
BEGIN SELECT RAISE(ABORT,'invalid product pack conversion'); END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `product_barcode_insert_guard`
BEFORE INSERT ON `product_barcodes`
WHEN NEW.`status` NOT IN ('pending','approved','rejected','inactive') OR length(NEW.`code`) NOT IN (8,12,13,14) OR NEW.`code` GLOB '*[^0-9]*'
BEGIN SELECT RAISE(ABORT,'invalid product barcode'); END;--> statement-breakpoint
PRAGMA optimize;
