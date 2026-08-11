CREATE TABLE `refill_reminders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`customer_profile_id` integer NOT NULL,
	`source_order_id` integer NOT NULL,
	`source_order_item_id` integer NOT NULL,
	`vendor_id` integer NOT NULL,
	`product_id` integer NOT NULL,
	`medicine_name` text NOT NULL,
	`original_quantity` integer DEFAULT 1 NOT NULL,
	`days_supply` integer DEFAULT 30 NOT NULL,
	`due_date` text NOT NULL,
	`reminder_lead_days` integer DEFAULT 3 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`snoozed_until` text,
	`last_notified_at` text,
	`repeat_order_id` integer,
	`schedule_source` text DEFAULT 'estimated' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`customer_profile_id`) REFERENCES `account_profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_order_item_id`) REFERENCES `order_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`repeat_order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `refill_reminders_source_item_uidx` ON `refill_reminders` (`source_order_item_id`);--> statement-breakpoint
CREATE INDEX `refill_reminders_customer_due_idx` ON `refill_reminders` (`customer_profile_id`,`status`,`due_date`);--> statement-breakpoint
CREATE INDEX `refill_reminders_vendor_due_idx` ON `refill_reminders` (`vendor_id`,`status`,`due_date`);