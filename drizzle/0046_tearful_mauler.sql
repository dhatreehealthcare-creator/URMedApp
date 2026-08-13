ALTER TABLE `notifications` ADD `lifecycle_status` text DEFAULT 'unread' NOT NULL;--> statement-breakpoint
ALTER TABLE `notifications` ADD `acknowledged_at` text;--> statement-breakpoint
ALTER TABLE `notifications` ADD `snoozed_until` text;--> statement-breakpoint
ALTER TABLE `notifications` ADD `resolved_at` text;--> statement-breakpoint
ALTER TABLE `notifications` ADD `resolution_reason` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `notifications` ADD `lifecycle_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `notifications` ADD `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL;--> statement-breakpoint
UPDATE `notifications`
SET `lifecycle_status` = CASE WHEN `read_at` IS NULL THEN 'unread' ELSE 'read' END,
	`updated_at` = COALESCE(`created_at`, CURRENT_TIMESTAMP);--> statement-breakpoint

-- P5-01/P5-02 originally deduplicated each alert type forever. If a product
-- moved from low to zero stock before this lifecycle existed, retain the newest
-- active record and close the older duplicate deterministically.
UPDATE `notifications`
SET `lifecycle_status` = 'resolved',
	`resolved_at` = COALESCE(`updated_at`, `created_at`, CURRENT_TIMESTAMP),
	`resolution_reason` = 'Superseded during notification lifecycle backfill',
	`lifecycle_version` = `lifecycle_version` + 1
WHERE `id` IN (
	SELECT older.`id`
	FROM `notifications` older
	WHERE older.`vendor_id` IS NOT NULL
		AND older.`notification_type` IN ('inventory_near_expiry', 'inventory_low_stock', 'inventory_zero_stock')
		AND EXISTS (
			SELECT 1 FROM `notifications` newer
			WHERE newer.`id` > older.`id`
				AND newer.`vendor_id` = older.`vendor_id`
				AND newer.`reference_type` = older.`reference_type`
				AND newer.`reference_id` = older.`reference_id`
				AND newer.`notification_type` IN ('inventory_near_expiry', 'inventory_low_stock', 'inventory_zero_stock')
		)
);--> statement-breakpoint
CREATE INDEX `notifications_vendor_lifecycle_idx` ON `notifications` (`vendor_id`,`lifecycle_status`,`snoozed_until`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_vendor_inventory_active_uidx` ON `notifications` (`vendor_id`,`reference_type`,`reference_id`) WHERE "notifications"."vendor_id" IS NOT NULL AND "notifications"."notification_type" IN ('inventory_near_expiry', 'inventory_low_stock', 'inventory_zero_stock') AND "notifications"."lifecycle_status" <> 'resolved';--> statement-breakpoint

CREATE TRIGGER `notifications_lifecycle_insert_guard`
BEFORE INSERT ON `notifications`
WHEN NEW.`lifecycle_status` NOT IN ('unread', 'read', 'acknowledged', 'snoozed', 'resolved')
	OR NEW.`lifecycle_version` < 0
	OR (NEW.`lifecycle_status` = 'snoozed' AND NEW.`snoozed_until` IS NULL)
	OR (NEW.`lifecycle_status` = 'resolved' AND (NEW.`resolved_at` IS NULL OR length(trim(NEW.`resolution_reason`)) < 5))
	OR (NEW.`notification_type` IN ('inventory_near_expiry', 'inventory_low_stock', 'inventory_zero_stock') AND (
		NEW.`vendor_id` IS NULL OR NEW.`profile_id` IS NOT NULL OR NEW.`reference_id` IS NULL
		OR NEW.`reference_type` NOT IN ('inventory_batch', 'inventory_reorder_product')
	))
BEGIN
	SELECT RAISE(ABORT, 'invalid notification lifecycle');
END;--> statement-breakpoint

CREATE TRIGGER `notifications_lifecycle_update_guard`
BEFORE UPDATE OF `lifecycle_status`, `acknowledged_at`, `snoozed_until`, `resolved_at`, `resolution_reason`, `lifecycle_version` ON `notifications`
WHEN NEW.`lifecycle_status` NOT IN ('unread', 'read', 'acknowledged', 'snoozed', 'resolved')
	OR NEW.`lifecycle_version` <> OLD.`lifecycle_version` + 1
	OR NOT (
		(OLD.`lifecycle_status` = 'unread' AND NEW.`lifecycle_status` IN ('read', 'acknowledged', 'snoozed', 'resolved'))
		OR (OLD.`lifecycle_status` = 'read' AND NEW.`lifecycle_status` IN ('acknowledged', 'snoozed', 'resolved'))
		OR (OLD.`lifecycle_status` = 'acknowledged' AND NEW.`lifecycle_status` IN ('snoozed', 'resolved'))
		OR (OLD.`lifecycle_status` = 'snoozed' AND NEW.`lifecycle_status` IN ('snoozed', 'acknowledged', 'resolved'))
	)
	OR (OLD.`lifecycle_status` = 'resolved' AND (
		NEW.`lifecycle_status` <> OLD.`lifecycle_status`
		OR NEW.`resolved_at` <> OLD.`resolved_at`
		OR NEW.`resolution_reason` <> OLD.`resolution_reason`
	))
	OR (NEW.`lifecycle_status` = 'snoozed' AND NEW.`snoozed_until` IS NULL)
	OR (NEW.`lifecycle_status` = 'resolved' AND (NEW.`resolved_at` IS NULL OR length(trim(NEW.`resolution_reason`)) < 5))
	OR (NEW.`lifecycle_status` <> 'resolved' AND (NEW.`resolved_at` IS NOT NULL OR length(trim(NEW.`resolution_reason`)) > 0))
BEGIN
	SELECT RAISE(ABORT, 'invalid notification lifecycle transition');
END;
