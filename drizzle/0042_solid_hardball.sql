CREATE TABLE `payment_refunds` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`vendor_id` integer NOT NULL,
	`customer_profile_id` integer NOT NULL,
	`sales_return_id` integer,
	`provider_payment_id` text NOT NULL,
	`provider_refund_id` text,
	`refund_receipt` text NOT NULL,
	`amount_paise` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`reason` text NOT NULL,
	`failure_reason` text DEFAULT '' NOT NULL,
	`requested_by_profile_id` integer NOT NULL,
	`initiated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`processed_at` text,
	`failed_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_profile_id`) REFERENCES `account_profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sales_return_id`) REFERENCES `sales_returns`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`requested_by_profile_id`) REFERENCES `account_profiles`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "payment_refunds_amount_check" CHECK("payment_refunds"."amount_paise" > 0),
	CONSTRAINT "payment_refunds_reason_check" CHECK(length(trim("payment_refunds"."reason")) >= 5)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_refunds_order_uidx` ON `payment_refunds` (`order_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `payment_refunds_receipt_uidx` ON `payment_refunds` (`refund_receipt`);--> statement-breakpoint
CREATE UNIQUE INDEX `payment_refunds_provider_uidx` ON `payment_refunds` (`provider_refund_id`);--> statement-breakpoint
CREATE INDEX `payment_refunds_customer_status_idx` ON `payment_refunds` (`customer_profile_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `payment_refunds_vendor_status_idx` ON `payment_refunds` (`vendor_id`,`status`,`updated_at`);--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS `payment_refunds_insert_guard`
BEFORE INSERT ON `payment_refunds`
BEGIN
  SELECT CASE
    WHEN NEW.status <> 'pending'
      OR NEW.provider_refund_id IS NOT NULL
      OR NEW.processed_at IS NOT NULL
      OR NEW.failed_at IS NOT NULL
      OR NOT EXISTS (
        SELECT 1 FROM orders current_order
        WHERE current_order.id = NEW.order_id
          AND current_order.vendor_id = NEW.vendor_id
          AND current_order.customer_profile_id = NEW.customer_profile_id
          AND current_order.payment_method = 'online'
          AND current_order.payment_status = 'paid'
          AND current_order.inventory_status = 'committed'
          AND current_order.razorpay_payment_id = NEW.provider_payment_id
          AND current_order.total_paise = NEW.amount_paise
      )
    THEN RAISE(ABORT, 'payment_refund_order_mismatch')
  END;
END;--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS `payment_refunds_update_guard`
BEFORE UPDATE ON `payment_refunds`
BEGIN
  SELECT CASE
    WHEN NEW.order_id <> OLD.order_id
      OR NEW.vendor_id <> OLD.vendor_id
      OR NEW.customer_profile_id <> OLD.customer_profile_id
      OR NEW.provider_payment_id <> OLD.provider_payment_id
      OR NEW.refund_receipt <> OLD.refund_receipt
      OR NEW.amount_paise <> OLD.amount_paise
      OR NEW.reason <> OLD.reason
      OR NEW.requested_by_profile_id <> OLD.requested_by_profile_id
      OR NEW.initiated_at <> OLD.initiated_at
      OR (OLD.provider_refund_id IS NOT NULL AND NEW.provider_refund_id <> OLD.provider_refund_id)
      OR (OLD.status = 'processed' AND NEW.status <> 'processed')
      OR NEW.status NOT IN ('pending', 'processed', 'failed')
      OR (NEW.status = 'processed' AND (NEW.provider_refund_id IS NULL OR NEW.processed_at IS NULL OR NEW.failure_reason <> ''))
      OR (NEW.status = 'failed' AND (length(trim(NEW.failure_reason)) = 0 OR NEW.failed_at IS NULL))
      OR (NEW.status = 'pending' AND (NEW.processed_at IS NOT NULL OR NEW.failed_at IS NOT NULL))
      OR (NEW.sales_return_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM sales_returns return_record
        WHERE return_record.id = NEW.sales_return_id
          AND return_record.vendor_id = NEW.vendor_id
          AND return_record.source_type = 'online'
          AND return_record.source_id = NEW.order_id
          AND return_record.refund_paise = NEW.amount_paise
      ))
    THEN RAISE(ABORT, 'payment_refund_invalid_transition')
  END;
END;--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS `payment_refunds_no_delete`
BEFORE DELETE ON `payment_refunds`
BEGIN
  SELECT RAISE(ABORT, 'payment_refund_delete_forbidden');
END;
