CREATE TABLE IF NOT EXISTS `chart_accounts` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `account_code` text NOT NULL,
  `name` text NOT NULL,
  `account_type` text NOT NULL,
  `normal_balance` text NOT NULL,
  `parent_code` text,
  `active` integer NOT NULL DEFAULT 1,
  `system` integer NOT NULL DEFAULT 0,
  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `chart_accounts_type_check` CHECK (`account_type` IN ('asset','liability','equity','income','expense')),
  CONSTRAINT `chart_accounts_balance_check` CHECK (`normal_balance` IN ('debit','credit')),
  CONSTRAINT `chart_accounts_flags_check` CHECK (`active` IN (0,1) AND `system` IN (0,1))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `chart_accounts_code_uidx` ON `chart_accounts` (`account_code`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `chart_accounts_type_idx` ON `chart_accounts` (`account_type`,`active`);--> statement-breakpoint
INSERT INTO `chart_accounts` (`account_code`,`name`,`account_type`,`normal_balance`,`system`) VALUES
 ('CASH_BANK','Cash and bank','asset','debit',1),
 ('CASH_ON_HAND','Cash on hand','asset','debit',1),
 ('BANK_CLEARING','Bank clearing','asset','debit',1),
 ('INVENTORY','Inventory','asset','debit',1),
 ('ACCOUNTS_RECEIVABLE','Accounts receivable','asset','debit',1),
 ('ACCOUNTS_PAYABLE','Accounts payable','liability','credit',1),
 ('SUPPLIER_PAYABLE','Supplier payable','liability','credit',1),
 ('GST_PAYABLE','GST payable','liability','credit',1),
 ('CUSTOMER_REFUNDS','Customer refunds payable','liability','credit',1),
 ('OWNER_EQUITY','Owner equity','equity','credit',1),
 ('RETAINED_EARNINGS','Retained earnings','equity','credit',1),
 ('SALES','Medicine sales','income','credit',1),
 ('DELIVERY_INCOME','Delivery income','income','credit',1),
 ('SALES_RETURNS','Sales returns','income','debit',1),
 ('PURCHASES','Purchases','expense','debit',1),
 ('PURCHASE_RETURNS','Purchase returns','income','credit',1),
 ('EXPENSE','Operating expense','expense','debit',1)
 ON CONFLICT(`account_code`) DO NOTHING;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `accounting_opening_balances` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `vendor_id` integer,
  `account_code` text NOT NULL,
  `as_of_date` text NOT NULL,
  `debit_paise` integer NOT NULL DEFAULT 0,
  `credit_paise` integer NOT NULL DEFAULT 0,
  `description` text NOT NULL DEFAULT 'Opening balance',
  `created_by_profile_id` integer NOT NULL,
  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`),
  FOREIGN KEY (`account_code`) REFERENCES `chart_accounts`(`account_code`),
  FOREIGN KEY (`created_by_profile_id`) REFERENCES `account_profiles`(`id`),
  CONSTRAINT `accounting_opening_balances_amount_check` CHECK (`debit_paise` >= 0 AND `credit_paise` >= 0 AND NOT (`debit_paise` > 0 AND `credit_paise` > 0))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `accounting_opening_balances_scope_uidx` ON `accounting_opening_balances` (`vendor_id`,`account_code`,`as_of_date`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `accounting_opening_balances_vendor_date_idx` ON `accounting_opening_balances` (`vendor_id`,`as_of_date`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `accounting_periods` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `vendor_id` integer,
  `period_start` text NOT NULL,
  `period_end` text NOT NULL,
  `status` text NOT NULL DEFAULT 'open',
  `closed_by_profile_id` integer,
  `closed_at` text,
  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`),
  FOREIGN KEY (`closed_by_profile_id`) REFERENCES `account_profiles`(`id`),
  CONSTRAINT `accounting_periods_status_check` CHECK (`status` IN ('open','closed')),
  CONSTRAINT `accounting_periods_dates_check` CHECK (date(`period_end`) >= date(`period_start`))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `accounting_periods_scope_dates_uidx` ON `accounting_periods` (`vendor_id`,`period_start`,`period_end`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `accounting_periods_scope_status_idx` ON `accounting_periods` (`vendor_id`,`status`,`period_end`);--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `accounting_periods_closed_guard`
BEFORE UPDATE ON `accounting_periods`
WHEN OLD.`status`='closed'
BEGIN SELECT RAISE(ABORT,'accounting period is permanently closed'); END;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `accounting_reconciliations` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `vendor_id` integer,
  `account_code` text NOT NULL,
  `period_start` text NOT NULL,
  `period_end` text NOT NULL,
  `ledger_paise` integer NOT NULL,
  `statement_paise` integer NOT NULL,
  `variance_paise` integer NOT NULL,
  `status` text NOT NULL,
  `note` text NOT NULL DEFAULT '',
  `reviewed_by_profile_id` integer,
  `reviewed_at` text,
  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`),
  FOREIGN KEY (`account_code`) REFERENCES `chart_accounts`(`account_code`),
  FOREIGN KEY (`reviewed_by_profile_id`) REFERENCES `account_profiles`(`id`),
  CONSTRAINT `accounting_reconciliations_status_check` CHECK (`status` IN ('pending','matched','exception'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `accounting_reconciliations_scope_uidx` ON `accounting_reconciliations` (`vendor_id`,`account_code`,`period_start`,`period_end`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `accounting_reconciliations_status_idx` ON `accounting_reconciliations` (`vendor_id`,`status`,`period_end`);--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `ledger_entries_closed_period_guard`
BEFORE INSERT ON `ledger_entries`
WHEN EXISTS (SELECT 1 FROM `accounting_periods` p WHERE p.`status`='closed' AND (p.`vendor_id` IS NULL OR p.`vendor_id`=NEW.`vendor_id`) AND date(NEW.`entry_date`) BETWEEN date(p.`period_start`) AND date(p.`period_end`))
BEGIN SELECT RAISE(ABORT,'accounting period is closed'); END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `accounting_opening_balances_no_update`
BEFORE UPDATE ON `accounting_opening_balances`
BEGIN SELECT RAISE(ABORT,'opening balances are immutable'); END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `accounting_opening_balances_no_delete`
BEFORE DELETE ON `accounting_opening_balances`
BEGIN SELECT RAISE(ABORT,'opening balances cannot be deleted'); END;--> statement-breakpoint
PRAGMA optimize;
