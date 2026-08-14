# URMED release-gate evidence matrix

This matrix is intentionally conservative. Local evidence is not substituted for hosted provider tests, production measurements, or human approval.

| Gate | Status | Local evidence | External evidence still required |
|---|---|---|---|
| Hosted D1/R2 backup, retention, encryption, restore, disaster recovery | EXTERNAL DEPENDENCY | `npm run backup:local`, `npm run restore:verify`, corruption/interruption/tenant-isolation tests | Cloudflare backup policy, R2 versioning/lifecycle, encryption/key rotation, authorized restore, RPO/RTO, DR and rollback drill |
| Cloudflare-scale performance and hosted observability | EXTERNAL DEPENDENCY | `npm run benchmark:reports`, local query plans, structured monitoring API and scheduled-job evidence | Approved anonymized production-scale D1 run, Worker CPU/latency/R2 metrics, dashboards, alerts, missed-job and incident drill |
| Accountant approval of `2026-08-14.v1` | BLOCKED | Policy document and approval API contract exist; approval remains pending | Signed accountant approval covering recognition, accrual, inventory valuation, GST periods, opening balances, reconciliation, and closing |
| Real bank-feed ingestion and reconciliation | EXTERNAL DEPENDENCY | Local staged import, matching, split-match, approval, reversal, audit, and tenant-scope flows | Approved bank-feed/provider adapter, credentials, matching/tolerance contract, production-like statement samples, reversal and reconciliation sign-off |
| Supabase/Twilio/Resend/Razorpay/R2 provider UAT | EXTERNAL DEPENDENCY | Provider-contract tests and local D1/R2 integration | Authorized non-production keys, OTP/email/payment/webhook/refund/object-encryption/lifecycle tests and provider failure evidence |
| Browser/accessibility/privacy/rollback/deployment testing | NOT STARTED | Build/artifact checks and privacy-focused automated tests | Role-based browser/device UAT, keyboard/screen-reader review, privacy sign-off, migration rollback/recovery, deployment smoke and rollback approval |

## Local evidence command

Run:

```sh
npm run release:gates:local
npm run release:gates:local -- --json
```

The checker only inspects local files and reports whether the evidence artifacts exist. It never contacts Cloudflare, Supabase, Twilio, Resend, Razorpay, R2, or any hosted service. `--strict` intentionally exits non-zero while external gates remain unresolved.

## Required execution order

1. Obtain accountant sign-off for policy `2026-08-14.v1`.
2. Obtain approved bank-feed and reconciliation matching/tolerance contracts.
3. Authorize non-production provider UAT and hosted D1/R2 backup/DR drills.
4. Run Cloudflare-scale performance and observability validation.
5. Complete browser/device/accessibility/privacy UAT.
6. Execute migration rollback, backup restore, deployment smoke, and production rollback drills.
7. Mark a gate complete only with dated evidence, environment, reviewer, and artifact references.

No hosted resources, production secrets, or deployments were accessed while preparing this matrix.
