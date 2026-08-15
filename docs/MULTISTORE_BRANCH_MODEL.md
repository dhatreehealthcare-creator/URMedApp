# URMED branch/store model (P1-MULTISTORE-01)

URMED keeps the legal pharmacy vendor as the tenant boundary. A vendor may own
one or more operational branches in `pharmacy_branches`; every branch has a
unique vendor-local code, active/inactive status, private operational address
and coordinates, and branch-specific pickup/delivery capability and radius.

Customer discovery uses only the branch `public_*` location fields when the
branch location is explicitly published. Private legal vendor coordinates are
never used as a public fallback. The legacy `vendor_public_locations` record is
retained for compatibility and is synchronized to the deterministic primary
branch.

Migrations 0064–0065 create one `PRIMARY` branch per existing vendor, assign
existing inventory, orders, offline sales, and purchase orders to it. This is a
reference backfill: stock is not copied, merged, or revalued. Vendors created
after the migration receive the same primary branch through a database default
trigger, legacy public-location writes update that primary branch, and the
database FEFO/stock guards are branch-scoped.

Inventory ownership is `vendor → branch → product → batch → stock`; the branch
and vendor are checked by database guards. Vendor branch APIs require the
existing vendor permission model, while the directory API is admin-only. Owners
can assign active staff to a branch through the branch API; assigned staff are
restricted to that active branch for inventory, purchases, POS, order queue and
order-tracking mutations. Unassigned staff retain vendor scope according to
their existing role permissions.

Admin stock, sales and home-delivery reports accept an optional `branchId`
filter in addition to the existing vendor filter. Report responses continue to
omit private legal coordinates and customer address data.

The current fulfillment policy is deliberately single-branch: a customer cart
groups lines by branch, and checkout rejects a mixed-branch group with a
separate-order instruction. Cross-branch split orders require a future product
and accounting decision; no silent split or stock merge is performed.

Hosted authentication, payment, and UAT gates remain external and were not
accessed by this local implementation.
