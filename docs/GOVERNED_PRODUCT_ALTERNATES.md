# Governed Product Alternates (P2-04)

## Decision D-09

An alternate link is a governed catalogue relationship, not a dispensing decision. Products are eligible only when both global records are active and administrator-approved and have the exact same normalized generic name, dosage form, structured strength value, and normalized strength unit. The application never substitutes a cart, order, prescription, or inventory item automatically.

The pharmacy owner or a currently verified vendor pharmacist may propose an eligible pair for their operational vendor. Only an active administrator may approve, reject, or deactivate the global relationship. A vendor sees its own proposal plus approved global links; another vendor's pending or rejected proposal is not disclosed.

## Lifecycle

- `pending`: vendor-created proposal awaiting administrator review.
- `approved`: administrator-reviewed global alternate link.
- `rejected`: administrator rejected the proposal with a reason; it may be corrected and resubmitted.
- `inactive`: an approved link was deactivated by an administrator or invalidated by a product's deactivation/clinical-identity edit.
- `withdrawn`: the submitting vendor withdrew its still-pending proposal.

Pairs are stored in ascending product-ID order. Database constraints reject self-links, mirrored duplicates, incompatible proposals, invalid transitions, and approval without an identified reviewer. Every proposal, resubmission, withdrawal, decision, and product-driven deactivation appends an immutable audit event.

## Migration 0040

Migration `0040_milky_grim_reaper.sql` rebuilds the former directed link table as the governed canonical model. Legacy links have no trustworthy review provenance, so they are canonicalized as `pending`; mirrored duplicates and self-links are rejected and counted in `migration_audit`. Administrators must review compatible legacy links before they become operational.

D1 applies this table-rebuild migration once through its migration ledger. The schema operations themselves are not intended to be rerun outside that ledger. Index and trigger creation is guarded, while the canonicalized-row counts provide migration review evidence. Back up hosted D1, review the migration audit, and validate pending legacy links before approval when deployment is later authorized.
