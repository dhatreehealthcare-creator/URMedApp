# Product/variant model and migration 0038

## Canonical model

The existing `products` row remains the global sellable product/variant during the compatibility period. This keeps every inventory, purchase, order, return, refill, ceiling-price, and alternate foreign key valid while downstream APIs move to structured fields.

The global variant now owns:

- generic/drug name and trade name, plus normalized search values;
- governed dosage-form and manufacturer foreign keys;
- a positive strength value paired with its normalized unit;
- pack container, positive pack size, pack-size unit, and dispensing UOM;
- the existing prescription requirement, HSN, drug schedule, and GST default;
- a governance state separate from catalogue activation.

Batch number, manufacture/expiry date, purchase cost, sale price, MRP, quantity, and vendor GST overrides remain inventory or receipt data. Legacy `name`, `composition`, `manufacturer`, `packaging`, `category_id`, `prescription_required`, and `gst_percent` columns remain readable until all consumers have migrated.

## Governance and alternates

Recovered `legacy_backup` catalogue rows are marked `approved` so the migration cannot hide the live catalogue. A future product submission defaults to `pending` and must be inactive. P2-03 allows a vendor to submit without editing a global approved row directly and currently requires an active administrator before setting both `governance_status = 'approved'` and `active = 1`. A future verified pharmacist-governance role would require a separate global authorization contract; ordinary vendor pharmacists cannot approve global records. The approval actor and before/after values belong in the immutable audit log.

An alternate link is not proof of clinical interchangeability. P2-04 may approve an alternate only when the governed active-ingredient identity, strength, dosage form, and approval state match. A legacy row missing any of those structured values is ineligible for automatic equivalence and requires pharmacist/admin review. Migration 0038 deliberately does not change `product_alternates` or approve existing links.

## Deterministic backfill

Migration `0038_pale_shape.sql` uses these conservative rules:

1. Link a manufacturer only by exact recovered display name or by the existing unique normalized name. It performs no fuzzy matching.
2. Do not use legacy `category_id` as a dosage form. The recovered seed assigns that value too broadly. Set `dosage_form_id` only when packaging contains exactly one word-bounded governed form.
3. Treat the recovered name as the trade name. Parse a generic name and strength only for a single-component expression containing exactly one final parenthesized positive value/unit.
4. Parse pack data only from `container of positive-size` descriptions with a recognized UOM. Retain the full legacy packaging text in every case.
5. Leave every ambiguous normalized value `NULL`. Missing structure is a review queue, not permission to infer clinical equivalence.

The migration writes aggregate linked/unresolved counts to `migration_audit` under entity `product_variant_backfill`. Exact counts must be reviewed in the target environment before enabling P2-03 writes.

Against the packaged 100,041-row recovered seed, the reviewed result is:

| Field | Deterministically populated | Left for review |
|---|---:|---:|
| Manufacturer FK | 100,041 | 0 |
| Dosage form | 51,919 | 48,122 |
| Strength value/unit | 27,963 | 72,078 |
| Pack value/UOM | 93,561 | 6,480 |

These are repository-seed observations, not a promise about hosted data. The target environment's `migration_audit.notes` is authoritative after migration.

## Migration and rollback review

D1 applies migration 0038 once through its migration ledger. SQLite does not support portable `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`; rerunning the raw SQL outside that ledger will fail on the first existing column. Recovery must therefore restore the pre-migration database backup or roll forward with a new migration—never manually rerun a partially applied file.

The added columns and indexes are backward-compatible because existing queries continue using legacy columns. The trigger guards do affect future product writes: pending/rejected/inactive variants cannot be active, structured value/unit pairs must be complete and positive, prescription flags must be Boolean, and GST must be 0, 5, 12, 18, or 28. Rollback requires dropping the two triggers and indexes; removing columns requires a SQLite table rebuild and should be avoided after structured writes begin.
