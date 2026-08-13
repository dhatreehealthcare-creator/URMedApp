# Manufacturer Governance and Merge (P2-05)

## Canonical identity

`products.manufacturer_id` is the source of truth for live manufacturer linkage. The legacy `products.manufacturer` string remains a display-compatibility field and is synchronized to the canonical name when an administrator approves a rename or merge. Search resolves the canonical manufacturer ID and its governed aliases; it no longer treats the legacy free-text product field as an independent manufacturer identity.

The recovered `manufacturers.id`, original display name, and normalized name are retained. Migration 0043 adds separate state, alias, request, and immutable governance-event records instead of deleting or replacing recovered identities.

## Governance policy

An operational vendor with product-submission permission may propose:

- a new global manufacturer;
- a rename of an active canonical manufacturer; or
- a merge from one active canonical manufacturer into another.

The proposal affects only the submitting vendor's visible request queue. It does not alter the global manufacturer master. Only an active administrator may approve or reject a request.

## Transactional rename and merge

Approval uses a D1 batch so request version validation, canonical changes, product foreign-key/display updates, alias movement, merge-state changes, and governance-event evidence either commit together or roll back together.

Optimistic request versions and partial uniqueness constraints prevent duplicate pending requests and stale approvals. A merge target must be active and canonical. Self-merges are rejected. Because a merged record cannot be a target, and any prior incoming merge references are flattened with incremented state versions to the new active target, cyclic merge state cannot be created.

No manufacturer or alias is deleted. On rename, the old canonical name remains an alias. On merge, source aliases move to the target while retaining source/provenance metadata, and the source manufacturer's state records its canonical target. Historical audit and governance events remain immutable.

## Deployment review

Migration 0043 will backfill every recovered manufacturer as active canonical state and record its recovered name as a provenance-bearing alias. Before applying it to hosted D1, take a backup and review normalized-name/alias collisions and the migration audit totals. No fuzzy or inferred merging is performed during backfill; all merges require an explicit administrator-reviewed request.
