CREATE TABLE `manufacturer_aliases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`manufacturer_id` integer NOT NULL,
	`alias_name` text NOT NULL,
	`normalized_alias` text NOT NULL,
	`provenance` text NOT NULL,
	`source_manufacturer_id` integer,
	`created_by_profile_id` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`manufacturer_id`) REFERENCES `manufacturers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_manufacturer_id`) REFERENCES `manufacturers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_profile_id`) REFERENCES `account_profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `manufacturer_aliases_normalized_uidx` ON `manufacturer_aliases` (`normalized_alias`);--> statement-breakpoint
CREATE INDEX `manufacturer_aliases_manufacturer_idx` ON `manufacturer_aliases` (`manufacturer_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `manufacturer_canonical_state` (
	`manufacturer_id` integer PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`merged_into_manufacturer_id` integer,
	`source` text DEFAULT 'recovered_catalogue' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`manufacturer_id`) REFERENCES `manufacturers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`merged_into_manufacturer_id`) REFERENCES `manufacturers`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "manufacturer_canonical_state_merge_check" CHECK(("manufacturer_canonical_state"."status" = 'merged' AND "manufacturer_canonical_state"."merged_into_manufacturer_id" IS NOT NULL AND "manufacturer_canonical_state"."manufacturer_id" <> "manufacturer_canonical_state"."merged_into_manufacturer_id") OR ("manufacturer_canonical_state"."status" <> 'merged' AND "manufacturer_canonical_state"."merged_into_manufacturer_id" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `manufacturer_canonical_state_status_idx` ON `manufacturer_canonical_state` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `manufacturer_canonical_state_merge_idx` ON `manufacturer_canonical_state` (`merged_into_manufacturer_id`);--> statement-breakpoint
CREATE TABLE `manufacturer_change_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`request_type` text NOT NULL,
	`submitted_vendor_id` integer NOT NULL,
	`created_by_profile_id` integer NOT NULL,
	`manufacturer_id` integer,
	`target_manufacturer_id` integer,
	`proposed_name` text DEFAULT '' NOT NULL,
	`normalized_proposed_name` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`reviewed_by_profile_id` integer,
	`review_reason` text DEFAULT '' NOT NULL,
	`reviewed_at` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`submitted_vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_profile_id`) REFERENCES `account_profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`manufacturer_id`) REFERENCES `manufacturers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_manufacturer_id`) REFERENCES `manufacturers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewed_by_profile_id`) REFERENCES `account_profiles`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "manufacturer_change_requests_pair_check" CHECK("manufacturer_change_requests"."manufacturer_id" IS NULL OR "manufacturer_change_requests"."target_manufacturer_id" IS NULL OR "manufacturer_change_requests"."manufacturer_id" <> "manufacturer_change_requests"."target_manufacturer_id")
);
--> statement-breakpoint
CREATE INDEX `manufacturer_change_requests_queue_idx` ON `manufacturer_change_requests` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `manufacturer_change_requests_vendor_idx` ON `manufacturer_change_requests` (`submitted_vendor_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `manufacturer_governance_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`request_id` integer NOT NULL,
	`event_type` text NOT NULL,
	`actor_profile_id` integer NOT NULL,
	`manufacturer_id` integer,
	`target_manufacturer_id` integer,
	`detail_json` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `manufacturer_change_requests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_profile_id`) REFERENCES `account_profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`manufacturer_id`) REFERENCES `manufacturers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_manufacturer_id`) REFERENCES `manufacturers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `manufacturer_governance_events_request_type_uidx` ON `manufacturer_governance_events` (`request_id`,`event_type`);--> statement-breakpoint
CREATE INDEX `manufacturer_governance_events_manufacturer_idx` ON `manufacturer_governance_events` (`manufacturer_id`,`created_at`);--> statement-breakpoint

-- Every recovered manufacturer remains a canonical record. No fuzzy merge or
-- destructive deduplication is performed by this migration.
INSERT INTO `manufacturer_canonical_state` (`manufacturer_id`, `status`, `source`)
SELECT `id`, 'active', 'recovered_catalogue' FROM `manufacturers`
WHERE 1 = 1
ON CONFLICT(`manufacturer_id`) DO NOTHING;--> statement-breakpoint
INSERT INTO `manufacturer_aliases` (
	`manufacturer_id`, `alias_name`, `normalized_alias`, `provenance`, `source_manufacturer_id`
)
SELECT `id`, `name`, `normalized_name`, 'recovered_catalogue', `id`
FROM `manufacturers`
WHERE 1 = 1
ON CONFLICT(`normalized_alias`) DO NOTHING;--> statement-breakpoint
UPDATE `products`
SET `manufacturer` = (SELECT manufacturer.`name` FROM `manufacturers` manufacturer
	WHERE manufacturer.`id` = `products`.`manufacturer_id`)
WHERE `manufacturer_id` IS NOT NULL
	AND EXISTS (SELECT 1 FROM `manufacturers` manufacturer
		WHERE manufacturer.`id` = `products`.`manufacturer_id`)
	AND `manufacturer` <> (SELECT manufacturer.`name` FROM `manufacturers` manufacturer
		WHERE manufacturer.`id` = `products`.`manufacturer_id`);--> statement-breakpoint
INSERT INTO `migration_audit` (
	`source_file`, `source_sha256`, `entity`, `source_rows`, `imported_rows`, `rejected_rows`, `notes`
)
SELECT '0043_tired_millenium_guard.sql', 'schema-migration-0043',
	'manufacturer_governance_backfill', count(*),
	(SELECT count(*) FROM `manufacturer_canonical_state` WHERE `source` = 'recovered_catalogue'),
	count(*) - (SELECT count(*) FROM `manufacturer_canonical_state` WHERE `source` = 'recovered_catalogue'),
	'Recovered manufacturer IDs and names retained as active canonical records and provenance-bearing aliases; no automatic merges'
FROM `manufacturers`
WHERE NOT EXISTS (SELECT 1 FROM `migration_audit` audit
	WHERE audit.`source_file` = '0043_tired_millenium_guard.sql'
		AND audit.`entity` = 'manufacturer_governance_backfill');--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS `manufacturer_requests_pending_new_name_uidx`
ON `manufacturer_change_requests` (`normalized_proposed_name`)
WHERE `status` = 'pending' AND `request_type` = 'new';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `manufacturer_requests_pending_source_uidx`
ON `manufacturer_change_requests` (`manufacturer_id`)
WHERE `status` = 'pending' AND `request_type` IN ('rename', 'merge');--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS `manufacturer_requests_insert_guard`
BEFORE INSERT ON `manufacturer_change_requests`
WHEN NEW.`status` <> 'pending'
	OR NEW.`reviewed_by_profile_id` IS NOT NULL OR NEW.`reviewed_at` IS NOT NULL
	OR trim(NEW.`review_reason`) <> '' OR NEW.`version` <> 1
	OR NEW.`request_type` NOT IN ('new', 'rename', 'merge')
	OR (NEW.`request_type` = 'new' AND (
		NEW.`manufacturer_id` IS NOT NULL OR NEW.`target_manufacturer_id` IS NOT NULL
		OR length(trim(NEW.`proposed_name`)) < 2 OR length(trim(NEW.`normalized_proposed_name`)) < 2
	))
	OR (NEW.`request_type` = 'rename' AND (
		NEW.`manufacturer_id` IS NULL OR NEW.`target_manufacturer_id` IS NOT NULL
		OR length(trim(NEW.`proposed_name`)) < 2 OR length(trim(NEW.`normalized_proposed_name`)) < 2
		OR NOT EXISTS (SELECT 1 FROM `manufacturer_canonical_state` state
			WHERE state.`manufacturer_id` = NEW.`manufacturer_id` AND state.`status` = 'active')
	))
	OR (NEW.`request_type` = 'merge' AND (
		NEW.`manufacturer_id` IS NULL OR NEW.`target_manufacturer_id` IS NULL
		OR NEW.`manufacturer_id` = NEW.`target_manufacturer_id`
		OR trim(NEW.`proposed_name`) <> '' OR trim(NEW.`normalized_proposed_name`) <> ''
		OR NOT EXISTS (SELECT 1 FROM `manufacturer_canonical_state` source
			WHERE source.`manufacturer_id` = NEW.`manufacturer_id` AND source.`status` = 'active')
		OR NOT EXISTS (SELECT 1 FROM `manufacturer_canonical_state` target
			WHERE target.`manufacturer_id` = NEW.`target_manufacturer_id` AND target.`status` = 'active')
	))
BEGIN
	SELECT RAISE(ABORT, 'manufacturer_request_invalid');
END;--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS `manufacturer_requests_update_guard`
BEFORE UPDATE ON `manufacturer_change_requests`
WHEN NEW.`request_type` <> OLD.`request_type`
	OR NEW.`submitted_vendor_id` <> OLD.`submitted_vendor_id`
	OR NEW.`created_by_profile_id` <> OLD.`created_by_profile_id`
	OR COALESCE(NEW.`manufacturer_id`, -1) <> COALESCE(OLD.`manufacturer_id`, -1)
	OR COALESCE(NEW.`target_manufacturer_id`, -1) <> COALESCE(OLD.`target_manufacturer_id`, -1)
	OR NEW.`proposed_name` <> OLD.`proposed_name`
	OR NEW.`normalized_proposed_name` <> OLD.`normalized_proposed_name`
	OR OLD.`status` <> 'pending' OR NEW.`status` NOT IN ('approved', 'rejected', 'withdrawn')
	OR NEW.`version` <> OLD.`version` + 1
	OR NEW.`reviewed_by_profile_id` IS NULL OR NEW.`reviewed_at` IS NULL
	OR length(trim(NEW.`review_reason`)) < 5
	OR (NEW.`status` IN ('approved', 'rejected') AND NOT EXISTS (
		SELECT 1 FROM `account_profiles` reviewer WHERE reviewer.`id` = NEW.`reviewed_by_profile_id`
			AND reviewer.`role` = 'admin' AND reviewer.`status` = 'active'
	))
	OR (NEW.`status` = 'withdrawn' AND NOT EXISTS (
		SELECT 1 FROM `vendors` vendor
		JOIN `account_profiles` reviewer ON reviewer.`id` = NEW.`reviewed_by_profile_id`
		WHERE vendor.`id` = NEW.`submitted_vendor_id` AND reviewer.`status` = 'active'
			AND (vendor.`profile_id` = NEW.`reviewed_by_profile_id` OR EXISTS (
				SELECT 1 FROM `vendor_staff` staff WHERE staff.`vendor_id` = vendor.`id`
					AND staff.`profile_id` = NEW.`reviewed_by_profile_id` AND staff.`status` = 'active'
			))
	))
	OR (NEW.`status` = 'approved' AND NEW.`request_type` = 'new' AND (
		EXISTS (SELECT 1 FROM `manufacturers` manufacturer
			WHERE manufacturer.`normalized_name` = NEW.`normalized_proposed_name`)
		OR EXISTS (SELECT 1 FROM `manufacturer_aliases` alias
			WHERE alias.`normalized_alias` = NEW.`normalized_proposed_name`)
	))
	OR (NEW.`status` = 'approved' AND NEW.`request_type` = 'rename' AND (
		EXISTS (SELECT 1 FROM `manufacturers` manufacturer
			WHERE manufacturer.`normalized_name` = NEW.`normalized_proposed_name`
				AND manufacturer.`id` <> NEW.`manufacturer_id`)
		OR EXISTS (SELECT 1 FROM `manufacturer_aliases` alias
			WHERE alias.`normalized_alias` = NEW.`normalized_proposed_name`
				AND alias.`manufacturer_id` <> NEW.`manufacturer_id`)
	))
	OR (NEW.`status` = 'approved' AND NEW.`request_type` IN ('rename', 'merge') AND
		NOT EXISTS (SELECT 1 FROM `manufacturer_canonical_state` source
			WHERE source.`manufacturer_id` = NEW.`manufacturer_id` AND source.`status` = 'active'))
	OR (NEW.`status` = 'approved' AND NEW.`request_type` = 'merge' AND
		NOT EXISTS (SELECT 1 FROM `manufacturer_canonical_state` target
			WHERE target.`manufacturer_id` = NEW.`target_manufacturer_id` AND target.`status` = 'active'))
BEGIN
	SELECT RAISE(ABORT, 'manufacturer_request_lifecycle_invalid');
END;--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS `manufacturer_state_insert_guard`
BEFORE INSERT ON `manufacturer_canonical_state`
WHEN NEW.`status` <> 'active' OR NEW.`merged_into_manufacturer_id` IS NOT NULL OR NEW.`version` <> 1
	OR NEW.`source` <> 'governed_creation'
	OR NOT EXISTS (
		SELECT 1 FROM `manufacturer_change_requests` request
		JOIN `manufacturers` manufacturer ON manufacturer.`normalized_name` = request.`normalized_proposed_name`
		WHERE request.`request_type` = 'new' AND request.`status` = 'approved'
			AND request.`manufacturer_id` IS NULL AND manufacturer.`id` = NEW.`manufacturer_id`
			AND NOT EXISTS (SELECT 1 FROM `manufacturer_governance_events` event WHERE event.`request_id` = request.`id`)
	)
BEGIN
	SELECT RAISE(ABORT, 'manufacturer_state_invalid');
END;--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS `manufacturer_state_update_guard`
BEFORE UPDATE ON `manufacturer_canonical_state`
WHEN NEW.`manufacturer_id` <> OLD.`manufacturer_id`
	OR NEW.`source` <> OLD.`source`
	OR NEW.`version` <> OLD.`version` + 1
	OR NOT (
		(OLD.`status` = 'active' AND NEW.`status` = 'active' AND NEW.`merged_into_manufacturer_id` IS NULL
			AND EXISTS (SELECT 1 FROM `manufacturer_change_requests` request
				WHERE request.`request_type` = 'rename' AND request.`status` = 'approved'
					AND request.`manufacturer_id` = OLD.`manufacturer_id`
					AND NOT EXISTS (SELECT 1 FROM `manufacturer_governance_events` event WHERE event.`request_id` = request.`id`)
					AND request.`proposed_name` = (SELECT manufacturer.`name` FROM `manufacturers` manufacturer WHERE manufacturer.`id` = OLD.`manufacturer_id`)
					AND request.`normalized_proposed_name` = (SELECT manufacturer.`normalized_name` FROM `manufacturers` manufacturer WHERE manufacturer.`id` = OLD.`manufacturer_id`)))
		OR (OLD.`status` = 'active' AND NEW.`status` = 'merged'
			AND NEW.`merged_into_manufacturer_id` IS NOT NULL
			AND NEW.`merged_into_manufacturer_id` <> NEW.`manufacturer_id`
			AND EXISTS (SELECT 1 FROM `manufacturer_canonical_state` target
				WHERE target.`manufacturer_id` = NEW.`merged_into_manufacturer_id` AND target.`status` = 'active')
			AND EXISTS (SELECT 1 FROM `manufacturer_change_requests` request
				WHERE request.`request_type` = 'merge' AND request.`status` = 'approved'
					AND request.`manufacturer_id` = OLD.`manufacturer_id`
					AND request.`target_manufacturer_id` = NEW.`merged_into_manufacturer_id`
					AND NOT EXISTS (SELECT 1 FROM `manufacturer_governance_events` event WHERE event.`request_id` = request.`id`)))
		OR (OLD.`status` = 'merged' AND NEW.`status` = 'merged'
			AND NEW.`merged_into_manufacturer_id` IS NOT NULL
			AND NEW.`merged_into_manufacturer_id` <> NEW.`manufacturer_id`
			AND EXISTS (SELECT 1 FROM `manufacturer_canonical_state` target
				WHERE target.`manufacturer_id` = NEW.`merged_into_manufacturer_id` AND target.`status` = 'active')
			AND EXISTS (SELECT 1 FROM `manufacturer_change_requests` request
				WHERE request.`request_type` = 'merge' AND request.`status` = 'approved'
					AND request.`manufacturer_id` = OLD.`merged_into_manufacturer_id`
					AND request.`target_manufacturer_id` = NEW.`merged_into_manufacturer_id`
					AND NOT EXISTS (SELECT 1 FROM `manufacturer_governance_events` event WHERE event.`request_id` = request.`id`)))
	)
BEGIN
	SELECT RAISE(ABORT, 'manufacturer_state_transition_invalid');
END;--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS `manufacturer_aliases_insert_guard`
BEFORE INSERT ON `manufacturer_aliases`
WHEN length(trim(NEW.`alias_name`)) < 2 OR length(trim(NEW.`normalized_alias`)) < 2
	OR NEW.`provenance` NOT IN ('governed_creation', 'rename', 'merge')
	OR NOT EXISTS (SELECT 1 FROM `manufacturer_canonical_state` state
		WHERE state.`manufacturer_id` = NEW.`manufacturer_id` AND state.`status` = 'active')
	OR (NEW.`provenance` = 'governed_creation' AND (
		NEW.`source_manufacturer_id` IS NOT NULL OR NOT EXISTS (
			SELECT 1 FROM `manufacturer_change_requests` request
			JOIN `manufacturers` manufacturer ON manufacturer.`normalized_name` = request.`normalized_proposed_name`
			WHERE request.`request_type` = 'new' AND request.`status` = 'approved'
				AND manufacturer.`id` = NEW.`manufacturer_id`
				AND manufacturer.`name` = NEW.`alias_name` AND manufacturer.`normalized_name` = NEW.`normalized_alias`
				AND NOT EXISTS (SELECT 1 FROM `manufacturer_governance_events` event WHERE event.`request_id` = request.`id`)
		)
	))
	OR (NEW.`provenance` = 'rename' AND (
		NEW.`source_manufacturer_id` <> NEW.`manufacturer_id` OR NOT EXISTS (
			SELECT 1 FROM `manufacturer_change_requests` request
			WHERE request.`request_type` = 'rename' AND request.`status` = 'approved'
				AND request.`manufacturer_id` = NEW.`manufacturer_id`
				AND NOT EXISTS (SELECT 1 FROM `manufacturer_governance_events` event WHERE event.`request_id` = request.`id`)
		)
	))
	OR (NEW.`provenance` = 'merge' AND (
		NEW.`source_manufacturer_id` IS NULL OR NEW.`source_manufacturer_id` = NEW.`manufacturer_id`
		OR NOT EXISTS (SELECT 1 FROM `manufacturer_change_requests` request
			WHERE request.`request_type` = 'merge' AND request.`status` = 'approved'
				AND request.`manufacturer_id` = NEW.`source_manufacturer_id`
				AND request.`target_manufacturer_id` = NEW.`manufacturer_id`
				AND NOT EXISTS (SELECT 1 FROM `manufacturer_governance_events` event WHERE event.`request_id` = request.`id`))
	))
BEGIN
	SELECT RAISE(ABORT, 'manufacturer_alias_invalid');
END;--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS `manufacturer_aliases_update_guard`
BEFORE UPDATE ON `manufacturer_aliases`
WHEN NEW.`id` <> OLD.`id` OR NEW.`alias_name` <> OLD.`alias_name`
	OR NEW.`normalized_alias` <> OLD.`normalized_alias` OR NEW.`provenance` <> OLD.`provenance`
	OR COALESCE(NEW.`created_by_profile_id`, -1) <> COALESCE(OLD.`created_by_profile_id`, -1)
	OR NEW.`created_at` <> OLD.`created_at`
	OR NEW.`manufacturer_id` = OLD.`manufacturer_id`
	OR NOT EXISTS (SELECT 1 FROM `manufacturer_canonical_state` state
		WHERE state.`manufacturer_id` = NEW.`manufacturer_id` AND state.`status` = 'active')
	OR NOT EXISTS (SELECT 1 FROM `manufacturer_change_requests` request
		WHERE request.`request_type` = 'merge' AND request.`status` = 'approved'
			AND request.`manufacturer_id` = OLD.`manufacturer_id`
			AND request.`target_manufacturer_id` = NEW.`manufacturer_id`
			AND NOT EXISTS (SELECT 1 FROM `manufacturer_governance_events` event WHERE event.`request_id` = request.`id`))
	OR COALESCE(NEW.`source_manufacturer_id`, -1) <> COALESCE(OLD.`source_manufacturer_id`, OLD.`manufacturer_id`)
BEGIN
	SELECT RAISE(ABORT, 'manufacturer_alias_redirect_invalid');
END;--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS `manufacturer_events_insert_guard`
BEFORE INSERT ON `manufacturer_governance_events`
WHEN NOT EXISTS (
	SELECT 1 FROM `manufacturer_change_requests` request
	WHERE request.`id` = NEW.`request_id`
		AND request.`reviewed_by_profile_id` = NEW.`actor_profile_id`
		AND (
			(NEW.`event_type` = 'approved_new' AND request.`request_type` = 'new' AND request.`status` = 'approved'
				AND NEW.`manufacturer_id` = (SELECT manufacturer.`id` FROM `manufacturers` manufacturer
					WHERE manufacturer.`normalized_name` = request.`normalized_proposed_name`)
				AND NEW.`target_manufacturer_id` IS NULL)
			OR (NEW.`event_type` = 'approved_rename' AND request.`request_type` = 'rename' AND request.`status` = 'approved'
				AND NEW.`manufacturer_id` = request.`manufacturer_id` AND NEW.`target_manufacturer_id` IS NULL)
			OR (NEW.`event_type` = 'approved_merge' AND request.`request_type` = 'merge' AND request.`status` = 'approved'
				AND NEW.`manufacturer_id` = request.`manufacturer_id`
				AND NEW.`target_manufacturer_id` = request.`target_manufacturer_id`)
			OR (NEW.`event_type` = 'rejected' AND request.`status` = 'rejected')
			OR (NEW.`event_type` = 'withdrawn' AND request.`status` = 'withdrawn')
		)
)
BEGIN
	SELECT RAISE(ABORT, 'manufacturer_event_invalid');
END;--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS `manufacturer_insert_guard`
BEFORE INSERT ON `manufacturers`
WHEN NOT EXISTS (
	SELECT 1 FROM `manufacturer_change_requests` request
	WHERE request.`request_type` = 'new' AND request.`status` = 'approved'
		AND request.`reviewed_by_profile_id` IS NOT NULL
		AND request.`proposed_name` = NEW.`name`
		AND request.`normalized_proposed_name` = NEW.`normalized_name`
		AND NOT EXISTS (SELECT 1 FROM `manufacturer_governance_events` event WHERE event.`request_id` = request.`id`)
)
BEGIN
	SELECT RAISE(ABORT, 'manufacturer_governance_required');
END;--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS `manufacturer_update_guard`
BEFORE UPDATE ON `manufacturers`
WHEN NEW.`id` <> OLD.`id` OR NOT EXISTS (
	SELECT 1 FROM `manufacturer_change_requests` request
	WHERE request.`request_type` = 'rename' AND request.`status` = 'approved'
		AND request.`reviewed_by_profile_id` IS NOT NULL
		AND request.`manufacturer_id` = OLD.`id`
		AND request.`proposed_name` = NEW.`name`
		AND request.`normalized_proposed_name` = NEW.`normalized_name`
		AND NOT EXISTS (SELECT 1 FROM `manufacturer_governance_events` event WHERE event.`request_id` = request.`id`)
)
BEGIN
	SELECT RAISE(ABORT, 'manufacturer_governance_required');
END;--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS `manufacturer_records_no_delete`
BEFORE DELETE ON `manufacturers`
BEGIN SELECT RAISE(ABORT, 'manufacturer_history_immutable'); END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `manufacturer_state_no_delete`
BEFORE DELETE ON `manufacturer_canonical_state`
BEGIN SELECT RAISE(ABORT, 'manufacturer_history_immutable'); END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `manufacturer_aliases_no_delete`
BEFORE DELETE ON `manufacturer_aliases`
BEGIN SELECT RAISE(ABORT, 'manufacturer_history_immutable'); END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `manufacturer_requests_no_delete`
BEFORE DELETE ON `manufacturer_change_requests`
BEGIN SELECT RAISE(ABORT, 'manufacturer_history_immutable'); END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `manufacturer_events_no_update`
BEFORE UPDATE ON `manufacturer_governance_events`
BEGIN SELECT RAISE(ABORT, 'manufacturer_history_immutable'); END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `manufacturer_events_no_delete`
BEFORE DELETE ON `manufacturer_governance_events`
BEGIN SELECT RAISE(ABORT, 'manufacturer_history_immutable'); END;--> statement-breakpoint

PRAGMA optimize;
