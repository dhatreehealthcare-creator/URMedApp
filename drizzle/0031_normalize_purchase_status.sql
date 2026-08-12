-- `received` is the canonical terminal status for the current immediate-receiving workflow.
-- Keep the existing completion timestamp when present and backfill it for legacy rows when absent.
UPDATE `purchase_orders`
SET `status` = 'received',
    `posted_at` = COALESCE(`posted_at`, `created_at`)
WHERE `status` = 'posted';
