# Endpoint abuse controls

URMED's local and packaged Worker builds use the D1-backed fixed-window limiter in
`lib/abuse-controls.ts`. Each request is keyed by a route policy, a hashed client
address, and (when available) the authenticated profile ID. Raw addresses are not
persisted. The limiter increments a unique `(route_key, subject_hash,
window_start_ms)` bucket atomically, so concurrent requests cannot bypass the
limit or create duplicate counters.

| Policy | Limit | Window | Keying | Protected surfaces |
| --- | ---: | ---: | --- | --- |
| `auth` | 12 | 60 seconds | IP + profile when known | profile synchronization and registration writes |
| `upload` | 6 | 60 seconds | IP + authenticated profile | document/R2 uploads, before multipart parsing and quota/storage work |
| `payment` | 12 | 60 seconds | IP + authenticated profile | Razorpay order, verify, and refund routes |
| `webhook` | 120 | 60 seconds | IP | Razorpay webhook after the bounded body check and before HMAC/JSON/D1 work |
| `public_search` | 60 | 60 seconds | IP | public catalog and inventory search |
| `gps` | 30 | 60 seconds | IP + authenticated profile | delivery location and delivery-proof updates (the domain still enforces a 15-second freshness/replay guard) |

Exceeded limits return a stable non-enumerating `429` response with
`Retry-After`, `Cache-Control: no-store`, and rate-limit headers. Limiter storage
failures fail closed with a non-cacheable `503`; this protects provider/R2/D1
costly paths when the abuse-control dependency is unavailable. Expired buckets
are removed opportunistically and fixed-window reset makes legitimate retries
possible after the advertised interval. Endpoint idempotency remains authoritative
for payment, webhook, and workflow retries; a retry that is already idempotent is
not treated as a second business transaction.

Oversized Razorpay webhook bodies are rejected with `413` before the limiter,
signature verification, JSON parsing, provider logic, or D1 writes. Upload limits
run after the required authenticated profile check but before multipart parsing,
quota reservation, and R2 access. GPS proof freshness/replay checks remain in the
delivery domain logic in addition to the request-rate limit.

The D1 bucket is the deterministic local/packaged implementation. A production
deployment must bind an approved Cloudflare Rate Limiting or equivalent durable
edge service and preserve these route policies, response semantics, and fail-closed
behavior. Hosted binding configuration, provider-side Supabase/Twilio/Razorpay
limits, and production tuning are release-gate work and are intentionally not
claimed by this local slice.
