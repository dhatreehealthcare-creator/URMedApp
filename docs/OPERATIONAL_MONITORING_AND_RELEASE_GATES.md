# Operational monitoring and release gates

P7-06 adds provider-independent operational evidence. `operational_events` is an append-only, sanitized event ledger. `operational_alerts` aggregates by a hashed category/provider/tenant-safe reference fingerprint, caps occurrences at 10,000, escalates severity, and supports versioned acknowledge/resolve actions. Event detail is bounded and redacts credentials, tokens, payment payloads, prescription data, addresses, coordinates, phone numbers, and email addresses.

The Worker records idempotent success/failure events for reservation recovery, reminders, inventory/SLA alerts, and transactional email processing. The admin-only `/api/admin/monitoring` endpoint and admin overview show bounded diagnostics with `private, no-store`; customers, vendors, and delivery roles cannot read or mutate them. Monitoring failures are fail-safe and never replace the primary job result.

Local validation is provider-independent. It does not prove hosted observability, Cloudflare alert delivery, or disaster recovery. Before production, release owners must verify:

- hosted D1/R2 backup, retention, encryption/key rotation, restore and rollback drills;
- Cloudflare-scale D1 performance and scheduled-job alarms;
- accountant approval and lock of accounting policy `2026-08-14.v1`;
- real bank-feed ingestion and approved reconciliation matching/tolerance rules;
- Supabase/Twilio, Resend, Razorpay and R2 provider UAT, webhook alarms and callback secrets;
- browser/device/accessibility/privacy UAT, incident runbooks, backup recovery evidence, and rollback testing.

No hosted resources or production secrets are accessed by local tests.
