PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_product_alternates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`product_id` integer NOT NULL,
	`alternate_product_id` integer NOT NULL,
	`submitted_vendor_id` integer,
	`created_by_profile_id` integer,
	`governance_status` text DEFAULT 'pending' NOT NULL,
	`reviewed_by_profile_id` integer,
	`review_reason` text DEFAULT '' NOT NULL,
	`reviewed_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`alternate_product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`submitted_vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_profile_id`) REFERENCES `account_profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewed_by_profile_id`) REFERENCES `account_profiles`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "product_alternates_canonical_pair_check" CHECK("__new_product_alternates"."product_id" < "__new_product_alternates"."alternate_product_id")
);
--> statement-breakpoint
INSERT INTO `migration_audit` (
	`source_file`, `source_sha256`, `entity`, `source_rows`, `imported_rows`, `rejected_rows`, `notes`
)
SELECT
	'0040_milky_grim_reaper.sql',
	'schema-migration-0040',
	'product_alternate_governance_backfill',
	count(*),
	count(DISTINCT CASE WHEN `product_id` <> `alternate_product_id`
		THEN min(`product_id`, `alternate_product_id`) || ':' || max(`product_id`, `alternate_product_id`) END),
	count(*) - count(DISTINCT CASE WHEN `product_id` <> `alternate_product_id`
		THEN min(`product_id`, `alternate_product_id`) || ':' || max(`product_id`, `alternate_product_id`) END),
	'Legacy directed links were canonicalized as unapproved pending records; self-links and mirrored duplicates were rejected'
FROM `product_alternates`;--> statement-breakpoint
INSERT INTO `__new_product_alternates` (
	`product_id`, `alternate_product_id`, `submitted_vendor_id`, `created_by_profile_id`,
	`governance_status`, `review_reason`, `created_at`, `updated_at`
)
SELECT
	min(`product_id`, `alternate_product_id`),
	max(`product_id`, `alternate_product_id`),
	NULL,
	min(`created_by_profile_id`),
	'pending',
	'Legacy ungoverned link requires administrator review',
	min(`created_at`),
	CURRENT_TIMESTAMP
FROM `product_alternates`
WHERE `product_id` <> `alternate_product_id`
GROUP BY min(`product_id`, `alternate_product_id`), max(`product_id`, `alternate_product_id`);--> statement-breakpoint
DROP TABLE `product_alternates`;--> statement-breakpoint
ALTER TABLE `__new_product_alternates` RENAME TO `product_alternates`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `product_alternates_pair_uidx` ON `product_alternates` (`product_id`,`alternate_product_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `product_alternates_governance_idx` ON `product_alternates` (`governance_status`,`updated_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `product_alternates_vendor_status_idx` ON `product_alternates` (`submitted_vendor_id`,`governance_status`,`updated_at`);--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS `product_alternates_insert_guard`
BEFORE INSERT ON `product_alternates`
WHEN NEW.`governance_status` <> 'pending'
	OR NEW.`submitted_vendor_id` IS NULL
	OR NEW.`created_by_profile_id` IS NULL
	OR NEW.`reviewed_by_profile_id` IS NOT NULL
	OR NEW.`reviewed_at` IS NOT NULL
	OR NOT EXISTS (
		SELECT 1 FROM `products` product, `products` alternate
		WHERE product.`id` = NEW.`product_id`
			AND alternate.`id` = NEW.`alternate_product_id`
			AND product.`active` = 1 AND product.`governance_status` = 'approved'
			AND alternate.`active` = 1 AND alternate.`governance_status` = 'approved'
			AND trim(product.`normalized_generic_name`) <> ''
			AND product.`normalized_generic_name` = alternate.`normalized_generic_name`
			AND product.`dosage_form_id` = alternate.`dosage_form_id`
			AND product.`strength_value` = alternate.`strength_value`
			AND product.`strength_unit` = alternate.`strength_unit`
	)
BEGIN
	SELECT RAISE(ABORT, 'invalid alternate proposal');
END;--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS `product_alternates_update_guard`
BEFORE UPDATE ON `product_alternates`
WHEN NEW.`product_id` <> OLD.`product_id`
	OR NEW.`alternate_product_id` <> OLD.`alternate_product_id`
	OR NEW.`governance_status` NOT IN ('pending', 'approved', 'rejected', 'inactive', 'withdrawn')
	OR NOT (
		(OLD.`governance_status` = NEW.`governance_status`)
		OR (OLD.`governance_status` = 'pending' AND NEW.`governance_status` IN ('approved', 'rejected', 'withdrawn'))
		OR (OLD.`governance_status` IN ('rejected', 'inactive', 'withdrawn') AND NEW.`governance_status` = 'pending')
		OR (OLD.`governance_status` = 'approved' AND NEW.`governance_status` = 'inactive')
	)
	OR (
		NEW.`governance_status` = 'pending'
		AND (NEW.`submitted_vendor_id` IS NULL OR NEW.`created_by_profile_id` IS NULL
			OR NEW.`reviewed_by_profile_id` IS NOT NULL OR NEW.`reviewed_at` IS NOT NULL
			OR trim(NEW.`review_reason`) <> '')
	)
	OR (
		NEW.`governance_status` IN ('approved', 'rejected', 'inactive', 'withdrawn')
		AND (NEW.`reviewed_by_profile_id` IS NULL OR NEW.`reviewed_at` IS NULL)
	)
	OR (NEW.`governance_status` IN ('rejected', 'inactive') AND length(trim(NEW.`review_reason`)) < 5)
	OR (
		NEW.`governance_status` IN ('pending', 'approved')
		AND NOT EXISTS (
			SELECT 1 FROM `products` product, `products` alternate
			WHERE product.`id` = NEW.`product_id`
				AND alternate.`id` = NEW.`alternate_product_id`
				AND product.`active` = 1 AND product.`governance_status` = 'approved'
				AND alternate.`active` = 1 AND alternate.`governance_status` = 'approved'
				AND trim(product.`normalized_generic_name`) <> ''
				AND product.`normalized_generic_name` = alternate.`normalized_generic_name`
				AND product.`dosage_form_id` = alternate.`dosage_form_id`
				AND product.`strength_value` = alternate.`strength_value`
				AND product.`strength_unit` = alternate.`strength_unit`
		)
	)
BEGIN
	SELECT RAISE(ABORT, 'invalid alternate lifecycle');
END;--> statement-breakpoint

PRAGMA optimize;
