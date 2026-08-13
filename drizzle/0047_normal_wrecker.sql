CREATE TABLE `notification_preferences` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`profile_id` integer NOT NULL,
	`category` text NOT NULL,
	`in_app_enabled` integer DEFAULT true NOT NULL,
	`email_enabled` integer DEFAULT false NOT NULL,
	`sms_enabled` integer DEFAULT false NOT NULL,
	`time_zone` text DEFAULT 'Asia/Kolkata' NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `account_profiles`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "notification_preferences_channel_check" CHECK(("notification_preferences"."category" NOT IN ('transactional','safety') OR "notification_preferences"."in_app_enabled" = 1) AND "notification_preferences"."sms_enabled" = 0 AND "notification_preferences"."version" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_preferences_profile_category_uidx` ON `notification_preferences` (`profile_id`,`category`);--> statement-breakpoint
CREATE INDEX `notification_preferences_profile_idx` ON `notification_preferences` (`profile_id`,`updated_at`);--> statement-breakpoint

-- Conservative D-11 backfill: all active profiles retain essential in-app
-- notifications. External channels remain off until an authenticated person
-- explicitly opts in after migration.
INSERT INTO `notification_preferences`
	(`profile_id`,`category`,`in_app_enabled`,`email_enabled`,`sms_enabled`,`time_zone`)
SELECT profile.`id`,category.`value`,CASE WHEN category.`value` IN ('transactional','safety') THEN 1 ELSE 0 END,0,0,'Asia/Kolkata'
FROM `account_profiles` profile
CROSS JOIN (SELECT 'transactional' AS `value` UNION ALL SELECT 'safety' UNION ALL SELECT 'reminder' UNION ALL SELECT 'marketing') category
WHERE profile.`status`='active'
ON CONFLICT(`profile_id`,`category`) DO NOTHING;--> statement-breakpoint

CREATE TRIGGER `notification_preferences_insert_guard`
BEFORE INSERT ON `notification_preferences`
WHEN NEW.`category` NOT IN ('transactional','safety','reminder','marketing')
	OR (NEW.`category` IN ('transactional','safety') AND NEW.`in_app_enabled`<>1)
	OR NEW.`in_app_enabled` NOT IN (0,1) OR NEW.`email_enabled` NOT IN (0,1)
	OR NEW.`sms_enabled`<>0 OR NEW.`version`<0
	OR length(trim(NEW.`time_zone`))<3 OR length(NEW.`time_zone`)>64
BEGIN
	SELECT RAISE(ABORT,'invalid notification preference');
END;--> statement-breakpoint

CREATE TRIGGER `notification_preferences_update_guard`
BEFORE UPDATE ON `notification_preferences`
WHEN NEW.`profile_id`<>OLD.`profile_id` OR NEW.`category`<>OLD.`category`
	OR (NEW.`category` IN ('transactional','safety') AND NEW.`in_app_enabled`<>1)
	OR NEW.`in_app_enabled` NOT IN (0,1) OR NEW.`email_enabled` NOT IN (0,1)
	OR NEW.`sms_enabled`<>0
	OR NEW.`version`<>OLD.`version`+1
	OR length(trim(NEW.`time_zone`))<3 OR length(NEW.`time_zone`)>64
BEGIN
	SELECT RAISE(ABORT,'invalid notification preference transition');
END;
