import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("provider release guide inventories runtime bindings, redirects, jobs, and no-go gates without secrets", async () => {
  const guide = await readFile(new URL("../docs/PRODUCTION_PROVIDER_AND_RELEASE_CONFIGURATION.md", import.meta.url), "utf8");
  for (const key of [
    "SUPABASE_URL", "SUPABASE_ANON_KEY", "RESEND_API_KEY", "RESEND_FROM_EMAIL",
    "RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET",
    "DATA_ENCRYPTION_KEY", "REMINDER_JOB_SECRET",
  ]) assert.match(guide, new RegExp(`\\b${key}\\b`));
  for (const path of ["/vendor/verification-return", "/vendor/reset-password", "/customer/reset-password", "/api/webhooks/razorpay"])
    assert.match(guide, new RegExp(path.replaceAll("/", "\\/")));
  for (const cron of ["*/5 * * * *", "*/15 * * * *", "30 0 * * *"])
    assert.ok(guide.includes(`\`${cron}\``));
  assert.match(guide, /must not be configured in production/i);
  assert.match(guide, /R2 quarantine and real malware scanning/i);
  assert.match(guide, /Never place real keys/i);
  assert.doesNotMatch(guide, /rzp_(?:test|live)_[A-Za-z0-9]{8,}/);
  assert.doesNotMatch(guide, /eyJ[A-Za-z0-9_-]{20,}\./);
});
