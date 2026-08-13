# Identity verification and vendor onboarding lifecycle

**Decision:** P1-02, 12 August 2026

This document defines the state boundaries used by vendor authentication and onboarding. The states are deliberately independent; `account_profiles.status` is not an onboarding state.

## Authorities

- Supabase Auth is authoritative for the authenticated user, email, phone, `email_confirmed_at`, and `phone_confirmed_at`.
- `account_profiles` mirrors the normalized provider email and Indian mobile number plus their provider-derived verification flags. Request-body verification flags are ignored.
- `vendors.registration_status` is authoritative for whether the unified registration package is still a draft or has been submitted.
- `vendors.approval_status` and `vendors.compliance_status` remain the administrator-review and compliance decisions.
- `account_profiles.status` is only the account control state. Non-`active` values such as inactive or suspended always deny access and are never changed by verification synchronization.
- Recovered `customers` records are an admin-only archive and never supply credentials, verification, profile ownership, or onboarding state.

## State model

| Dimension | States | Transition authority |
|---|---|---|
| Provider session | unauthenticated, authenticated | Supabase or the existing local integration-test session contract |
| Email | pending, verified | Presence of the provider email and `email_confirmed_at` |
| Phone | pending, verified | Presence of a normalized 10-digit Indian provider phone and `phone_confirmed_at` |
| Vendor registration | draft, submitted | Atomic unified registration submission |
| Administrator review | draft/pending, approved, rejected | Administrator compliance workflow |
| Compliance | pending, verified, rejected | Administrator licence/pharmacist review |
| Account control | active, inactive/suspended | Account administration; never provider synchronization |

An active vendor session may enter the restricted onboarding surface. Operational vendor UI and APIs require all of the following:

1. active account status;
2. provider-verified email;
3. provider-verified phone matching the submitted registration phone;
4. registration status `submitted`;
5. approval status `approved`;
6. compliance status `verified`.

Submission moves only the registration/review state. It does not grant operational access. Verification synchronization is idempotent and does not infer identity from vendor form values or recovered data.

## Compatibility and migration

Migration `0034_little_sunfire.sql` adds explicit vendor submission fields and provider-claim fields for deterministic local test sessions. It:

- copies test-session claims only from the explicitly linked `account_profiles` row;
- leaves recovered `customers` untouched;
- marks already approved/compliance-verified vendors as submitted;
- preserves P1-01 submissions using their `vendor.registration.submitted` audit event;
- leaves other vendors in `draft`;
- does not rewrite inactive or suspended account state.

The migration must be applied after `0033`. Hosted application is intentionally deferred to a controlled release.

## Duplicate identity and concurrency policy

**Decision:** P1-03, 12 August 2026

- Provider-confirmed email is normalized with `lower(trim(email))`; provider-confirmed Indian mobile is stored as exactly 10 digits.
- `account_profiles` is the global live-identity namespace across customer, vendor, administrator, and delivery roles. Recovered `customers` rows do not participate.
- D1's partial unique indexes are authoritative for non-empty normalized email and phone. Preliminary lookups improve the message but never decide race outcomes.
- Authenticated conflicts return HTTP `409` with code `identity_conflict` and only the conflicting field. They never return the other profile, role, name, or internal identifier.
- Public email signup uses the same neutral result for an accepted pending registration and a provider duplicate signal. This avoids an email-account enumeration oracle.
- Vendor profile and registration phone changes remain provider-verification-gated and show a recovery-oriented conflict without identifying the existing owner.
- Vendor profile and draft-vendor creation execute as one D1 batch. A losing email/phone race therefore leaves neither a partial live profile nor an orphaned vendor shell.

Migration `0035_outstanding_krista_starr.sql` creates case/whitespace-insensitive live-email uniqueness before dropping the former non-unique lookup index. It does not normalize, delete, merge, auto-link, or infer ownership for existing rows. Before applying it to an existing environment, run this read-only preflight and investigate any result against the provider identity before migration:

```sql
SELECT lower(trim(email)) AS normalized_email, COUNT(*) AS profile_count
FROM account_profiles
WHERE trim(email) <> ''
GROUP BY lower(trim(email))
HAVING COUNT(*) > 1;
```

If conflicts exist, migration application intentionally stops at the new unique-index creation while the old lookup index is still present. Resolve ownership through an approved provider-backed support process; never pick a winner from email/phone equality alone.

## Verification return and registration status

**Decision:** P1-04, 12 August 2026

- Vendor signup and unverified-login resend requests target the same-origin `/vendor/verification-return` route.
- The return route removes provider query/hash values from the browser address immediately, displays expired/error and returned states, and gives an explicit vendor sign-in fallback.
- P1-04 does not exchange a PKCE code, create a session, or automatically sign the user in. Those behaviors and their provider-specific decision remain P1-05.
- `/vendor/registration/status` is the canonical success/status destination after registration submission. It may also be opened later from the authenticated vendor card or onboarding screen.
- `/api/vendor/registration/status` requires the active pharmacy owner session. It returns identity verification, submission, licence, pharmacist, compliance, and administrator-review state without the private legal address, latitude, or longitude.
- One deterministic next action is derived in priority order: verify email, verify phone, finish registration, resolve rejection, add pharmacist, await review, or open operational workspace.
- Pending-review owners may upload and submit only their own licence/pharmacist onboarding records. Inventory, sales, orders, procurement, accounts, and all other vendor operations still require fully operational access.

P1-04 adds no migration. Supabase/Twilio keys, provider redirect allowlisting, real email delivery, expired-link behavior, and browser/provider contract tests remain environment work and P1-10. Automatic login remains P1-05.
