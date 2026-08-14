-- Benchmark evidence showed the home-delivery report's tenant + method + date
-- predicate was using the older vendor/date path and filtering delivery_method
-- after the range scan. This composite path matches the actual report filter.
CREATE INDEX IF NOT EXISTS `orders_vendor_delivery_date_idx`
  ON `orders` (`vendor_id`,`delivery_method`,`created_at`,`id`);
--> statement-breakpoint
PRAGMA optimize;
