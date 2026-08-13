-- Create the race-closing constraint before removing the old lookup index. If
-- legacy normalized duplicates exist, migration application stops without
-- dropping the existing index or rewriting/auto-linking either profile.
CREATE UNIQUE INDEX `account_profiles_normalized_email_uidx` ON `account_profiles` (lower(trim("email"))) WHERE trim("account_profiles"."email") <> '';--> statement-breakpoint
DROP INDEX `account_profiles_email_idx`;
