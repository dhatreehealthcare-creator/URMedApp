CREATE TABLE `account_profiles` (
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
CREATE UNIQUE INDEX `account_profiles_auth_user_uidx` ON `account_profiles` (`auth_user_id`);
--> statement-breakpoint
CREATE INDEX `account_profiles_role_idx` ON `account_profiles` (`role`);
--> statement-breakpoint
CREATE INDEX `account_profiles_email_idx` ON `account_profiles` (`email`);
--> statement-breakpoint
CREATE INDEX `account_profiles_phone_idx` ON `account_profiles` (`phone`);
--> statement-breakpoint
CREATE TABLE `vendors` (
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
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (`profile_id`) REFERENCES `account_profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vendors_profile_uidx` ON `vendors` (`profile_id`);
--> statement-breakpoint
CREATE INDEX `vendors_approval_idx` ON `vendors` (`approval_status`);
--> statement-breakpoint
CREATE TABLE `pharmacy_inventory` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `vendor_id` integer NOT NULL,
  `product_id` integer NOT NULL,
  `batch_number` text NOT NULL,
  `expiry_date` text,
  `manufacturing_date` text,
  `dosage` text DEFAULT '' NOT NULL,
  `purchase_price_paise` integer DEFAULT 0 NOT NULL,
  `sale_price_paise` integer NOT NULL,
  `quantity` integer DEFAULT 0 NOT NULL,
  `gst_percent` integer DEFAULT 0 NOT NULL,
  `reorder_level` integer DEFAULT 5 NOT NULL,
  `active` integer DEFAULT true NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pharmacy_inventory_batch_uidx` ON `pharmacy_inventory` (`vendor_id`,`product_id`,`batch_number`);
--> statement-breakpoint
CREATE INDEX `pharmacy_inventory_product_idx` ON `pharmacy_inventory` (`product_id`,`active`,`quantity`);
--> statement-breakpoint
CREATE INDEX `pharmacy_inventory_vendor_idx` ON `pharmacy_inventory` (`vendor_id`);
--> statement-breakpoint
CREATE TABLE `customer_addresses` (
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
CREATE TABLE `orders` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `order_number` text NOT NULL,
  `customer_profile_id` integer NOT NULL,
  `vendor_id` integer NOT NULL,
  `subtotal_paise` integer NOT NULL,
  `tax_paise` integer DEFAULT 0 NOT NULL,
  `delivery_fee_paise` integer DEFAULT 0 NOT NULL,
  `total_paise` integer NOT NULL,
  `payment_method` text NOT NULL,
  `payment_status` text DEFAULT 'pending' NOT NULL,
  `delivery_method` text NOT NULL,
  `order_status` text DEFAULT 'placed' NOT NULL,
  `delivery_status` text DEFAULT 'awaiting_confirmation' NOT NULL,
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
CREATE UNIQUE INDEX `orders_order_number_uidx` ON `orders` (`order_number`);
--> statement-breakpoint
CREATE INDEX `orders_customer_idx` ON `orders` (`customer_profile_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `orders_vendor_idx` ON `orders` (`vendor_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `orders_razorpay_idx` ON `orders` (`razorpay_order_id`);
--> statement-breakpoint
CREATE TABLE `order_items` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `order_id` integer NOT NULL,
  `inventory_id` integer NOT NULL,
  `product_id` integer NOT NULL,
  `product_name` text NOT NULL,
  `batch_number` text NOT NULL,
  `quantity` integer NOT NULL,
  `unit_price_paise` integer NOT NULL,
  `gst_percent` integer DEFAULT 0 NOT NULL,
  `line_total_paise` integer NOT NULL,
  FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`inventory_id`) REFERENCES `pharmacy_inventory`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `delivery_events` (
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
CREATE INDEX `delivery_events_order_idx` ON `delivery_events` (`order_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `payment_events` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `provider_event_id` text NOT NULL,
  `order_id` integer,
  `event_type` text NOT NULL,
  `payload_hash` text DEFAULT '' NOT NULL,
  `processed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_events_provider_event_uidx` ON `payment_events` (`provider_event_id`);
