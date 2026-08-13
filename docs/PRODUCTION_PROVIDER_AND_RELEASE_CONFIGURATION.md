# URMED production provider and release configuration

This document lists the external configuration that remains required before a
hosted URMED environment can be treated as release-ready. It intentionally
contains variable names and validation steps only—never provider credentials.

## Required Worker bindings and secrets

| Binding | Purpose | Release validation |
|---|---|---|
| `DB` | Hosted Cloudflare D1 database | Apply reviewed migrations in order after a backup; verify migration ledger and application health |
| `BUCKET` | Private Cloudflare R2 document storage | Confirm CORS is not public, lifecycle policy is approved, and upload/download ownership tests pass |
| `APP_STAGE` | Runtime stage | Set to `production`; never set production to `integration` |
| `SUPABASE_URL` | Supabase Auth project URL | Must match the intended environment |
| `SUPABASE_ANON_KEY` | Public Supabase anonymous key | Browser-safe anon key only; never use the service-role key here |
| `RESEND_API_KEY` | Transactional email provider credential | Verify sender domain and a real test delivery; outbox retries remain provider/environment dependent |
| `RESEND_FROM_EMAIL` | Verified sender identity | Must belong to the verified sending domain |
| `RAZORPAY_KEY_ID` | Browser/server payment key ID | Use live or sandbox consistently with its matching secret |
| `RAZORPAY_KEY_SECRET` | Razorpay API/signature secret | Secret binding only; validate order, capture lookup, refund and failure flows |
| `RAZORPAY_WEBHOOK_SECRET` | Webhook HMAC secret | Configure the exact deployed webhook URL and replay a signed test event |
| `DATA_ENCRYPTION_KEY` | Vendor bank-account encryption | At least 24 characters; provision through secret storage; approve rotation/re-encryption procedure before launch |
| `REMINDER_JOB_SECRET` | Optional authenticated manual reminder-job call | Strong independent secret; scheduled Worker execution does not require it |
| `EINVOICE_API_URL` / `EINVOICE_API_KEY` | Future authorized GST e-invoice connector | Leave unset until a legal/provider owner approves the connector and IRN policy |

`INTEGRATION_TEST_AUTH_SECRET` is generated only by the isolated local test
harness. It must not be configured in production. The test-login contract also
requires `APP_STAGE=integration`, so production rejects test tokens before D1.

## Supabase and phone OTP configuration

Before provider E2E/UAT:

1. Enable email/password authentication and require email confirmation.
2. Configure the approved Indian phone provider (for example Twilio through
   Supabase), sender identity, country restrictions, OTP lifetime, resend
   limits, and abuse controls.
3. Add exact HTTPS redirect allowlist entries for:
   - `/vendor/verification-return`
   - `/vendor/reset-password`
   - `/customer/reset-password`
   - the customer registration return URL used by the deployed application.
4. Align signup, verification, recovery and resend templates with those URLs.
5. Prove email verification plus phone OTP on the same provider user, expired
   links/OTPs, resend throttling, duplicate identities, recovery, logout, and
   session expiry in the hosted browser.
6. Confirm no provider service-role key is exposed to the Worker or browser.

## Razorpay configuration

1. Configure the deployed webhook endpoint `/api/webhooks/razorpay` with the
   matching HMAC secret and only the event types supported by the reconciler.
2. Run sandbox/browser evidence for order creation, successful verification,
   failed payment, duplicate verify/webhook race, cancellation refund, failed
   refund/retry and late webhook replay.
3. Confirm the payment key shown by `/api/runtime` is the public key ID only.
4. Do not enable production COD finality until P3-07 collection/custody evidence
   replaces the current delivery-implies-payment behavior.

## Scheduled jobs

The verified Worker artifact must contain these independent UTC crons:

- `*/5 * * * *` — expired stock-reservation recovery;
- `*/15 * * * *` — due pill/refill processing using Asia/Kolkata rules;
- `30 0 * * *` — daily vendor expiry/stock alerts (06:00 IST).
- `7,17,27,37,47,57 * * * *` — transactional email outbox leasing and delivery retries.

After deployment, verify one bounded run of each job from structured logs and
confirm that retrying the same window creates no duplicate stock release,
notification, reminder, or email provider request. Outbox provider failures
remain in retry/dead-letter state and are visible through the administrator
email-outbox surface.

## D1/R2 release sequence

1. Take and checksum a recoverable D1/R2 backup; record the restore procedure.
2. Run every documented hosted read-only preflight for migrations that can stop
   on ambiguous data.
3. Apply migrations once in ascending order; never run local integration
   fixtures against hosted resources.
4. Verify the hosted migration ledger, expected tables/triggers/indexes, and
   the application runtime health endpoint.
5. Run tenant-isolated smoke tests with disposable provider users/documents.
6. Verify cleanup and retain the deployment/build/migration identifiers.
7. Keep rollback as backup restore or an explicitly reviewed forward repair;
   do not destructively edit immutable financial/audit evidence.

## Remaining no-go release gates

Even with every secret connected, release remains blocked until the roadmap's
open Phase 7 work is approved and evidenced, especially:

- R2 quarantine and real malware scanning;
- broad endpoint rate limits/provider-cost abuse controls and session revocation;
- pharmacy, prescription, GST/credit-note, privacy, retention and COD legal decisions;
- backup restore drill and structured monitoring;
- accessibility, performance, privacy and browser QA;
- role-based UAT and production smoke/rollback approval;
- P3-06/P3-07 return, credit-note and evidence-backed COD reconciliation;
- accountant-approved D-10 accounting cutover before publishing financial statements.

Never place real keys, tokens, account numbers, patient data, or production
database identifiers in this repository, test output, screenshots, or issue
comments.
