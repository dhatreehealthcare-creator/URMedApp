-- P1-MULTISTORE-01: all legacy FEFO/stock guards must respect branch scope.
-- The pre-branch triggers were vendor-wide and would reject a valid primary
-- branch sale merely because another branch had an earlier-expiring batch.
DROP TRIGGER IF EXISTS order_items_validate_atomic_stock;
CREATE TRIGGER order_items_validate_atomic_stock
BEFORE INSERT ON order_items
WHEN NEW.quantity <= 0 OR NOT EXISTS (
  SELECT 1 FROM pharmacy_inventory chosen
  JOIN orders sale ON sale.id = NEW.order_id
  WHERE chosen.id = NEW.inventory_id
    AND chosen.vendor_id = sale.vendor_id
    AND chosen.branch_id = sale.branch_id
    AND chosen.product_id = NEW.product_id
    AND chosen.batch_number = NEW.batch_number
    AND chosen.active = 1
    AND chosen.quarantine_status = 'available'
    AND chosen.expiry_date IS NOT NULL
    AND date(chosen.expiry_date) >= date('now')
    AND (chosen.quantity - chosen.reserved_quantity) >= NEW.quantity
)
BEGIN SELECT RAISE(ABORT, 'stock_unavailable'); END;

DROP TRIGGER IF EXISTS order_items_validate_fefo;
CREATE TRIGGER order_items_validate_fefo
BEFORE INSERT ON order_items
WHEN EXISTS (
  SELECT 1
  FROM pharmacy_inventory chosen
  JOIN orders sale ON sale.id = NEW.order_id
  JOIN pharmacy_inventory earlier
    ON earlier.vendor_id = chosen.vendor_id
   AND earlier.branch_id = chosen.branch_id
   AND earlier.product_id = chosen.product_id
  WHERE chosen.id = NEW.inventory_id
    AND chosen.branch_id = sale.branch_id
    AND earlier.id <> chosen.id
    AND earlier.active = 1
    AND earlier.quarantine_status = 'available'
    AND earlier.expiry_date IS NOT NULL
    AND date(earlier.expiry_date) >= date('now')
    AND (earlier.quantity - earlier.reserved_quantity) > 0
    AND (date(earlier.expiry_date) < date(chosen.expiry_date)
      OR (date(earlier.expiry_date) = date(chosen.expiry_date) AND earlier.id < chosen.id))
)
BEGIN SELECT RAISE(ABORT, 'fefo_violation'); END;

DROP TRIGGER IF EXISTS offline_sale_stock_guard;
CREATE TRIGGER offline_sale_stock_guard
BEFORE INSERT ON offline_sale_items
WHEN NEW.quantity <= 0
  OR NEW.taxable_paise <> NEW.unit_price_paise * NEW.quantity - NEW.discount_paise
  OR NEW.tax_paise <> NEW.cgst_paise + NEW.sgst_paise + NEW.igst_paise
  OR NEW.line_total_paise <> NEW.taxable_paise + NEW.tax_paise
  OR NEW.tax_paise <> CAST((NEW.taxable_paise * NEW.gst_percent + 50) / 100 AS INTEGER)
  OR NOT EXISTS (
    SELECT 1 FROM offline_sales sale
    JOIN pharmacy_inventory inventory ON inventory.id = NEW.inventory_id
    JOIN products product ON product.id = inventory.product_id
    JOIN vendors vendor ON vendor.id = sale.vendor_id
    WHERE sale.id = NEW.offline_sale_id
      AND inventory.vendor_id = sale.vendor_id
      AND inventory.branch_id = sale.branch_id
      AND inventory.product_id = NEW.product_id
      AND inventory.batch_number = NEW.batch_number
      AND inventory.expiry_date = NEW.expiry_date
      AND inventory.sale_price_paise = NEW.unit_price_paise
      AND inventory.gst_percent = NEW.gst_percent
      AND inventory.mrp_paise = NEW.mrp_paise
      AND product.name = NEW.product_name
      AND product.hsn_code = NEW.hsn_code
      AND product.prescription_required = NEW.prescription_required
      AND product.drug_schedule = NEW.drug_schedule
      AND product.active = 1 AND product.governance_status = 'approved' AND product.drug_schedule <> 'UNCLASSIFIED'
      AND inventory.active = 1 AND inventory.quarantine_status = 'available'
      AND inventory.cold_chain_status IN ('not_applicable','within_range')
      AND date(inventory.expiry_date) >= date('now')
      AND inventory.quantity - inventory.reserved_quantity >= NEW.quantity
      AND vendor.registration_status = 'submitted'
      AND vendor.approval_status = 'approved' AND vendor.compliance_status = 'verified' AND vendor.suspended_at IS NULL
      AND EXISTS (SELECT 1 FROM vendor_licences current_licence
        WHERE current_licence.vendor_id = vendor.id
          AND current_licence.verification_status = 'verified' AND current_licence.suspended_at IS NULL
          AND date(current_licence.valid_from) <= date('now') AND date(current_licence.valid_until) >= date('now'))
      AND EXISTS (SELECT 1 FROM pharmacists current_pharmacist
        WHERE current_pharmacist.vendor_id = vendor.id
          AND current_pharmacist.verification_status = 'verified' AND current_pharmacist.active = 1
          AND (current_pharmacist.valid_from IS NULL OR date(current_pharmacist.valid_from) <= date('now'))
          AND (current_pharmacist.valid_until IS NULL OR date(current_pharmacist.valid_until) >= date('now')))
      AND (NEW.gst_percent = 0 OR (length(vendor.gst_number) = 15 AND substr(vendor.gst_number,1,2) GLOB '[0-9][0-9]'))
      AND ((substr(vendor.gst_number,1,2) = sale.place_of_supply_state_code
        AND NEW.igst_paise = 0 AND NEW.cgst_paise = CAST(NEW.tax_paise / 2 AS INTEGER)
        AND NEW.sgst_paise = NEW.tax_paise - CAST(NEW.tax_paise / 2 AS INTEGER))
        OR (substr(vendor.gst_number,1,2) <> sale.place_of_supply_state_code
        AND NEW.cgst_paise = 0 AND NEW.sgst_paise = 0 AND NEW.igst_paise = NEW.tax_paise)
        OR (NEW.gst_percent = 0 AND NEW.cgst_paise = 0 AND NEW.sgst_paise = 0 AND NEW.igst_paise = 0))
      AND inventory.id = (SELECT first.id FROM pharmacy_inventory first
        WHERE first.vendor_id = inventory.vendor_id AND first.branch_id = inventory.branch_id
          AND first.product_id = inventory.product_id AND first.active = 1
          AND first.quarantine_status = 'available'
          AND first.cold_chain_status IN ('not_applicable','within_range')
          AND date(first.expiry_date) >= date('now') AND first.quantity - first.reserved_quantity > 0
        ORDER BY date(first.expiry_date), first.id LIMIT 1)
  )
BEGIN SELECT RAISE(ABORT, 'offline_sale_stock_invalid'); END;
