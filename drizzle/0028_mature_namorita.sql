CREATE TABLE `test_accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`profile_id` integer NOT NULL,
	`email` text NOT NULL,
	`password_sha256` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `account_profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `test_accounts_profile_uidx` ON `test_accounts` (`profile_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `test_accounts_email_uidx` ON `test_accounts` (`email`);--> statement-breakpoint
CREATE TABLE `test_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`test_account_id` integer NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`test_account_id`) REFERENCES `test_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `test_sessions_token_uidx` ON `test_sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `test_sessions_account_expiry_idx` ON `test_sessions` (`test_account_id`,`expires_at`);
--> statement-breakpoint
INSERT INTO `account_profiles` (`auth_user_id`, `role`, `name`, `email`, `phone`, `email_verified`, `phone_verified`, `status`)
VALUES ('test:customer', 'customer', 'URMED Test Customer', 'customer@urmed.test', '0000000001', 1, 1, 'active');
--> statement-breakpoint
INSERT INTO `account_profiles` (`auth_user_id`, `role`, `name`, `email`, `phone`, `email_verified`, `phone_verified`, `status`)
VALUES ('test:vendor', 'vendor', 'URMED Test Pharmacist', 'vendor@urmed.test', '0000000002', 1, 1, 'active');
--> statement-breakpoint
INSERT INTO `test_accounts` (`profile_id`, `email`, `password_sha256`, `active`)
SELECT `id`, 'customer@urmed.test', '82653beae118d41e23e29c582a86f50675468ed1b588c284704a7a3491e32184', 1
FROM `account_profiles` WHERE `auth_user_id` = 'test:customer';
--> statement-breakpoint
INSERT INTO `test_accounts` (`profile_id`, `email`, `password_sha256`, `active`)
SELECT `id`, 'vendor@urmed.test', '82653beae118d41e23e29c582a86f50675468ed1b588c284704a7a3491e32184', 1
FROM `account_profiles` WHERE `auth_user_id` = 'test:vendor';
--> statement-breakpoint
INSERT INTO `vendors` (`profile_id`, `business_name`, `owner_name`, `phone`, `email`, `gst_number`, `licence_number`,
  `address`, `latitude`, `longitude`, `home_delivery`, `approval_status`, `compliance_status`, `delivery_radius_km`)
SELECT `id`, 'URMED Test Pharmacy', 'URMED Test Pharmacist', '0000000002', 'vendor@urmed.test',
  '36ABCDE1234F1Z5', 'TEST-DL-2026-001', 'Test location, Hyderabad, Telangana', '17.4318', '78.4073', 1, 'approved', 'verified', 10
FROM `account_profiles` WHERE `auth_user_id` = 'test:vendor';
--> statement-breakpoint
INSERT INTO `pharmacy_inventory` (`vendor_id`, `product_id`, `batch_number`, `expiry_date`, `manufacturing_date`,
  `dosage`, `purchase_price_paise`, `sale_price_paise`, `mrp_paise`, `quantity`, `reserved_quantity`, `gst_percent`,
  `reorder_level`, `quarantine_status`, `storage_location`, `active`)
SELECT v.`id`, COALESCE(
    (SELECT p.`id` FROM `products` p WHERE p.`normalized_name` LIKE '%dolo 650%' ORDER BY p.`id` LIMIT 1),
    (SELECT p.`id` FROM `products` p WHERE p.`active` = 1 ORDER BY p.`id` LIMIT 1)
  ), 'TEST-URMED-001', '2028-12-31', '2026-07-01', 'Test stock only', 2500, 3120, 3470, 100, 0, 5,
  10, 'available', 'TEST-RACK-A1', 1
FROM `vendors` v JOIN `account_profiles` profile ON profile.`id` = v.`profile_id`
WHERE profile.`auth_user_id` = 'test:vendor';
