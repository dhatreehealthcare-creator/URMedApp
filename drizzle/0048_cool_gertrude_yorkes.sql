CREATE TABLE `transactional_email_outbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`profile_id` integer NOT NULL,
	`recipient_email` text NOT NULL,
	`category` text NOT NULL,
	`event_type` text NOT NULL,
	`payload_json` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 5 NOT NULL,
	`next_attempt_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`lease_owner` text DEFAULT '' NOT NULL,
	`lease_expires_at` text,
	`provider_message_id` text DEFAULT '' NOT NULL,
	`last_error_code` text DEFAULT '' NOT NULL,
	`last_error_reason` text DEFAULT '' NOT NULL,
	`sent_at` text,
	`dead_lettered_at` text,
	`cancelled_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `account_profiles`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "transactional_email_outbox_attempt_check" CHECK("transactional_email_outbox"."attempt_count" >= 0 AND "transactional_email_outbox"."max_attempts" BETWEEN 1 AND 12 AND "transactional_email_outbox"."attempt_count" <= "transactional_email_outbox"."max_attempts")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transactional_email_outbox_dedupe_uidx` ON `transactional_email_outbox` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `transactional_email_outbox_due_idx` ON `transactional_email_outbox` (`status`,`next_attempt_at`,`id`);--> statement-breakpoint
CREATE INDEX `transactional_email_outbox_lease_idx` ON `transactional_email_outbox` (`status`,`lease_expires_at`,`id`);--> statement-breakpoint
CREATE INDEX `transactional_email_outbox_profile_idx` ON `transactional_email_outbox` (`profile_id`,`created_at`);--> statement-breakpoint

CREATE TRIGGER `transactional_email_outbox_insert_guard`
BEFORE INSERT ON `transactional_email_outbox`
WHEN NEW.`status`<>'queued' OR NEW.`attempt_count`<>0
	OR NEW.`lease_owner`<>'' OR NEW.`lease_expires_at` IS NOT NULL
	OR NEW.`provider_message_id`<>'' OR NEW.`last_error_code`<>'' OR NEW.`last_error_reason`<>''
	OR NEW.`sent_at` IS NOT NULL OR NEW.`dead_lettered_at` IS NOT NULL OR NEW.`cancelled_at` IS NOT NULL
	OR NEW.`recipient_email`<>lower(trim(NEW.`recipient_email`))
	OR length(NEW.`recipient_email`)<3 OR length(NEW.`recipient_email`)>320
	OR instr(NEW.`recipient_email`,' ')>0 OR instr(NEW.`recipient_email`,'@')<2
	OR NEW.`category` NOT IN ('transactional','safety','reminder')
	OR NEW.`event_type` NOT IN ('order_placed','order_status_changed','prescription_reviewed','refill_due','pill_due')
	OR (NEW.`event_type` IN ('order_placed','order_status_changed') AND NEW.`category`<>'transactional')
	OR (NEW.`event_type`='prescription_reviewed' AND NEW.`category`<>'safety')
	OR (NEW.`event_type` IN ('refill_due','pill_due') AND NEW.`category`<>'reminder')
	OR length(NEW.`dedupe_key`)<3 OR length(NEW.`dedupe_key`)>200
	OR NEW.`dedupe_key`<>trim(NEW.`dedupe_key`) OR NEW.`dedupe_key` GLOB '*[^A-Za-z0-9:._-]*'
	OR json_valid(NEW.`payload_json`)<>1 OR json_type(NEW.`payload_json`)<>'object'
	OR length(NEW.`payload_json`)<2 OR length(NEW.`payload_json`)>4000
	OR length(NEW.`next_attempt_at`)<20
BEGIN
	SELECT RAISE(ABORT,'invalid transactional email outbox item');
END;--> statement-breakpoint

CREATE TRIGGER `transactional_email_outbox_update_guard`
BEFORE UPDATE ON `transactional_email_outbox`
WHEN NEW.`profile_id`<>OLD.`profile_id` OR NEW.`recipient_email`<>OLD.`recipient_email`
	OR NEW.`category`<>OLD.`category` OR NEW.`event_type`<>OLD.`event_type`
	OR NEW.`payload_json`<>OLD.`payload_json` OR NEW.`dedupe_key`<>OLD.`dedupe_key`
	OR NEW.`max_attempts`<>OLD.`max_attempts` OR NEW.`created_at`<>OLD.`created_at`
	OR NEW.`status` NOT IN ('queued','processing','sent','retry_wait','dead_letter','cancelled')
	OR NOT (
		(OLD.`status` IN ('queued','retry_wait') AND NEW.`status` IN ('processing','cancelled'))
		OR (OLD.`status`='processing' AND NEW.`status` IN ('sent','retry_wait','dead_letter','cancelled'))
		OR (OLD.`status`='dead_letter' AND NEW.`status`='retry_wait')
	)
	OR (NEW.`status`='processing' AND (
		OLD.`status` NOT IN ('queued','retry_wait') OR NEW.`attempt_count`<>OLD.`attempt_count`+1
		OR length(NEW.`lease_owner`)<3 OR length(NEW.`lease_owner`)>160 OR NEW.`lease_expires_at` IS NULL
	))
	OR (NEW.`status`<>'processing' AND (NEW.`lease_owner`<>'' OR NEW.`lease_expires_at` IS NOT NULL))
	OR (OLD.`status`='processing' AND NEW.`status`<>'processing' AND NEW.`attempt_count`<>OLD.`attempt_count`)
	OR (OLD.`status` IN ('queued','retry_wait') AND NEW.`status`='cancelled' AND NEW.`attempt_count`<>OLD.`attempt_count`)
	OR (OLD.`status`='dead_letter' AND (NEW.`attempt_count`<>0 OR NEW.`last_error_code`<>'' OR NEW.`last_error_reason`<>''))
	OR (NEW.`status`='sent' AND (NEW.`sent_at` IS NULL OR length(NEW.`provider_message_id`)<1))
	OR (NEW.`status`<>'sent' AND (NEW.`sent_at` IS NOT NULL OR NEW.`provider_message_id`<>''))
	OR (NEW.`status`='dead_letter' AND (NEW.`dead_lettered_at` IS NULL OR length(NEW.`last_error_code`)<1))
	OR (NEW.`status`<>'dead_letter' AND NEW.`dead_lettered_at` IS NOT NULL)
	OR (NEW.`status`='cancelled' AND NEW.`cancelled_at` IS NULL)
	OR (NEW.`status`<>'cancelled' AND NEW.`cancelled_at` IS NOT NULL)
	OR length(NEW.`provider_message_id`)>200 OR length(NEW.`last_error_code`)>80 OR length(NEW.`last_error_reason`)>240
	OR length(NEW.`next_attempt_at`)<20
BEGIN
	SELECT RAISE(ABORT,'invalid transactional email outbox transition');
END;--> statement-breakpoint

PRAGMA optimize;
