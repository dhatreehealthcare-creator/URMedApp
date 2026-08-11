CREATE INDEX IF NOT EXISTS `pharmacy_inventory_fefo_idx`
ON `pharmacy_inventory` (`vendor_id`, `product_id`, `active`, `quarantine_status`, `expiry_date`, `id`);--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `order_items_validate_atomic_stock`
BEFORE INSERT ON `order_items`
WHEN NEW.quantity <= 0 OR NOT EXISTS (
  SELECT 1
  FROM pharmacy_inventory chosen
  JOIN orders sale ON sale.id = NEW.order_id
  WHERE chosen.id = NEW.inventory_id
    AND chosen.vendor_id = sale.vendor_id
    AND chosen.product_id = NEW.product_id
    AND chosen.batch_number = NEW.batch_number
    AND chosen.active = 1
    AND chosen.quarantine_status = 'available'
    AND chosen.expiry_date IS NOT NULL
    AND date(chosen.expiry_date) >= date('now')
    AND (chosen.quantity - chosen.reserved_quantity) >= NEW.quantity
)
BEGIN
  SELECT RAISE(ABORT, 'stock_unavailable');
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `order_items_validate_fefo`
BEFORE INSERT ON `order_items`
WHEN EXISTS (
  SELECT 1
  FROM pharmacy_inventory chosen
  JOIN pharmacy_inventory earlier
    ON earlier.vendor_id = chosen.vendor_id AND earlier.product_id = chosen.product_id
  WHERE chosen.id = NEW.inventory_id
    AND earlier.id <> chosen.id
    AND earlier.active = 1
    AND earlier.quarantine_status = 'available'
    AND earlier.expiry_date IS NOT NULL
    AND date(earlier.expiry_date) >= date('now')
    AND (earlier.quantity - earlier.reserved_quantity) > 0
    AND (date(earlier.expiry_date) < date(chosen.expiry_date)
      OR (date(earlier.expiry_date) = date(chosen.expiry_date) AND earlier.id < chosen.id))
)
BEGIN
  SELECT RAISE(ABORT, 'fefo_violation');
END;
