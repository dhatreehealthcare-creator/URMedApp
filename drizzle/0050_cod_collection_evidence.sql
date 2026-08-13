CREATE TABLE IF NOT EXISTS `cod_collection_evidence` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `order_id` integer NOT NULL,
  `vendor_id` integer NOT NULL,
  `amount_paise` integer NOT NULL,
  `tender_mode` text NOT NULL,
  `receipt_reference` text NOT NULL,
  `idempotency_key` text NOT NULL,
  `collector_profile_id` integer NOT NULL,
  `collection_status` text DEFAULT 'collected' NOT NULL,
  `custody_status` text DEFAULT 'on_hand' NOT NULL,
  `collected_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `deposit_reference` text DEFAULT '' NOT NULL,
  `deposited_at` text,
  `deposited_by_profile_id` integer,
  `reconciliation_reference` text DEFAULT '' NOT NULL,
  `reconciled_at` text,
  `reconciled_by_profile_id` integer,
  `notes` text DEFAULT '' NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`collector_profile_id`) REFERENCES `account_profiles`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`deposited_by_profile_id`) REFERENCES `account_profiles`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`reconciled_by_profile_id`) REFERENCES `account_profiles`(`id`) ON UPDATE no action ON DELETE no action,
  CONSTRAINT `cod_collection_amount_check` CHECK(`amount_paise` > 0 AND length(trim(`receipt_reference`)) BETWEEN 3 AND 120 AND length(trim(`idempotency_key`)) BETWEEN 8 AND 160)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `cod_collection_order_uidx` ON `cod_collection_evidence` (`order_id`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `cod_collection_idempotency_uidx` ON `cod_collection_evidence` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `cod_collection_vendor_status_idx` ON `cod_collection_evidence` (`vendor_id`,`custody_status`,`collected_at`);--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS `cod_collection_insert_guard`
BEFORE INSERT ON `cod_collection_evidence`
WHEN NEW.`tender_mode` NOT IN ('cash','upi','card','bank_transfer')
  OR NEW.`collection_status`<>'collected' OR NEW.`custody_status`<>'on_hand'
  OR NEW.`amount_paise`<=0 OR length(trim(NEW.`receipt_reference`)) NOT BETWEEN 3 AND 120
  OR length(trim(NEW.`idempotency_key`)) NOT BETWEEN 8 AND 160
  OR NEW.`deposited_at` IS NOT NULL OR NEW.`reconciled_at` IS NOT NULL
  OR NEW.`deposit_reference`<>'' OR NEW.`reconciliation_reference`<>''
BEGIN SELECT RAISE(ABORT,'invalid COD collection evidence'); END;--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS `cod_collection_update_guard`
BEFORE UPDATE ON `cod_collection_evidence`
WHEN NEW.`order_id`<>OLD.`order_id` OR NEW.`vendor_id`<>OLD.`vendor_id`
  OR NEW.`amount_paise`<>OLD.`amount_paise` OR NEW.`tender_mode`<>OLD.`tender_mode`
  OR NEW.`receipt_reference`<>OLD.`receipt_reference` OR NEW.`idempotency_key`<>OLD.`idempotency_key`
  OR NEW.`collector_profile_id`<>OLD.`collector_profile_id` OR NEW.`collected_at`<>OLD.`collected_at`
  OR NEW.`collection_status` NOT IN ('collected','voided')
  OR NEW.`custody_status` NOT IN ('on_hand','deposited','reconciled')
  OR (OLD.`collection_status`='voided' AND NEW.`collection_status`<>'voided')
  OR (OLD.`custody_status`='on_hand' AND NEW.`custody_status` NOT IN ('on_hand','deposited'))
  OR (OLD.`custody_status`='deposited' AND NEW.`custody_status` NOT IN ('deposited','reconciled'))
  OR (OLD.`custody_status`='reconciled' AND NEW.`custody_status`<>'reconciled')
  OR (NEW.`custody_status`='deposited' AND (length(trim(NEW.`deposit_reference`))<3 OR NEW.`deposited_at` IS NULL OR NEW.`deposited_by_profile_id` IS NULL))
  OR (NEW.`custody_status`='reconciled' AND (length(trim(NEW.`reconciliation_reference`))<3 OR NEW.`reconciled_at` IS NULL OR NEW.`reconciled_by_profile_id` IS NULL OR NEW.`custody_status`<>OLD.`custody_status` AND OLD.`custody_status`<>'deposited'))
  OR (NEW.`custody_status`='on_hand' AND (NEW.`deposit_reference`<>'' OR NEW.`deposited_at` IS NOT NULL OR NEW.`deposited_by_profile_id` IS NOT NULL))
BEGIN SELECT RAISE(ABORT,'invalid COD collection transition'); END;--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS `cod_collection_delete_guard`
BEFORE DELETE ON `cod_collection_evidence`
BEGIN SELECT RAISE(ABORT,'COD collection evidence is immutable and cannot be deleted'); END;--> statement-breakpoint

PRAGMA optimize;
