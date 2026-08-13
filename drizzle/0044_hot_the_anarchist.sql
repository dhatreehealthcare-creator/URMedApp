CREATE TABLE `offline_prescription_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`offline_prescription_id` integer NOT NULL,
	`product_id` integer NOT NULL,
	`medicine_text` text NOT NULL,
	`quantity_requested` integer NOT NULL,
	FOREIGN KEY (`offline_prescription_id`) REFERENCES `offline_prescriptions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "offline_prescription_items_quantity_check" CHECK("offline_prescription_items"."quantity_requested" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `offline_prescription_items_capture_product_uidx` ON `offline_prescription_items` (`offline_prescription_id`,`product_id`);--> statement-breakpoint
CREATE TABLE `offline_prescription_review_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`review_id` integer NOT NULL,
	`product_id` integer NOT NULL,
	`quantity_approved` integer NOT NULL,
	FOREIGN KEY (`review_id`) REFERENCES `offline_prescription_reviews`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "offline_prescription_review_items_quantity_check" CHECK("offline_prescription_review_items"."quantity_approved" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `offline_prescription_review_items_review_product_uidx` ON `offline_prescription_review_items` (`review_id`,`product_id`);--> statement-breakpoint
CREATE TABLE `offline_prescription_reviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`offline_prescription_id` integer NOT NULL,
	`pharmacist_id` integer NOT NULL,
	`decision` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`reviewed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`offline_prescription_id`) REFERENCES `offline_prescriptions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`pharmacist_id`) REFERENCES `pharmacists`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `offline_prescription_reviews_capture_uidx` ON `offline_prescription_reviews` (`offline_prescription_id`);--> statement-breakpoint
CREATE INDEX `offline_prescription_reviews_pharmacist_idx` ON `offline_prescription_reviews` (`pharmacist_id`,`reviewed_at`);--> statement-breakpoint
CREATE TABLE `offline_prescriptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`capture_number` text NOT NULL,
	`vendor_id` integer NOT NULL,
	`customer_profile_id` integer,
	`document_id` integer NOT NULL,
	`patient_name` text NOT NULL,
	`patient_address` text NOT NULL,
	`prescriber_name` text NOT NULL,
	`prescriber_address` text NOT NULL,
	`prescribed_on` text NOT NULL,
	`serial_number` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'uploaded' NOT NULL,
	`rejection_reason` text DEFAULT '' NOT NULL,
	`captured_by_profile_id` integer NOT NULL,
	`reviewed_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_profile_id`) REFERENCES `account_profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`document_id`) REFERENCES `stored_documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`captured_by_profile_id`) REFERENCES `account_profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `offline_prescriptions_number_uidx` ON `offline_prescriptions` (`capture_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `offline_prescriptions_document_uidx` ON `offline_prescriptions` (`document_id`);--> statement-breakpoint
CREATE INDEX `offline_prescriptions_vendor_status_idx` ON `offline_prescriptions` (`vendor_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `offline_prescriptions_customer_idx` ON `offline_prescriptions` (`customer_profile_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `offline_sale_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`offline_sale_id` integer NOT NULL,
	`vendor_id` integer NOT NULL,
	`event_type` text NOT NULL,
	`actor_profile_id` integer NOT NULL,
	`request_fingerprint` text NOT NULL,
	`evidence_json` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`offline_sale_id`) REFERENCES `offline_sales`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_profile_id`) REFERENCES `account_profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `offline_sale_events_sale_type_uidx` ON `offline_sale_events` (`offline_sale_id`,`event_type`);--> statement-breakpoint
CREATE INDEX `offline_sale_events_vendor_date_idx` ON `offline_sale_events` (`vendor_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `offline_sale_items` ADD `product_name` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `offline_sale_items` ADD `hsn_code` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `offline_sale_items` ADD `mrp_paise` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `offline_sale_items` ADD `discount_paise` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `offline_sale_items` ADD `cgst_paise` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `offline_sale_items` ADD `sgst_paise` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `offline_sale_items` ADD `igst_paise` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `offline_sale_items` ADD `prescription_required` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `offline_sale_items` ADD `drug_schedule` text DEFAULT 'UNCLASSIFIED' NOT NULL;--> statement-breakpoint
UPDATE `offline_sale_items`
SET `product_name` = COALESCE((SELECT product.`name` FROM `products` product WHERE product.`id` = `offline_sale_items`.`product_id`), ''),
	`hsn_code` = COALESCE((SELECT product.`hsn_code` FROM `products` product WHERE product.`id` = `offline_sale_items`.`product_id`), ''),
	`mrp_paise` = COALESCE((SELECT inventory.`mrp_paise` FROM `pharmacy_inventory` inventory WHERE inventory.`id` = `offline_sale_items`.`inventory_id`), 0),
	`cgst_paise` = CAST(`tax_paise` / 2 AS INTEGER), `sgst_paise` = `tax_paise` - CAST(`tax_paise` / 2 AS INTEGER),
	`prescription_required` = COALESCE((SELECT product.`prescription_required` FROM `products` product WHERE product.`id` = `offline_sale_items`.`product_id`), 0),
	`drug_schedule` = COALESCE((SELECT product.`drug_schedule` FROM `products` product WHERE product.`id` = `offline_sale_items`.`product_id`), 'UNCLASSIFIED');--> statement-breakpoint
CREATE UNIQUE INDEX `offline_sale_items_sale_inventory_uidx` ON `offline_sale_items` (`offline_sale_id`,`inventory_id`);--> statement-breakpoint
ALTER TABLE `offline_sales` ADD `customer_profile_id` integer REFERENCES account_profiles(id);--> statement-breakpoint
ALTER TABLE `offline_sales` ADD `offline_prescription_id` integer REFERENCES offline_prescriptions(id);--> statement-breakpoint
ALTER TABLE `offline_sales` ADD `idempotency_key` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `offline_sales` ADD `request_fingerprint` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `offline_sales` ADD `gross_paise` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `offline_sales` ADD `cgst_paise` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `offline_sales` ADD `sgst_paise` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `offline_sales` ADD `igst_paise` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `offline_sales` ADD `buyer_gstin` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `offline_sales` ADD `place_of_supply_state_code` text DEFAULT '00' NOT NULL;--> statement-breakpoint
UPDATE `offline_sales`
SET `gross_paise` = `subtotal_paise` + `discount_paise`,
	`cgst_paise` = CAST(`tax_paise` / 2 AS INTEGER), `sgst_paise` = `tax_paise` - CAST(`tax_paise` / 2 AS INTEGER),
	`place_of_supply_state_code` = COALESCE((SELECT invoice.`place_of_supply_state_code` FROM `tax_invoices` invoice
		WHERE invoice.`source_type` = 'offline_sale' AND invoice.`source_id` = `offline_sales`.`id` ORDER BY invoice.`id` DESC LIMIT 1), '00');--> statement-breakpoint
CREATE UNIQUE INDEX `offline_sales_vendor_idempotency_uidx` ON `offline_sales` (`vendor_id`,`idempotency_key`) WHERE "offline_sales"."idempotency_key" <> '';--> statement-breakpoint
CREATE UNIQUE INDEX `offline_sales_prescription_uidx` ON `offline_sales` (`offline_prescription_id`) WHERE "offline_sales"."offline_prescription_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `tax_invoices_offline_source_uidx` ON `tax_invoices` (`source_type`,`source_id`) WHERE "tax_invoices"."source_type" = 'offline_sale';
--> statement-breakpoint

CREATE TRIGGER `offline_prescriptions_insert_guard`
BEFORE INSERT ON `offline_prescriptions`
WHEN NEW.`status` <> 'uploaded'
	OR length(trim(NEW.`patient_name`)) < 2 OR length(trim(NEW.`patient_address`)) < 5
	OR length(trim(NEW.`prescriber_name`)) < 2 OR length(trim(NEW.`prescriber_address`)) < 5
	OR date(NEW.`prescribed_on`) IS NULL OR date(NEW.`prescribed_on`) > date('now')
	OR NOT EXISTS (
		SELECT 1 FROM `stored_documents` document
		WHERE document.`id` = NEW.`document_id` AND document.`purpose` = 'offline_prescription'
			AND document.`vendor_id` = NEW.`vendor_id` AND document.`owner_profile_id` = NEW.`captured_by_profile_id`
			AND document.`status` = 'active' AND document.`malware_status` = 'content_validated'
	)
	OR (NEW.`customer_profile_id` IS NOT NULL AND NOT EXISTS (
		SELECT 1 FROM `account_profiles` customer
		WHERE customer.`id` = NEW.`customer_profile_id` AND customer.`role` = 'customer'
			AND customer.`status` = 'active' AND customer.`email_verified` = 1 AND customer.`phone_verified` = 1
	))
	OR NOT EXISTS (
		SELECT 1 FROM `account_profiles` actor
		WHERE actor.`id` = NEW.`captured_by_profile_id` AND actor.`role` = 'vendor' AND actor.`status` = 'active'
			AND actor.`email_verified` = 1 AND actor.`phone_verified` = 1
			AND (EXISTS (SELECT 1 FROM `vendors` owner WHERE owner.`id` = NEW.`vendor_id` AND owner.`profile_id` = actor.`id`)
				OR EXISTS (SELECT 1 FROM `vendor_staff` staff WHERE staff.`vendor_id` = NEW.`vendor_id`
					AND staff.`profile_id` = actor.`id` AND staff.`status` = 'active'))
	)
BEGIN
	SELECT RAISE(ABORT, 'offline_prescription_invalid');
END;--> statement-breakpoint

CREATE TRIGGER `offline_prescriptions_no_update`
BEFORE UPDATE ON `offline_prescriptions`
WHEN NEW.`id` <> OLD.`id` OR NEW.`capture_number` <> OLD.`capture_number`
	OR NEW.`vendor_id` <> OLD.`vendor_id`
	OR COALESCE(NEW.`customer_profile_id`, -1) <> COALESCE(OLD.`customer_profile_id`, -1)
	OR NEW.`document_id` <> OLD.`document_id` OR NEW.`patient_name` <> OLD.`patient_name`
	OR NEW.`patient_address` <> OLD.`patient_address` OR NEW.`prescriber_name` <> OLD.`prescriber_name`
	OR NEW.`prescriber_address` <> OLD.`prescriber_address` OR NEW.`prescribed_on` <> OLD.`prescribed_on`
	OR NEW.`serial_number` <> OLD.`serial_number` OR NEW.`captured_by_profile_id` <> OLD.`captured_by_profile_id`
	OR NEW.`created_at` <> OLD.`created_at` OR OLD.`status` <> 'uploaded'
	OR NEW.`status` NOT IN ('approved','rejected','clarification_required')
	OR NEW.`reviewed_at` IS NULL
	OR (NEW.`status` = 'approved' AND trim(NEW.`rejection_reason`) <> '')
	OR (NEW.`status` <> 'approved' AND length(trim(NEW.`rejection_reason`)) < 5)
	OR NOT EXISTS (
		SELECT 1 FROM `offline_prescription_reviews` review
		WHERE review.`offline_prescription_id` = OLD.`id` AND review.`decision` = NEW.`status`
	)
BEGIN
	SELECT RAISE(ABORT, 'offline_prescription_transition_invalid');
END;--> statement-breakpoint

CREATE TRIGGER `offline_prescriptions_no_delete`
BEFORE DELETE ON `offline_prescriptions`
BEGIN
	SELECT RAISE(ABORT, 'offline_prescription_immutable');
END;--> statement-breakpoint

CREATE TRIGGER `offline_prescription_items_guard`
BEFORE INSERT ON `offline_prescription_items`
WHEN NEW.`quantity_requested` <= 0 OR NOT EXISTS (
	SELECT 1 FROM `offline_prescriptions` capture JOIN `products` product ON product.`id` = NEW.`product_id`
	WHERE capture.`id` = NEW.`offline_prescription_id` AND capture.`status` = 'uploaded'
		AND product.`active` = 1 AND product.`governance_status` = 'approved'
		AND product.`drug_schedule` <> 'UNCLASSIFIED'
)
BEGIN
	SELECT RAISE(ABORT, 'offline_prescription_item_invalid');
END;--> statement-breakpoint

CREATE TRIGGER `offline_prescription_items_no_update`
BEFORE UPDATE ON `offline_prescription_items`
BEGIN
	SELECT RAISE(ABORT, 'offline_prescription_item_immutable');
END;--> statement-breakpoint

CREATE TRIGGER `offline_prescription_items_no_delete`
BEFORE DELETE ON `offline_prescription_items`
BEGIN
	SELECT RAISE(ABORT, 'offline_prescription_item_immutable');
END;--> statement-breakpoint

CREATE TRIGGER `offline_prescription_reviews_guard`
BEFORE INSERT ON `offline_prescription_reviews`
WHEN NEW.`decision` NOT IN ('approved','rejected','clarification_required')
	OR (NEW.`decision` <> 'approved' AND length(trim(NEW.`notes`)) < 5)
	OR NOT EXISTS (
		SELECT 1 FROM `offline_prescriptions` capture
		JOIN `pharmacists` pharmacist ON pharmacist.`id` = NEW.`pharmacist_id`
		JOIN `account_profiles` pharmacist_profile ON pharmacist_profile.`id` = pharmacist.`profile_id`
		WHERE capture.`id` = NEW.`offline_prescription_id` AND capture.`status` = 'uploaded'
			AND pharmacist.`vendor_id` = capture.`vendor_id` AND pharmacist.`active` = 1
			AND pharmacist.`verification_status` = 'verified'
			AND pharmacist_profile.`role` = 'vendor' AND pharmacist_profile.`status` = 'active'
			AND pharmacist_profile.`email_verified` = 1 AND pharmacist_profile.`phone_verified` = 1
			AND (pharmacist.`valid_from` IS NULL OR date(pharmacist.`valid_from`) <= date('now'))
			AND (pharmacist.`valid_until` IS NULL OR date(pharmacist.`valid_until`) >= date('now'))
	)
BEGIN
	SELECT RAISE(ABORT, 'offline_prescription_review_invalid');
END;--> statement-breakpoint

CREATE TRIGGER `offline_prescription_reviews_no_update`
BEFORE UPDATE ON `offline_prescription_reviews`
BEGIN
	SELECT RAISE(ABORT, 'offline_prescription_review_immutable');
END;--> statement-breakpoint

CREATE TRIGGER `offline_prescription_reviews_no_delete`
BEFORE DELETE ON `offline_prescription_reviews`
BEGIN
	SELECT RAISE(ABORT, 'offline_prescription_review_immutable');
END;--> statement-breakpoint

CREATE TRIGGER `offline_prescription_review_items_guard`
BEFORE INSERT ON `offline_prescription_review_items`
WHEN NEW.`quantity_approved` <= 0 OR NOT EXISTS (
	SELECT 1 FROM `offline_prescription_reviews` review
	JOIN `offline_prescription_items` requested
		ON requested.`offline_prescription_id` = review.`offline_prescription_id`
		AND requested.`product_id` = NEW.`product_id`
	WHERE review.`id` = NEW.`review_id` AND review.`decision` = 'approved'
		AND NEW.`quantity_approved` <= requested.`quantity_requested`
)
BEGIN
	SELECT RAISE(ABORT, 'offline_prescription_review_item_invalid');
END;--> statement-breakpoint

CREATE TRIGGER `offline_prescription_review_items_no_update`
BEFORE UPDATE ON `offline_prescription_review_items`
BEGIN
	SELECT RAISE(ABORT, 'offline_prescription_review_item_immutable');
END;--> statement-breakpoint

CREATE TRIGGER `offline_prescription_review_items_no_delete`
BEFORE DELETE ON `offline_prescription_review_items`
BEGIN
	SELECT RAISE(ABORT, 'offline_prescription_review_item_immutable');
END;--> statement-breakpoint

CREATE TRIGGER `offline_sales_insert_guard`
BEFORE INSERT ON `offline_sales`
WHEN length(trim(NEW.`idempotency_key`)) < 8 OR length(NEW.`request_fingerprint`) <> 64
	OR NEW.`gross_paise` <= 0 OR NEW.`discount_paise` < 0 OR NEW.`discount_paise` >= NEW.`gross_paise`
	OR NEW.`subtotal_paise` <> NEW.`gross_paise` - NEW.`discount_paise`
	OR NEW.`tax_paise` <> NEW.`cgst_paise` + NEW.`sgst_paise` + NEW.`igst_paise`
	OR NEW.`total_paise` <> NEW.`subtotal_paise` + NEW.`tax_paise`
	OR NEW.`place_of_supply_state_code` NOT GLOB '[0-9][0-9]'
	OR (NEW.`payment_mode` = 'credit' AND NEW.`customer_profile_id` IS NULL)
	OR (NEW.`customer_profile_id` IS NOT NULL AND NOT EXISTS (
		SELECT 1 FROM `account_profiles` customer WHERE customer.`id` = NEW.`customer_profile_id`
			AND customer.`role` = 'customer' AND customer.`status` = 'active'
			AND customer.`email_verified` = 1 AND customer.`phone_verified` = 1
			AND customer.`name` = NEW.`customer_name` AND customer.`phone` = NEW.`customer_phone`
	))
	OR (NEW.`offline_prescription_id` IS NOT NULL AND NOT EXISTS (
		SELECT 1 FROM `offline_prescriptions` capture WHERE capture.`id` = NEW.`offline_prescription_id`
			AND capture.`vendor_id` = NEW.`vendor_id` AND capture.`status` = 'approved'
	))
	OR NOT EXISTS (
		SELECT 1 FROM `account_profiles` actor
		WHERE actor.`id` = NEW.`created_by_profile_id` AND actor.`role` = 'vendor' AND actor.`status` = 'active'
			AND actor.`email_verified` = 1 AND actor.`phone_verified` = 1
			AND (EXISTS (SELECT 1 FROM `vendors` owner WHERE owner.`id` = NEW.`vendor_id` AND owner.`profile_id` = actor.`id`)
				OR EXISTS (SELECT 1 FROM `vendor_staff` staff WHERE staff.`vendor_id` = NEW.`vendor_id`
					AND staff.`profile_id` = actor.`id` AND staff.`status` = 'active'))
	)
BEGIN
	SELECT RAISE(ABORT, 'offline_sale_invalid');
END;--> statement-breakpoint

DROP TRIGGER IF EXISTS `offline_sale_stock_guard`;--> statement-breakpoint
CREATE TRIGGER `offline_sale_stock_guard`
BEFORE INSERT ON `offline_sale_items`
WHEN NEW.`quantity` <= 0 OR NEW.`taxable_paise` <> NEW.`unit_price_paise` * NEW.`quantity` - NEW.`discount_paise`
	OR NEW.`tax_paise` <> NEW.`cgst_paise` + NEW.`sgst_paise` + NEW.`igst_paise`
	OR NEW.`line_total_paise` <> NEW.`taxable_paise` + NEW.`tax_paise`
	OR NEW.`tax_paise` <> CAST((NEW.`taxable_paise` * NEW.`gst_percent` + 50) / 100 AS INTEGER)
	OR NOT EXISTS (
		SELECT 1 FROM `offline_sales` sale
		JOIN `pharmacy_inventory` inventory ON inventory.`id` = NEW.`inventory_id`
		JOIN `products` product ON product.`id` = inventory.`product_id`
		JOIN `vendors` vendor ON vendor.`id` = sale.`vendor_id`
		WHERE sale.`id` = NEW.`offline_sale_id` AND inventory.`vendor_id` = sale.`vendor_id`
			AND inventory.`product_id` = NEW.`product_id` AND inventory.`batch_number` = NEW.`batch_number`
			AND inventory.`expiry_date` = NEW.`expiry_date` AND inventory.`sale_price_paise` = NEW.`unit_price_paise`
			AND inventory.`gst_percent` = NEW.`gst_percent` AND inventory.`mrp_paise` = NEW.`mrp_paise`
			AND product.`name` = NEW.`product_name` AND product.`hsn_code` = NEW.`hsn_code`
			AND product.`prescription_required` = NEW.`prescription_required` AND product.`drug_schedule` = NEW.`drug_schedule`
			AND product.`active` = 1 AND product.`governance_status` = 'approved' AND product.`drug_schedule` <> 'UNCLASSIFIED'
			AND inventory.`active` = 1 AND inventory.`quarantine_status` = 'available'
			AND inventory.`cold_chain_status` IN ('not_applicable','within_range')
			AND date(inventory.`expiry_date`) >= date('now')
			AND inventory.`quantity` - inventory.`reserved_quantity` >= NEW.`quantity`
			AND vendor.`registration_status` = 'submitted'
			AND vendor.`approval_status` = 'approved' AND vendor.`compliance_status` = 'verified' AND vendor.`suspended_at` IS NULL
			AND EXISTS (
				SELECT 1 FROM `vendor_licences` current_licence
				WHERE current_licence.`vendor_id` = vendor.`id`
					AND current_licence.`verification_status` = 'verified' AND current_licence.`suspended_at` IS NULL
					AND date(current_licence.`valid_from`) <= date('now') AND date(current_licence.`valid_until`) >= date('now')
			)
			AND EXISTS (
				SELECT 1 FROM `pharmacists` current_pharmacist
				WHERE current_pharmacist.`vendor_id` = vendor.`id`
					AND current_pharmacist.`verification_status` = 'verified' AND current_pharmacist.`active` = 1
					AND (current_pharmacist.`valid_from` IS NULL OR date(current_pharmacist.`valid_from`) <= date('now'))
					AND (current_pharmacist.`valid_until` IS NULL OR date(current_pharmacist.`valid_until`) >= date('now'))
			)
			AND (NEW.`gst_percent` = 0 OR (length(vendor.`gst_number`) = 15 AND substr(vendor.`gst_number`,1,2) GLOB '[0-9][0-9]'))
			AND (
				(substr(vendor.`gst_number`,1,2) = sale.`place_of_supply_state_code`
					AND NEW.`igst_paise` = 0 AND NEW.`cgst_paise` = CAST(NEW.`tax_paise` / 2 AS INTEGER)
					AND NEW.`sgst_paise` = NEW.`tax_paise` - CAST(NEW.`tax_paise` / 2 AS INTEGER))
				OR (substr(vendor.`gst_number`,1,2) <> sale.`place_of_supply_state_code`
					AND NEW.`cgst_paise` = 0 AND NEW.`sgst_paise` = 0 AND NEW.`igst_paise` = NEW.`tax_paise`)
				OR (NEW.`gst_percent` = 0 AND NEW.`cgst_paise` = 0 AND NEW.`sgst_paise` = 0 AND NEW.`igst_paise` = 0)
			)
			AND inventory.`id` = (
				SELECT first.`id` FROM `pharmacy_inventory` first
				WHERE first.`vendor_id` = inventory.`vendor_id` AND first.`product_id` = inventory.`product_id`
					AND first.`active` = 1 AND first.`quarantine_status` = 'available'
					AND first.`cold_chain_status` IN ('not_applicable','within_range')
					AND date(first.`expiry_date`) >= date('now') AND first.`quantity` - first.`reserved_quantity` > 0
				ORDER BY date(first.`expiry_date`), first.`id` LIMIT 1
			)
	)
BEGIN
	SELECT RAISE(ABORT, 'offline_sale_stock_invalid');
END;--> statement-breakpoint

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
			AND invoice.`subtotal_paise` = sale.`subtotal_paise` AND invoice.`cgst_paise` = sale.`cgst_paise`
			AND invoice.`sgst_paise` = sale.`sgst_paise` AND invoice.`igst_paise` = sale.`igst_paise`
			AND invoice.`total_paise` = sale.`total_paise`)
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
BEGIN
	SELECT RAISE(ABORT, 'offline_sale_evidence_invalid');
END;--> statement-breakpoint

CREATE TRIGGER `offline_sale_events_no_update`
BEFORE UPDATE ON `offline_sale_events`
BEGIN
	SELECT RAISE(ABORT, 'offline_sale_evidence_immutable');
END;--> statement-breakpoint

CREATE TRIGGER `offline_sale_events_no_delete`
BEFORE DELETE ON `offline_sale_events`
BEGIN
	SELECT RAISE(ABORT, 'offline_sale_evidence_immutable');
END;--> statement-breakpoint

CREATE TRIGGER `offline_sales_no_update`
BEFORE UPDATE ON `offline_sales`
BEGIN
	SELECT RAISE(ABORT, 'offline_sale_immutable');
END;--> statement-breakpoint

CREATE TRIGGER `offline_sales_no_delete`
BEFORE DELETE ON `offline_sales`
BEGIN
	SELECT RAISE(ABORT, 'offline_sale_immutable');
END;--> statement-breakpoint

CREATE TRIGGER `offline_sale_items_no_update`
BEFORE UPDATE ON `offline_sale_items`
BEGIN
	SELECT RAISE(ABORT, 'offline_sale_item_immutable');
END;--> statement-breakpoint

CREATE TRIGGER `offline_sale_items_no_delete`
BEFORE DELETE ON `offline_sale_items`
BEGIN
	SELECT RAISE(ABORT, 'offline_sale_item_immutable');
END;
