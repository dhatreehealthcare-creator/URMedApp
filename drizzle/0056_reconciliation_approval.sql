CREATE TABLE IF NOT EXISTS `accounting_statement_imports` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `vendor_id` integer,
  `account_code` text NOT NULL,
  `period_start` text NOT NULL,
  `period_end` text NOT NULL,
  `source_name` text NOT NULL,
  `source_checksum` text NOT NULL,
  `row_count` integer NOT NULL,
  `status` text NOT NULL DEFAULT 'staged',
  `imported_by_profile_id` integer NOT NULL,
  `approved_by_profile_id` integer,
  `approved_at` text,
  `reversed_by_profile_id` integer,
  `reversed_at` text,
  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`),
  FOREIGN KEY (`account_code`) REFERENCES `chart_accounts`(`account_code`),
  FOREIGN KEY (`imported_by_profile_id`) REFERENCES `account_profiles`(`id`),
  FOREIGN KEY (`approved_by_profile_id`) REFERENCES `account_profiles`(`id`),
  FOREIGN KEY (`reversed_by_profile_id`) REFERENCES `account_profiles`(`id`),
  CONSTRAINT `accounting_statement_imports_status_check` CHECK (`status` IN ('staged','approved','reversed')),
  CONSTRAINT `accounting_statement_imports_row_count_check` CHECK (`row_count` >= 0),
  CONSTRAINT `accounting_statement_imports_dates_check` CHECK (date(`period_end`) >= date(`period_start`))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `accounting_statement_imports_checksum_uidx` ON `accounting_statement_imports` (`vendor_id`,`account_code`,`source_checksum`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `accounting_statement_imports_scope_date_idx` ON `accounting_statement_imports` (`vendor_id`,`account_code`,`period_end`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `accounting_reconciliation_matches` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `reconciliation_item_id` integer NOT NULL,
  `ledger_entry_id` integer NOT NULL,
  `amount_paise` integer NOT NULL,
  `status` text NOT NULL DEFAULT 'proposed',
  `created_by_profile_id` integer NOT NULL,
  `approved_by_profile_id` integer,
  `approved_at` text,
  `reversed_by_profile_id` integer,
  `reversed_at` text,
  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`reconciliation_item_id`) REFERENCES `accounting_reconciliation_items`(`id`),
  FOREIGN KEY (`ledger_entry_id`) REFERENCES `ledger_entries`(`id`),
  FOREIGN KEY (`created_by_profile_id`) REFERENCES `account_profiles`(`id`),
  FOREIGN KEY (`approved_by_profile_id`) REFERENCES `account_profiles`(`id`),
  FOREIGN KEY (`reversed_by_profile_id`) REFERENCES `account_profiles`(`id`),
  CONSTRAINT `accounting_reconciliation_matches_status_check` CHECK (`status` IN ('proposed','approved','reversed')),
  CONSTRAINT `accounting_reconciliation_matches_amount_check` CHECK (`amount_paise` > 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `accounting_reconciliation_matches_pair_uidx` ON `accounting_reconciliation_matches` (`reconciliation_item_id`,`ledger_entry_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `accounting_reconciliation_matches_item_status_idx` ON `accounting_reconciliation_matches` (`reconciliation_item_id`,`status`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `accounting_policy_approvals` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `policy_key` text NOT NULL,
  `policy_version` text NOT NULL,
  `decision` text NOT NULL,
  `approval_reference` text NOT NULL,
  `approved_by_profile_id` integer NOT NULL,
  `approved_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`approved_by_profile_id`) REFERENCES `account_profiles`(`id`),
  CONSTRAINT `accounting_policy_approvals_decision_check` CHECK (`decision` IN ('approved','revoked')),
  CONSTRAINT `accounting_policy_approvals_reference_check` CHECK (length(trim(`approval_reference`)) >= 5)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `accounting_policy_approvals_version_uidx` ON `accounting_policy_approvals` (`policy_key`,`policy_version`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `accounting_policy_approvals_active_idx` ON `accounting_policy_approvals` (`policy_key`,`decision`,`approved_at`);--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `accounting_statement_imports_no_delete`
BEFORE DELETE ON `accounting_statement_imports`
BEGIN SELECT RAISE(ABORT,'accounting statement imports are immutable'); END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `accounting_reconciliation_matches_no_delete`
BEFORE DELETE ON `accounting_reconciliation_matches`
BEGIN SELECT RAISE(ABORT,'reconciliation match evidence is immutable'); END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `accounting_policy_approvals_no_update`
BEFORE UPDATE ON `accounting_policy_approvals`
BEGIN SELECT RAISE(ABORT,'accounting policy approvals are immutable'); END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `accounting_policy_approvals_no_delete`
BEFORE DELETE ON `accounting_policy_approvals`
BEGIN SELECT RAISE(ABORT,'accounting policy approvals are immutable'); END;--> statement-breakpoint
PRAGMA optimize;
