DROP TRIGGER IF EXISTS `offline_sale_events_completed_guard`;
--> statement-breakpoint
PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `__new_tax_invoices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`invoice_number` text NOT NULL,
	`vendor_id` integer NOT NULL,
	`source_type` text NOT NULL,
	`source_id` integer NOT NULL,
	`source_number` text DEFAULT '' NOT NULL,
	`seller_name` text DEFAULT '' NOT NULL,
	`seller_address` text DEFAULT '' NOT NULL,
	`seller_email` text DEFAULT '' NOT NULL,
	`seller_gstin` text NOT NULL,
	`buyer_name` text DEFAULT '' NOT NULL,
	`buyer_address` text DEFAULT '' NOT NULL,
	`buyer_gstin` text DEFAULT '' NOT NULL,
	`place_of_supply_state_code` text NOT NULL,
	`payment_mode` text DEFAULT '' NOT NULL,
	`currency` text DEFAULT 'INR' NOT NULL,
	`gross_paise` integer DEFAULT 0 NOT NULL,
	`discount_paise` integer DEFAULT 0 NOT NULL,
	`subtotal_paise` integer NOT NULL,
	`cgst_paise` integer DEFAULT 0 NOT NULL,
	`sgst_paise` integer DEFAULT 0 NOT NULL,
	`igst_paise` integer DEFAULT 0 NOT NULL,
	`delivery_fee_paise` integer DEFAULT 0 NOT NULL,
	`total_paise` integer NOT NULL,
	`irn` text DEFAULT '' NOT NULL,
	`qr_code_payload` text DEFAULT '' NOT NULL,
	`snapshot_version` integer DEFAULT 1 NOT NULL,
	`issued_by_profile_id` integer,
	`issued_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`issued_by_profile_id`) REFERENCES `account_profiles`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "tax_invoices_source_check" CHECK(`source_type` IN ('online_order', 'offline_sale') AND `source_id` > 0 AND length(trim(`source_number`)) > 0),
	CONSTRAINT "tax_invoices_identity_check" CHECK(length(trim(`invoice_number`)) > 0 AND length(trim(`seller_name`)) > 0 AND length(trim(`seller_address`)) > 0 AND length(trim(`buyer_name`)) > 0 AND `place_of_supply_state_code` GLOB '[0-9][0-9]' AND `currency` = 'INR' AND `snapshot_version` = 1),
	CONSTRAINT "tax_invoices_amount_check" CHECK(`gross_paise` >= 0 AND `discount_paise` >= 0 AND `gross_paise` = `subtotal_paise` + `discount_paise` AND `subtotal_paise` >= 0 AND `cgst_paise` >= 0 AND `sgst_paise` >= 0 AND `igst_paise` >= 0 AND `delivery_fee_paise` >= 0 AND `total_paise` = `subtotal_paise` + `cgst_paise` + `sgst_paise` + `igst_paise` + `delivery_fee_paise`)
);
--> statement-breakpoint
INSERT INTO `__new_tax_invoices` (
	`id`,`invoice_number`,`vendor_id`,`source_type`,`source_id`,`source_number`,
	`seller_name`,`seller_address`,`seller_email`,`seller_gstin`,
	`buyer_name`,`buyer_address`,`buyer_gstin`,`place_of_supply_state_code`,
	`payment_mode`,`currency`,`gross_paise`,`discount_paise`,`subtotal_paise`,
	`cgst_paise`,`sgst_paise`,`igst_paise`,`delivery_fee_paise`,`total_paise`,
	`irn`,`qr_code_payload`,`snapshot_version`,`issued_by_profile_id`,`issued_at`
)
SELECT invoice.`id`,invoice.`invoice_number`,invoice.`vendor_id`,invoice.`source_type`,invoice.`source_id`,
	CASE invoice.`source_type`
		WHEN 'online_order' THEN COALESCE((SELECT o.`order_number` FROM `orders` o WHERE o.`id`=invoice.`source_id`),'LEGACY-'||invoice.`id`)
		ELSE COALESCE((SELECT s.`sale_number` FROM `offline_sales` s WHERE s.`id`=invoice.`source_id`),'LEGACY-'||invoice.`id`) END,
	COALESCE(NULLIF(trim(vendor.`business_name`),''),'Registered pharmacy'),
	COALESCE(NULLIF(trim(vendor.`address`),''),'Registered pharmacy address unavailable'),
	COALESCE(vendor.`email`,''),invoice.`seller_gstin`,
	CASE invoice.`source_type`
		WHEN 'online_order' THEN COALESCE(NULLIF(trim((SELECT o.`customer_name` FROM `orders` o WHERE o.`id`=invoice.`source_id`)),''),'Customer')
		ELSE COALESCE(NULLIF(trim((SELECT s.`customer_name` FROM `offline_sales` s WHERE s.`id`=invoice.`source_id`)),''),'Walk-in customer') END,
	CASE invoice.`source_type`
		WHEN 'online_order' THEN COALESCE((SELECT o.`delivery_address` FROM `orders` o WHERE o.`id`=invoice.`source_id`),'')
		ELSE '' END,
	CASE invoice.`source_type`
		WHEN 'offline_sale' THEN COALESCE((SELECT s.`buyer_gstin` FROM `offline_sales` s WHERE s.`id`=invoice.`source_id`),invoice.`buyer_gstin`)
		ELSE invoice.`buyer_gstin` END,
	invoice.`place_of_supply_state_code`,
	CASE invoice.`source_type`
		WHEN 'online_order' THEN COALESCE((SELECT o.`payment_method` FROM `orders` o WHERE o.`id`=invoice.`source_id`),'')
		ELSE COALESCE((SELECT s.`payment_mode` FROM `offline_sales` s WHERE s.`id`=invoice.`source_id`),'') END,
	'INR',
	CASE invoice.`source_type`
		WHEN 'online_order' THEN COALESCE((SELECT SUM(i.`unit_price_paise`*i.`quantity`) FROM `order_items` i WHERE i.`order_id`=invoice.`source_id`),invoice.`subtotal_paise`)
		ELSE COALESCE((SELECT s.`gross_paise` FROM `offline_sales` s WHERE s.`id`=invoice.`source_id`),invoice.`subtotal_paise`) END,
	CASE invoice.`source_type`
		WHEN 'online_order' THEN COALESCE((SELECT SUM(i.`discount_paise`) FROM `order_items` i WHERE i.`order_id`=invoice.`source_id`),0)
		ELSE COALESCE((SELECT s.`discount_paise` FROM `offline_sales` s WHERE s.`id`=invoice.`source_id`),0) END,
	CASE invoice.`source_type`
		WHEN 'online_order' THEN COALESCE((SELECT SUM(i.`taxable_paise`) FROM `order_items` i WHERE i.`order_id`=invoice.`source_id`),invoice.`subtotal_paise`)
		ELSE COALESCE((SELECT s.`subtotal_paise` FROM `offline_sales` s WHERE s.`id`=invoice.`source_id`),invoice.`subtotal_paise`) END,
	CASE invoice.`source_type` WHEN 'online_order' THEN COALESCE((SELECT SUM(i.`cgst_paise`) FROM `order_items` i WHERE i.`order_id`=invoice.`source_id`),invoice.`cgst_paise`) ELSE COALESCE((SELECT s.`cgst_paise` FROM `offline_sales` s WHERE s.`id`=invoice.`source_id`),invoice.`cgst_paise`) END,
	CASE invoice.`source_type` WHEN 'online_order' THEN COALESCE((SELECT SUM(i.`sgst_paise`) FROM `order_items` i WHERE i.`order_id`=invoice.`source_id`),invoice.`sgst_paise`) ELSE COALESCE((SELECT s.`sgst_paise` FROM `offline_sales` s WHERE s.`id`=invoice.`source_id`),invoice.`sgst_paise`) END,
	CASE invoice.`source_type` WHEN 'online_order' THEN COALESCE((SELECT SUM(i.`igst_paise`) FROM `order_items` i WHERE i.`order_id`=invoice.`source_id`),invoice.`igst_paise`) ELSE COALESCE((SELECT s.`igst_paise` FROM `offline_sales` s WHERE s.`id`=invoice.`source_id`),invoice.`igst_paise`) END,
	CASE invoice.`source_type` WHEN 'online_order' THEN COALESCE((SELECT o.`delivery_fee_paise` FROM `orders` o WHERE o.`id`=invoice.`source_id`),MAX(invoice.`total_paise`-invoice.`subtotal_paise`-invoice.`cgst_paise`-invoice.`sgst_paise`-invoice.`igst_paise`,0)) ELSE 0 END,
	CASE invoice.`source_type` WHEN 'online_order' THEN COALESCE((SELECT SUM(i.`line_total_paise`) + o.`delivery_fee_paise` FROM `orders` o JOIN `order_items` i ON i.`order_id`=o.`id` WHERE o.`id`=invoice.`source_id`),invoice.`total_paise`) ELSE COALESCE((SELECT s.`total_paise` FROM `offline_sales` s WHERE s.`id`=invoice.`source_id`),invoice.`total_paise`) END,
	invoice.`irn`,invoice.`qr_code_payload`,1,
	CASE invoice.`source_type`
		WHEN 'offline_sale' THEN (SELECT s.`created_by_profile_id` FROM `offline_sales` s WHERE s.`id`=invoice.`source_id`)
		ELSE (SELECT e.`actor_profile_id` FROM `delivery_events` e WHERE e.`order_id`=invoice.`source_id` AND e.`status`='delivered' ORDER BY e.`id` DESC LIMIT 1) END,
	invoice.`issued_at`
FROM `tax_invoices` invoice JOIN `vendors` vendor ON vendor.`id`=invoice.`vendor_id`;
--> statement-breakpoint
DROP TABLE `tax_invoices`;
--> statement-breakpoint
ALTER TABLE `__new_tax_invoices` RENAME TO `tax_invoices`;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
--> statement-breakpoint
CREATE UNIQUE INDEX `tax_invoices_number_uidx` ON `tax_invoices` (`invoice_number`);
--> statement-breakpoint
CREATE UNIQUE INDEX `tax_invoices_source_uidx` ON `tax_invoices` (`source_type`,`source_id`);
--> statement-breakpoint
CREATE INDEX `tax_invoices_vendor_date_idx` ON `tax_invoices` (`vendor_id`,`issued_at`);
--> statement-breakpoint
CREATE TABLE `tax_invoice_lines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`invoice_id` integer NOT NULL,
	`line_number` integer NOT NULL,
	`source_item_id` integer NOT NULL,
	`product_name` text NOT NULL,
	`hsn_code` text DEFAULT '' NOT NULL,
	`batch_number` text DEFAULT '' NOT NULL,
	`expiry_date` text DEFAULT '' NOT NULL,
	`quantity` integer NOT NULL,
	`unit_price_paise` integer NOT NULL,
	`gross_paise` integer NOT NULL,
	`discount_paise` integer DEFAULT 0 NOT NULL,
	`taxable_paise` integer NOT NULL,
	`gst_percent` integer NOT NULL,
	`cgst_paise` integer DEFAULT 0 NOT NULL,
	`sgst_paise` integer DEFAULT 0 NOT NULL,
	`igst_paise` integer DEFAULT 0 NOT NULL,
	`line_total_paise` integer NOT NULL,
	FOREIGN KEY (`invoice_id`) REFERENCES `tax_invoices`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "tax_invoice_lines_amount_check" CHECK(`line_number` > 0 AND `source_item_id` > 0 AND length(trim(`product_name`)) > 0 AND `quantity` > 0 AND `unit_price_paise` > 0 AND `gross_paise` = `unit_price_paise` * `quantity` AND `discount_paise` >= 0 AND `taxable_paise` = `gross_paise` - `discount_paise` AND `taxable_paise` >= 0 AND `gst_percent` IN (0, 5, 12, 18, 28) AND `cgst_paise` >= 0 AND `sgst_paise` >= 0 AND `igst_paise` >= 0 AND `line_total_paise` = `taxable_paise` + `cgst_paise` + `sgst_paise` + `igst_paise`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tax_invoice_lines_number_uidx` ON `tax_invoice_lines` (`invoice_id`,`line_number`);
--> statement-breakpoint
CREATE UNIQUE INDEX `tax_invoice_lines_source_uidx` ON `tax_invoice_lines` (`invoice_id`,`source_item_id`);
--> statement-breakpoint
CREATE INDEX `tax_invoice_lines_invoice_idx` ON `tax_invoice_lines` (`invoice_id`);
--> statement-breakpoint
INSERT INTO `tax_invoice_lines` (`invoice_id`,`line_number`,`source_item_id`,`product_name`,`hsn_code`,`batch_number`,`expiry_date`,`quantity`,`unit_price_paise`,`gross_paise`,`discount_paise`,`taxable_paise`,`gst_percent`,`cgst_paise`,`sgst_paise`,`igst_paise`,`line_total_paise`)
SELECT invoice.`id`,(SELECT COUNT(*) FROM `order_items` prior WHERE prior.`order_id`=item.`order_id` AND prior.`id`<=item.`id`),item.`id`,item.`product_name`,item.`hsn_code`,item.`batch_number`,COALESCE(item.`expiry_date`,''),item.`quantity`,item.`unit_price_paise`,item.`unit_price_paise`*item.`quantity`,item.`discount_paise`,item.`taxable_paise`,item.`gst_percent`,item.`cgst_paise`,item.`sgst_paise`,item.`igst_paise`,item.`line_total_paise`
FROM `tax_invoices` invoice JOIN `order_items` item ON invoice.`source_type`='online_order' AND item.`order_id`=invoice.`source_id`;
--> statement-breakpoint
INSERT INTO `tax_invoice_lines` (`invoice_id`,`line_number`,`source_item_id`,`product_name`,`hsn_code`,`batch_number`,`expiry_date`,`quantity`,`unit_price_paise`,`gross_paise`,`discount_paise`,`taxable_paise`,`gst_percent`,`cgst_paise`,`sgst_paise`,`igst_paise`,`line_total_paise`)
SELECT invoice.`id`,(SELECT COUNT(*) FROM `offline_sale_items` prior WHERE prior.`offline_sale_id`=item.`offline_sale_id` AND prior.`id`<=item.`id`),item.`id`,item.`product_name`,item.`hsn_code`,item.`batch_number`,item.`expiry_date`,item.`quantity`,item.`unit_price_paise`,item.`unit_price_paise`*item.`quantity`,item.`discount_paise`,item.`taxable_paise`,item.`gst_percent`,item.`cgst_paise`,item.`sgst_paise`,item.`igst_paise`,item.`line_total_paise`
FROM `tax_invoices` invoice JOIN `offline_sale_items` item ON invoice.`source_type`='offline_sale' AND item.`offline_sale_id`=invoice.`source_id`;
--> statement-breakpoint

CREATE TRIGGER `tax_invoices_insert_guard`
BEFORE INSERT ON `tax_invoices`
WHEN NOT (
	(NEW.`source_type`='online_order' AND EXISTS (
		SELECT 1 FROM `orders` source JOIN `vendors` vendor ON vendor.`id`=source.`vendor_id`
		WHERE source.`id`=NEW.`source_id` AND source.`vendor_id`=NEW.`vendor_id`
			AND source.`delivery_status`='delivered' AND source.`payment_status`='paid'
			AND NEW.`invoice_number`='GST-'||source.`order_number` AND NEW.`source_number`=source.`order_number`
			AND NEW.`seller_name`=COALESCE(NULLIF(trim(vendor.`business_name`),''),'Registered pharmacy')
			AND NEW.`seller_address`=COALESCE(NULLIF(trim(vendor.`address`),''),'Registered pharmacy address unavailable')
			AND NEW.`seller_email`=COALESCE(vendor.`email`,'') AND NEW.`seller_gstin`=vendor.`gst_number`
			AND NEW.`buyer_name`=source.`customer_name` AND NEW.`buyer_address`=source.`delivery_address` AND NEW.`buyer_gstin`=''
			AND NEW.`place_of_supply_state_code`=source.`place_of_supply_state_code` AND NEW.`payment_mode`=source.`payment_method`
			AND NEW.`currency`='INR' AND NEW.`snapshot_version`=1
			AND NEW.`gross_paise`=(SELECT SUM(item.`unit_price_paise`*item.`quantity`) FROM `order_items` item WHERE item.`order_id`=source.`id`)
			AND NEW.`discount_paise`=(SELECT SUM(item.`discount_paise`) FROM `order_items` item WHERE item.`order_id`=source.`id`)
			AND NEW.`subtotal_paise`=source.`subtotal_paise`
			AND NEW.`cgst_paise`=(SELECT SUM(item.`cgst_paise`) FROM `order_items` item WHERE item.`order_id`=source.`id`)
			AND NEW.`sgst_paise`=(SELECT SUM(item.`sgst_paise`) FROM `order_items` item WHERE item.`order_id`=source.`id`)
			AND NEW.`igst_paise`=(SELECT SUM(item.`igst_paise`) FROM `order_items` item WHERE item.`order_id`=source.`id`)
			AND NEW.`delivery_fee_paise`=source.`delivery_fee_paise` AND NEW.`total_paise`=source.`total_paise`
	)) OR
	(NEW.`source_type`='offline_sale' AND EXISTS (
		SELECT 1 FROM `offline_sales` source JOIN `vendors` vendor ON vendor.`id`=source.`vendor_id`
		WHERE source.`id`=NEW.`source_id` AND source.`vendor_id`=NEW.`vendor_id`
			AND NEW.`invoice_number`='GST-'||source.`sale_number` AND NEW.`source_number`=source.`sale_number`
			AND NEW.`seller_name`=COALESCE(NULLIF(trim(vendor.`business_name`),''),'Registered pharmacy')
			AND NEW.`seller_address`=COALESCE(NULLIF(trim(vendor.`address`),''),'Registered pharmacy address unavailable')
			AND NEW.`seller_email`=COALESCE(vendor.`email`,'') AND NEW.`seller_gstin`=vendor.`gst_number`
			AND NEW.`buyer_name`=source.`customer_name` AND NEW.`buyer_address`='' AND NEW.`buyer_gstin`=source.`buyer_gstin`
			AND NEW.`place_of_supply_state_code`=source.`place_of_supply_state_code` AND NEW.`payment_mode`=source.`payment_mode`
			AND NEW.`currency`='INR' AND NEW.`snapshot_version`=1
			AND NEW.`gross_paise`=source.`gross_paise` AND NEW.`discount_paise`=source.`discount_paise`
			AND NEW.`subtotal_paise`=source.`subtotal_paise` AND NEW.`cgst_paise`=source.`cgst_paise`
			AND NEW.`sgst_paise`=source.`sgst_paise` AND NEW.`igst_paise`=source.`igst_paise`
			AND NEW.`delivery_fee_paise`=0 AND NEW.`total_paise`=source.`total_paise`
	))
)
BEGIN SELECT RAISE(ABORT,'invalid immutable tax invoice snapshot'); END;
--> statement-breakpoint
CREATE TRIGGER `tax_invoices_populate_lines`
AFTER INSERT ON `tax_invoices`
BEGIN
	INSERT INTO `tax_invoice_lines` (`invoice_id`,`line_number`,`source_item_id`,`product_name`,`hsn_code`,`batch_number`,`expiry_date`,`quantity`,`unit_price_paise`,`gross_paise`,`discount_paise`,`taxable_paise`,`gst_percent`,`cgst_paise`,`sgst_paise`,`igst_paise`,`line_total_paise`)
	SELECT NEW.`id`,(SELECT COUNT(*) FROM `order_items` prior WHERE prior.`order_id`=item.`order_id` AND prior.`id`<=item.`id`),item.`id`,item.`product_name`,item.`hsn_code`,item.`batch_number`,COALESCE(item.`expiry_date`,''),item.`quantity`,item.`unit_price_paise`,item.`unit_price_paise`*item.`quantity`,item.`discount_paise`,item.`taxable_paise`,item.`gst_percent`,item.`cgst_paise`,item.`sgst_paise`,item.`igst_paise`,item.`line_total_paise`
	FROM `order_items` item WHERE NEW.`source_type`='online_order' AND item.`order_id`=NEW.`source_id`;
	INSERT INTO `tax_invoice_lines` (`invoice_id`,`line_number`,`source_item_id`,`product_name`,`hsn_code`,`batch_number`,`expiry_date`,`quantity`,`unit_price_paise`,`gross_paise`,`discount_paise`,`taxable_paise`,`gst_percent`,`cgst_paise`,`sgst_paise`,`igst_paise`,`line_total_paise`)
	SELECT NEW.`id`,(SELECT COUNT(*) FROM `offline_sale_items` prior WHERE prior.`offline_sale_id`=item.`offline_sale_id` AND prior.`id`<=item.`id`),item.`id`,item.`product_name`,item.`hsn_code`,item.`batch_number`,item.`expiry_date`,item.`quantity`,item.`unit_price_paise`,item.`unit_price_paise`*item.`quantity`,item.`discount_paise`,item.`taxable_paise`,item.`gst_percent`,item.`cgst_paise`,item.`sgst_paise`,item.`igst_paise`,item.`line_total_paise`
	FROM `offline_sale_items` item WHERE NEW.`source_type`='offline_sale' AND item.`offline_sale_id`=NEW.`source_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `tax_invoices_no_update` BEFORE UPDATE ON `tax_invoices` BEGIN SELECT RAISE(ABORT,'tax invoices are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `tax_invoices_no_delete` BEFORE DELETE ON `tax_invoices` BEGIN SELECT RAISE(ABORT,'tax invoices are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `tax_invoice_lines_no_insert` BEFORE INSERT ON `tax_invoice_lines`
WHEN NOT (
	EXISTS (SELECT 1 FROM `tax_invoices` invoice JOIN `order_items` item
		ON invoice.`source_type`='online_order' AND item.`order_id`=invoice.`source_id`
		WHERE invoice.`id`=NEW.`invoice_id` AND item.`id`=NEW.`source_item_id`
			AND NEW.`line_number`=(SELECT count(*) FROM `order_items` prior WHERE prior.`order_id`=item.`order_id` AND prior.`id`<=item.`id`)
			AND NEW.`product_name`=item.`product_name` AND NEW.`hsn_code`=item.`hsn_code`
			AND NEW.`batch_number`=item.`batch_number` AND NEW.`expiry_date`=COALESCE(item.`expiry_date`,'')
			AND NEW.`quantity`=item.`quantity` AND NEW.`unit_price_paise`=item.`unit_price_paise`
			AND NEW.`gross_paise`=item.`unit_price_paise`*item.`quantity` AND NEW.`discount_paise`=item.`discount_paise`
			AND NEW.`taxable_paise`=item.`taxable_paise` AND NEW.`gst_percent`=item.`gst_percent`
			AND NEW.`cgst_paise`=item.`cgst_paise` AND NEW.`sgst_paise`=item.`sgst_paise`
			AND NEW.`igst_paise`=item.`igst_paise` AND NEW.`line_total_paise`=item.`line_total_paise`)
	OR EXISTS (SELECT 1 FROM `tax_invoices` invoice JOIN `offline_sale_items` item
		ON invoice.`source_type`='offline_sale' AND item.`offline_sale_id`=invoice.`source_id`
		WHERE invoice.`id`=NEW.`invoice_id` AND item.`id`=NEW.`source_item_id`
			AND NEW.`line_number`=(SELECT count(*) FROM `offline_sale_items` prior WHERE prior.`offline_sale_id`=item.`offline_sale_id` AND prior.`id`<=item.`id`)
			AND NEW.`product_name`=item.`product_name` AND NEW.`hsn_code`=item.`hsn_code`
			AND NEW.`batch_number`=item.`batch_number` AND NEW.`expiry_date`=item.`expiry_date`
			AND NEW.`quantity`=item.`quantity` AND NEW.`unit_price_paise`=item.`unit_price_paise`
			AND NEW.`gross_paise`=item.`unit_price_paise`*item.`quantity` AND NEW.`discount_paise`=item.`discount_paise`
			AND NEW.`taxable_paise`=item.`taxable_paise` AND NEW.`gst_percent`=item.`gst_percent`
			AND NEW.`cgst_paise`=item.`cgst_paise` AND NEW.`sgst_paise`=item.`sgst_paise`
			AND NEW.`igst_paise`=item.`igst_paise` AND NEW.`line_total_paise`=item.`line_total_paise`)
)
BEGIN SELECT RAISE(ABORT,'invalid tax invoice line'); END;
--> statement-breakpoint
CREATE TRIGGER `tax_invoice_lines_no_update` BEFORE UPDATE ON `tax_invoice_lines` BEGIN SELECT RAISE(ABORT,'tax invoice lines are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `tax_invoice_lines_no_delete` BEFORE DELETE ON `tax_invoice_lines` BEGIN SELECT RAISE(ABORT,'tax invoice lines are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `offline_sale_events_completed_guard`
BEFORE INSERT ON `offline_sale_events`
WHEN NEW.`event_type` <> 'completed' OR NOT EXISTS (
	SELECT 1 FROM `offline_sales` sale
	WHERE sale.`id` = NEW.`offline_sale_id` AND sale.`vendor_id` = NEW.`vendor_id`
		AND sale.`request_fingerprint` = NEW.`request_fingerprint`
		AND EXISTS (SELECT 1 FROM `offline_sale_items` item WHERE item.`offline_sale_id` = sale.`id`)
		AND sale.`gross_paise` = (SELECT sum(item.`unit_price_paise` * item.`quantity`) FROM `offline_sale_items` item WHERE item.`offline_sale_id` = sale.`id`)
		AND sale.`discount_paise` = (SELECT sum(item.`discount_paise`) FROM `offline_sale_items` item WHERE item.`offline_sale_id` = sale.`id`)
		AND sale.`subtotal_paise` = (SELECT sum(item.`taxable_paise`) FROM `offline_sale_items` item WHERE item.`offline_sale_id` = sale.`id`)
		AND sale.`tax_paise` = (SELECT sum(item.`tax_paise`) FROM `offline_sale_items` item WHERE item.`offline_sale_id` = sale.`id`)
		AND sale.`total_paise` = (SELECT sum(item.`line_total_paise`) FROM `offline_sale_items` item WHERE item.`offline_sale_id` = sale.`id`)
		AND EXISTS (SELECT 1 FROM `tax_invoices` invoice WHERE invoice.`source_type` = 'offline_sale'
			AND invoice.`source_id` = sale.`id` AND invoice.`vendor_id` = sale.`vendor_id`
			AND invoice.`gross_paise` = sale.`gross_paise` AND invoice.`discount_paise` = sale.`discount_paise`
			AND invoice.`subtotal_paise` = sale.`subtotal_paise` AND invoice.`cgst_paise` = sale.`cgst_paise`
			AND invoice.`sgst_paise` = sale.`sgst_paise` AND invoice.`igst_paise` = sale.`igst_paise`
			AND invoice.`total_paise` = sale.`total_paise`
			AND (SELECT count(*) FROM `tax_invoice_lines` line WHERE line.`invoice_id`=invoice.`id`)
				= (SELECT count(*) FROM `offline_sale_items` item WHERE item.`offline_sale_id`=sale.`id`)
			AND (SELECT sum(line.`line_total_paise`) FROM `tax_invoice_lines` line WHERE line.`invoice_id`=invoice.`id`) = sale.`total_paise`)
		AND (SELECT COALESCE(sum(ledger.`debit_paise`),0) FROM `ledger_entries` ledger
			WHERE ledger.`reference_type` = 'offline_sale' AND ledger.`reference_id` = sale.`id`) = sale.`total_paise`
		AND (SELECT COALESCE(sum(ledger.`credit_paise`),0) FROM `ledger_entries` ledger
			WHERE ledger.`reference_type` = 'offline_sale' AND ledger.`reference_id` = sale.`id`) = sale.`total_paise`
		AND NOT EXISTS (
			SELECT 1 FROM `offline_sale_items` item WHERE item.`offline_sale_id` = sale.`id`
				AND NOT EXISTS (SELECT 1 FROM `stock_ledger` stock WHERE stock.`reference_type` = 'offline_sale'
					AND stock.`reference_id` = sale.`id` AND stock.`inventory_id` = item.`inventory_id`
					AND stock.`quantity_delta` = -item.`quantity`)
		)
		AND NOT EXISTS (
			SELECT 1 FROM `offline_sale_items` item WHERE item.`offline_sale_id` = sale.`id`
				AND (item.`prescription_required` = 1 OR item.`drug_schedule` IN ('H','H1','X','NDPS'))
				AND (sale.`offline_prescription_id` IS NULL OR NOT EXISTS (
					SELECT 1 FROM `offline_prescription_reviews` review
					JOIN `offline_prescription_review_items` approved ON approved.`review_id` = review.`id`
					WHERE review.`offline_prescription_id` = sale.`offline_prescription_id`
						AND review.`decision` = 'approved' AND approved.`product_id` = item.`product_id`
					GROUP BY approved.`product_id`
					HAVING sum(approved.`quantity_approved`) >= (SELECT sum(required.`quantity`) FROM `offline_sale_items` required
						WHERE required.`offline_sale_id` = sale.`id` AND required.`product_id` = item.`product_id`)
				))
		)
		AND NOT EXISTS (
			SELECT 1 FROM `offline_sale_items` item WHERE item.`offline_sale_id` = sale.`id`
				AND (item.`prescription_required` = 1 OR item.`drug_schedule` IN ('H','H1','X','NDPS'))
				AND NOT EXISTS (SELECT 1 FROM `statutory_register_entries` register_entry
					WHERE register_entry.`source_type` = 'offline_sale' AND register_entry.`source_id` = sale.`id`
						AND register_entry.`product_id` = item.`product_id` AND register_entry.`batch_number` = item.`batch_number`
						AND register_entry.`quantity_supplied` = item.`quantity`)
		)
)
BEGIN SELECT RAISE(ABORT, 'offline_sale_evidence_invalid'); END;
