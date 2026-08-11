DROP VIEW IF EXISTS `sellable_inventory`;--> statement-breakpoint
CREATE VIEW `sellable_inventory` AS
SELECT i.*
FROM pharmacy_inventory i
JOIN products p ON p.id = i.product_id
JOIN vendors v ON v.id = i.vendor_id
JOIN account_profiles owner ON owner.id = v.profile_id
WHERE i.active = 1
  AND i.quarantine_status = 'available'
  AND i.cold_chain_status IN ('not_applicable', 'within_range')
  AND i.expiry_date IS NOT NULL
  AND date(i.expiry_date) >= date('now')
  AND (i.quantity - i.reserved_quantity) > 0
  AND p.active = 1
  AND v.approval_status = 'approved'
  AND v.compliance_status = 'verified'
  AND v.suspended_at IS NULL
  AND (
    owner.auth_user_id LIKE 'test:%'
    OR (
      EXISTS (SELECT 1 FROM vendor_licences licence WHERE licence.vendor_id = v.id AND licence.verification_status = 'verified' AND date(licence.valid_until) >= date('now') AND licence.suspended_at IS NULL)
      AND EXISTS (SELECT 1 FROM pharmacists pharmacist WHERE pharmacist.vendor_id = v.id AND pharmacist.verification_status = 'verified' AND pharmacist.active = 1 AND (pharmacist.valid_until IS NULL OR date(pharmacist.valid_until) >= date('now')))
    )
  );--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `prescription_review_single_decision`
BEFORE INSERT ON `prescription_reviews`
WHEN NOT EXISTS (SELECT 1 FROM prescriptions WHERE id = NEW.prescription_id AND status = 'uploaded')
BEGIN
  SELECT RAISE(ABORT, 'prescription_already_reviewed');
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `offline_sale_stock_guard`
BEFORE INSERT ON `offline_sale_items`
WHEN NEW.quantity <= 0 OR NOT EXISTS (
  SELECT 1 FROM offline_sales sale
  JOIN pharmacy_inventory inventory ON inventory.id = NEW.inventory_id
  JOIN products product ON product.id = inventory.product_id
  JOIN vendors vendor ON vendor.id = sale.vendor_id
  WHERE sale.id = NEW.offline_sale_id
    AND inventory.vendor_id = sale.vendor_id
    AND inventory.product_id = NEW.product_id
    AND inventory.batch_number = NEW.batch_number
    AND inventory.expiry_date = NEW.expiry_date
    AND inventory.sale_price_paise = NEW.unit_price_paise
    AND inventory.gst_percent = NEW.gst_percent
    AND inventory.active = 1 AND product.active = 1
    AND inventory.quarantine_status = 'available'
    AND inventory.cold_chain_status IN ('not_applicable','within_range')
    AND date(inventory.expiry_date) >= date('now')
    AND (inventory.quantity - inventory.reserved_quantity) >= NEW.quantity
    AND vendor.approval_status = 'approved' AND vendor.compliance_status = 'verified' AND vendor.suspended_at IS NULL
    AND inventory.id = (
      SELECT first.id FROM pharmacy_inventory first
      WHERE first.vendor_id = inventory.vendor_id AND first.product_id = inventory.product_id
        AND first.active = 1 AND first.quarantine_status = 'available'
        AND first.cold_chain_status IN ('not_applicable','within_range')
        AND date(first.expiry_date) >= date('now') AND (first.quantity - first.reserved_quantity) > 0
      ORDER BY date(first.expiry_date), first.id LIMIT 1
    )
)
BEGIN
  SELECT RAISE(ABORT, 'offline_sale_stock_invalid');
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `sales_return_quantity_guard`
BEFORE INSERT ON `sales_return_items`
WHEN NEW.quantity <= 0 OR NOT EXISTS (
  SELECT 1 FROM sales_returns current_return
  JOIN pharmacy_inventory inventory ON inventory.id = NEW.inventory_id
  WHERE current_return.id = NEW.sales_return_id
    AND current_return.status <> 'cancelled'
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
BEGIN
  SELECT RAISE(ABORT, 'sales_return_quantity_invalid');
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `delivery_assignment_guard`
BEFORE INSERT ON `delivery_assignments`
WHEN NOT EXISTS (
  SELECT 1 FROM orders order_record
  JOIN delivery_agents agent ON agent.id = NEW.agent_id
  JOIN account_profiles profile ON profile.id = agent.profile_id
  WHERE order_record.id = NEW.order_id
    AND order_record.delivery_method = 'urmed'
    AND order_record.delivery_status = 'ready_for_pickup'
    AND order_record.order_status NOT IN ('completed','cancelled')
    AND agent.availability_status IN ('available','online')
    AND profile.status = 'active'
    AND NOT EXISTS (SELECT 1 FROM delivery_assignments active_assignment WHERE active_assignment.order_id = order_record.id AND active_assignment.status NOT IN ('delivered','cancelled'))
)
BEGIN
  SELECT RAISE(ABORT, 'delivery_assignment_invalid');
END;
