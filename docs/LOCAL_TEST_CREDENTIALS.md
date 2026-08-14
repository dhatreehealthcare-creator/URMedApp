# Local URMED test credentials

These accounts are deterministic fixtures for local development and the
packaged local D1/R2 integration suite only. They are not real users and must
never be created in Supabase, Cloudflare, or any hosted/production database.

| Role | Email | Password |
|---|---|---|
| Admin | `admin@urmed.test` | `Urmed@Test2026!` |
| Vendor owner | `vendor@urmed.test` | `Urmed@Test2026!` |
| Customer | `customer@urmed.test` | `Urmed@Test2026!` |

The password is stored only as a SHA-256 fixture hash in the local migration
and test fixture. Production authentication never accepts these credentials.

## Local authentication

The test-login endpoint is available only when `APP_STAGE=integration` and a
per-run `INTEGRATION_TEST_AUTH_SECRET` of at least 32 characters is present.
The integration harness generates that secret automatically. Supply it in the
`x-urmed-integration-key` header when posting the email and password to:

```text
POST /api/auth/test-login
```

The response contains a short-lived isolated test bearer token. Test sessions
are stored as hashes, expire after eight hours, and are replaced on a later
login for the same fixture account.

## Seeded local data

The vendor fixture is an approved, operational pharmacy tenant with a verified
licence and pharmacist, published pickup location, inventory, supplier, and
pricing data. The customer fixture has an owned address and receives dynamic
cart/order fixtures during integration tests; carts are intentionally
client-session state and are not persisted as fake production orders.

The local fixture also contains secondary vendors/customers, operational staff,
inactive/unverified accounts, and an archive-only recovered customer for
authorization and tenant-isolation tests.

## Reset

Run the packaged integration command to create a fresh disposable D1/R2 state:

```bash
npm run test:integration:built
```

Do not copy these credentials into `.env`, hosted secrets, screenshots, logs,
or production documentation.
