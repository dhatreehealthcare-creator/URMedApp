DROP INDEX `account_profiles_phone_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `account_profiles_phone_uidx` ON `account_profiles` (`phone`) WHERE "account_profiles"."phone" <> '';--> statement-breakpoint
CREATE UNIQUE INDEX `vendors_phone_uidx` ON `vendors` (`phone`) WHERE "vendors"."phone" <> '';--> statement-breakpoint
CREATE UNIQUE INDEX `vendors_email_uidx` ON `vendors` (`email`) WHERE "vendors"."email" <> '';