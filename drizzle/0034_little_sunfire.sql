ALTER TABLE `test_accounts` ADD `phone` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `test_accounts` ADD `email_confirmed` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `test_accounts` ADD `phone_confirmed` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `vendors` ADD `registration_status` text DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE `vendors` ADD `registration_submitted_at` text;--> statement-breakpoint
-- Test-session provider claims are copied only from their explicitly linked live profile.
-- The recovered customers archive is deliberately excluded from this backfill.
UPDATE `test_accounts`
SET `phone` = COALESCE((SELECT profile.`phone` FROM `account_profiles` profile WHERE profile.`id` = `test_accounts`.`profile_id`), ''),
    `email_confirmed` = COALESCE((SELECT profile.`email_verified` FROM `account_profiles` profile WHERE profile.`id` = `test_accounts`.`profile_id`), 0),
    `phone_confirmed` = COALESCE((SELECT profile.`phone_verified` FROM `account_profiles` profile WHERE profile.`id` = `test_accounts`.`profile_id`), 0);--> statement-breakpoint
-- Preserve registrations that were submitted under P1-01 before the explicit
-- state column existed, as well as already approved/verified pharmacies.
UPDATE `vendors`
SET `registration_status` = 'submitted',
    `registration_submitted_at` = COALESCE(
      (SELECT MIN(event.`created_at`) FROM `audit_events` event
        WHERE event.`action` = 'vendor.registration.submitted'
          AND event.`entity_type` = 'vendor'
          AND CAST(event.`entity_id` AS INTEGER) = `vendors`.`id`),
      `updated_at`,
      `created_at`
    )
WHERE (`approval_status` = 'approved' AND `compliance_status` = 'verified')
   OR EXISTS (
      SELECT 1 FROM `audit_events` event
      WHERE event.`action` = 'vendor.registration.submitted'
        AND event.`entity_type` = 'vendor'
        AND CAST(event.`entity_id` AS INTEGER) = `vendors`.`id`
   );
