# Operational report performance review

## Benchmark command and methodology

Run the reproducible local benchmark with:

```sh
npm run benchmark:reports
```

It uses Node's `node:sqlite` against a fresh in-memory database for each scale and writes machine-readable output to `scripts/report-performance.latest.json` (or the path supplied by `URMED_REPORT_BENCHMARK_OUTPUT`). The default run creates 10,000, 100,000, and 1,000,000 rows per synthetic entity (inventory, orders/items/invoices, expenses, and delivery assignments), distributes them across eight vendors, and queries tenant `2` over a one-year date range. It captures page 1, an offset-10,000 page, full grouped totals, `EXPLAIN QUERY PLAN`, candidate bounds, and export limits. The fixture contains no customer names, addresses, phone numbers, or coordinates.

This is reproducible local evidence, not a claim about hosted Cloudflare D1 latency. Hosted benchmarking requires an approved anonymized snapshot and a separately approved provider/UAT run.

## Observed results

| Scale | Load | Stock total/query | Sales total/query | Expense total/query | Home-delivery total/query | Delivery candidate bound |
|---:|---:|---:|---:|---:|---:|---:|
| 10k | 147.67 ms | 125 / 0.90 ms | 365 / 3.69 ms | 1,092 / 1.03 ms | 1,250 / 0.47 ms | 1,250, post-filter 625, no overflow |
| 100k | 1,887.44 ms | 125 / 10.05 ms | 365 / 52.77 ms | 1,092 / 10.02 ms | 12,500 / 5.36 ms | 12,500, post-filter 6,250, no overflow |
| 1m | 23,170.31 ms | 125 / 138.48 ms | 365 / 798.86 ms | 1,092 / 148.04 ms | 125,000 / 84.25 ms | 125,000, post-filter 62,500, explicit overflow |

The reported timings are one local run on the developer machine; the JSON output records the exact run timestamp, plans, page timings, row counts, and risk flags. They are comparison evidence, not an SLA.

## Query-plan findings

- Stock uses `pharmacy_inventory_vendor_idx` and the product primary key. Grouping and ordering require temporary B-trees; this is expected for grouped output and is not a tenant scan.
- Sales uses `tax_invoices_source_date_idx`, order primary-key lookups, and `order_items_order_idx`. Grouping uses a temporary B-tree. Tenant and date predicates are applied before grouping; no date-function predicate bypass was detected.
- Expenses uses `expenses_vendor_date_idx` with a vendor/date range. Grouping and ordering use temporary B-trees.
- Home delivery uses the composite `orders_vendor_delivery_date_idx (vendor_id, delivery_method, created_at, id)` and `delivery_assignments_order_idx`. It has no full scan or temporary B-tree in the benchmark plan. The benchmark retains 12,500 candidates and applies a derived post-filter to 6,250 rows at 100k, proving rows beyond the former 5,000 candidate boundary are not silently discarded. At 100k the offset-10,000 probe remains populated and is slower than page 1, so large exports should use the bounded export contract or a future keyset/materialized fact strategy.
- Production sales and home-delivery loaders now use half-open timestamp ranges (`>= start`, `< next day`) rather than wrapping indexed timestamp columns in `date(...)` predicates. Display grouping still derives a calendar date after the range has been narrowed.
- No N+1 query is present in the benchmark SQL. Production loaders still require periodic plan review against a representative D1 snapshot, especially the sales CTEs and derived home-delivery distance/SLA filters.

## Change made

Migration `0060_report_delivery_access.sql` adds only the justified home-delivery access path:

```sql
CREATE INDEX orders_vendor_delivery_date_idx
  ON orders(vendor_id, delivery_method, created_at, id);
```

The index is mirrored in `db/schema.ts`. No speculative indexes were added for temporary grouping B-trees. The home-delivery loader applies its date/vendor/method predicates in SQL, bounds candidate work at 100,001 rows, and returns an explicit overflow error rather than silently dropping rows. Derived filters and privacy removal happen before response pagination. Synchronous CSV/XLSX/PDF exports remain complete filtered exports up to 5,000 grouped rows and return HTTP 422 above that documented cap; JSON remains the paginated contract for larger result sets.

## Remaining scalability risks

1. The benchmark is synthetic and local. Run the same script against an approved anonymized D1 snapshot before setting production SLOs.
2. Grouped reports use temporary B-trees, which may become material at larger cardinalities. A daily reporting fact table or pre-aggregation should be considered only after D1 plans and timings justify it.
3. Offset pagination gets slower at high offsets. Keyset pagination or an asynchronous export job is the next scaling option if the 5,000-row synchronous contract becomes insufficient.
4. Home-delivery distance/SLA derivation remains in Worker memory by design to avoid exposing coordinates. The 100,001 candidate bound is an explicit safety boundary, not unlimited scalability.
5. Production provider latency, D1 regional behavior, and browser download performance are not measured here.

## Hosted release-gate checklist

The following gates remain external and are intentionally not marked complete by this local benchmark:

- [ ] Supabase project, redirect allowlists, session expiry/revocation, and role-based browser UAT.
- [ ] Twilio/OTP sender, verified-number policy, rate limits, and failure/retry UAT.
- [ ] Resend credentials, sender/domain verification, transactional outbox delivery, retry/dead-letter and provider-ID evidence.
- [ ] Razorpay test keys, callback URLs, webhook secret rotation/replay tests, payment/refund reconciliation.
- [ ] R2 bucket, encryption/key rotation, object lifecycle, quarantine and recovery checks.
- [ ] Scheduled Worker cron configuration, monitoring, alerting, lease recovery, and missed-job replay.
- [ ] Backup/restore drill for D1 and R2, checksum verification, and rollback rehearsal.
- [ ] Browser/device UAT for admin reports and exports, accessibility (keyboard/screen reader), privacy review, and download behavior.
- [ ] Performance/privacy review against approved representative data and rollback testing for migration `0060`.

No hosted provider, production secret, deployment, or external resource was accessed for this review.

## Accounting approval gate

The recognition and closing rules in `docs/ACCOUNTING_RECOGNITION_AND_CLOSING_POLICY.md` remain implementation defaults until an accountant approves the policy version and its inventory valuation, accrual, GST-period, opening-balance, and close-period rules.
