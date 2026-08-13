# Scheduled reminder processing

URMED has two independent Cloudflare Worker schedules:

- `*/5 * * * *` releases abandoned inventory reservations.
- `*/15 * * * *` processes due pill and refill reminders.
- `30 0 * * *` (06:00 India time) generates vendor near-expiry and
  zero/low-stock alerts.

The Worker dispatches by the exact cron expression. A reservation event cannot
run reminder processing, and an unknown schedule is ignored. Cloudflare invokes
the `scheduled` handler directly, so scheduled production execution does not
expose or depend on a public HTTP secret.

Administrators may inspect or run the processor through
`/api/admin/reminders/process`. That route accepts either the normal authenticated
administrator session or an exact `x-urmed-job-secret` matching the typed
`REMINDER_JOB_SECRET` Worker binding. If the binding is absent, the header is not
an authentication bypass and an administrator session is still required.

## Current policy boundary

The scheduler uses `Asia/Kolkata` only as its conservative fallback. Migration
`0047` gives each active live profile a reminder preference with an IANA time
zone, and each pill/refill due window is evaluated in that zone. Processing
requires the latest `health_reminders` consent, an active customer profile, and
at least one enabled reminder channel. In-app and email reminder channels are
both explicit opt-ins; email additionally requires a provider-verified address.
Quiet hours are not currently modelled.

In-app notification creation is idempotent for the local calendar day. Refill
rows are guarded by `last_notified_at`; pill notifications use a conditional
insert against the reminder and local date. Retrying the same scheduled event
does not send another notification or amplify no-op audit events.

When in-app is enabled, its notification is persisted before any email attempt.
Email-only reminders record idempotent delivery evidence so the same local day
is not sent twice. The job result and Worker log report provider-unavailable or failed attempts, but a
durable transactional email outbox, retry policy, provider identifiers, and
dead-letter handling remain P5-06. This limitation must be resolved before
email delivery is treated as reliable.

Vendor inventory alerts use the same explicit India-local calendar date. Only
currently operational pharmacies qualify. Near-expiry alerts reference the
exact batch; stock alerts aggregate eligible available quantity by product and
reference the product for purchase-order handoff. Each condition/reference is
deduplicated for its alert lifetime. P5-03 owns acknowledgement, resolution,
and any future re-alert policy.

## Local verification

Run the focused regression suite with:

```sh
node --experimental-strip-types --test tests/reminder-processing.test.mjs
```

The verified production build must contain both cron expressions in
`dist/server/wrangler.json`; `scripts/validate-artifact.sh` enforces that
contract. Local D1/R2 state remains isolated by the existing integration-test
harness, and no hosted resource is required for these checks.
