CREATE TABLE IF NOT EXISTS `accounting_parties` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `vendor_id` integer,
  `party_type` text NOT NULL,
  `party_ref_id` integer NOT NULL,
  `display_name` text NOT NULL,
  `active` integer NOT NULL DEFAULT 1,
  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`),
  CONSTRAINT `accounting_parties_type_check` CHECK (`party_type` IN ('supplier','customer')),
  CONSTRAINT `accounting_parties_name_check` CHECK (length(trim(`display_name`)) > 0),
  CONSTRAINT `accounting_parties_active_check` CHECK (`active` IN (0,1))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `accounting_parties_scope_ref_uidx` ON `accounting_parties` (`vendor_id`,`party_type`,`party_ref_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `accounting_parties_scope_type_idx` ON `accounting_parties` (`vendor_id`,`party_type`,`active`);--> statement-breakpoint
ALTER TABLE `ledger_entries` ADD COLUMN `party_id` integer;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ledger_entries_party_date_idx` ON `ledger_entries` (`party_id`,`entry_date`);--> statement-breakpoint
INSERT INTO `accounting_parties` (`vendor_id`,`party_type`,`party_ref_id`,`display_name`)
SELECT supplier.vendor_id,'supplier',supplier.id,supplier.business_name FROM suppliers supplier
WHERE NOT EXISTS (SELECT 1 FROM accounting_parties party WHERE party.vendor_id=supplier.vendor_id AND party.party_type='supplier' AND party.party_ref_id=supplier.id);--> statement-breakpoint
INSERT INTO `accounting_parties` (`vendor_id`,`party_type`,`party_ref_id`,`display_name`)
SELECT NULL,'customer',profile.id,profile.name FROM account_profiles profile
WHERE profile.role='customer'
  AND NOT EXISTS (SELECT 1 FROM accounting_parties party WHERE party.vendor_id IS NULL AND party.party_type='customer' AND party.party_ref_id=profile.id);--> statement-breakpoint
UPDATE ledger_entries SET party_id=(SELECT party.id FROM accounting_parties party JOIN purchase_orders purchase ON party.party_type='supplier' AND party.party_ref_id=purchase.supplier_id AND party.vendor_id=purchase.vendor_id WHERE ledger_entries.reference_type='purchase_order' AND purchase.id=ledger_entries.reference_id)
WHERE reference_type='purchase_order' AND party_id IS NULL;--> statement-breakpoint
UPDATE ledger_entries SET party_id=(SELECT party.id FROM accounting_parties party JOIN purchase_receipts receipt ON party.party_type='supplier' AND party.vendor_id=receipt.vendor_id JOIN purchase_orders receipt_order ON receipt_order.id=receipt.purchase_order_id AND party.party_ref_id=receipt_order.supplier_id WHERE ledger_entries.reference_type='purchase_receipt' AND receipt.id=ledger_entries.reference_id)
WHERE reference_type='purchase_receipt' AND party_id IS NULL;--> statement-breakpoint
UPDATE ledger_entries SET party_id=(SELECT party.id FROM accounting_parties party JOIN supplier_returns return_record ON party.party_type='supplier' AND party.party_ref_id=return_record.supplier_id AND party.vendor_id=return_record.vendor_id WHERE ledger_entries.reference_type='supplier_return' AND return_record.id=ledger_entries.reference_id)
WHERE reference_type='supplier_return' AND party_id IS NULL;--> statement-breakpoint
UPDATE ledger_entries SET party_id=(SELECT party.id FROM accounting_parties party JOIN orders order_record ON party.party_type='customer' AND party.party_ref_id=order_record.customer_profile_id AND party.vendor_id IS NULL WHERE ledger_entries.reference_type='online_order' AND order_record.id=ledger_entries.reference_id)
WHERE reference_type='online_order' AND party_id IS NULL;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `accounting_parties_no_delete`
BEFORE DELETE ON `accounting_parties`
BEGIN SELECT RAISE(ABORT,'accounting parties cannot be deleted'); END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `ledger_entries_party_projection`
AFTER INSERT ON `ledger_entries`
WHEN NEW.`party_id` IS NULL
BEGIN
  UPDATE ledger_entries SET party_id = CASE
    WHEN NEW.reference_type IN ('purchase_order','purchase_receipt','supplier_return') THEN (
      SELECT party.id FROM accounting_parties party
      JOIN purchase_orders purchase ON NEW.reference_type='purchase_order' AND purchase.id=NEW.reference_id
      LEFT JOIN purchase_receipts receipt ON NEW.reference_type='purchase_receipt' AND receipt.id=NEW.reference_id
      LEFT JOIN supplier_returns supplier_return ON NEW.reference_type='supplier_return' AND supplier_return.id=NEW.reference_id
      WHERE party.party_type='supplier' AND party.vendor_id=NEW.vendor_id
        AND party.party_ref_id=COALESCE(purchase.supplier_id,(SELECT po.supplier_id FROM purchase_orders po WHERE po.id=receipt.purchase_order_id),supplier_return.supplier_id)
      LIMIT 1)
    WHEN NEW.reference_type='online_order' THEN (
      SELECT party.id FROM accounting_parties party JOIN orders order_record ON order_record.id=NEW.reference_id
      WHERE party.party_type='customer' AND party.party_ref_id=order_record.customer_profile_id AND party.vendor_id IS NULL LIMIT 1)
    ELSE NULL END
  WHERE id=NEW.id;
END;--> statement-breakpoint
PRAGMA optimize;
