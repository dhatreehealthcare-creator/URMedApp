CREATE TRIGGER IF NOT EXISTS `transactional_email_outbox_delete_guard`
BEFORE DELETE ON `transactional_email_outbox`
BEGIN
	SELECT RAISE(ABORT,'transactional email outbox rows are immutable and cannot be deleted');
END;--> statement-breakpoint

PRAGMA optimize;
