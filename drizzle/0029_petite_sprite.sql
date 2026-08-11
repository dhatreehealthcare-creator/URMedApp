CREATE TABLE `supplier_return_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`supplier_return_id` integer NOT NULL,
	`purchase_order_item_id` integer NOT NULL,
	`inventory_id` integer NOT NULL,
	`quantity` integer NOT NULL,
	`amount_paise` integer NOT NULL,
	`disposition` text DEFAULT 'returned_to_supplier' NOT NULL,
	FOREIGN KEY (`supplier_return_id`) REFERENCES `supplier_returns`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`purchase_order_item_id`) REFERENCES `purchase_order_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`inventory_id`) REFERENCES `pharmacy_inventory`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `supplier_return_items_return_idx` ON `supplier_return_items` (`supplier_return_id`);--> statement-breakpoint
CREATE TABLE `supplier_returns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`return_number` text NOT NULL,
	`vendor_id` integer NOT NULL,
	`supplier_id` integer NOT NULL,
	`purchase_order_id` integer NOT NULL,
	`debit_note_number` text NOT NULL,
	`reason` text NOT NULL,
	`total_paise` integer NOT NULL,
	`status` text DEFAULT 'completed' NOT NULL,
	`created_by_profile_id` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`purchase_order_id`) REFERENCES `purchase_orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_profile_id`) REFERENCES `account_profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `supplier_returns_number_uidx` ON `supplier_returns` (`return_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `supplier_returns_debit_note_uidx` ON `supplier_returns` (`debit_note_number`);--> statement-breakpoint
CREATE INDEX `supplier_returns_vendor_date_idx` ON `supplier_returns` (`vendor_id`,`created_at`);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `supplier_return_quantity_guard`
BEFORE INSERT ON `supplier_return_items`
WHEN NEW.quantity < 1
	OR NEW.inventory_id <> COALESCE((SELECT inventory_id FROM purchase_order_items WHERE id = NEW.purchase_order_item_id), -1)
	OR NEW.quantity > COALESCE((SELECT quantity FROM pharmacy_inventory WHERE id = NEW.inventory_id), 0)
	OR NEW.quantity > (
		COALESCE((SELECT quantity + free_quantity FROM purchase_order_items WHERE id = NEW.purchase_order_item_id), 0)
		- COALESCE((SELECT SUM(items.quantity) FROM supplier_return_items items JOIN supplier_returns ret ON ret.id = items.supplier_return_id WHERE items.purchase_order_item_id = NEW.purchase_order_item_id AND ret.status <> 'cancelled'), 0)
	)
BEGIN
	SELECT RAISE(ABORT, 'supplier_return_quantity_invalid');
END;
--> statement-breakpoint
INSERT INTO `account_profiles` (`auth_user_id`, `role`, `name`, `email`, `phone`, `email_verified`, `phone_verified`, `status`)
VALUES ('test:admin', 'admin', 'URMED Test Administrator', 'admin@urmed.test', '0000000003', 1, 1, 'active');
--> statement-breakpoint
INSERT INTO `account_profiles` (`auth_user_id`, `role`, `name`, `email`, `phone`, `email_verified`, `phone_verified`, `status`)
VALUES ('test:delivery', 'delivery', 'URMED Test Rider', 'delivery@urmed.test', '0000000004', 1, 1, 'active');
--> statement-breakpoint
INSERT INTO `test_accounts` (`profile_id`, `email`, `password_sha256`, `active`)
SELECT `id`, 'admin@urmed.test', '82653beae118d41e23e29c582a86f50675468ed1b588c284704a7a3491e32184', 1
FROM `account_profiles` WHERE `auth_user_id` = 'test:admin';
--> statement-breakpoint
INSERT INTO `test_accounts` (`profile_id`, `email`, `password_sha256`, `active`)
SELECT `id`, 'delivery@urmed.test', '82653beae118d41e23e29c582a86f50675468ed1b588c284704a7a3491e32184', 1
FROM `account_profiles` WHERE `auth_user_id` = 'test:delivery';
--> statement-breakpoint
INSERT INTO `delivery_agents` (`profile_id`, `vehicle_type`, `vehicle_number`, `licence_number`, `availability_status`, `current_latitude`, `current_longitude`)
SELECT `id`, 'bike', 'TS09-TEST-2026', 'TEST-DL-RIDER-2026', 'available', '17.4318', '78.4073'
FROM `account_profiles` WHERE `auth_user_id` = 'test:delivery';
