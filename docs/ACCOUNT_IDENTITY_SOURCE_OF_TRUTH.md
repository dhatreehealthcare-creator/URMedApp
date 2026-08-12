# Account identity source of truth

**Decision:** Accepted for P0-07 on 2026-08-12  
**Scope:** Live URMED identities, roles, customer-owned operational data, and the imported `customers` archive

## Decision

URMED uses three deliberately separate identity layers:

| Concern | Authoritative system or table | Rule |
|---|---|---|
| Credentials, password, OTP, verified email/phone, and browser session | Supabase Auth | D1 never stores production credentials or decides whether a Supabase credential is valid. |
| Live URMED identity, role, status, and ownership key | D1 `account_profiles` | `account_profiles.id` is the only application-level profile key used by orders, prescriptions, addresses, reminders, consents, notifications, documents, vendors, staff, administrators, and delivery agents. |
| Imported legacy customer evidence | D1 `customers` | This is an admin-only, immutable recovery archive. Its rows are not accounts, cannot authenticate, own no live records, and are not included in live customer totals. |
| Local test identities | D1 `test_accounts` and `test_sessions` linked to `account_profiles` | Test-only authentication support. It does not change the production authority rules above. |

The canonical live identity chain is:

`Supabase user ID -> account_profiles.auth_user_id -> account_profiles.id -> operational records`

The `customers` table must never be used as a fallback identity or login source.

## Repository evidence

- `account_profiles.auth_user_id` is unique and is the lookup used after bearer-token authentication.
- Live API authorization calls `requireLocalProfile`, which requires an active profile and checks the allowed role.
- Customer-owned tables reference `account_profiles.id`; none references `customers.id`.
- Orders, prescriptions, customer safety, refills, and notifications scope reads and writes with the authenticated profile ID.
- The `customers` table is populated only by the controlled legacy import and is read only by the authenticated administrator recovery endpoint.
- Only three of 7,371 legacy rows passed the original import filters. Legacy passwords were deliberately excluded.

## Required invariants

1. A live request must authenticate through Supabase Auth or the explicit local test-session mechanism, then resolve exactly one active `account_profiles` row by `auth_user_id`.
2. Live customer counts and reports must query `account_profiles` with role `customer`, not `customers`.
3. All new customer-owned foreign keys must reference `account_profiles.id`.
4. `customers.email`, `customers.mobile`, and legacy verification flags are historical evidence only. They do not prove current ownership.
5. Email or phone equality may identify a claim candidate, but must never create a link or overwrite live profile data automatically.
6. No password reset, login, session, authorization, consent, order, prescription, reminder, or notification flow may read from `customers`.
7. The recovery archive is admin-only and must always be labelled as reference data, separately from live registrations.
8. Import/repair tooling may write the archive; normal customer and operational APIs may not mutate it.

## Future claim and link strategy

No recovered row is linked today. A later, separately approved implementation should use an explicit claim workflow:

1. The person first creates or signs into a Supabase account and obtains an active `account_profiles` row with role `customer`.
2. A normalized email/phone match may surface a possible legacy record, but it remains unlinked.
3. The claimant must prove current control of both contact channels when both are present. Mismatches, duplicates, inaccessible contacts, or conflicting live profiles require an audited administrator/support review.
4. Store the result in a dedicated table such as `legacy_customer_links`, rather than adding authentication fields to `customers`. Recommended fields are:
   - unique `legacy_customer_id` referencing `customers.id`;
   - unique `profile_id` referencing `account_profiles.id`;
   - `status` (`pending`, `verified`, `rejected`, `revoked`);
   - evidence/match basis and verification timestamps;
   - reviewer profile where manual review was required;
   - created, updated, and revoked timestamps.
5. Insert a verified link and its audit event in one transaction. Repeated claims must be idempotent; a row or profile already linked elsewhere must fail with a conflict.
6. Do not overwrite the live name, email, phone, or verification state. Optional address import requires the authenticated customer’s explicit confirmation and creates a normal `customer_addresses` record.
7. Preserve the original legacy row and import provenance. Revocation disables the association without rewriting the archive.
8. Any future legacy order import should retain its legacy key and resolve ownership through the verified link; it must not change current operational order ownership silently.

## Conflict handling

| Situation | Required result |
|---|---|
| One email and phone candidate | Offer a claim; do not auto-link. |
| Email-only or phone-only match | Require additional proof or manual review. |
| Email and phone point to different rows | Block automated progress and investigate. |
| Multiple candidates | Block automated progress and investigate. |
| Legacy contact differs from the live profile | Never overwrite the live profile; require reviewed evidence. |
| Legacy row says “verified” | Treat as historical metadata, not present-day proof. |
| Claimed live profile becomes inactive | Keep audit/provenance; deny live access through normal profile status enforcement. |

## Reporting and terminology

- **Live customer / registration:** active or historical `account_profiles` rows with role `customer`, according to the report’s stated status filters.
- **Recovered customer reference:** a row in `customers`; never add it to live registration counts.
- **Claimed legacy reference:** a recovered row with a future verified link. It remains one live customer, not an additional customer.
- Dashboards and exports must show live and recovered counts separately with these labels.

## Migration and rollback considerations

P0-07 changes no database structure or production records. No migration is required. The future claim table and any data-copy operation require their own reviewed migration, uniqueness constraints, audit coverage, conflict tests, privacy review, and rollback plan. The current archive remains intact and unlinked until that work is explicitly authorized.
