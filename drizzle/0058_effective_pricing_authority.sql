-- Canonical effective-dated pricing and conversion-period guards.
-- Existing rows remain valid; future versions are rejected only when periods overlap.
DROP INDEX IF EXISTS `product_pack_conversions_product_uom_uidx`;
CREATE INDEX IF NOT EXISTS `product_pack_conversions_product_uom_effective_idx`
  ON `product_pack_conversions` (`product_id`,`presentation_uom`,`effective_from`);

-- Closing the prior version is the one governed metadata mutation permitted;
-- financial price fields and identity fields remain immutable.
DROP TRIGGER IF EXISTS `inventory_price_history_no_update`;
CREATE TRIGGER IF NOT EXISTS `inventory_price_history_no_update`
BEFORE UPDATE ON `inventory_price_history`
WHEN NOT (
  OLD.`effective_until` IS NULL
  AND NEW.`effective_until` IS NOT NULL
  AND NEW.`inventory_id`=OLD.`inventory_id`
  AND NEW.`vendor_id`=OLD.`vendor_id`
  AND NEW.`product_id`=OLD.`product_id`
  AND NEW.`purchase_price_paise`=OLD.`purchase_price_paise`
  AND NEW.`sale_price_paise`=OLD.`sale_price_paise`
  AND NEW.`mrp_paise`=OLD.`mrp_paise`
  AND NEW.`gst_percent`=OLD.`gst_percent`
  AND NEW.`effective_from`=OLD.`effective_from`
)
BEGIN SELECT RAISE(ABORT,'inventory price history is immutable'); END;

CREATE TRIGGER IF NOT EXISTS `inventory_price_history_no_overlap_insert`
BEFORE INSERT ON `inventory_price_history`
WHEN EXISTS (
  SELECT 1 FROM `inventory_price_history` existing
  WHERE existing.`inventory_id`=NEW.`inventory_id`
    AND date(existing.`effective_from`)<>date(NEW.`effective_from`)
    AND date(NEW.`effective_from`) < date(COALESCE(existing.`effective_until`,'9999-12-31'))
    AND date(existing.`effective_from`) < date(COALESCE(NEW.`effective_until`,'9999-12-31'))
)
BEGIN SELECT RAISE(ABORT,'overlapping effective price period'); END;

CREATE TRIGGER IF NOT EXISTS `inventory_price_history_no_overlap_update`
BEFORE UPDATE OF `inventory_id`,`effective_from`,`effective_until` ON `inventory_price_history`
WHEN EXISTS (
  SELECT 1 FROM `inventory_price_history` existing
  WHERE existing.`inventory_id`=NEW.`inventory_id` AND existing.`id`<>NEW.`id`
    AND date(existing.`effective_from`)<>date(NEW.`effective_from`)
    AND date(NEW.`effective_from`) < date(COALESCE(existing.`effective_until`,'9999-12-31'))
    AND date(existing.`effective_from`) < date(COALESCE(NEW.`effective_until`,'9999-12-31'))
)
BEGIN SELECT RAISE(ABORT,'overlapping effective price period'); END;

CREATE TRIGGER IF NOT EXISTS `product_pack_conversions_no_overlap_insert`
BEFORE INSERT ON `product_pack_conversions`
WHEN EXISTS (
  SELECT 1 FROM `product_pack_conversions` existing
  WHERE existing.`product_id`=NEW.`product_id` AND lower(existing.`presentation_uom`)=lower(NEW.`presentation_uom`)
    AND existing.`governance_status` IN ('pending','approved')
    AND date(NEW.`effective_from`) < date(COALESCE(existing.`effective_until`,'9999-12-31'))
    AND date(existing.`effective_from`) < date(COALESCE(NEW.`effective_until`,'9999-12-31'))
)
BEGIN SELECT RAISE(ABORT,'overlapping effective conversion period'); END;

CREATE TRIGGER IF NOT EXISTS `product_pack_conversions_no_overlap_update`
BEFORE UPDATE OF `product_id`,`presentation_uom`,`effective_from`,`effective_until`,`governance_status` ON `product_pack_conversions`
WHEN NEW.`governance_status` IN ('pending','approved') AND EXISTS (
  SELECT 1 FROM `product_pack_conversions` existing
  WHERE existing.`product_id`=NEW.`product_id` AND lower(existing.`presentation_uom`)=lower(NEW.`presentation_uom`) AND existing.`id`<>NEW.`id`
    AND existing.`governance_status` IN ('pending','approved')
    AND date(NEW.`effective_from`) < date(COALESCE(existing.`effective_until`,'9999-12-31'))
    AND date(existing.`effective_from`) < date(COALESCE(NEW.`effective_until`,'9999-12-31'))
)
BEGIN SELECT RAISE(ABORT,'overlapping effective conversion period'); END;

CREATE INDEX IF NOT EXISTS `product_ceiling_prices_effective_lookup_idx`
  ON `product_ceiling_prices` (`product_id`,`effective_from`,`effective_until`);
