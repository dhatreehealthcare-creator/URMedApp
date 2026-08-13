# Governed product master

The connected product master implements the current D-02 policy: an operational vendor owner or vendor pharmacist may submit a structured product, but only an active URMED administrator may approve, reject, edit, or deactivate the global catalogue record. A vendor submission is always `pending` and inactive. Vendor reads include the active approved global catalogue plus only that vendor's own submissions; another vendor's pending or rejected submissions are not exposed.

Every submission and governance change appends an immutable audit event. The event records the submitting vendor, actor, normalized structured fields, state change, reason where required, request ID, and hash-chain predecessor. Ordinary vendor pharmacists have no global approval authority.

## Compatibility identifiers

Existing downstream tables require `products.legacy_id`. New governed rows therefore receive an internal compatibility ID atomically inside their insert statement:

- allocation starts at `900000000`;
- each insert uses the current maximum plus one under the existing unique constraint;
- allocation stops before `1000000000`;
- the ID is explicitly labelled a compatibility ID in the API/UI and is not represented as recovered provenance.

No hosted sequence or extra schema is required. A uniqueness race returns HTTP 409 and is safe to retry after refreshing the catalogue.

## API behavior

- `GET /api/vendor/products` searches/paginates active approved products and the authenticated vendor's submissions.
- `POST /api/vendor/products` validates and creates a pending inactive submission.
- `PATCH /api/vendor/products` lets the same vendor edit/resubmit or withdraw only its pending/rejected record.
- `GET /api/admin/products` searches/paginates the global governance queue and catalogue.
- `PATCH /api/admin/products` edits structured fields or performs approve/reject/deactivate transitions.

Approvals require generic/trade names, active dosage-form and manufacturer references, a positive structured strength pair, positive pack/UOM values, and no duplicate active variant. Deactivation is rejected while an active inventory batch has physical or reserved stock. GST, prescription, HSN, schedule, cold-chain, and text inputs are server validated; browser values are never trusted.

P2-03 does not implement alternate relationships or infer clinical substitutability. That remains P2-04 under the exact D-09 compatibility and explicit approval policy.
