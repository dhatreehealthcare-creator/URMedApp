CREATE TABLE IF NOT EXISTS `reminder_delivery_evidence` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `reminder_type` text NOT NULL,
  `reminder_id` integer NOT NULL,
  `profile_id` integer NOT NULL REFERENCES `account_profiles`(`id`),
  `local_date` text NOT NULL,
  `channel` text NOT NULL,
  `dedupe_key` text NOT NULL,
  `outbox_id` integer REFERENCES `transactional_email_outbox`(`id`),
  `status` text NOT NULL DEFAULT 'queued',
  `provider_message_id` text NOT NULL DEFAULT '',
  `attempt_count` integer NOT NULL DEFAULT 0,
  `last_error_code` text NOT NULL DEFAULT '',
  `last_error_reason` text NOT NULL DEFAULT '',
  `sent_at` text,
  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `reminder_delivery_evidence_shape_check` CHECK (`reminder_type` IN ('pill','refill') AND `channel` IN ('email','in_app') AND `status` IN ('queued','processing','sent','retry_wait','dead_letter','cancelled') AND `reminder_id` > 0 AND `attempt_count` >= 0 AND length(trim(`local_date`)) = 10 AND length(trim(`dedupe_key`)) BETWEEN 3 AND 240),
  CONSTRAINT `reminder_delivery_evidence_state_check` CHECK ((`status`='sent' AND `sent_at` IS NOT NULL AND (`channel`='in_app' OR length(`provider_message_id`)>0)) OR (`status`<>'sent' AND `sent_at` IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `reminder_delivery_evidence_dedupe_uidx` ON `reminder_delivery_evidence` (`dedupe_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `reminder_delivery_evidence_day_uidx` ON `reminder_delivery_evidence` (`reminder_type`,`reminder_id`,`local_date`,`channel`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `reminder_delivery_evidence_profile_idx` ON `reminder_delivery_evidence` (`profile_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `reminder_delivery_evidence_status_idx` ON `reminder_delivery_evidence` (`status`,`updated_at`);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `reminder_delivery_evidence_no_delete`
BEFORE DELETE ON `reminder_delivery_evidence`
BEGIN SELECT RAISE(ABORT,'reminder delivery evidence is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `reminder_delivery_evidence_update_guard`
BEFORE UPDATE ON `reminder_delivery_evidence`
WHEN NEW.`reminder_type`<>OLD.`reminder_type` OR NEW.`reminder_id`<>OLD.`reminder_id` OR NEW.`profile_id`<>OLD.`profile_id` OR NEW.`local_date`<>OLD.`local_date` OR NEW.`channel`<>OLD.`channel` OR NEW.`dedupe_key`<>OLD.`dedupe_key` OR COALESCE(NEW.`outbox_id`,0)<>COALESCE(OLD.`outbox_id`,0)
BEGIN SELECT RAISE(ABORT,'reminder delivery identity is immutable'); END;
--> statement-breakpoint
PRAGMA optimize;
