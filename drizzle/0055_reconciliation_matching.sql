CREATE TABLE IF NOT EXISTS `accounting_reconciliation_items` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `vendor_id` integer,
  `account_code` text NOT NULL,
  `period_start` text NOT NULL,
  `period_end` text NOT NULL,
  `external_reference` text NOT NULL,
  `external_date` text NOT NULL,
  `amount_paise` integer NOT NULL,
  `matched_ledger_entry_id` integer,
  `status` text NOT NULL DEFAULT 'unmatched',
  `note` text NOT NULL DEFAULT '',
  `created_by_profile_id` integer NOT NULL,
  `matched_by_profile_id` integer,
  `matched_at` text,
  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`),
  FOREIGN KEY (`account_code`) REFERENCES `chart_accounts`(`account_code`),
  FOREIGN KEY (`matched_ledger_entry_id`) REFERENCES `ledger_entries`(`id`),
  FOREIGN KEY (`created_by_profile_id`) REFERENCES `account_profiles`(`id`),
  FOREIGN KEY (`matched_by_profile_id`) REFERENCES `account_profiles`(`id`),
  CONSTRAINT `accounting_reconciliation_items_status_check` CHECK (`status` IN ('unmatched','matched','ignored')),
  CONSTRAINT `accounting_reconciliation_items_amount_check` CHECK (`amount_paise` >= 0),
  CONSTRAINT `accounting_reconciliation_items_date_check` CHECK (date(`external_date`) IS NOT NULL)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `accounting_reconciliation_items_ref_uidx` ON `accounting_reconciliation_items` (`vendor_id`,`account_code`,`external_reference`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `accounting_reconciliation_items_match_idx` ON `accounting_reconciliation_items` (`vendor_id`,`account_code`,`status`,`external_date`);--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `accounting_reconciliation_items_match_guard`
BEFORE UPDATE OF `status`,`matched_ledger_entry_id` ON `accounting_reconciliation_items`
WHEN NEW.`status`='matched' AND NEW.`matched_ledger_entry_id` IS NULL
BEGIN SELECT RAISE(ABORT,'matched reconciliation item requires a ledger entry'); END;--> statement-breakpoint
PRAGMA optimize;
