CREATE TABLE IF NOT EXISTS `account_profiles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`auth_user_id` text NOT NULL,
	`role` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`email` text DEFAULT '' NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`phone_verified` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `account_profiles_auth_user_uidx` ON `account_profiles` (`auth_user_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `account_profiles_role_idx` ON `account_profiles` (`role`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `account_profiles_email_idx` ON `account_profiles` (`email`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `account_profiles_phone_idx` ON `account_profiles` (`phone`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `audit_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`vendor_id` integer,
	`actor_profile_id` integer,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`before_json` text DEFAULT '' NOT NULL,
	`after_json` text DEFAULT '' NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`request_id` text DEFAULT '' NOT NULL,
	`previous_event_hash` text DEFAULT '' NOT NULL,
	`event_hash` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_profile_id`) REFERENCES `account_profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `audit_events_hash_uidx` ON `audit_events` (`event_hash`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `audit_events_entity_idx` ON `audit_events` (`entity_type`,`entity_id`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `audit_events_vendor_idx` ON `audit_events` (`vendor_id`,`created_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `backup_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`backup_type` text NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text,
	`status` text NOT NULL,
	`verification_status` text DEFAULT 'pending' NOT NULL,
	`restore_tested_at` text,
	`object_key` text DEFAULT '' NOT NULL,
	`checksum_sha256` text DEFAULT '' NOT NULL,
	`notes` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `backup_runs_started_idx` ON `backup_runs` (`started_at`,`status`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `breach_incidents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`incident_number` text NOT NULL,
	`detected_at` text NOT NULL,
	`description` text NOT NULL,
	`affected_record_types` text NOT NULL,
	`affected_count` integer DEFAULT 0 NOT NULL,
	`containment_action` text DEFAULT '' NOT NULL,
	`notification_status` text DEFAULT 'assessment_pending' NOT NULL,
	`closed_at` text,
	`created_by_profile_id` integer,
	FOREIGN KEY (`created_by_profile_id`) REFERENCES `account_profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `breach_incidents_number_uidx` ON `breach_incidents` (`incident_number`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `customer_addresses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`profile_id` integer NOT NULL,
	`label` text DEFAULT 'Home' NOT NULL,
	`address` text NOT NULL,
	`latitude` text DEFAULT '' NOT NULL,
	`longitude` text DEFAULT '' NOT NULL,
	`is_default` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `account_profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `data_consents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`profile_id` integer NOT NULL,
	`purpose` text NOT NULL,
	`policy_version` text NOT NULL,
	`consent_status` text NOT NULL,
	`captured_ip_hash` text DEFAULT '' NOT NULL,
	`granted_at` text,
	`withdrawn_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `account_profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `data_consents_profile_purpose_idx` ON `data_consents` (`profile_id`,`purpose`,`created_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `delivery_agents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`profile_id` integer NOT NULL,
	`vehicle_type` text DEFAULT 'bike' NOT NULL,
	`vehicle_number` text DEFAULT '' NOT NULL,
	`licence_number` text DEFAULT '' NOT NULL,
	`availability_status` text DEFAULT 'offline' NOT NULL,
	`current_latitude` text DEFAULT '' NOT NULL,
	`current_longitude` text DEFAULT '' NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `account_profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `delivery_agents_profile_uidx` ON `delivery_agents` (`profile_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `delivery_assignments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`agent_id` integer NOT NULL,
	`assigned_by_profile_id` integer,
	`assigned_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`accepted_at` text,
	`picked_up_at` text,
	`delivered_at` text,
	`status` text DEFAULT 'assigned' NOT NULL,
	`proof_document_id` integer,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `delivery_agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assigned_by_profile_id`) REFERENCES `account_profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`proof_document_id`) REFERENCES `stored_documents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `delivery_assignments_order_idx` ON `delivery_assignments` (`order_id`,`status`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `delivery_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`status` text NOT NULL,
	`actor_profile_id` integer,
	`note` text DEFAULT '' NOT NULL,
	`latitude` text DEFAULT '' NOT NULL,
	`longitude` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_profile_id`) REFERENCES `account_profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `delivery_events_order_idx` ON `delivery_events` (`order_id`,`created_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `expenses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`vendor_id` integer,
	`purpose` text NOT NULL,
	`expense_head` text NOT NULL,
	`amount_paise` integer NOT NULL,
	`expense_date` text NOT NULL,
	`payment_mode` text NOT NULL,
	`reference_number` text DEFAULT '' NOT NULL,
	`created_by_profile_id` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_profile_id`) REFERENCES `account_profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `expenses_vendor_date_idx` ON `expenses` (`vendor_id`,`expense_date`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `ledger_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`vendor_id` integer,
	`account_code` text NOT NULL,
	`entry_date` text NOT NULL,
	`description` text NOT NULL,
	`debit_paise` integer DEFAULT 0 NOT NULL,
	`credit_paise` integer DEFAULT 0 NOT NULL,
	`reference_type` text NOT NULL,
	`reference_id` integer,
	`created_by_profile_id` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_profile_id`) REFERENCES `account_profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ledger_entries_vendor_date_idx` ON `ledger_entries` (`vendor_id`,`entry_date`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`profile_id` integer,
	`vendor_id` integer,
	`notification_type` text NOT NULL,
	`severity` text DEFAULT 'info' NOT NULL,
	`title` text NOT NULL,
	`message` text NOT NULL,
	`reference_type` text DEFAULT '' NOT NULL,
	`reference_id` integer,
	`read_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `account_profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `notifications_vendor_read_idx` ON `notifications` (`vendor_id`,`read_at`,`created_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `offline_sale_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`offline_sale_id` integer NOT NULL,
	`inventory_id` integer NOT NULL,
	`product_id` integer NOT NULL,
	`batch_number` text NOT NULL,
	`expiry_date` text NOT NULL,
	`quantity` integer NOT NULL,
	`unit_price_paise` integer NOT NULL,
	`gst_percent` integer NOT NULL,
	`taxable_paise` integer NOT NULL,
	`tax_paise` integer NOT NULL,
	`line_total_paise` integer NOT NULL,
	FOREIGN KEY (`offline_sale_id`) REFERENCES `offline_sales`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`inventory_id`) REFERENCES `pharmacy_inventory`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `offline_sale_items_sale_idx` ON `offline_sale_items` (`offline_sale_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `offline_sales` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sale_number` text NOT NULL,
	`vendor_id` integer NOT NULL,
	`customer_name` text DEFAULT 'Walk-in customer' NOT NULL,
	`customer_phone` text DEFAULT '' NOT NULL,
	`prescription_id` integer,
	`subtotal_paise` integer NOT NULL,
	`tax_paise` integer NOT NULL,
	`discount_paise` integer DEFAULT 0 NOT NULL,
	`total_paise` integer NOT NULL,
	`payment_mode` text NOT NULL,
	`created_by_profile_id` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`prescription_id`) REFERENCES `prescriptions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_profile_id`) REFERENCES `account_profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `offline_sales_number_uidx` ON `offline_sales` (`sale_number`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `offline_sales_vendor_date_idx` ON `offline_sales` (`vendor_id`,`created_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `order_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`inventory_id` integer NOT NULL,
	`product_id` integer NOT NULL,
	`product_name` text NOT NULL,
	`batch_number` text NOT NULL,
	`quantity` integer NOT NULL,
	`unit_price_paise` integer NOT NULL,
	`gst_percent` integer DEFAULT 0 NOT NULL,
	`hsn_code` text DEFAULT '' NOT NULL,
	`expiry_date` text,
	`taxable_paise` integer DEFAULT 0 NOT NULL,
	`cgst_paise` integer DEFAULT 0 NOT NULL,
	`sgst_paise` integer DEFAULT 0 NOT NULL,
	`igst_paise` integer DEFAULT 0 NOT NULL,
	`discount_paise` integer DEFAULT 0 NOT NULL,
	`line_total_paise` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`inventory_id`) REFERENCES `pharmacy_inventory`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `orders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_number` text NOT NULL,
	`customer_profile_id` integer NOT NULL,
	`vendor_id` integer NOT NULL,
	`prescription_id` integer,
	`invoice_id` integer,
	`order_type` text DEFAULT 'online' NOT NULL,
	`subtotal_paise` integer NOT NULL,
	`tax_paise` integer DEFAULT 0 NOT NULL,
	`delivery_fee_paise` integer DEFAULT 0 NOT NULL,
	`total_paise` integer NOT NULL,
	`payment_method` text NOT NULL,
	`payment_status` text DEFAULT 'pending' NOT NULL,
	`delivery_method` text NOT NULL,
	`order_status` text DEFAULT 'placed' NOT NULL,
	`delivery_status` text DEFAULT 'awaiting_confirmation' NOT NULL,
	`prescription_status` text DEFAULT 'not_required' NOT NULL,
	`place_of_supply_state_code` text DEFAULT '36' NOT NULL,
	`customer_name` text NOT NULL,
	`customer_phone` text DEFAULT '' NOT NULL,
	`delivery_address` text DEFAULT '' NOT NULL,
	`latitude` text DEFAULT '' NOT NULL,
	`longitude` text DEFAULT '' NOT NULL,
	`razorpay_order_id` text DEFAULT '' NOT NULL,
	`razorpay_payment_id` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`customer_profile_id`) REFERENCES `account_profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `orders_order_number_uidx` ON `orders` (`order_number`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `orders_customer_idx` ON `orders` (`customer_profile_id`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `orders_vendor_idx` ON `orders` (`vendor_id`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `orders_razorpay_idx` ON `orders` (`razorpay_order_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `payment_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider_event_id` text NOT NULL,
	`order_id` integer,
	`event_type` text NOT NULL,
	`payload_hash` text DEFAULT '' NOT NULL,
	`processed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `payment_events_provider_event_uidx` ON `payment_events` (`provider_event_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `pharmacists` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`vendor_id` integer NOT NULL,
	`profile_id` integer,
	`full_name` text NOT NULL,
	`council_name` text NOT NULL,
	`registration_number` text NOT NULL,
	`valid_from` text,
	`valid_until` text,
	`document_id` integer,
	`verification_status` text DEFAULT 'pending' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`profile_id`) REFERENCES `account_profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`document_id`) REFERENCES `stored_documents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `pharmacists_vendor_registration_uidx` ON `pharmacists` (`vendor_id`,`registration_number`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `pharmacists_vendor_status_idx` ON `pharmacists` (`vendor_id`,`verification_status`,`active`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `pharmacy_inventory` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`vendor_id` integer NOT NULL,
	`product_id` integer NOT NULL,
	`batch_number` text NOT NULL,
	`expiry_date` text,
	`manufacturing_date` text,
	`dosage` text DEFAULT '' NOT NULL,
	`purchase_price_paise` integer DEFAULT 0 NOT NULL,
	`sale_price_paise` integer NOT NULL,
	`mrp_paise` integer DEFAULT 0 NOT NULL,
	`quantity` integer DEFAULT 0 NOT NULL,
	`reserved_quantity` integer DEFAULT 0 NOT NULL,
	`gst_percent` integer DEFAULT 0 NOT NULL,
	`reorder_level` integer DEFAULT 5 NOT NULL,
	`quarantine_status` text DEFAULT 'available' NOT NULL,
	`storage_location` text DEFAULT '' NOT NULL,
	`cold_chain_status` text DEFAULT 'not_applicable' NOT NULL,
	`last_counted_at` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `pharmacy_inventory_batch_uidx` ON `pharmacy_inventory` (`vendor_id`,`product_id`,`batch_number`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `pharmacy_inventory_product_idx` ON `pharmacy_inventory` (`product_id`,`active`,`quantity`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `pharmacy_inventory_vendor_idx` ON `pharmacy_inventory` (`vendor_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `pill_reminders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`customer_profile_id` integer NOT NULL,
	`product_id` integer,
	`medicine_name` text NOT NULL,
	`dosage_instructions` text DEFAULT '' NOT NULL,
	`reminder_time` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text,
	`recurrence_rule` text DEFAULT 'daily' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`customer_profile_id`) REFERENCES `account_profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `pill_reminders_customer_idx` ON `pill_reminders` (`customer_profile_id`,`active`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `prescription_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`prescription_id` integer NOT NULL,
	`product_id` integer,
	`medicine_text` text NOT NULL,
	`dosage_text` text DEFAULT '' NOT NULL,
	`duration_text` text DEFAULT '' NOT NULL,
	`quantity_approved` integer,
	FOREIGN KEY (`prescription_id`) REFERENCES `prescriptions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `prescription_items_prescription_idx` ON `prescription_items` (`prescription_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `prescription_reviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`prescription_id` integer NOT NULL,
	`pharmacist_id` integer NOT NULL,
	`decision` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`reviewed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`prescription_id`) REFERENCES `prescriptions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`pharmacist_id`) REFERENCES `pharmacists`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `prescription_reviews_prescription_idx` ON `prescription_reviews` (`prescription_id`,`reviewed_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `prescriptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`prescription_number` text NOT NULL,
	`customer_profile_id` integer NOT NULL,
	`vendor_id` integer,
	`document_id` integer NOT NULL,
	`patient_name` text NOT NULL,
	`patient_address` text DEFAULT '' NOT NULL,
	`prescriber_name` text DEFAULT '' NOT NULL,
	`prescriber_address` text DEFAULT '' NOT NULL,
	`prescribed_on` text,
	`serial_number` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'uploaded' NOT NULL,
	`rejection_reason` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`reviewed_at` text,
	FOREIGN KEY (`customer_profile_id`) REFERENCES `account_profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`document_id`) REFERENCES `stored_documents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `prescriptions_number_uidx` ON `prescriptions` (`prescription_number`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `prescriptions_vendor_status_idx` ON `prescriptions` (`vendor_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `prescriptions_customer_idx` ON `prescriptions` (`customer_profile_id`,`created_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `product_alternates` (
	`product_id` integer NOT NULL,
	`alternate_product_id` integer NOT NULL,
	`created_by_profile_id` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`alternate_product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_profile_id`) REFERENCES `account_profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `product_alternates_pair_uidx` ON `product_alternates` (`product_id`,`alternate_product_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `product_ceiling_prices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`product_id` integer NOT NULL,
	`notification_number` text NOT NULL,
	`ceiling_price_paise` integer NOT NULL,
	`effective_from` text NOT NULL,
	`effective_until` text,
	`source_url` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `product_ceiling_prices_product_idx` ON `product_ceiling_prices` (`product_id`,`effective_from`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `purchase_order_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`purchase_order_id` integer NOT NULL,
	`product_id` integer NOT NULL,
	`inventory_id` integer,
	`batch_number` text NOT NULL,
	`expiry_date` text NOT NULL,
	`manufacturing_date` text,
	`dosage` text DEFAULT '' NOT NULL,
	`quantity` integer NOT NULL,
	`free_quantity` integer DEFAULT 0 NOT NULL,
	`purchase_price_paise` integer NOT NULL,
	`sale_price_paise` integer NOT NULL,
	`mrp_paise` integer DEFAULT 0 NOT NULL,
	`gst_percent` integer NOT NULL,
	`taxable_paise` integer NOT NULL,
	`tax_paise` integer NOT NULL,
	`line_total_paise` integer NOT NULL,
	FOREIGN KEY (`purchase_order_id`) REFERENCES `purchase_orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`inventory_id`) REFERENCES `pharmacy_inventory`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `purchase_order_items_purchase_idx` ON `purchase_order_items` (`purchase_order_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `purchase_orders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`purchase_number` text NOT NULL,
	`vendor_id` integer NOT NULL,
	`supplier_id` integer NOT NULL,
	`invoice_number` text NOT NULL,
	`invoice_date` text NOT NULL,
	`subtotal_paise` integer DEFAULT 0 NOT NULL,
	`tax_paise` integer DEFAULT 0 NOT NULL,
	`total_paise` integer DEFAULT 0 NOT NULL,
	`payment_status` text DEFAULT 'unpaid' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_by_profile_id` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`posted_at` text,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_profile_id`) REFERENCES `account_profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `purchase_orders_number_uidx` ON `purchase_orders` (`purchase_number`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `purchase_orders_vendor_invoice_uidx` ON `purchase_orders` (`vendor_id`,`supplier_id`,`invoice_number`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `purchase_orders_vendor_date_idx` ON `purchase_orders` (`vendor_id`,`invoice_date`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `retention_policies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`record_type` text NOT NULL,
	`retention_months` integer NOT NULL,
	`legal_basis` text NOT NULL,
	`disposal_method` text NOT NULL,
	`active_from` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `retention_policies_record_uidx` ON `retention_policies` (`record_type`,`active_from`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `sales_return_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sales_return_id` integer NOT NULL,
	`inventory_id` integer NOT NULL,
	`quantity` integer NOT NULL,
	`condition` text NOT NULL,
	`disposition` text NOT NULL,
	`amount_paise` integer NOT NULL,
	FOREIGN KEY (`sales_return_id`) REFERENCES `sales_returns`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`inventory_id`) REFERENCES `pharmacy_inventory`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `sales_returns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`return_number` text NOT NULL,
	`vendor_id` integer NOT NULL,
	`source_type` text NOT NULL,
	`source_id` integer NOT NULL,
	`reason` text NOT NULL,
	`credit_note_number` text NOT NULL,
	`refund_paise` integer NOT NULL,
	`status` text DEFAULT 'completed' NOT NULL,
	`created_by_profile_id` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_profile_id`) REFERENCES `account_profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `sales_returns_number_uidx` ON `sales_returns` (`return_number`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `statutory_register_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`vendor_id` integer NOT NULL,
	`register_type` text NOT NULL,
	`serial_number` text NOT NULL,
	`transaction_date` text NOT NULL,
	`patient_name` text NOT NULL,
	`patient_address` text NOT NULL,
	`prescriber_name` text NOT NULL,
	`prescriber_address` text NOT NULL,
	`product_id` integer NOT NULL,
	`batch_number` text NOT NULL,
	`quantity_supplied` integer NOT NULL,
	`source_type` text NOT NULL,
	`source_id` integer NOT NULL,
	`pharmacist_id` integer NOT NULL,
	`retention_until` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`pharmacist_id`) REFERENCES `pharmacists`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `statutory_register_vendor_serial_uidx` ON `statutory_register_entries` (`vendor_id`,`register_type`,`serial_number`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `statutory_register_date_idx` ON `statutory_register_entries` (`vendor_id`,`register_type`,`transaction_date`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `stock_ledger` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`vendor_id` integer NOT NULL,
	`inventory_id` integer NOT NULL,
	`movement_type` text NOT NULL,
	`quantity_delta` integer NOT NULL,
	`balance_after` integer NOT NULL,
	`reference_type` text NOT NULL,
	`reference_id` integer,
	`reason` text DEFAULT '' NOT NULL,
	`actor_profile_id` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`inventory_id`) REFERENCES `pharmacy_inventory`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_profile_id`) REFERENCES `account_profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `stock_ledger_inventory_idx` ON `stock_ledger` (`inventory_id`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `stock_ledger_vendor_idx` ON `stock_ledger` (`vendor_id`,`created_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `stored_documents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_profile_id` integer,
	`vendor_id` integer,
	`purpose` text NOT NULL,
	`object_key` text NOT NULL,
	`original_filename` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`malware_status` text DEFAULT 'pending' NOT NULL,
	`retention_until` text,
	`status` text DEFAULT 'active' NOT NULL,
	`uploaded_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`owner_profile_id`) REFERENCES `account_profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `stored_documents_object_uidx` ON `stored_documents` (`object_key`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `stored_documents_vendor_idx` ON `stored_documents` (`vendor_id`,`purpose`,`status`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `suppliers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`vendor_id` integer NOT NULL,
	`business_name` text NOT NULL,
	`contact_name` text NOT NULL,
	`phone` text NOT NULL,
	`email` text DEFAULT '' NOT NULL,
	`address` text DEFAULT '' NOT NULL,
	`gst_number` text DEFAULT '' NOT NULL,
	`drug_licence_number` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `suppliers_vendor_business_uidx` ON `suppliers` (`vendor_id`,`business_name`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `suppliers_vendor_status_idx` ON `suppliers` (`vendor_id`,`status`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `tax_invoices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`invoice_number` text NOT NULL,
	`vendor_id` integer NOT NULL,
	`source_type` text NOT NULL,
	`source_id` integer NOT NULL,
	`seller_gstin` text NOT NULL,
	`buyer_gstin` text DEFAULT '' NOT NULL,
	`place_of_supply_state_code` text NOT NULL,
	`subtotal_paise` integer NOT NULL,
	`cgst_paise` integer DEFAULT 0 NOT NULL,
	`sgst_paise` integer DEFAULT 0 NOT NULL,
	`igst_paise` integer DEFAULT 0 NOT NULL,
	`total_paise` integer NOT NULL,
	`irn` text DEFAULT '' NOT NULL,
	`qr_code_payload` text DEFAULT '' NOT NULL,
	`issued_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `tax_invoices_number_uidx` ON `tax_invoices` (`invoice_number`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `tax_invoices_vendor_date_idx` ON `tax_invoices` (`vendor_id`,`issued_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `temperature_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`vendor_id` integer NOT NULL,
	`storage_location` text NOT NULL,
	`inventory_id` integer,
	`temperature_celsius_x10` integer NOT NULL,
	`within_range` integer NOT NULL,
	`excursion_action` text DEFAULT '' NOT NULL,
	`recorded_by_profile_id` integer,
	`recorded_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`inventory_id`) REFERENCES `pharmacy_inventory`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recorded_by_profile_id`) REFERENCES `account_profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `temperature_logs_vendor_date_idx` ON `temperature_logs` (`vendor_id`,`recorded_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `vendor_bank_accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`vendor_id` integer NOT NULL,
	`bank_name` text NOT NULL,
	`account_name` text NOT NULL,
	`account_number_encrypted` text NOT NULL,
	`account_last4` text DEFAULT '' NOT NULL,
	`ifsc_code` text NOT NULL,
	`verification_status` text DEFAULT 'pending' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `vendor_bank_accounts_vendor_idx` ON `vendor_bank_accounts` (`vendor_id`,`active`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `vendor_licences` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`vendor_id` integer NOT NULL,
	`licence_number` text NOT NULL,
	`form_type` text NOT NULL,
	`licence_category` text DEFAULT 'retail' NOT NULL,
	`issuing_authority` text NOT NULL,
	`issued_on` text,
	`valid_from` text NOT NULL,
	`valid_until` text NOT NULL,
	`document_id` integer,
	`verification_status` text DEFAULT 'pending' NOT NULL,
	`suspended_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`document_id`) REFERENCES `stored_documents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `vendor_licences_vendor_number_uidx` ON `vendor_licences` (`vendor_id`,`licence_number`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `vendor_licences_expiry_idx` ON `vendor_licences` (`valid_until`,`verification_status`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `vendor_staff` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`vendor_id` integer NOT NULL,
	`profile_id` integer NOT NULL,
	`staff_role` text NOT NULL,
	`permissions_json` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`invited_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`joined_at` text,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`profile_id`) REFERENCES `account_profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `vendor_staff_vendor_profile_uidx` ON `vendor_staff` (`vendor_id`,`profile_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `vendor_staff_role_idx` ON `vendor_staff` (`vendor_id`,`staff_role`,`status`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `vendors` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`profile_id` integer,
	`business_name` text NOT NULL,
	`owner_name` text NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`landline` text DEFAULT '' NOT NULL,
	`email` text DEFAULT '' NOT NULL,
	`gst_number` text DEFAULT '' NOT NULL,
	`licence_number` text DEFAULT '' NOT NULL,
	`address` text DEFAULT '' NOT NULL,
	`latitude` text DEFAULT '' NOT NULL,
	`longitude` text DEFAULT '' NOT NULL,
	`home_delivery` integer DEFAULT false NOT NULL,
	`approval_status` text DEFAULT 'testing' NOT NULL,
	`compliance_status` text DEFAULT 'pending' NOT NULL,
	`suspended_at` text,
	`suspension_reason` text DEFAULT '' NOT NULL,
	`delivery_radius_km` integer DEFAULT 5 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `account_profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `vendors_profile_uidx` ON `vendors` (`profile_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `vendors_approval_idx` ON `vendors` (`approval_status`);--> statement-breakpoint
ALTER TABLE `products` ADD `generic_name` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `products` ADD `trade_name` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `products` ADD `product_information` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `products` ADD `drug_schedule` text DEFAULT 'UNCLASSIFIED' NOT NULL;--> statement-breakpoint
ALTER TABLE `products` ADD `cold_chain_required` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `products` ADD `nppa_ceiling_paise` integer;--> statement-breakpoint
ALTER TABLE `products` ADD `active` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `products` ADD `updated_at` text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE `products` SET `updated_at` = `migrated_at` WHERE `updated_at` = '';--> statement-breakpoint
ALTER TABLE `vendors` ADD `compliance_status` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `vendors` ADD `suspended_at` text;--> statement-breakpoint
ALTER TABLE `vendors` ADD `suspension_reason` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `vendors` ADD `delivery_radius_km` integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE `pharmacy_inventory` ADD `mrp_paise` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `pharmacy_inventory` ADD `reserved_quantity` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `pharmacy_inventory` ADD `quarantine_status` text DEFAULT 'available' NOT NULL;--> statement-breakpoint
ALTER TABLE `pharmacy_inventory` ADD `storage_location` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `pharmacy_inventory` ADD `cold_chain_status` text DEFAULT 'not_applicable' NOT NULL;--> statement-breakpoint
ALTER TABLE `pharmacy_inventory` ADD `last_counted_at` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `prescription_id` integer;--> statement-breakpoint
ALTER TABLE `orders` ADD `invoice_id` integer;--> statement-breakpoint
ALTER TABLE `orders` ADD `order_type` text DEFAULT 'online' NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `prescription_status` text DEFAULT 'not_required' NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `place_of_supply_state_code` text DEFAULT '36' NOT NULL;--> statement-breakpoint
ALTER TABLE `order_items` ADD `hsn_code` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `order_items` ADD `expiry_date` text;--> statement-breakpoint
ALTER TABLE `order_items` ADD `taxable_paise` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `order_items` ADD `cgst_paise` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `order_items` ADD `sgst_paise` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `order_items` ADD `igst_paise` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `order_items` ADD `discount_paise` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE VIEW IF NOT EXISTS `sellable_inventory` AS
SELECT i.*
FROM pharmacy_inventory i
JOIN products p ON p.id = i.product_id
JOIN vendors v ON v.id = i.vendor_id
WHERE i.active = 1
  AND i.quarantine_status = 'available'
  AND i.cold_chain_status IN ('not_applicable', 'within_range')
  AND (i.expiry_date IS NULL OR date(i.expiry_date) >= date('now'))
  AND (i.quantity - i.reserved_quantity) > 0
  AND p.active = 1
  AND v.compliance_status = 'approved'
  AND v.suspended_at IS NULL;--> statement-breakpoint
CREATE VIEW IF NOT EXISTS `inventory_alerts` AS
SELECT i.id AS inventory_id, i.vendor_id, i.product_id, p.name AS product_name,
  i.batch_number, i.expiry_date, i.quantity, i.reserved_quantity, i.reorder_level,
  CASE
    WHEN i.expiry_date IS NOT NULL AND date(i.expiry_date) < date('now') THEN 'expired'
    WHEN i.expiry_date IS NOT NULL AND date(i.expiry_date) <= date('now', '+90 day') THEN 'near_expiry'
    WHEN (i.quantity - i.reserved_quantity) <= 0 THEN 'zero_stock'
    WHEN (i.quantity - i.reserved_quantity) <= i.reorder_level THEN 'low_stock'
  END AS alert_type
FROM pharmacy_inventory i
JOIN products p ON p.id = i.product_id
WHERE i.active = 1
  AND (
    (i.expiry_date IS NOT NULL AND date(i.expiry_date) <= date('now', '+90 day'))
    OR (i.quantity - i.reserved_quantity) <= i.reorder_level
  );--> statement-breakpoint
CREATE VIEW IF NOT EXISTS `vendor_compliance_summary` AS
SELECT v.id AS vendor_id,
  CASE WHEN EXISTS (
    SELECT 1 FROM vendor_licences l
    WHERE l.vendor_id = v.id AND l.verification_status = 'verified'
      AND date(l.valid_until) >= date('now') AND l.suspended_at IS NULL
  ) THEN 1 ELSE 0 END AS has_valid_licence,
  CASE WHEN EXISTS (
    SELECT 1 FROM pharmacists p
    WHERE p.vendor_id = v.id AND p.verification_status = 'verified'
      AND p.active = 1 AND (p.valid_until IS NULL OR date(p.valid_until) >= date('now'))
  ) THEN 1 ELSE 0 END AS has_verified_pharmacist,
  v.compliance_status, v.suspended_at
FROM vendors v;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `audit_events_no_update`
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'Audit events are append-only');
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `audit_events_no_delete`
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'Audit events are append-only');
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `stock_ledger_no_update`
BEFORE UPDATE ON stock_ledger
BEGIN
  SELECT RAISE(ABORT, 'Stock ledger entries are append-only');
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `stock_ledger_no_delete`
BEFORE DELETE ON stock_ledger
BEGIN
  SELECT RAISE(ABORT, 'Stock ledger entries are append-only');
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `statutory_register_no_update`
BEFORE UPDATE ON statutory_register_entries
BEGIN
  SELECT RAISE(ABORT, 'Statutory register entries are append-only');
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `statutory_register_no_delete`
BEFORE DELETE ON statutory_register_entries
BEGIN
  SELECT RAISE(ABORT, 'Statutory register entries are append-only');
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `quarantine_expired_inventory_insert`
AFTER INSERT ON pharmacy_inventory
WHEN NEW.expiry_date IS NOT NULL AND date(NEW.expiry_date) < date('now')
BEGIN
  UPDATE pharmacy_inventory SET quarantine_status = 'expired', active = 0 WHERE id = NEW.id;
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `quarantine_expired_inventory_update`
AFTER UPDATE OF expiry_date ON pharmacy_inventory
WHEN NEW.expiry_date IS NOT NULL AND date(NEW.expiry_date) < date('now')
BEGIN
  UPDATE pharmacy_inventory SET quarantine_status = 'expired', active = 0 WHERE id = NEW.id;
END;
