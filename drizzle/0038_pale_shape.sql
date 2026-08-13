ALTER TABLE `products` ADD `manufacturer_id` integer REFERENCES manufacturers(id);--> statement-breakpoint
ALTER TABLE `products` ADD `dosage_form_id` integer REFERENCES dosage_forms(id);--> statement-breakpoint
ALTER TABLE `products` ADD `strength_value` text;--> statement-breakpoint
ALTER TABLE `products` ADD `strength_unit` text;--> statement-breakpoint
ALTER TABLE `products` ADD `pack_type` text;--> statement-breakpoint
ALTER TABLE `products` ADD `pack_size_value` text;--> statement-breakpoint
ALTER TABLE `products` ADD `pack_size_unit` text;--> statement-breakpoint
ALTER TABLE `products` ADD `dispensing_uom` text;--> statement-breakpoint
ALTER TABLE `products` ADD `normalized_generic_name` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `products` ADD `normalized_trade_name` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `products` ADD `governance_status` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `products_manufacturer_id_idx` ON `products` (`manufacturer_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `products_dosage_form_idx` ON `products` (`dosage_form_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `products_governance_idx` ON `products` (`governance_status`,`active`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `products_equivalence_idx` ON `products` (`normalized_generic_name`,`dosage_form_id`,`strength_value`,`strength_unit`,`governance_status`);--> statement-breakpoint

-- Every recovered row is an already-published catalogue record. New rows keep
-- the schema default of pending and must remain inactive until governed CRUD
-- records an administrator/pharmacist approval in P2-03.
UPDATE `products`
SET `governance_status` = 'approved'
WHERE `source` = 'legacy_backup';--> statement-breakpoint
UPDATE `products`
SET `active` = 0
WHERE `source` <> 'legacy_backup' AND `governance_status` = 'pending';--> statement-breakpoint

-- Prefer the exact recovered display value. The normalized fallback is safe
-- because manufacturers.normalized_name is unique. No fuzzy matching occurs.
CREATE INDEX IF NOT EXISTS `manufacturers_0038_display_name_idx` ON `manufacturers` (`name`);--> statement-breakpoint
UPDATE `products` AS `product_row`
SET `manufacturer_id` = (
	SELECT `manufacturers`.`id`
	FROM `manufacturers`
	WHERE `manufacturers`.`name` = `product_row`.`manufacturer`
	LIMIT 1
)
WHERE `manufacturer_id` IS NULL
	AND EXISTS (
		SELECT 1 FROM `manufacturers`
		WHERE `manufacturers`.`name` = `product_row`.`manufacturer`
	);--> statement-breakpoint
UPDATE `products` AS `product_row`
SET `manufacturer_id` = (
	SELECT `manufacturers`.`id`
	FROM `manufacturers`
	WHERE `manufacturers`.`normalized_name` = lower(trim(`product_row`.`manufacturer`))
	LIMIT 1
)
WHERE `manufacturer_id` IS NULL
	AND EXISTS (
		SELECT 1 FROM `manufacturers`
		WHERE `manufacturers`.`normalized_name` = lower(trim(`product_row`.`manufacturer`))
	);--> statement-breakpoint
DROP INDEX IF EXISTS `manufacturers_0038_display_name_idx`;--> statement-breakpoint

-- Legacy category_id is not used here: the recovered catalogue assigned that
-- value too broadly. A dosage form is backfilled only when packaging contains
-- exactly one governed, word-bounded form.
UPDATE `products`
SET `dosage_form_id` = CASE
	WHEN instr(' ' || lower(trim(`packaging`)) || ' ', ' tablet ') > 0 THEN 1
	WHEN instr(' ' || lower(trim(`packaging`)) || ' ', ' capsule ') > 0 THEN 2
	WHEN instr(' ' || lower(trim(`packaging`)) || ' ', ' injection ') > 0 THEN 3
	WHEN instr(' ' || lower(trim(`packaging`)) || ' ', ' ointment ') > 0 THEN 4
	WHEN instr(' ' || lower(trim(`packaging`)) || ' ', ' cream ') > 0 THEN 5
	WHEN instr(' ' || lower(trim(`packaging`)) || ' ', ' aerosol ') > 0 THEN 6
	WHEN instr(' ' || lower(trim(`packaging`)) || ' ', ' patch ') > 0 THEN 7
	WHEN instr(' ' || lower(trim(`packaging`)) || ' ', ' syrup ') > 0 THEN 8
	ELSE NULL
END
WHERE `dosage_form_id` IS NULL
	AND (
		(instr(' ' || lower(trim(`packaging`)) || ' ', ' tablet ') > 0) +
		(instr(' ' || lower(trim(`packaging`)) || ' ', ' capsule ') > 0) +
		(instr(' ' || lower(trim(`packaging`)) || ' ', ' injection ') > 0) +
		(instr(' ' || lower(trim(`packaging`)) || ' ', ' ointment ') > 0) +
		(instr(' ' || lower(trim(`packaging`)) || ' ', ' cream ') > 0) +
		(instr(' ' || lower(trim(`packaging`)) || ' ', ' aerosol ') > 0) +
		(instr(' ' || lower(trim(`packaging`)) || ' ', ' patch ') > 0) +
		(instr(' ' || lower(trim(`packaging`)) || ' ', ' syrup ') > 0)
	) = 1;--> statement-breakpoint

UPDATE `products`
SET `trade_name` = `name`
WHERE trim(`trade_name`) = '';--> statement-breakpoint
UPDATE `products`
SET `normalized_trade_name` = `normalized_name`
WHERE trim(`normalized_trade_name`) = '';--> statement-breakpoint

-- A legacy strength is parsed only for a single-component expression ending
-- in one parenthesized positive value/unit, for example Paracetamol(650mg).
WITH `single_component` AS (
	SELECT `id`,
		trim(substr(trim(`composition`), 1, instr(trim(`composition`), '(') - 1)) AS `generic_name_value`,
		trim(substr(
			trim(`composition`),
			instr(trim(`composition`), '(') + 1,
			length(trim(`composition`)) - instr(trim(`composition`), '(') - 1
		)) AS `strength_spec`
	FROM `products`
	WHERE trim(`composition`) <> ''
		AND instr(trim(`composition`), '(') > 1
		AND substr(trim(`composition`), -1) = ')'
		AND length(trim(`composition`)) - length(replace(trim(`composition`), '(', '')) = 1
		AND length(trim(`composition`)) - length(replace(trim(`composition`), ')', '')) = 1
		AND instr(trim(`composition`), ',') = 0
),
`parsed_component` AS (
	SELECT `id`, `generic_name_value`, `strength_spec`,
		length(`strength_spec`) - length(ltrim(`strength_spec`, '0123456789.')) AS `numeric_length`
	FROM `single_component`
),
`valid_component` AS (
	SELECT `id`, `generic_name_value`,
		substr(`strength_spec`, 1, `numeric_length`) AS `strength_value_value`,
		lower(trim(substr(`strength_spec`, `numeric_length` + 1))) AS `strength_unit_value`
	FROM `parsed_component`
	WHERE `numeric_length` > 0
		AND `generic_name_value` <> ''
		AND substr(`strength_spec`, 1, 1) <> '.'
		AND substr(`strength_spec`, `numeric_length`, 1) <> '.'
		AND length(substr(`strength_spec`, 1, `numeric_length`))
			- length(replace(substr(`strength_spec`, 1, `numeric_length`), '.', '')) <= 1
		AND CAST(substr(`strength_spec`, 1, `numeric_length`) AS REAL) > 0
		AND length(trim(substr(`strength_spec`, `numeric_length` + 1))) BETWEEN 1 AND 40
)
UPDATE `products`
SET `generic_name` = CASE
		WHEN trim(`generic_name`) = '' THEN (SELECT `generic_name_value` FROM `valid_component` WHERE `valid_component`.`id` = `products`.`id`)
		ELSE `generic_name`
	END,
	`strength_value` = COALESCE(`strength_value`, (SELECT `strength_value_value` FROM `valid_component` WHERE `valid_component`.`id` = `products`.`id`)),
	`strength_unit` = COALESCE(`strength_unit`, (SELECT `strength_unit_value` FROM `valid_component` WHERE `valid_component`.`id` = `products`.`id`))
WHERE `id` IN (SELECT `id` FROM `valid_component`);--> statement-breakpoint

UPDATE `products`
SET `normalized_generic_name` = lower(trim(`generic_name`))
WHERE trim(`normalized_generic_name`) = '' AND trim(`generic_name`) <> '';--> statement-breakpoint

-- Packaging is normalized only when it follows "container of positive-size"
-- and the remaining text identifies an unambiguous supported UOM.
WITH `pack_candidate` AS (
	SELECT `id`,
		lower(trim(substr(`packaging`, 1, instr(lower(`packaging`), ' of ') - 1))) AS `pack_type_value`,
		trim(substr(`packaging`, instr(lower(`packaging`), ' of ') + 4)) AS `pack_tail`
	FROM `products`
	WHERE instr(lower(`packaging`), ' of ') > 1
),
`parsed_pack` AS (
	SELECT `id`, `pack_type_value`, `pack_tail`,
		length(`pack_tail`) - length(ltrim(`pack_tail`, '0123456789.')) AS `numeric_length`
	FROM `pack_candidate`
),
`normalized_pack` AS (
	SELECT `id`, `pack_type_value`,
		substr(`pack_tail`, 1, `numeric_length`) AS `pack_size_value_value`,
		CASE
			WHEN lower(trim(substr(`pack_tail`, `numeric_length` + 1))) LIKE 'mcg%' THEN 'mcg'
			WHEN lower(trim(substr(`pack_tail`, `numeric_length` + 1))) LIKE 'mg%' THEN 'mg'
			WHEN lower(trim(substr(`pack_tail`, `numeric_length` + 1))) LIKE 'kg%' THEN 'kg'
			WHEN lower(trim(substr(`pack_tail`, `numeric_length` + 1))) LIKE 'gm%' THEN 'g'
			WHEN lower(trim(substr(`pack_tail`, `numeric_length` + 1))) LIKE 'ml%' THEN 'ml'
			WHEN lower(trim(substr(`pack_tail`, `numeric_length` + 1))) LIKE 'litre%' THEN 'l'
			WHEN lower(trim(substr(`pack_tail`, `numeric_length` + 1))) LIKE 'l %' THEN 'l'
			WHEN lower(trim(substr(`pack_tail`, `numeric_length` + 1))) LIKE '%tablet%' THEN 'tablet'
			WHEN lower(trim(substr(`pack_tail`, `numeric_length` + 1))) LIKE '%capsule%' THEN 'capsule'
			WHEN lower(trim(substr(`pack_tail`, `numeric_length` + 1))) LIKE '%injection%' THEN 'injection'
			WHEN lower(trim(substr(`pack_tail`, `numeric_length` + 1))) LIKE '%patch%' THEN 'patch'
			WHEN lower(trim(substr(`pack_tail`, `numeric_length` + 1))) LIKE 'unit%' THEN 'unit'
			WHEN lower(trim(substr(`pack_tail`, `numeric_length` + 1))) LIKE '%device%' THEN 'device'
			ELSE NULL
		END AS `pack_size_unit_value`
	FROM `parsed_pack`
	WHERE `numeric_length` > 0
		AND length(`pack_type_value`) BETWEEN 1 AND 40
		AND substr(`pack_tail`, 1, 1) <> '.'
		AND substr(`pack_tail`, `numeric_length`, 1) <> '.'
		AND length(substr(`pack_tail`, 1, `numeric_length`))
			- length(replace(substr(`pack_tail`, 1, `numeric_length`), '.', '')) <= 1
		AND CAST(substr(`pack_tail`, 1, `numeric_length`) AS REAL) > 0
)
UPDATE `products`
SET `pack_type` = COALESCE(`pack_type`, (SELECT `pack_type_value` FROM `normalized_pack` WHERE `normalized_pack`.`id` = `products`.`id`)),
	`pack_size_value` = COALESCE(`pack_size_value`, (SELECT `pack_size_value_value` FROM `normalized_pack` WHERE `normalized_pack`.`id` = `products`.`id`)),
	`pack_size_unit` = COALESCE(`pack_size_unit`, (SELECT `pack_size_unit_value` FROM `normalized_pack` WHERE `normalized_pack`.`id` = `products`.`id`)),
	`dispensing_uom` = COALESCE(`dispensing_uom`, (SELECT `pack_size_unit_value` FROM `normalized_pack` WHERE `normalized_pack`.`id` = `products`.`id`))
WHERE `id` IN (SELECT `id` FROM `normalized_pack` WHERE `pack_size_unit_value` IS NOT NULL);--> statement-breakpoint

-- Keep structured pairs, tax defaults, Rx defaults, and publication state
-- valid even before the P2-03 API starts writing them.
CREATE TRIGGER IF NOT EXISTS `products_structured_insert_guard`
BEFORE INSERT ON `products`
WHEN
	((NEW.`strength_value` IS NULL) <> (NEW.`strength_unit` IS NULL))
	OR (NEW.`strength_value` IS NOT NULL AND (
		CAST(NEW.`strength_value` AS REAL) <= 0
		OR NEW.`strength_value` GLOB '*[^0-9.]*'
		OR substr(NEW.`strength_value`, 1, 1) = '.'
		OR substr(NEW.`strength_value`, -1) = '.'
		OR length(NEW.`strength_value`) - length(replace(NEW.`strength_value`, '.', '')) > 1
		OR length(trim(NEW.`strength_unit`)) NOT BETWEEN 1 AND 40
	))
	OR ((NEW.`pack_size_value` IS NULL) <> (NEW.`pack_size_unit` IS NULL))
	OR (NEW.`pack_size_value` IS NOT NULL AND (
		CAST(NEW.`pack_size_value` AS REAL) <= 0
		OR NEW.`pack_size_value` GLOB '*[^0-9.]*'
		OR substr(NEW.`pack_size_value`, 1, 1) = '.'
		OR substr(NEW.`pack_size_value`, -1) = '.'
		OR length(NEW.`pack_size_value`) - length(replace(NEW.`pack_size_value`, '.', '')) > 1
		OR length(trim(NEW.`pack_size_unit`)) NOT BETWEEN 1 AND 40
	))
	OR NEW.`prescription_required` NOT IN (0, 1)
	OR NEW.`gst_percent` NOT IN (0, 5, 12, 18, 28)
	OR NEW.`governance_status` NOT IN ('pending', 'approved', 'rejected', 'inactive')
	OR (NEW.`governance_status` <> 'approved' AND NEW.`active` <> 0)
BEGIN
	SELECT RAISE(ABORT, 'invalid structured product variant');
END;--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS `products_structured_update_guard`
BEFORE UPDATE OF `strength_value`, `strength_unit`, `pack_size_value`, `pack_size_unit`, `prescription_required`, `gst_percent`, `governance_status`, `active` ON `products`
WHEN
	((NEW.`strength_value` IS NULL) <> (NEW.`strength_unit` IS NULL))
	OR (NEW.`strength_value` IS NOT NULL AND (
		CAST(NEW.`strength_value` AS REAL) <= 0
		OR NEW.`strength_value` GLOB '*[^0-9.]*'
		OR substr(NEW.`strength_value`, 1, 1) = '.'
		OR substr(NEW.`strength_value`, -1) = '.'
		OR length(NEW.`strength_value`) - length(replace(NEW.`strength_value`, '.', '')) > 1
		OR length(trim(NEW.`strength_unit`)) NOT BETWEEN 1 AND 40
	))
	OR ((NEW.`pack_size_value` IS NULL) <> (NEW.`pack_size_unit` IS NULL))
	OR (NEW.`pack_size_value` IS NOT NULL AND (
		CAST(NEW.`pack_size_value` AS REAL) <= 0
		OR NEW.`pack_size_value` GLOB '*[^0-9.]*'
		OR substr(NEW.`pack_size_value`, 1, 1) = '.'
		OR substr(NEW.`pack_size_value`, -1) = '.'
		OR length(NEW.`pack_size_value`) - length(replace(NEW.`pack_size_value`, '.', '')) > 1
		OR length(trim(NEW.`pack_size_unit`)) NOT BETWEEN 1 AND 40
	))
	OR NEW.`prescription_required` NOT IN (0, 1)
	OR NEW.`gst_percent` NOT IN (0, 5, 12, 18, 28)
	OR NEW.`governance_status` NOT IN ('pending', 'approved', 'rejected', 'inactive')
	OR (NEW.`governance_status` <> 'approved' AND NEW.`active` <> 0)
BEGIN
	SELECT RAISE(ABORT, 'invalid structured product variant');
END;--> statement-breakpoint

INSERT INTO `migration_audit` (
	`source_file`, `source_sha256`, `entity`, `source_rows`, `imported_rows`, `rejected_rows`, `notes`
)
SELECT
	'0038_pale_shape.sql',
	'schema-migration-0038',
	'product_variant_backfill',
	count(*),
	sum(CASE WHEN `manufacturer_id` IS NOT NULL OR `dosage_form_id` IS NOT NULL OR `strength_value` IS NOT NULL OR `pack_size_value` IS NOT NULL THEN 1 ELSE 0 END),
	sum(CASE WHEN `manufacturer_id` IS NULL AND `dosage_form_id` IS NULL AND `strength_value` IS NULL AND `pack_size_value` IS NULL THEN 1 ELSE 0 END),
	'manufacturer_id=' || sum(`manufacturer_id` IS NOT NULL)
		|| '; dosage_form_id=' || sum(`dosage_form_id` IS NOT NULL)
		|| '; strength=' || sum(`strength_value` IS NOT NULL)
		|| '; pack=' || sum(`pack_size_value` IS NOT NULL)
		|| '; unresolved_manufacturer=' || sum(`manufacturer_id` IS NULL)
		|| '; unresolved_dosage_form=' || sum(`dosage_form_id` IS NULL)
		|| '; ambiguous values intentionally remain NULL'
FROM `products`;--> statement-breakpoint

PRAGMA optimize;
