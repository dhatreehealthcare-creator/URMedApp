# Dosage-form taxonomy

URMED treats tablet, capsule, injection, ointment, cream, aerosol, transdermal patch, and syrup as pharmaceutical dosage forms. They are not commercial product categories.

The governed `dosage_forms` master owns stable numeric IDs, internal codes, URL-safe slugs, display names, ordering, and active/inactive status. Commercial categories remain in the separate `categories` master and may later describe groupings such as therapeutic, merchandising, or catalogue classifications.

## Canonical seed and legacy compatibility

| ID | Code | Slug | Name | Legacy category ID |
|---:|---|---|---|---:|
| 1 | `TAB` | `tablet` | Tablet | 1 |
| 2 | `CAP` | `capsule` | Capsule | 2 |
| 3 | `INJ` | `injection` | Injection | 3 |
| 4 | `OINT` | `ointment` | Ointment | 4 |
| 5 | `CRM` | `cream` | Cream | 5 |
| 6 | `AER` | `aerosol` | Aerosol | 6 |
| 7 | `TDP` | `transdermal-patch` | Transdermal Patch | 7 |
| 8 | `SYR` | `syrup` | Syrup | 8 |

The recovered catalogue currently stores these values in `products.category_id`. P2-01 deliberately leaves those foreign keys and the legacy `categories` rows unchanged so existing catalogue/search behavior is preserved. Stable dosage-form IDs match the legacy IDs, giving P2-02 a deterministic compatibility mapping when it adds the structured product/variant relationship. That later migration must not reinterpret future commercial category IDs as dosage forms.

P2-01 did not add product CRUD or structured variant columns. Migration 0038 subsequently adds `products.dosage_form_id` and the other P2-02 compatibility fields; connected governed CRUD remains P2-03 work.
