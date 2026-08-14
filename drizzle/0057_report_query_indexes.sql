-- P2 reporting access paths.  These are additive and safe to apply repeatedly.
-- The existing vendor/date indexes remain in place for tenant-scoped queries;
-- these composites cover the operational delivery/status predicates without
-- forcing a full orders scan as the report volume grows.
CREATE INDEX IF NOT EXISTS `orders_delivery_date_vendor_idx`
  ON `orders` (`delivery_method`,`created_at`,`vendor_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `orders_status_date_vendor_idx`
  ON `orders` (`order_status`,`created_at`,`vendor_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `tax_invoices_source_date_idx`
  ON `tax_invoices` (`source_type`,`issued_at`,`source_id`);
--> statement-breakpoint
-- Every governed inventory write (opening stock and purchase receipt included)
-- must leave an immutable effective-price snapshot.  Vendor pricing writes
-- their richer actor/reason row first; the NOT EXISTS guard avoids a duplicate
-- snapshot for that same effective day and value.
CREATE TRIGGER IF NOT EXISTS `pharmacy_inventory_price_history_insert`
AFTER INSERT ON `pharmacy_inventory`
WHEN NOT EXISTS (
  SELECT 1 FROM `inventory_price_history` history
  WHERE history.`inventory_id`=NEW.`id`
    AND history.`effective_from`=date(COALESCE(NEW.`created_at`,CURRENT_TIMESTAMP))
    AND history.`purchase_price_paise`=NEW.`purchase_price_paise`
    AND history.`sale_price_paise`=NEW.`sale_price_paise`
    AND history.`mrp_paise`=NEW.`mrp_paise`
    AND history.`gst_percent`=NEW.`gst_percent`
)
BEGIN
  INSERT INTO `inventory_price_history`
    (`inventory_id`,`vendor_id`,`product_id`,`purchase_price_paise`,`sale_price_paise`,`mrp_paise`,`gst_percent`,`effective_from`,`source`,`reason`)
  VALUES (NEW.`id`,NEW.`vendor_id`,NEW.`product_id`,NEW.`purchase_price_paise`,NEW.`sale_price_paise`,NEW.`mrp_paise`,NEW.`gst_percent`,date(COALESCE(NEW.`created_at`,CURRENT_TIMESTAMP)),'inventory','Automatic inventory price snapshot');
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `pharmacy_inventory_price_history_update`
AFTER UPDATE OF `purchase_price_paise`,`sale_price_paise`,`mrp_paise`,`gst_percent` ON `pharmacy_inventory`
WHEN (
  OLD.`purchase_price_paise`<>NEW.`purchase_price_paise`
  OR OLD.`sale_price_paise`<>NEW.`sale_price_paise`
  OR OLD.`mrp_paise`<>NEW.`mrp_paise`
  OR OLD.`gst_percent`<>NEW.`gst_percent`
)
  AND NOT EXISTS (
    SELECT 1 FROM `inventory_price_history` history
    WHERE history.`inventory_id`=NEW.`id`
      AND history.`effective_from`=date(CURRENT_TIMESTAMP)
      AND history.`purchase_price_paise`=NEW.`purchase_price_paise`
      AND history.`sale_price_paise`=NEW.`sale_price_paise`
      AND history.`mrp_paise`=NEW.`mrp_paise`
      AND history.`gst_percent`=NEW.`gst_percent`
)
BEGIN
  INSERT INTO `inventory_price_history`
    (`inventory_id`,`vendor_id`,`product_id`,`purchase_price_paise`,`sale_price_paise`,`mrp_paise`,`gst_percent`,`effective_from`,`source`,`reason`)
  VALUES (NEW.`id`,NEW.`vendor_id`,NEW.`product_id`,NEW.`purchase_price_paise`,NEW.`sale_price_paise`,NEW.`mrp_paise`,NEW.`gst_percent`,date(CURRENT_TIMESTAMP),'inventory','Automatic inventory repricing snapshot');
END;
