ALTER TABLE `sales_returns` ADD COLUMN `discount_paise` integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `sales_returns` ADD COLUMN `tax_paise` integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `sales_returns` ADD COLUMN `delivery_fee_paise` integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `sales_returns` ADD COLUMN `refund_method` text NOT NULL DEFAULT 'credit';--> statement-breakpoint
ALTER TABLE `sales_returns` ADD COLUMN `refund_status` text NOT NULL DEFAULT 'recorded';--> statement-breakpoint
ALTER TABLE `sales_returns` ADD COLUMN `refund_reference` text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE `sales_returns` ADD COLUMN `provider_refund_id` text;--> statement-breakpoint
ALTER TABLE `sales_returns` ADD COLUMN `idempotency_key` text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE `sales_return_items` ADD COLUMN `source_item_id` integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `sales_return_items` ADD COLUMN `gross_paise` integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `sales_return_items` ADD COLUMN `discount_paise` integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `sales_return_items` ADD COLUMN `taxable_paise` integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `sales_return_items` ADD COLUMN `tax_paise` integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `sales_return_items` ADD COLUMN `cgst_paise` integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `sales_return_items` ADD COLUMN `sgst_paise` integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `sales_return_items` ADD COLUMN `igst_paise` integer NOT NULL DEFAULT 0;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `sales_returns_vendor_idempotency_uidx` ON `sales_returns` (`vendor_id`,`idempotency_key`) WHERE `idempotency_key` <> '';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `sales_returns_source_idx` ON `sales_returns` (`vendor_id`,`source_type`,`source_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `return_quarantine_holds` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `vendor_id` integer NOT NULL,
  `sales_return_item_id` integer NOT NULL,
  `inventory_id` integer NOT NULL,
  `quantity` integer NOT NULL,
  `condition` text NOT NULL,
  `status` text NOT NULL DEFAULT 'held',
  `reason` text NOT NULL,
  `created_by_profile_id` integer NOT NULL,
  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`),
  FOREIGN KEY (`sales_return_item_id`) REFERENCES `sales_return_items`(`id`),
  FOREIGN KEY (`inventory_id`) REFERENCES `pharmacy_inventory`(`id`),
  FOREIGN KEY (`created_by_profile_id`) REFERENCES `account_profiles`(`id`),
  CONSTRAINT `return_quarantine_holds_quantity_check` CHECK (`quantity` > 0),
  CONSTRAINT `return_quarantine_holds_condition_check` CHECK (`condition` IN ('damaged','expired')),
  CONSTRAINT `return_quarantine_holds_status_check` CHECK (`status` IN ('held','released','disposed'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `return_quarantine_holds_item_uidx` ON `return_quarantine_holds` (`sales_return_item_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `return_quarantine_holds_vendor_idx` ON `return_quarantine_holds` (`vendor_id`,`status`,`created_at`);--> statement-breakpoint
DROP TRIGGER IF EXISTS `sales_return_quantity_guard`;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `sales_return_quantity_guard`
BEFORE INSERT ON `sales_return_items`
WHEN NEW.quantity <= 0 OR NOT EXISTS (
  SELECT 1 FROM sales_returns current_return
  JOIN pharmacy_inventory inventory ON inventory.id = NEW.inventory_id
  WHERE current_return.id = NEW.sales_return_id
    AND current_return.status <> 'cancelled'
    AND (current_return.status = 'pending' OR (
      (current_return.source_type='online' AND EXISTS (SELECT 1 FROM orders sale WHERE sale.id=current_return.source_id AND sale.vendor_id=current_return.vendor_id AND sale.order_status='completed' AND sale.delivery_status='delivered' AND sale.payment_status='paid' AND sale.inventory_status='committed'))
      OR (current_return.source_type='offline' AND EXISTS (SELECT 1 FROM offline_sales sale JOIN offline_sale_events event ON event.offline_sale_id=sale.id AND event.event_type='completed' WHERE sale.id=current_return.source_id AND sale.vendor_id=current_return.vendor_id))
    ))
    AND inventory.vendor_id = current_return.vendor_id
    AND NEW.quantity <= (
      CASE current_return.source_type
        WHEN 'online' THEN COALESCE((SELECT SUM(item.quantity) FROM order_items item JOIN orders sale ON sale.id = item.order_id WHERE sale.id = current_return.source_id AND sale.vendor_id = current_return.vendor_id AND item.inventory_id = NEW.inventory_id), 0)
        WHEN 'offline' THEN COALESCE((SELECT SUM(item.quantity) FROM offline_sale_items item JOIN offline_sales sale ON sale.id = item.offline_sale_id WHERE sale.id = current_return.source_id AND sale.vendor_id = current_return.vendor_id AND item.inventory_id = NEW.inventory_id), 0)
        ELSE 0
      END
      - COALESCE((SELECT SUM(prior_item.quantity) FROM sales_return_items prior_item JOIN sales_returns prior_return ON prior_return.id = prior_item.sales_return_id WHERE prior_return.vendor_id = current_return.vendor_id AND prior_return.source_type = current_return.source_type AND prior_return.source_id = current_return.source_id AND prior_return.status <> 'cancelled' AND prior_item.inventory_id = NEW.inventory_id), 0)
    )
)
BEGIN SELECT RAISE(ABORT, 'sales_return_quantity_invalid'); END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `sales_returns_completed_immutable`
BEFORE UPDATE ON `sales_returns`
WHEN OLD.status='completed' AND (NEW.return_number<>OLD.return_number OR NEW.vendor_id<>OLD.vendor_id OR NEW.source_type<>OLD.source_type OR NEW.source_id<>OLD.source_id OR NEW.reason<>OLD.reason OR NEW.credit_note_number<>OLD.credit_note_number OR NEW.refund_paise<>OLD.refund_paise OR NEW.discount_paise<>OLD.discount_paise OR NEW.tax_paise<>OLD.tax_paise OR NEW.delivery_fee_paise<>OLD.delivery_fee_paise OR NEW.refund_method<>OLD.refund_method OR NEW.refund_reference<>OLD.refund_reference OR NEW.provider_refund_id IS NOT OLD.provider_refund_id)
BEGIN SELECT RAISE(ABORT, 'completed sales return is immutable'); END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `sales_returns_no_delete`
BEFORE DELETE ON `sales_returns`
BEGIN SELECT RAISE(ABORT, 'credit note evidence cannot be deleted'); END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `sales_return_items_immutable`
BEFORE UPDATE ON `sales_return_items`
WHEN EXISTS (SELECT 1 FROM sales_returns WHERE id=OLD.sales_return_id AND status='completed')
BEGIN SELECT RAISE(ABORT, 'completed credit note items are immutable'); END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `sales_return_items_no_delete`
BEFORE DELETE ON `sales_return_items`
WHEN EXISTS (SELECT 1 FROM sales_returns WHERE id=OLD.sales_return_id AND status='completed')
BEGIN SELECT RAISE(ABORT, 'completed credit note items cannot be deleted'); END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `return_quarantine_holds_no_delete`
BEFORE DELETE ON `return_quarantine_holds`
BEGIN SELECT RAISE(ABORT, 'return quarantine evidence cannot be deleted'); END;--> statement-breakpoint
PRAGMA optimize;
