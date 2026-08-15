# URMED Requirements Gap Analysis and Implementation Roadmap

**Analysis date:** 12 August 2026
**Application:** URMED Pharmacy & Medicine Delivery
**Purpose:** Trace the supplied vendor, customer, and administrator requirements against the current codebase, identify functional and technical gaps, and define a dependency-aware implementation plan.

## 1. How to use this document

This is the working source of truth for the remaining implementation. Each requirement has a stable ID that should be referenced in commits, pull requests, tests, and release notes.

Status legend:

- **Implemented:** A database-backed user flow and server-side validation exist.
- **Partial:** Some UI, API, or data support exists, but the requirement is not complete end to end.
- **Prototype:** A visible screen exists, but it uses static data or only changes local component state.
- **Missing:** No usable implementation was found.
- **Decision required:** Product or compliance clarification is needed before implementation.

When work starts, change the relevant roadmap checkbox from `[ ]` to `[x]` only after its acceptance criteria and tests pass.

## 2. Executive assessment

URMED is not an empty prototype. It already has a strong transactional foundation:

- public catalogue search backed by the recovered product database;
- Supabase-based public authentication hooks and local test accounts;
- D1-backed customer, vendor, stock, order, prescription, delivery, accounting, consent, and reminder records;
- R2-backed document uploads with extension, MIME, size, and file-signature validation;
- vendor compliance review for drug licences and pharmacists;
- supplier management and multi-line purchase receiving;
- batch-level inventory, FEFO allocation, expiry controls, quarantine controls, and stock ledger entries;
- online and offline orders, GST calculation, Razorpay payment endpoints, and delivery state transitions;
- prescription upload and verified-pharmacist review;
- pill and refill reminders;
- expense and ledger records, audit events, and several admin summary queries.

The application now has substantially more live, database-backed workflows than the original baseline. Immutable GST invoice HTML/PDF generation, authenticated download, scheduled stock/reminder alerts, and the requested operational admin reports are now implemented. The remaining gaps are concentrated in:

1. governed UOM/presentation conversion, barcode identifiers, price history, and tax-inclusive MRP policy;
2. complete sales returns/COD reconciliation, message outbox reliability, and genuine accounting statements;
3. hosted-provider configuration, malware scanning, broader abuse controls, legal retention decisions, and browser/UAT evidence.

Production demo rows, fixture credentials, private-location exposure, and the broad role switch have been removed from production surfaces. Provider-independent implementation is testable locally, but the application is not release-ready until the Phase 7 provider, security, compliance, and UAT gates are closed.

### Baseline verification

- Production Vinext artifact: **build and artifact validation passed**.
- Lint: **passed**.
- Automated tests: **283 of 283 unit/regression tests passed**.
- Packaged-Worker integration: **18 of 18 isolated real-HTTP D1/R2 scenario groups passed** against all 47 clean migrations, including a repeat migration pass with zero reapplication.
- There is still no hosted-provider browser-level registration-to-order or purchase-to-report test.
- The repository has no local `.env` file. Hosted environment values may exist outside the repository, but local Supabase, Resend, Razorpay, encryption, and scheduled-job integration readiness cannot be assumed.

## 3. Current architecture

| Area | Current implementation | Assessment |
|---|---|---|
| Web application | Next-compatible App Router on Vinext/Vite with a public marketplace and dedicated `/vendor`, `/customer`, `/admin`, and `/delivery` workspaces | Each role workspace has a direct URL and mounts only after an active exact-role profile is confirmed |
| Structured data | Cloudflare D1 with Drizzle schema and SQL migrations | Strong foundation; several tables are ahead of their UI |
| Files | Cloudflare R2 plus `stored_documents` metadata | Suitable foundation; malware scanning is not actually implemented |
| Public authentication | Supabase Auth; Twilio is expected through Supabase phone provider configuration | Unified vendor/customer flows and protected callback/recovery pages are implemented; real provider keys, allowlists, and hosted E2E remain release blockers |
| Email | Supabase verification email plus Resend helper for transactional messages | Provider-dependent; failures are not queued or retried |
| Payments and invoices | Razorpay order/verification/webhooks/refunds, expiring D1 stock reservations, immutable GST invoice snapshots, and deterministic HTML/PDF rendering | Reservation, payment/refund, invoice finality, replay controls, and COD collection evidence are integration-tested; hosted provider reconciliation remains pending |
| Maps/geolocation | Browser geolocation and Leaflet-based picker | Private legal and explicitly published service locations are separated; saved customer addresses and fresh/rate-limited rider proof are implemented |
| Authorization | Active local role profiles, exact-role route gates, role-scoped APIs, vendor permissions, and test sessions | Human admin bypasses and the production role switch are removed; server/API authorization remains the security boundary |
| Tests | 283 unit/regression tests plus 18 isolated packaged-Worker D1/R2 HTTP scenario groups | Provider-independent transactional, identity, tenant, procurement, cart/payment/invoice, delivery, POS/Rx, notification, scheduled-job, and storage controls are covered; hosted-provider/browser/UAT layers remain |

## 4. Immediate defects and risks

These should be addressed before adding broad new features.

| Priority | Finding | Impact | Required action |
|---|---|---|---|
| Resolved P0-01 | Purchase receiving formerly saved `received`, while supplier-return queries required `posted` | Valid received stock could be absent from the selector | `received` is canonical, legacy `posted` remains compatible/normalized, and real-D1 HTTP coverage proves selector and return side effects |
| Resolved P0-02–P0-04 | Online orders formerly decremented stock before payment and did not recover abandoned reservations | Unpaid or abandoned orders could remove sellable stock indefinitely | Expiring reservations now commit/release once and scheduled recovery handles no-traffic periods; real-D1 coverage proves each terminal path |
| Resolved P0-05 | Vendor compliance UI formerly relied on inconsistent owner-only authorization | Signed-in administrators could fail while a special header succeeded | All human admin APIs/UI calls use active administrator bearer sessions; role and inactive-session boundaries are integration-tested |
| Resolved P0-06 | Public auth UI formerly allowed role switching inside one page instead of enforcing route and role access | Users could see irrelevant workspaces; authorization behavior was hard to reason about | Dedicated exact-role routes and a shared active-profile gate are now in place; the production switch and duplicate delivery login were removed |
| Resolved P1-01–P1-10 foundation | Vendor/customer registration, verification return, account recovery, profile, public location, and resume state were fragmented or missing | Incomplete users had ambiguous readiness and unsafe fallbacks | Unified provider-authoritative flows, dedicated pages, resumable state, privacy boundaries, and deterministic packaged integration coverage are implemented; real Supabase/Twilio keys and hosted browser E2E remain P7-01/P7-08 blockers |
| Resolved test-auth exposure | Fixture credentials and a test-login card were formerly visible in production UI | Known fixtures could have created an alternate login path | Production UI contains no fixture credentials; the server contract is accepted only in the integration stage with a strong per-run secret, and production rejects test tokens before D1 access |
| Resolved customer registration | Customer signup formerly split email and phone-only paths | Neither path met the required identity journey | One provider account now collects name, email/password and required mobile OTP, and both verified factors gate all customer operations |
| Resolved product master foundation | Product master was a local-state prototype | Vendors/admin could not govern products, manufacturers, or alternates | Dosage forms, structured variants, governed product CRUD, clinical alternates, manufacturer proposals/merge, and live UI/API surfaces are implemented |
| Resolved operational reporting / accounting pending | Admin operational reporting formerly consisted of fixed-limit summary queries | Requested stock, sales, expense, and home-delivery reports now have authenticated filters, pagination, totals, and safe CSV export | Add chart-of-accounts drilldown, opening balances, reconciliation, trial balance, P&L, balance sheet, broader exports, and packaged report coverage under P6-04/P6-08/P6-10/P6-11 |
| Resolved location privacy | Public inventory and delivery formerly exposed or fell back to private legal coordinates | Registered legal and movement locations could be disclosed or falsified | Public inventory uses only explicitly published locations; delivery uses published pickup points, fresh/rate-limited GPS proof, minimized completed-order PII, and no permanent location-ping audit amplification |
| P7-02 partial | New uploads now pass a deterministic local content scanner, remain `pending_scan` until clean, and suspicious files are quarantined and non-downloadable | Local EICAR/active-content detection prevents immediate exposure, while legacy `content_validated` rows remain grandfathered | Connect an approved hosted AV provider and asynchronous retry/retention workflow before production malware protection is claimed |
| P7-03 partial | Endpoint-specific abuse controls now use durable D1 fixed-window buckets for auth/profile, uploads, payments, webhooks, public search, and GPS, with hashed identities and stable 429 responses | Local and packaged Worker requests are bounded before costly parsing/provider/R2 work and concurrent search throttling is proven | Bind and tune an approved hosted edge limiter, add provider-side Supabase/Twilio/Razorpay controls, and complete session-revocation/UAT gates before claiming production abuse protection |
| P7-05 partial | Added explicit local D1/R2 backup manifests, SHA-256 artifact checksums, schema/migration/tenant/evidence validation, staged restore verification, corruption rejection, and machine-readable recovery reports | Local backup/restore is deterministic and exercised against the packaged Worker state without hosted access | Hosted Cloudflare backup retention, encryption/versioning, restore authorization, disaster-recovery objectives, and production restore drills remain external release gates |
| Resolved P0-08 | `npm run build` formerly depended on Linux GNU `timeout`, and `vinext start` did not inject local D1/R2 bindings | macOS production-like local verification was confusing and database/file APIs returned HTTP 500 | Build now uses a portable bounded runner; production preview runs the packaged Worker with persistent local D1/R2 bindings and applies packaged migrations |
| P2 | Resend failures return `sent: false` but are not retried or surfaced | Verification-adjacent and order messages can be silently lost | Add an outbox, retry policy, delivery status, and admin visibility |
| Resolved customer cart | The live product/order flow formerly supported one selected product | Multi-item checkout could not be completed | The live cart now supports multiple lines, quantities, pharmacy grouping, server revalidation, saved addresses, Rx selection, payments, history, cancellation, and reorder preparation |
| Resolved P0-07 | `customers` legacy records and live `account_profiles` formerly lacked an explicit ownership policy | Reporting and identity ownership could become ambiguous | Supabase Auth now has the documented credential authority, `account_profiles` is the live application identity/ownership source, and `customers` is an unlinked admin-only reference archive |

## 5. Requirement traceability matrix

### 5.1 Vendor registration, login, and profile

| ID | Requirement | Status | Current evidence | Gap / required completion | Phase |
|---|---|---|---|---|---|
| V-REG-01 | Shop/business name | Implemented | Collected, draft-persisted/resumable, validated, and submitted through the unified authenticated vendor-registration wizard | None for the stated requirement | 1 |
| V-REG-02 | Owner name | Implemented | Collected, length-bounded, draft-persisted, and submitted through shared server validation | Stronger legal-name guidance remains a compliance-policy option | 1 |
| V-REG-03 | Phone, exactly 10 digits | Implemented foundation | Provider-confirmed Indian mobile claims are normalized to one 10-digit value, globally unique in live profiles, synchronized to D1, and required for submission and operational access | Add hosted-provider E2E coverage under P1-10 | 1 |
| V-REG-04 | Ask for and verify phone OTP | Implemented foundation | Supabase phone OTP/phone-change verification is authoritative; a browser request cannot assert verification, and email-only or phone-only completion is rejected | Complete dedicated resend/recovery UX and hosted-provider E2E coverage under P1-07/P1-10 | 1 |
| V-REG-05 | Validate phone already registered | Implemented foundation | Authenticated preflight plus the final normalized-phone D1 constraint return a structured recovery-oriented conflict; concurrent packaged-Worker requests prove exactly one winner and no partial vendor shell | Add real Supabase/Twilio provider-contract and browser coverage under P1-10 | 1 |
| V-REG-06 | Landline, 10 digits | Implemented | Included in onboarding; optional under D-04 and validated as exactly 10 digits when entered | None for the stated requirement | 1 |
| V-REG-07 | Email and duplicate validation | Implemented foundation | Public provider duplicate signals use a neutral non-enumerating result; authenticated D1 linking enforces case/whitespace-insensitive global uniqueness and returns structured conflicts | Add real Supabase email provider-contract and browser coverage under P1-10 | 1 |
| V-REG-08 | Password | Implemented | Supabase email/password registration, confirmation, strong-password validation, secure change, and recovery pages exist | Hosted provider rate-limit/session policy remains P7-01/P7-03 | 1 |
| V-REG-09 | GST number | Implemented foundation | Optional GSTIN is included in registration and format-validated under D-05 | Enforce the GST-rated selling gate in the sales phase | 1 |
| V-REG-10 | Required licence upload; JPG/JPEG/PNG/PDF/DOC/DOCX | Implemented foundation | The wizard requires the exact allowed formats; signature/MIME checks, 8 MB limit, R2 metadata, licence record, and pending review are wired | Add upload progress/retry and Phase 7 quarantine/malware scanning | 1, 7 |
| V-REG-11 | Private address with geolocation, latitude, longitude | Implemented | Unified wizard requires, validates, draft-persists, and submits a private legal address/pin; public pickup/service points use a separate consented record | Private map-tile provider privacy remains a P7-07 review item | 1 |
| V-REG-12 | Registration success page | Implemented | Submission moves to `/vendor/registration/status`, which shows identity, licence, pharmacist, compliance, administrator-review, rejection, and operational milestones with one next action | Hosted browser E2E coverage remains P1-10 | 1 |
| V-REG-13 | Email verification link sent | Partial | Supabase signup/resend targets the dedicated same-origin vendor verification-return route | Configure/verify provider redirect allowlist, template, expiry, resend limits, keys, and delivery observability | 1, 7 |
| V-REG-14 | Verification link returns user and auto-logs in | Partial | `/vendor/verification-return` handles safe returned/error states, scrubs callback parameters, and provides explicit sign-in/status continuation | Decide and prove provider-specific auto-login under P1-05; add hosted-provider/browser E2E under P1-10 | 1 |
| V-LOGIN-01 | Vendor email/password login | Implemented | Dedicated Supabase password login, verification-pending, forgot/reset-password, sign-out, and role-safe continuation routes exist; test login is integration-only | Hosted lockout/rate-limit/session-expiry policy remains P7-01/P7-03 | 1 |
| V-LOGIN-02 | Only verified email can login; otherwise resend link | Partial | Login catches “email not confirmed” and resends | Confirm provider settings prevent unverified sessions; add resend throttling and E2E test | 1 |
| V-PRO-01 | Editable business/owner/phone/landline/GST | Implemented | Live D1-backed vendor setup form and API exist | Add field-level errors and concurrent-update handling | 1 |
| V-PRO-02 | Phone re-verification and duplicate validation | Implemented foundation | Supabase phone-change OTP plus matching provider-claim and D1 conflict checks prevent spoofing/races | Hosted-provider OTP expiry/recovery E2E remains P7-01/P7-08 | 1 |
| V-PRO-03 | Email read-only | Implemented | Email is read-only in vendor setup | Document support/admin process for a legal email change | 1 |
| V-PRO-04 | Licence replacement/upload | Implemented foundation | Multiple licences, current/expiring/expired states, replacement upload, document status, and guarded admin review exist | Malware quarantine/scanning remains P7-02 | 1, 7 |
| V-PRO-05 | Private geo address and coordinates | Implemented | Legal address/pin is owner/admin-only; public pickup/service location is a separate opt-in record and customer APIs do not fall back to private coordinates | Private map-tile provider privacy remains P7-07 | 1 |
| V-PRO-06 | Home delivery Yes/No | Implemented | Stored with delivery radius and enforced for pharmacy delivery | Add customer-facing availability derived from server policy | 1 |
| V-PRO-07 | Bank name, account name/no, IFSC | Implemented | Account number is encrypted; vendors receive last-four/status only; administrators can guardedly verify/reject masked active records with atomic audit evidence | Encryption-key rotation remains P7-01/P7-04 | 1, 7 |
| V-PRO-08 | Change password | Implemented | Supabase secure-password reauthentication nonce and strong replacement policy are implemented, with dedicated recovery flow | Hosted provider E2E remains P7-08 | 1 |

### 5.2 Vendor orders, offline sales, stock, and procurement

| ID | Requirement | Status | Current evidence | Gap / required completion | Phase |
|---|---|---|---|---|---|
| V-ORD-01 | Customer details and order details | Implemented | Tenant-scoped vendor queue/detail provides filters, search, pagination, customer/order/Rx/payment/delivery data, workflow actions, and authenticated invoice print/download | None for the stated requirement | 3 |
| V-ORD-02 | Vendor order workflow | Implemented foundation | Payment/prescription gates and controlled status transitions exist | Add SLA indicators, cancellation/refund policy, idempotency tests, and operational notifications | 3 |
| V-SALE-01 | Offline sale with customer name | Implemented | Multi-line POS supports optional exact live-customer lookup, discounts, payment mode, FEFO, Rx capture/review, idempotent stock/accounting/statutory evidence, and invoice print/download | Sales returns/refunds remain P3-06 | 3 |
| V-STK-01 | Purchase order: stockist, invoice number, date | Implemented | Live supplier invoice receiving exists | Rename consistently as purchase/GRN if immediate receiving is intended; add draft/approve/receive states if true PO workflow is required | 2 |
| V-STK-02 | Product rows with batch, expiry, manufacture date, dosage, prices, quantity, GST | Implemented through procurement | Multi-line form and server validation exist | Add barcode/search ergonomics, UOM/pack conversion, duplicate-line handling, and integration tests | 2 |
| V-STK-03 | Amount = purchase price × quantity + GST | Implemented | Client preview and server-authoritative paise calculation exist | Add rounding policy acceptance tests and invoice-level discount/freight decision | 2 |
| V-STK-04 | Amount/tax/total summary | Implemented | Summary and persisted totals exist | Add printable purchase voucher and supplier balance update | 2 |
| V-STK-05 | Direct/opening stock entry | Partial | Inventory API supports opening stock with audit record | UI lacks manufacture date and dosage fields; define when direct stock is allowed versus purchase receiving | 2 |
| V-STK-06 | Stock ledger | Implemented | Purchases/receipts, online/POS sale, cancellation, return, manual adjustment, and cycle-count movements are guarded, immutable, tenant-scoped, and reconciled against physical/reserved stock | UOM/base-quantity conversion remains P2-09 | 0, 2 |

### 5.3 Product, supplier, and manufacturer masters

| ID | Requirement | Status | Current evidence | Gap / required completion | Phase |
|---|---|---|---|---|---|
| V-PRD-01 | Categories dropdown: tablet, capsule, injection, ointment, cream, aerosols, transdermal patches, syrup | Implemented | D-01 treats these as a separate governed dosage-form master with stable seeded IDs; commercial categories remain separately governed | None for the stated values | 2 |
| V-PRD-02 | Drug name and trade name | Implemented | Structured generic/trade fields have live vendor submission, admin governance, duplicate handling, search, and edit/deactivate UI/APIs | None for the stated requirement | 2 |
| V-PRD-03 | Product information | Implemented | Governed product CRUD validates and persists information, names, clinical attributes, packaging, and lifecycle state | None for the stated requirement | 2 |
| V-PRD-04 | Alternate products with right-side search/select | Implemented | Live search/propose/review/withdraw/deactivate surfaces enforce D-09 clinical identity, no self/mirror/cycle, and no automatic substitution | None for the governed linking requirement | 2 |
| V-PRD-05 | Dosage units such as 1 mg / 50 mg | Implemented | Product variants store structured strength value/unit and dosage form, with guarded governance and legacy review state | Pack-to-base inventory conversion remains P2-09 | 2 |
| V-PRD-06 | Purchase and sale price per unit | Partial | Stored per batch and snapshotted on transactions/invoices | Immutable price history, versioned repricing authorization, governed presentation UOM, and tax-inclusive MRP enforcement remain P2-09/D-13 | 2 |
| V-PRD-07 | Batch number | Implemented in inventory | Unique by vendor/product/batch | Keep as inventory data, not a shared product-master field | 2 |
| V-PRD-08 | Manufacturer | Implemented | Normalized manufacturer foreign keys, aliases/provenance, vendor proposals, administrator rename/merge, product display sync, and immutable lifecycle guards exist | None for the stated master requirement | 2 |
| V-PRD-09 | Prescription mandatory | Implemented | Governed product editor controls Rx/schedule state; online and offline sales require owned reviewed prescription evidence where applicable | Prescription-age/retention policy remains P7-04 | 2, 3 |
| V-PRD-10 | GST 0/5/12/18/28 | Implemented foundation | Product default and batch snapshots are constrained to the stated rates and used for server-authoritative purchase, order, POS, return, and invoice calculations | Effective-date tax history and override policy remain P2-09/P7-04 | 2 |
| V-SUP-01 | Add supplier/stockist | Implemented | Vendor-scoped supplier create exists | Add duplicate policy for GSTIN/phone and optional documents if required | 2 |
| V-SUP-02 | Business name, contact name, phone, email, address | Implemented | UI/API validation and persistence exist | Confirm required/optional fields against final policy | 2 |
| V-SUP-03 | Edit and view suppliers | Implemented | Tenant-scoped create/edit/inactivate, bounded search/sort/pagination, detail, purchase/return history, recorded payable, and ledger activity exist | Supplier payment posting remains an accounting feature | 2, 6 |
| V-MFR-01 | Add manufacturer business name | Implemented | Vendors submit governed new-manufacturer proposals; active administrators approve/reject into the canonical master | None for the stated requirement | 2 |
| V-MFR-02 | Edit/view manufacturer | Implemented | Live canonical/alias search, explicit rename/merge requests, concurrency guards, product synchronization, lineage, and audit evidence exist | None for the governed master requirement | 2 |

### 5.4 Vendor alerts and reports

| ID | Requirement | Status | Current evidence | Gap / required completion | Phase |
|---|---|---|---|---|---|
| V-ALT-01 | Near-expiry reminder three months prior as popup | Partial | 90-day query, count, and alert table exist | No popup/inbox/email job for vendors. Add deduplicated vendor notifications, read/snooze/action state, and scheduler | 5 |
| V-ALT-02 | Zero-stock reminder | Partial | Zero/low-stock rows and reorder levels exist | Add deduplicated vendor notifications, acknowledgement, supplier/PO action, and scheduler | 5 |
| V-RPT-01 | Offline sales report | Implemented foundation | Dedicated admin report filters completed offline lines by date/medicine/store with gross, completed returns, net totals, pagination, and safe CSV | Vendor-facing export and XLSX/PDF remain P6-10 | 6 |
| V-RPT-02 | Online sales report | Implemented foundation | Dedicated admin report covers completed online lines by date/medicine/store with return/net recognition, pagination, and safe CSV | Payment/delivery refinements and XLSX/PDF remain P6-10 | 6 |

### 5.5 Customer registration, login, ordering, and reminders

| ID | Requirement | Status | Current evidence | Gap / required completion | Phase |
|---|---|---|---|---|---|
| C-REG-01 | Name | Implemented | One unified customer registration journey requires and provider-synchronizes the customer name | None for the stated requirement | 1 |
| C-REG-02 | Phone, exact 10 digits, OTP | Implemented foundation | Unified email/password registration requires a normalized 10-digit mobile and Supabase phone-change OTP on the same provider account; both factors gate operations | Hosted Supabase/Twilio E2E remains P7-01/P7-08 | 1 |
| C-REG-03 | Validate phone already registered | Implemented foundation | Global live-profile phone uniqueness and structured race handling apply across roles | Connect the policy to the unified customer journey and add hosted-provider E2E coverage under P1-06/P1-10 | 1 |
| C-REG-04 | Email and duplicate validation | Implemented foundation | Public email signup is non-enumerating and D1 enforces normalized global live-profile uniqueness under concurrency | Connect the policy to unified customer UX and add hosted-provider E2E coverage under P1-06/P1-10 | 1 |
| C-REG-05 | Password | Implemented | Unified customer form requires password/confirmation and the provider account remains the sole credential authority | Hosted provider policy verification remains P7-01 | 1 |
| C-LOGIN-01 | Customer email/password login | Implemented | Dedicated password login, verification-pending, forgot/reset-password, sign-out, and role-safe continuation routes exist | Hosted session-expiry and lockout E2E remain P7-03/P7-08 | 1 |
| C-LOGIN-02 | Verified email gate; resend verification link | Partial | Same behavior as vendor login | Add dedicated verification status/success route and E2E proof | 1 |
| C-ORD-01 | Name and phone | Implemented in checkout | Server validates both | Prefill from verified profile and restrict unverified phone edits or reverify changes | 4 |
| C-ORD-02 | Address with geolocation, latitude, longitude | Implemented | Tenant-scoped saved/edit/default addresses and map pins feed server-side serviceability; checkout resolves only owned records | Private tile-provider privacy remains P7-07 | 4 |
| C-ORD-03 | Search and add to cart | Implemented | Live multi-line cart supports quantity/edit/remove, pharmacy grouping, and authoritative stock/price/GST/Rx/serviceability/address revalidation | P2-09 versioned pricing remains | 4 |
| C-ORD-04 | Upload prescription order | Implemented foundation | Secure R2 upload, pharmacist review, multi-Rx cart selection, tenant/ownership checks, and atomic one-use guards exist | Document age/expiry and malware policy remain P7-02/P7-04 | 4, 7 |
| C-ORD-05 | Cart | Implemented | Production demo drawer/data were removed; authenticated live inventory drives a multi-line pharmacy-grouped checkout cart | Persistence across devices is not required by the supplied scope | 4 |
| C-ORD-06 | Payment | Implemented foundation | Razorpay order/verify/webhook/failure/retry/refund/receipt and COD flows integrate with exact-once reservation/stock/accounting state; COD now requires exact collection evidence and custody reconciliation before delivery/invoice finality | Hosted Razorpay sandbox/browser E2E remains P7-01; payment reconciliation and provider UAT remain release gates | 4 |
| C-ORD-07 | Pickup or home delivery | Implemented foundation | Pickup, pharmacy, and URMED delivery modes exist with radius enforcement | Clarify “home delivery” choices in UX and calculate configurable fees/promises server-side | 4 |
| C-HIS-01 | Purchase history | Implemented | Tenant-scoped search/filter/pagination, order detail, delivery timeline, controlled cancellation/refund, and revalidated reorder-to-cart exist | None for the stated requirement | 4 |
| C-HIS-02 | Invoice access | Implemented | Customers can privately download/print deterministic immutable GST invoice HTML/PDF for their delivered order; payment receipt remains distinct | None for the stated requirement | 3, 4 |
| C-REM-01 | Pill reminder: drug name and reminder date | Implemented beyond minimum | Medicine, time, start/end date, recurrence, toggle, consent, and notification inbox exist | Add edit/delete, timezone handling, job automation, delivery channels, and tests | 5 |
| C-REM-02 | Refill/reorder reminder | Implemented foundation | Delivered orders create estimated reminders; customers can confirm/snooze/cancel/reorder | Automate scheduling, provider delivery, and prescription-expiry decisions | 5 |

### 5.6 Administrator panel

| ID | Requirement | Status | Current evidence | Gap / required completion | Phase |
|---|---|---|---|---|---|
| A-REG-01 | List registrations | Implemented | Admin-only bounded live-account directory covers vendor/customer/delivery/admin roles, effective status, verification/onboarding state, date filters, and pagination | None for the stated requirement | 6 |
| A-REG-02 | Required filters: product category, name, status | Implemented | “Category” is explicitly the live account role for registrations; name/contact/store, role, effective status, and registration-date filters exist; product categories remain separate | None after the documented clarification | 6 |
| A-REG-03 | View registered stores by location | Implemented | Admin-only status/publication/home-delivery filtered list and privacy-safe in-app coordinate plot distinguish private legal and published service points without third-party tiles | Region/geocoding filters remain optional enhancement | 6 |
| A-CAT-01 | Product categories | Implemented | Governed commercial taxonomy supports create/edit/activate/deactivate, case-insensitive uniqueness, usage counts, atomic audit, and remains separate from dosage forms | None for the stated requirement | 2, 6 |
| A-LED-01 | Ledgers for individual stores | Implemented foundation | Vendor-scoped account master, opening balances, period filters, trial balance, P&L, balance sheet, and reconciliation drilldown are available through authenticated statement APIs/UI | Supplier/customer party sub-ledgers and XLSX/PDF exports remain | 6 |
| A-RPT-01 | Stock report medicine-wise | Implemented foundation | Dedicated report filters and groups medicine inventory with physical/reserved/available/quarantined/expired/low stock and cost/retail totals, pagination, and CSV | Batch drilldown and XLSX/PDF remain P6-10 | 6 |
| A-RPT-02 | Stock report manufacturer-wise | Implemented foundation | Same report supports canonical manufacturer filters/group data and valuation totals | XLSX/PDF remain P6-10 | 6 |
| A-RPT-03 | Sales report date-wise | Implemented foundation | Dedicated online/offline completed-sales report applies date/store/channel filters and subtracts completed returns into gross/returned/net totals | XLSX/PDF remain P6-10 | 6 |
| A-RPT-04 | Sales report medicine-wise | Implemented foundation | Online order and offline POS lines are unified and filterable by medicine with completed return/net recognition | XLSX/PDF remain P6-10 | 6 |
| A-EXP-01 | Expense purpose, amount, date, payment mode | Implemented foundation | Admin expense form posts balanced entries | Add vendor selector, edit/reversal policy, attachments, filters, and exports | 6 |
| A-EXP-02 | Expenses date-wise and head-wise report | Implemented foundation | Dedicated date/head/store/entry/payment filters, grouping totals, pagination, and safe CSV are live | Edit/reversal/attachment policy and XLSX/PDF remain P6-04/P6-10 | 6 |
| A-BAL-01 | Balance sheet | Implemented foundation | Authenticated statements calculate assets, liabilities, equity plus current-period net income and expose a balanced/unbalanced invariant; the old sales-minus-expenses KPI remains explicitly labelled as not a balance sheet | Accountant-approved recognition/closing policy and exports remain | 6 |
| A-DEL-01 | Home delivery report | Implemented foundation | Privacy-minimized admin report filters date/store/method/status/rider/distance/SLA/fee/COD and exports safe CSV without customer PII or coordinates | Evidence-backed COD reconciliation remains P3-07; XLSX/PDF remain P6-10 | 3, 6 |

## 6. Recommended implementation phases

### Phase 0 — Stabilize the transactional baseline

**Goal:** Remove known integrity and authorization risks before expanding the interface.

- [x] P0-01 Unify purchase status values and repair supplier-return eligibility.
- [x] P0-02 Replace immediate online stock decrement with an expiring reservation lifecycle using `reserved_quantity` or a dedicated reservation table.
- [x] P0-03 Release reservations after payment failure, timeout, prescription rejection, or cancellation; make release idempotent.
- [x] P0-04 Add a scheduled recovery job for abandoned payments/reservations.
- [x] P0-05 Unify admin authorization and make all admin UI calls authenticated.
- [x] P0-06 Introduce protected routes for `/vendor`, `/customer`, `/admin`, and `/delivery`; remove the production role switch.
- [x] P0-07 Decide and document the source of truth for live accounts versus recovered `customers` records.
- [x] P0-08 Make the build/preview workflow cross-platform and binding-aware.
- [x] P0-09 Add D1/R2 API integration-test infrastructure and test the defects above.

**Phase 0 status:** Complete as of 2026-08-12.

**Exit criteria:** Met. Stock is reservation-backed and recovered after terminal/abandoned payment paths; received purchases are supplier-returnable with audited accounting/stock effects; role and tenant boundaries reject unauthorized access; and the verified build, binding-aware preview, and isolated D1/R2 test workflows run on macOS and Linux without GNU `timeout`.

**P0-01 lifecycle decision (2026-08-12):** The immediate-receiving path transitions through `posting` to the canonical terminal state `received`. Only `received` is emitted by current code and it is returnable. Legacy `posted` rows remain readable/returnable during rollout and migration `0031_normalize_purchase_status.sql` converts them to `received`; `draft` remains the schema default for future draft-entry work.

**P0-02 reservation decision (2026-08-12):** New online orders create one active `inventory_reservations` row per FEFO-allocated order item with a 15-minute expiry. Creation increases `reserved_quantity` but does not reduce physical `quantity` or write a sale stock movement. Verified/captured payment atomically transitions active reservations to `committed`, reduces both physical and reserved quantities, records the stock ledger movement once, and marks the order inventory commitment as `committed`. COD and pre-migration orders retain their existing committed-stock behavior. Idempotent release is completed in P0-03; scheduled recovery remains P0-04.

**P0-03 release decision (2026-08-12):** Payment failure, prescription rejection, and order cancellation transition only active reservations to `released` inside the surrounding business transaction. Expired reservations transition to `expired` during payment eligibility and normal order/catalogue/inventory/refill/vendor-operation traffic. Database transition guards decrement `reserved_quantity` once, preserve physical `quantity`, block release after commitment, and make repeated events no-ops. P0-04 remains responsible for scheduled recovery when no application traffic occurs.

**P0-04 recovery decision (2026-08-12):** The hosted Worker runs an inventory-reservation expiry sweep every five minutes, independently of request traffic. Each scheduled timestamp has a unique recovery-run key; completed or in-progress duplicates are no-ops, failed runs may retry the same key, and each invocation processes at most ten set-based batches of 50 orders. Run status, attempts, released order/reservation counts, remaining backlog, timestamps, and errors are persisted in `inventory_reservation_recovery_runs`, while Worker logs report the same operational summary. A remaining backlog is intentionally left for the next scheduled run rather than extending one Worker invocation without a bound.

**P0-05 administrator authorization decision (2026-08-12):** Every human `/api/admin/*` request now requires the same active URMED profile with role `admin`, authenticated by the application bearer session. The former hard-coded Sites-owner email and `terminal.local` bypasses were removed, and compliance/operations audit records use the authenticated administrator profile. The reminder processor retains its configured job secret as a separate machine credential; its admin UI invocation uses the normal bearer session. Public profile creation still permits only customer/vendor roles, and every admin data or compliance-document request uses the authenticated request helper. Dedicated workspace routing and removal of the testing role switch are recorded under P0-06.

**P0-06 protected-route decision (2026-08-12):** `/vendor`, `/customer`, `/admin`, and `/delivery` are dedicated App Router entry points using one shared session gate. Workspace content mounts only after `/api/auth/profile` returns an active profile whose role exactly matches the requested route; a wrong-role or inactive profile is rejected, while every data API retains its existing server-side role and tenant checks as the security boundary. Customer and vendor routes retain public registration/login, but administrator and delivery roles are login-only and must be pre-provisioned. The public marketplace now links to real role URLs, the in-page role/mode switch was removed, and delivery no longer owns a second test-only login/session path.

**P0-07 account identity decision (2026-08-12):** Supabase Auth is authoritative for production credentials, verification, and sessions; `account_profiles` is authoritative for live URMED roles, status, identity, and ownership; and the imported `customers` table is an immutable, admin-only recovery archive that cannot authenticate or own live operational records. The canonical relationship is `Supabase user ID -> account_profiles.auth_user_id -> account_profiles.id -> operational records`. No recovered row is linked today, and email/phone equality must never auto-link or overwrite a live profile. A future claim flow requires new reviewed schema, current contact proof, uniqueness/conflict controls, transactional audit evidence, explicit address consent, and preservation of the original archive. The complete decision and conflict matrix are recorded in `docs/ACCOUNT_IDENTITY_SOURCE_OF_TRUTH.md`.

**P0-08 build/preview decision (2026-08-12):** `npm run build` is the canonical bounded production build on macOS and Linux and no longer requires GNU `timeout`; its Node runner preserves the child exit code and returns `124` after timeout/forced termination. `npm run start` (and its `preview` alias) is the canonical local production preview: it validates the built artifact, applies the artifact's pending migrations to persistent local D1 state, and runs the packaged Worker through Wrangler with the declared `DB`, `BUCKET`, assets, and scheduled handler bindings. The listener defaults to `127.0.0.1:3000`, can be changed with `HOST`/`PORT`, and never targets hosted D1/R2 unless the workflow is explicitly redesigned. Artifact validation rejects drift between `.openai/hosting.json`, the generated Worker configuration, packaged migrations, assets, and cron before the preview starts.

**P0-09 integration-test decision (2026-08-12):** The canonical API integration command builds the packaged Worker, creates one temporary local D1/R2 persistence set, applies all packaged migrations and proves the repeat pass is a no-op, loads one deterministic suite fixture, and starts the packaged Worker in Miniflare/Workerd on an operating-system-assigned loopback port. Business scenarios use real HTTP; the scheduled handler is invoked through Miniflare's handler trigger without normal application traffic; and D1/R2 side effects are inspected only after the runtime stops. Outbound provider access is disabled, test-only Razorpay secrets sign local verification/webhook requests, failure logs are buffered, and timeout/signal cleanup removes all temporary state. No production bypass/diagnostic endpoint, hosted resource, or deployment is involved.

### Phase 1 — Complete identity, registration, and profiles

**Goal:** Deliver coherent vendor and customer onboarding from first form to verified session.

- [x] P1-01 Build a unified vendor registration wizard containing all required business, contact, licence, and private-location fields.
- [x] P1-02 Require phone OTP and email verification before onboarding is marked complete.
- [x] P1-03 Add safe duplicate phone/email handling and race-condition tests.
- [x] P1-04 Add vendor registration success/status and verification-return routes.
- [x] P1-05 Confirm auto-login after email verification; provide an explicit login fallback.
- [x] P1-06 Build unified customer registration with name, phone OTP, email, password, and confirmation.
- [x] P1-07 Add dedicated vendor/customer login, verification pending, resend, forgot-password, reset-password, and sign-out pages.
- [x] P1-08 Finish vendor profile, bank verification status, phone change, password change, and licence renewal UX.
- [x] P1-09 Separate private legal address from any public pickup/service location and stop returning private coordinates publicly.
- [x] P1-10 Add onboarding integration and end-to-end tests, including interrupted/resumed signup.

**Exit criteria:** A new vendor and customer can complete all required fields, verification, auto-login, and profile retrieval without using a test account or hidden role switch.

**P1-01 vendor-registration decision (2026-08-12):** Public email/password account creation remains the authentication boundary and creates only a draft vendor shell. Once authenticated, one four-step wizard collects business/owner names, required 10-digit mobile verification, optional exact-10-digit landline, read-only account email, optional format-checked GSTIN, private legal address and coordinates, home-delivery policy, and the required current drug-licence document/details. The final server action validates the complete package, confirms the authenticated phone, rejects duplicate phone ownership, verifies the vendor-owned R2 document, atomically writes the vendor/profile/licence records, moves non-approved vendors to pending review, and writes one registration-submitted audit event. D-04, D-05, and D-06 are accepted as documented. Dedicated status/verification routes, resumable drafts, and public-location separation remain P1-04/P1-05 and P1-09/P1-10.

**P1-02 identity-verification decision (2026-08-12):** Supabase/provider claims are authoritative for email and mobile verification; browser-supplied identity values or verification flags cannot complete onboarding. `account_profiles.status` remains only the active/inactive/suspended account-control state, while email verification, phone verification, vendor registration (`draft`/`submitted`), administrator approval, and compliance are independent states. Provider claims are normalized and synchronized to D1 idempotently. A vendor may use only the setup/verification surface until both factors are verified and the complete registration package is submitted; operational vendor UI/API access additionally requires approval and verified compliance. Existing approved/verified vendors and explicitly linked test fixtures are backfilled safely by migration `0034`; recovered `customers` rows are never verification or ownership fallbacks. The full model is documented in `docs/IDENTITY_VERIFICATION_AND_VENDOR_ONBOARDING.md`.

**P1-03 duplicate-identity decision (2026-08-12):** Supabase remains the credential authority, while D1 enforces one global non-empty normalized email and 10-digit mobile across live `account_profiles`. Public email registration gives the same neutral response for provider-accepted pending signup and recognized duplicate signals; authenticated linking conflicts return HTTP `409 identity_conflict` with only the conflicting field. Preliminary lookups exist for usable feedback, but partial unique indexes close the final race. Vendor profile and shell creation are one atomic D1 batch, so a loser cannot leave partial records. Migration `0035` creates case/whitespace-insensitive email uniqueness before dropping the former lookup index, rewrites no identity data, and intentionally stops for provider-backed review if legacy normalized duplicates exist. Local packaged-Worker tests use a harness-owned fake Supabase user contract with external networking disabled; real provider-contract tests remain P1-10.

**P1-04 registration-status decision (2026-08-12):** Vendor signup and resend links now target `/vendor/verification-return`; the route scrubs callback parameters and shows returned/error states with explicit sign-in and status actions, but intentionally performs no code exchange or automatic login before P1-05. Successful registration moves to `/vendor/registration/status`, backed by an active-owner-only API that returns email/phone, submission, licence, pharmacist, compliance, and review milestones without private address or coordinates. A deterministic next action guides the vendor through verification, submission, correction, pharmacist completion, review, or operational access. Pending owners may manage only licence/pharmacist onboarding records needed for approval; operational modules remain locked. P1-04 has no migration and real provider redirect/delivery/expiry validation remains P1-10/P7-01.

### Phase 2 — Complete masters, procurement, and inventory

**Goal:** Establish reliable master data and stock creation before broad sales rollout.

- [x] P2-01 Decide category versus dosage-form taxonomy and seed the approved values.
- [x] P2-02 Introduce a structured product/variant model for drug name, trade name, form, strength/unit, packaging, manufacturer, Rx requirement, and GST default.
- [x] P2-03 Implement governed product create/edit/view/deactivate APIs and UI.
- [x] P2-04 Implement alternate product search/link/unlink with clinical/admin governance.
- [x] P2-05 Normalize manufacturer linkage and add controlled rename/merge.
- [x] P2-06 Finish supplier list/search/detail, balances, and purchase history.
- [x] P2-07 Define purchase lifecycle: draft, approved, received, returned, and cancelled/reversed.
- [x] P2-08 Add stock adjustments, cycle counts, reason codes, and reconciliation.
- [x] P2-09 Add price history, UOM/pack conversion, barcode support decision, and MRP enforcement.
- [x] P2-10 Add API/integration tests for purchases, duplicate invoices, batches, tax rounding, and returns.

**Exit criteria:** Authorized users can maintain master data and receive, adjust, trace, and return stock without manual database work.

### Phase 3 — Complete vendor sales and order operations

**Goal:** Make online fulfilment and counter sales operational for pharmacy staff.

- [x] P3-01 Create a filterable online order queue and full order detail page.
- [x] P3-02 Remove static order cards/tables once live views replace them.
- [x] P3-03 Build multi-line offline POS cart with customer lookup, discounts, payment mode, totals, and receipt.
- [x] P3-04 Enforce prescription capture/review for Rx offline sales.
- [x] P3-05 Add GST invoice HTML/PDF generation and authenticated download/print.
- [x] P3-06 Complete returns/refunds/credit notes for finalized online and offline sources.
- [x] P3-07 Add order/SLA/vendor notifications and evidence-backed payment/COD reconciliation.
- [x] P3-08 Add end-to-end tests for online fulfilment, self-delivery, pickup, URMED delivery, cancellation, POS, and returns.

**Exit criteria:** A vendor can process each valid order path and perform a multi-item counter sale with correct stock, tax, ledger, invoice, and audit results.

### Phase 4 — Complete customer commerce

**Goal:** Replace the demonstration cart with a real search-to-payment journey.

- [x] P4-01 Implement a real cart with multiple lines, quantity changes, removal, and pharmacy grouping.
- [x] P4-02 Revalidate stock, FEFO allocation, price, GST, prescription, and serviceability at checkout.
- [x] P4-03 Use `customer_addresses` for saved/default addresses and map selection.
- [x] P4-04 Prefill verified customer identity and require re-verification for phone changes.
- [x] P4-05 Integrate prescription selection for one or more Rx cart items.
- [x] P4-06 Complete Razorpay sandbox flow, failure/retry, webhook reconciliation, refunds, and receipts.
- [x] P4-07 Add order history/detail, delivery timeline, invoice download, cancellation rules, and reorder.
- [x] P4-08 Remove demo product/cart/order-success data from the public site.
- [ ] P4-09 Add end-to-end tests from search through payment/delivery and purchase history.

**Exit criteria:** A verified customer can place and pay for a multi-item order, upload required prescriptions, choose pickup/delivery, track it, and retrieve its invoice.

### Phase 5 — Alerts, reminders, and communication reliability

**Goal:** Turn existing alert queries and reminder tables into reliable actions.

- [x] P5-01 Generate deduplicated 90-day near-expiry vendor notifications.
- [x] P5-02 Generate zero/low-stock vendor notifications with direct reorder actions.
- [x] P5-03 Add vendor notification inbox/popup, read, acknowledge, snooze, and resolution state.
- [x] P5-04 Automate pill/refill scheduling in the hosting environment with authenticated job execution.
- [x] P5-05 Add notification preferences, consent checks, timezone handling, and channel rules.
- [x] P5-06 Add transactional email outbox, retries, provider IDs, failure visibility, and dead-letter handling.
- [x] P5-07 Add idempotency and scheduler tests to prevent duplicate alerts/messages.

**Exit criteria:** Due alerts appear once, can be acted on, and have auditable delivery/read state; provider failure does not silently lose a message.

### Phase 6 — Administrator reporting and accounting

**Goal:** Fulfil the complete administrator panel and reporting requirements.

- [x] P6-01 Add filterable registration lists with status, name, date, role, and clarified category filter.
- [x] P6-02 Add admin-only registered-store map and location/status filters.
- [x] P6-03 Complete category and manufacturer governance screens.
- [x] P6-04 Add store-ledger drilldown, chart of accounts, opening balances, and reconciliation. **Partial:** governed account master, opening balances, immutable periods, reconciliation API, and statement drilldown are live; broader party-ledger and export work remains.
- [x] P6-05 Add medicine-wise and manufacturer-wise stock reports.
- [x] P6-06 Add date-wise and medicine-wise online/offline sales reports with returns/net values.
- [x] P6-07 Add date/head/store expense reports.
- [x] P6-08 Implement trial balance, profit and loss, and a genuine balance sheet. **Partial:** statements are derived from governed postings/opening balances; accountant-approved recognition policy and full statement exports remain.
- [x] P6-09 Add home-delivery report with store, method, status, rider, distance, SLA, fee, and COD filters.
- [ ] P6-10 Add CSV/XLSX/PDF export where operationally required, plus pagination and indexed queries. **Partial:** bounded pagination and formula-safe current-page CSV export are implemented; XLSX/PDF and indexed-query review remain.
- [ ] P6-11 Add authorization and tenant-isolation tests for every report. **Partial:** focused authorization/privacy/filter tests exist; packaged HTTP coverage for every report remains.

**Exit criteria:** Admin users can filter, reconcile, and export the requested operational and accounting reports without accessing raw database tools.

### Phase 7 — Production hardening and release

**Goal:** Prove security, compliance, reliability, and operability before public release.

- [ ] P7-01 Configure and verify Supabase, Twilio, Resend, Razorpay, R2, encryption key, and scheduled jobs in each environment.
- [ ] P7-02 Add R2 upload quarantine and malware scanning before documents become viewable.
- [ ] P7-03 Add rate limits, abuse controls, account recovery, session revocation, and security headers review.
- [ ] P7-04 Review pharmacy, prescription, GST, privacy/consent, retention, and audit requirements with qualified legal/compliance owners.
- [ ] P7-05 Add automated backup, checksum, restore drill, and recovery evidence.
- [x] P7-06 Add structured monitoring for auth, payments, webhooks, jobs, emails, storage, and database errors.
- [ ] P7-07 Complete accessibility, responsive behavior, performance, privacy, and browser QA.
- [ ] P7-08 Run role-based UAT with vendor, customer, admin, pharmacist, and delivery-agent scenarios.
- [x] P7-09 Remove test credentials, test role switching, development metadata, and demo records from production surfaces.
- [ ] P7-10 Complete release checklist, rollback plan, and production smoke test.

**Exit criteria:** Production integrations are verified, critical end-to-end tests pass, operational recovery is proven, and no demo/test-only access is exposed.

## 7. Recommended data and API changes

The following changes should be designed during the named phases rather than added all at once.

### Identity and onboarding

- Keep credentials and verification tokens in Supabase; do not store passwords in D1.
- Treat `account_profiles` as the only live application identity and ownership table; keep legacy `customers` as unlinked admin-only reference data unless a separately approved proof-based claim migration is implemented.
- Add registration/onboarding status fields or a dedicated onboarding table so an account can be verified but still incomplete.
- Keep normalized live-email and mobile uniqueness enforced in D1 across roles; never rely only on UI/preflight checks.
- Persist vendor onboarding drafts only after authentication, or use a short-lived signed server workflow if pre-auth upload is required.

### Product model

- Separate product identity from stock/batch fields.
- Recommended product-level fields: generic/drug name, trade name, formulation/dosage form, strength value, strength unit, packaging/UOM, manufacturer ID, product information, prescription requirement, drug schedule, HSN, and default GST.
- Keep batch number, manufacture/expiry date, purchase cost, sale price, MRP, and quantity at inventory/receipt level.
- Use existing `product_alternates` only after the approval model is defined; “alternate” should not imply automatic clinical interchangeability.

### Inventory and payment reservations

- Add an `inventory_reservations` table or a strict order-item reservation state with expiry timestamp.
- Update `reserved_quantity` atomically when an order is created.
- Convert reservations to stock movements only after the defined payment/prescription gate.
- Release reservations idempotently after failure, rejection, cancellation, or timeout.
- Add indexes for active reservation expiry and order lookup.

### Accounting and reporting

- Add a governed chart of accounts and ledger-account master if a real balance sheet is required.
- Record reversible journal entries rather than editing posted financial transactions.
- Define period, timezone, tax-inclusive/exclusive, refund, cancellation, and COD recognition policies.
- Create report endpoints with explicit filter parameters, pagination cursors, summary totals, and export jobs for large datasets.
- Add indexes based on the actual report filters and verify them with `EXPLAIN QUERY PLAN`.

### Files and communication

- Keep upload bytes quarantined until asynchronous malware scanning passes.
- Store scan provider, signature/version, result, scanned timestamp, and failure reason.
- Add an email/notification outbox with idempotency key, attempts, provider message ID, next attempt, and terminal failure state.

## 8. Decisions required before the related phase

| Decision ID | Question | Recommended default | Needed by |
|---|---|---|---|
| D-01 | Are tablet/capsule/etc. “categories” or dosage forms? | Treat them as dosage forms; keep commercial categories separate | Phase 2 |
| D-02 | Who may create/edit a global product or manufacturer? | Vendor submits; admin/pharmacist-governance role approves global changes | Phase 2 |
| D-03 | Is “purchase order” a draft order or immediate invoice receipt? | Model PO and goods receipt separately if approval/partial receipt is needed; otherwise label current flow “Purchase receipt” | Phase 2 |
| D-04 | Is landline optional? | Optional, but validate exact 10 digits when entered | Phase 1 |
| D-05 | Is GSTIN optional for registration? | Optional to register; mandatory before selling GST-rated products | Phase 1 |
| D-06 | What pharmacy location may customers see? | Keep legal address private; expose only approved public pickup location or server-computed distance | Phase 1 |
| D-07 | Can one cart contain products from multiple pharmacies? | Split into separate orders by pharmacy, with a clear checkout summary | Phase 4 |
| D-08 | When is online stock committed? | Reserve at order creation; commit after payment and prescription gate; expire automatically | Phase 0 |
| D-09 | What qualifies as an alternate medicine? | Require matching active ingredients/strength/form plus verified pharmacist/admin approval | Phase 2 |
| D-10 | What financial statements are legally/operationally expected? | Confirm chart of accounts, opening balances, recognition policy, and reporting period with an accountant | Phase 6 |
| D-11 | What channels should alerts use? | In-app by default; email/SMS only with the required consent and notification preferences | Phase 5 |
| D-12 | What retention periods apply to licences, prescriptions, invoices, audits, and location data? | Obtain legal/compliance approval and encode versioned policies | Phase 7 |
| D-13 | What is the governed stock/pricing unit and MRP policy? | Use indivisible base inventory units with direct governed presentation conversions; treat sale price as GST-exclusive and MRP as tax-inclusive; require approval before enforcing NPPA ceiling semantics | Phase 2 |
| D-14 | Which delivered medicines are returnable, for how long, and how are delivery fees, discounts, GST credit notes, partial/repeated returns, quarantine, and refund tenders handled? | Require an immutable finalized invoice line, explicit policy eligibility, exact remaining quantity/value, physical inspection, separate quarantine holdings, and accountant/legal approval of tax/refund rules | Phase 3 |
| D-15 | What evidence and custody model makes COD paid and reconciled? | Never infer collection from delivery GPS; require exact amount, tender, collector, timestamp, idempotency and receipt evidence, then track cash-in-transit/deposit/reconciliation separately | Phase 3 |

## 9. Test strategy and definition of done

### Existing automated coverage

The current 283 unit/regression tests validate portable build/preview behavior, authorization and least privilege, identity/archive isolation, provider-claim synchronization, onboarding, governed masters, procurement and duplicate/batch races, inventory reconciliation, carts, reservations, payment/refund/invoice state, delivery proof/privacy, POS/Rx logic, scheduled alerts/reminders, the vendor notification lifecycle, accounting atomicity, document access/quotas, browser security headers, error boundaries, and production-demo removal. The packaged Worker adds 18 real local HTTP/D1/R2 scenario groups covering all 47 migrations and their repeat pass, provider-independent identity races/resume, purchases/returns, inventory adjustments, cart/payment/refund/recovery/invoices, delivery isolation, manufacturer governance, multi-line POS/Rx, R2 validation/access, and direct post-run transactional evidence.

### Required test layers

1. **Unit tests** for validation, state machines, totals, permission decisions, and formatting.
2. **D1 integration tests** for transactions, triggers, uniqueness, tenant scoping, reservations, reports, and migrations.
3. **R2 integration tests** for allowed/rejected uploads, ownership, quarantine, and document access.
4. **Provider contract tests** using Supabase/Twilio, Resend, and Razorpay sandbox/test environments.
5. **Browser end-to-end tests** for vendor registration, customer registration, login, purchasing, stock, cart, prescription, payment, order fulfilment, reminders, and admin reports.
6. **Security tests** for cross-tenant access, role escalation, IDOR, duplicate submission/idempotency, webhook replay, file attacks, and rate limits.

### Definition of done for every requirement

A requirement is **Implemented** only when all applicable items below are true:

- [ ] UI is connected to a real API; no hard-coded success state or demo row remains in the production path.
- [ ] Server validates all business rules and does not trust the client.
- [ ] Authorization and tenant ownership are enforced server-side.
- [ ] D1/R2 changes are migration-backed and rollback/recovery implications are documented.
- [ ] Loading, empty, validation, conflict, provider-failure, and retry states are usable.
- [ ] Audit/ledger/stock side effects are correct and idempotent.
- [ ] Unit/integration tests cover success, invalid input, duplicate/race, and unauthorized cases.
- [ ] Critical user journey has an end-to-end test.
- [ ] Accessibility and mobile layout are checked.
- [ ] Requirement row and phase checklist are updated in this document.

## 10. Suggested first execution slice

Do not begin with report styling or additional dashboard cards. The first implementation slice should be:

1. fix purchase status/supplier-return mismatch;
2. implement stock reservations and expiry/release behavior;
3. unify admin authorization;
4. establish protected role routes;
5. add integration tests for those controls;
6. then complete vendor registration end to end.

This sequence protects stock and tenant integrity before more users and workflows are added.

## 11. Progress log

Add one row whenever a requirement or phase milestone is completed.

| Date | Requirement/phase IDs | Summary | Tests/evidence | Remaining follow-up |
|---|---|---|---|---|
| 2026-08-12 | Analysis baseline | Repository mapped to supplied requirements; production artifact, lint, and 24 tests verified | Build validation passed; lint passed; 24/24 tests passed | Begin Phase 0 |
| 2026-08-12 | P0-01 | Standardized immediate purchase receiving on `received`; made received and legacy `posted` rows supplier-returnable; added legacy normalization migration and transactional regression coverage | TypeScript passed; lint passed; 29/29 tests passed; Vinext production build and artifact validation passed | Apply migration `0031` with the next release; proceed to P0-02 stock reservations |
| 2026-08-12 | P0-02 | Added 15-minute online inventory reservations, atomic payment-time stock commitment, database transition guards, customer expiry visibility, and pre-migration compatibility | Migration and expiry index verified in SQLite fixtures; TypeScript and lint passed; 36/36 tests passed; Vinext production build and artifact validation passed | Apply migrations `0031` and `0032` with the next release; proceed to P0-03 idempotent reservation release |
| 2026-08-12 | P0-03 | Added one idempotent release path for failed payments, rejected prescriptions, cancellations, and request-driven expiry reconciliation; released orders are no longer payable and the customer sees the released state | TypeScript and lint passed; 41/41 tests passed; Vinext production build and artifact validation passed | Apply migrations `0031` and `0032` with the next release; proceed to P0-04 scheduled recovery |
| 2026-08-12 | P0-04 | Added a five-minute Worker cron that recovers expired reservations without request traffic, uses bounded set-based batches, deduplicates scheduled events, retries failed runs, and records recovery outcomes/backlog | Migration `0033` verified in SQLite fixtures; TypeScript and lint passed; 45/45 tests passed; direct Vinext production build and scheduled-handler/cron artifact validation passed | Apply migrations `0031` through `0033` with the next release; proceed to P0-05 unified admin authorization |
| 2026-08-12 | P0-05 | Unified all human admin APIs on active app-admin bearer sessions, removed owner/localhost bypasses, login-gated the admin workspace, authenticated every admin UI/document request, and attributed admin mutations to the signed-in profile | TypeScript and lint passed; 50/50 tests passed, including shared-contract, wrong-role, bypass-removal, route-inventory, caller-inventory, and login-gate coverage; direct Vinext production build and artifact validation passed | No new migration; proceed to P0-06 protected role routes and removal of the production role switch |
| 2026-08-12 | P0-06 | Added dedicated `/vendor`, `/customer`, `/admin`, and `/delivery` entry points behind one active exact-role session gate; removed the in-page production role switch, homepage mode routing, and duplicate delivery login/session controls | TypeScript and lint passed; 55/55 tests passed, including route inventory, active/exact-role enforcement, inactive/wrong-role rejection, login-only privileged roles, and role-switch removal; direct Vinext production build exposed all four routes and artifact validation passed | No migration; proceed to P0-07 live-account versus recovered-customer source-of-truth decision |
| 2026-08-12 | P0-07 | Established Supabase Auth as credential authority, `account_profiles` as the only live identity and ownership source, and `customers` as an unlinked admin-only recovery archive; documented future proof-based claim/link rules and corrected recovery UI/API terminology | TypeScript and lint passed; 59/59 tests passed, including authority-policy, live-schema ownership, archive API isolation, credential exclusion, and no-auto-link guardrails; direct Vinext production build and artifact validation passed | No migration or data rewrite; proceed to P0-08 cross-platform, binding-aware build and preview workflow |
| 2026-08-12 | P0-08 | Replaced the GNU-only build timeout with a portable bounded Node runner; made the packaged Worker the canonical production preview; added persistent local D1 migration and D1/R2 binding injection; strengthened artifact drift validation and documented listener/state/environment controls | TypeScript and lint passed; 61/61 tests passed, including portable success/timeout and preview wiring coverage; `npm run build` passed directly on macOS; fresh production preview applied all 34 migrations, exposed local `DB`/`BUCKET`, returned catalog data, and completed an authenticated R2 upload/download smoke test | No migration; keep `.sites-runtime/preview-state` disposable and local; proceed to P0-09 D1/R2 API integration-test infrastructure |
| 2026-08-12 | P0-09 / Phase 0 exit | Added one deterministic packaged-Worker integration harness with fresh local D1/R2, repeatable packaged migrations, suite fixtures, real HTTP transactions, scheduled-handler dispatch, provider network isolation, post-runtime persistence inspection, bounded execution, failure logs, and guaranteed cleanup | Shell/Node syntax, TypeScript, lint, 61/61 unit tests, six integration scenario groups, the complete verified test command, and production build/artifact validation passed | No migration or deployment; confirm D-04, D-05, and D-06 with stakeholders, then proceed to P1-01 vendor registration wizard |
| 2026-08-12 | P1-01 | Accepted D-04/D-05/D-06 and replaced split pharmacy setup with a four-step authenticated vendor registration wizard and one validated business/contact/private-location/licence submission; new vendor shells remain drafts until submission | TypeScript and lint passed; 66/66 unit/regression tests passed; isolated packaged-Worker HTTP integration proved the vendor-owned R2 upload, atomic D1 vendor/licence pending-review state, and audit event; verified production build/artifact validation passed | No migration or deployment; proceed to P1-02 phone OTP and email verification completion policy |
| 2026-08-12 | P1-02 | Made provider claims authoritative for email/mobile verification, synchronized normalized claims to D1 idempotently, separated account/identity/registration/approval/compliance states, blocked browser spoofing and phone-only vendor signup, and restricted incomplete vendors to onboarding until both factors are verified and the submitted registration is approved | TypeScript and lint passed; 73/73 unit/regression tests passed; eight packaged-Worker D1/R2 integration scenarios proved every verification combination, phone mismatch rejection, spoof resistance, idempotent synchronization, inactive/wrong-role/archive isolation, registration submission, and operational access gates; complete verified build/artifact command passed | Apply repeatable migration `0034` with the next release; real Supabase/Twilio provider keys and hosted-flow tests remain unconfigured; test-login production exposure and private-coordinate disclosure remain blockers; proceed to P1-03 duplicate phone/email race handling |
| 2026-08-12 | P1-03 | Added case/whitespace-insensitive global live-email uniqueness, retained normalized-phone uniqueness, mapped authenticated database races to structured non-enumerating conflicts, made public email duplicate responses neutral, and made profile/vendor-shell creation atomic | TypeScript and lint passed; 79/79 unit/regression tests passed; nine packaged-Worker D1/R2 scenarios used isolated local provider claims to prove concurrent email and phone contention each produce one winner, one repeatable conflict, and no partial loser records; complete verified build/artifact command passed | Apply migrations `0034` and `0035` after the documented read-only duplicate-email preflight; connect real Supabase/Twilio keys for provider-contract tests; test-login exposure and private-coordinate disclosure remain blockers; proceed to P1-04 registration success/status and verification-return routes |
| 2026-08-12 | P1-04 | Added dedicated vendor verification-return and persistent registration-status routes, targeted signup/resend links at the callback, scrubbed callback parameters, exposed an owner-only privacy-minimized milestone API, redirected successful submissions to status, and removed the pending-review pharmacist onboarding deadlock without unlocking operations | TypeScript and lint passed; 85/85 unit/regression tests passed; nine packaged-Worker D1/R2 scenarios proved signed-in owner/wrong-role/tenant boundaries, private-coordinate exclusion, submitted/status milestones, and pending-review pharmacist upload/submission while operational APIs stay denied; complete verified build/artifact command passed | No new migration; apply pending `0034`/`0035` with the next release; configure real Supabase/Twilio keys and redirect allowlists for provider E2E; test-login exposure and public coordinate disclosure remain blockers; proceed to P1-05 auto-login with explicit login fallback |
| 2026-08-13 | P1-05–P1-10 | Completed controlled verification-return session handling with fallback, unified customer registration, dedicated account/recovery pages, vendor profile/licence/bank-status UX, public/private location separation, resumable onboarding, and integration-only test auth isolation | Provider-independent flows are covered by unit and packaged HTTP/D1/R2 tests, including interrupted customer/vendor onboarding; production UI contains no fixture login | Real Supabase/Twilio keys, redirect allowlists, message delivery, and hosted browser E2E remain P7-01/P7-08 release gates |
| 2026-08-13 | P2-01–P2-08 | Added governed dosage forms, structured product variants, product CRUD, clinical alternates, manufacturer rename/merge governance, supplier directory, draft/approval/partial-receipt purchase lifecycle, and append-only stock reconciliation | Migrations `0037`–`0041` and `0043` apply cleanly; unit and real-HTTP D1 tests cover tenant scope, concurrency, FEFO, return quantities, ledgers, immutable evidence, and migration backfill | P2-09 price/UOM/barcode/MRP policy remains decision-gated; P2-10 is complete |
| 2026-08-13 | P3-01–P3-04 | Replaced static order/POS prototypes with a live vendor queue and multi-line offline POS; added exact live-customer lookup, server FEFO, discounts, GST, idempotency, Rx capture/review, R2 access controls, statutory evidence, and atomic stock/accounting/invoice evidence | Additive migration `0044` applies from clean state and repeats with zero pending work; packaged Worker proves role/tenant/compliance boundaries, reservation floors, multi-batch allocation, Rx one-use, audit rollback, and post-run evidence | Proceed to P3-05 immutable GST invoice HTML/PDF and authenticated download/print; P3-06 returns and P3-07 COD reconciliation follow |
| 2026-08-13 | P4-01–P4-08 | Added multi-line pharmacy-grouped cart, authoritative checkout revalidation, saved/default addresses, verified identity, multi-Rx selection, local Razorpay lifecycle/refunds/receipts, order history/timeline/cancellation/reorder, authenticated GST invoice download/print, and removed demo commerce data | Complete verified build/artifact and 18/18 packaged HTTP/D1/R2 scenarios passed | P4-09 hosted browser/provider E2E remains |
| 2026-08-13 | Security/data-integrity audit corrections | Closed generic vendor order permission bypass, purpose-blind document download, compliance-expiry fail-open, private delivery-location fallback, GPS proof/audit amplification, non-atomic compliance/expense evidence, public GET recovery writes, webhook body amplification, patient-register overfetch, broad admin PII, full legacy-archive loading, and fabricated production dashboard claims | TypeScript and lint passed; targeted failure-injection tests passed; complete verified build and packaged suite passed | COD collection finality, malware quarantine/scanning, global abuse controls, reporting completeness, legal retention, monitoring, provider setup, and UAT remain release blockers |
| 2026-08-13 | P2-10 | Canonicalized supplier invoice numbers, mapped duplicate races to stable conflicts, revalidated batch identity at receipt, and added deterministic paise GST plus purchase/return regression coverage | Focused purchase tests passed 18/18; consolidated TypeScript, lint, unit tests, build, and packaged D1/R2 suite passed | P2-09 requires D-13 pricing/UOM/MRP decisions and a new migration after `0046`; input-GST reversal on supplier debit notes remains an accounting-policy decision |
| 2026-08-13 | P3-05 / P4-07 completion | Added migration `0045` with immutable source-derived GST invoice headers/lines, deterministic escaped HTML/PDF, authenticated customer/vendor download and print controls, and exact-once online/POS issuance | All 46 migrations apply cleanly with a zero-work repeat; deterministic PDF tests and visual QA passed; packaged Worker proved invoice finality, tenant isolation, stable bytes, privacy, and immutable D1 evidence | P3-06 sales returns/credit notes and P3-07 evidence-backed COD reconciliation remain |
| 2026-08-13 | P5-01–P5-04, P5-07 | Added deduplicated 90-day expiry and low/zero-stock alerts, an operational vendor inbox with read/acknowledge/snooze/resolve and re-alert policy, India-timezone pill/refill processing, distinct Worker crons, and idempotency/scheduler coverage | Migration `0046` applies cleanly with a zero-work repeat; lifecycle changes and immutable audit evidence commit atomically; 283/283 unit tests, TypeScript, zero-warning lint, verified production build, and 18/18 packaged HTTP/D1/R2 scenarios passed across all 47 migrations | Followed by P5-05 and P5-06; COD collection finality is the next financial-integrity priority |
| 2026-08-13 | P5-05 | Added profile-scoped notification preferences, mandatory essential in-app delivery, consent-controlled optional channels, verified-email eligibility, disabled-until-supported SMS, strict IANA time zones, optimistic atomic audit, and per-profile reminder scheduling | Migration `0047` conservatively enables only essential in-app categories for existing active profiles and applies cleanly with zero repeat work; focused preference/reminder tests, TypeScript, and zero-warning lint passed | P5-06 is now complete; proceed to COD collection finality and reconciliation |
| 2026-08-13 | COD collection finality / P3-07 reconciliation slice | Removed delivery-implies-paid behavior. Added exact-total COD collection evidence with tender mode, receipt/idempotency reference, collector, atomic payment/ledger/audit posting, duplicate/concurrency protection, and on-hand → deposited → reconciled custody transitions with immutable D1 guards. Delivery, invoice, and accounting finality now require prior collection evidence. | Migration `0050` applies cleanly with a zero-work repeat; 306/306 unit tests, TypeScript, zero-warning lint, verified production build/artifact validation, and 20/20 packaged HTTP/D1/R2 scenarios passed, including wrong-role, replay, exact amount, custody, and delivery-finality checks | P3-06 returns/credit notes and the remaining P3-07 SLA/vendor-notification work remain; hosted payment-provider/UAT reconciliation remains a release gate |
| 2026-08-13 | P5-06 / Phase 5 exit | Completed the transactional email outbox: order and prescription transitions enqueue atomically in their D1 batches; reminders enqueue instead of sending inline; the scheduled Worker leases, retries with bounded backoff, records provider IDs, recovers leases, dead-letters terminal failures, and supports audited admin retry/failure visibility. Added immutable delete protection and repeat-safe deduplication. | Migration `0049` applies cleanly after `0048` and repeats with zero work; 303/303 unit tests, TypeScript, zero-warning lint, verified production build/artifact validation, and 20/20 packaged HTTP/D1/R2 scenario groups passed, including scheduled processing and outbox side-effect inspection | Provider delivery remains dependent on configured Resend credentials; hosted provider E2E and release configuration remain P7 gates; proceed to COD collection finality and reconciliation |
| 2026-08-13 | P6-01–P6-03, P6-05–P6-07, P6-09 | Added live registration filters, privacy-safe admin store map, category/manufacturer governance, and dedicated stock, sales, expense, and home-delivery reports | Admin-only/no-store APIs, bounded filters/pagination, formula-safe CSV, privacy tests, TypeScript, lint, unit suite, and production build passed | P6-04/P6-08 accounting statements remain; P6-10 export/performance and P6-11 packaged-report coverage are partial |
| 2026-08-13 | P7-03 partial hardening | Added a bounded Razorpay webhook body, upload count/byte quotas with atomic R2 metadata reservation, fresh/rate-limited rider proof, and uniform Worker browser security headers | Oversize/quota/concurrency/header unit tests passed; production artifact and isolated real-HTTP D1/R2 suite passed | Global endpoint rate limits, session revocation review, nonce-based CSP, malware quarantine, and broader provider abuse controls remain |
| 2026-08-13 | P7-09 | Removed production fixture credentials, role switching, hard-coded marketplace/order/report records, and fabricated operational claims; isolated test authentication behind a strong per-run integration-stage secret and private harness header | Production-surface and test-auth regressions pass; production rejects prefixed integration tokens before D1 access; verified artifact contains only the controlled server-side integration route | Keep integration secrets runtime-only and never configure `APP_STAGE=integration` in hosted environments |
| 2026-08-13 | P3-06 / P3-07 | Unified finalized online/offline sales returns behind tenant-scoped source eligibility, immutable tax/discount credit-note snapshots, idempotent keys, separate returned-quantity quarantine holds, stock/ledger/audit evidence, and added atomic new-order notifications, scheduled SLA-overdue generation, and queue indicators | Migration `0051` applies cleanly and repeats with zero work; sales-return unit tests, TypeScript, zero-warning lint, verified production build/artifact validation, and packaged HTTP/D1/R2 suite passed; existing 306 unit tests remain green | P3-08 broader fulfilment/returns end-to-end expansion remains; provider delivery, malware quarantine, abuse controls, accounting statements, and hosted UAT remain release gates |
| 2026-08-13 | P3-08 | Expanded packaged Worker fulfilment coverage through paid pickup and pharmacy self-delivery, plus finalized online sealed returns with idempotent replay, excess/cross-tenant rejection, terminal-state protection, and inventory evidence | Clean local D1/R2 runtime exercised both delivery branches and online return/credit-note side effects over real HTTP; all packaged scenario groups passed after 52 migrations with repeat application at zero | Next: P2-09 pricing/UOM/MRP governance; broader release gates remain provider UAT, malware quarantine, abuse controls, accounting statements, and report exports |
| 2026-08-13 | P2-09 | Added immutable batch price history, effective-dated vendor pricing, governed presentation-to-base UOM conversion proposals, GTIN-8/12/13/14 validation and admin approval, and tax-inclusive MRP/sale-price guards. Legacy zero-price inventory is safely backfilled before enforcement; NPPA ceiling remains advisory pending policy approval. | Migration `0052` applies cleanly and repeats with zero work; pricing unit tests, TypeScript, lint, verified build/artifact validation, and packaged Worker pricing/tenant/MRP scenarios passed | Next: accounting statements/chart of accounts; broader release gates remain abuse controls, malware quarantine, hosted provider UAT, and report exports |
| 2026-08-13 | P6-04/P6-08 accounting statements | Added seeded chart of accounts, immutable opening balances, one-way accounting periods with closed-period posting guards, vendor/admin statement APIs, reconciliation records, and governed trial balance, P&L, and balance-sheet calculations over existing ledger postings. | Migration `0053` applies cleanly and repeats with zero work; accounting unit tests, TypeScript, zero-warning lint, verified build/artifact validation, and packaged Worker tenant/auth/period scenarios passed; full unit suite 317/317 passed | Party sub-ledgers, accountant-approved recognition policy, XLSX/PDF statement exports, and broader report performance review remain |
| 2026-08-14 | P6 accounting completion slice | Added supplier/customer accounting parties with historical ledger backfill and future-posting projection, protected sub-ledger drilldown, CSV/XLSX/PDF statement exports, immutable opening/period controls, reconciliation policy documentation, and party/date ledger indexes. | Migration `0054` applies cleanly and repeats with zero work; accounting tests 4/4, TypeScript, zero-warning lint, verified build/artifact validation, and packaged Worker accounting/auth/tenant scenarios passed | Accountant approval of recognition policy, advanced reconciliation matching, broader indexed-report benchmarking, and hosted/UAT release gates remain |
| 2026-08-14 | P6 reporting/reconciliation hardening | Added CSV/XLSX/PDF exports for stock, sales, expenses, and home-delivery reports; added protected reconciliation review coverage and documented EXPLAIN/query-plan benchmarking requirements. | Accounting/export unit coverage 5/5, TypeScript, zero-warning lint, migration repeatability, verified build/artifact validation, and packaged Worker suite passed | Accountant sign-off and hosted provider/UAT remain external gates; representative production-scale D1 benchmark and bank-feed matching require approved data/provider contracts |
| 2026-08-14 | P6 advanced reconciliation | Added external reconciliation-item staging, duplicate-reference protection, account/vendor scope matching, one-time ledger matching, immutable evidence links, and audited match transitions. | Migration `0055` applies cleanly and repeats with zero work; report/accounting tests 11/11, TypeScript, lint, and local migration validation passed | Real bank-feed ingestion, accountant approval, production-scale EXPLAIN benchmarks, and hosted provider/UAT remain external gates |
| 2026-08-14 | P6 accounting controls / reconciliation approval | Added versioned accountant-policy approval evidence, immutable statement-import batches with checksum deduplication, staged bank rows, split reconciliation-match proposals with approval/reversal lifecycle, and protected reconciliation listing. Returns/credit notes were re-audited against finalized online/offline source guards, tax snapshots, quarantine quantities, idempotency, and terminal-state tests. | Migration `0056` applies cleanly and repeats with zero work; TypeScript, zero-warning lint, accounting/return tests 8/8, full unit suite 319/319, production build/artifact validation, and packaged D1/R2 integration passed | Accountant must still approve policy version `2026-08-14.v1`; real bank-feed/provider ingestion, production-scale query plans, and hosted/UAT remain pending |
| 2026-08-14 | Reconciliation workspace / matching controls | Added admin reconciliation workspace with CSV import, staged-row listing, explicit bounded amount/date tolerances, deterministic candidate suggestions, and approval/reversal API lifecycle. Added a local EXPLAIN QUERY PLAN smoke benchmark for ledger/order report predicates. | TypeScript, zero-warning lint, focused accounting tests 7/7, full unit suite 321/321, migration validation 57/57 with repeat 0, production build/artifact validation, and packaged D1/R2 integration passed | Accountant sign-off, real bank-feed/provider adapter, production-scale 10k/100k/1m-row benchmark, and hosted/UAT remain external gates |
| 2026-08-14 | P2 reporting/pricing/reminders hardening | Added packaged CSV/XLSX/PDF export assertions for every operational report, private headers and byte checks; added vendor/admin pricing governance workspace with effective-price and GTIN review; added reminder edit/delete UI/API with audited ownership checks; expanded local report-plan smoke tooling. | TypeScript, zero-warning lint, pricing/reminder tests 10/10, full unit suite 323/323, 57-migration clean/repeat validation, production build/artifact validation, and packaged D1/R2 integration passed | NPPA ceiling automation still requires approved policy; real bank/provider ingestion, production-scale benchmarks, malware/rate-limit hardening, and hosted/UAT remain pending |
| 2026-08-14 | P2 hardening completion slice | Added synthetic 10k/100k/1m-row local report benchmark output, typed NPPA ceiling mode (`advisory`/`enforce`) with effective ceiling lookup, and retained advisory behavior until policy approval. Reminder edit/delete, export coverage, GTIN review, and pricing workspace remain validated. | TypeScript, zero-warning lint, full unit 323/323, migration validation 57/57 repeat 0, production build/artifact validation passed | NPPA enforcement requires a governed runtime setting and approved ceiling data; hosted bank/provider ingestion, Cloudflare-scale benchmarks, malware scanning, rate limits, and UAT remain pending |
| 2026-08-14 | P7-03 local abuse-control slice | Added a durable D1 fixed-window limiter with hashed IP/profile keys, endpoint-specific policies for auth, uploads, payments, Razorpay webhooks, public search, and GPS, stable 429/Retry-After responses, fail-closed storage errors, and packaged local throttling coverage. | TypeScript, zero-warning lint, full unit 337/337, migration validation 63/63 repeat 0, production build/artifact validation and packaged local D1/R2 coverage passed | Hosted Cloudflare rate-limit binding, provider-side Supabase/Twilio/Razorpay controls, session revocation, and production tuning remain external release gates; see `docs/ABUSE_CONTROLS.md` |
| 2026-08-14 | P2-PRICING-01 | Made effective-dated pricing authoritative through a shared resolver across catalog, inventory, online checkout, POS, stock/refill/report reads, and immutable invoice snapshots; opening-stock and purchase paths now enforce the centralized NPPA policy; added same-day version handling, non-overlapping future periods, versioned UOM guards, barcode search, and vendor/admin pricing/conversion review UI. | 59 migrations apply cleanly with repeat 0; TypeScript, zero-warning lint, 326/326 unit tests, verified production build/artifact validation, and full packaged D1/R2 integration passed | NPPA remains advisory until accountant/business approval supplies ceiling data and enables enforce mode; real hosted provider/UAT and production-scale D1 benchmarking remain release gates |
| 2026-08-14 | P2-REMINDER-01 | Added immutable per-reminder/date/channel delivery evidence correlated to the transactional email outbox; reminder scheduling now queues email only through the outbox, records in-app evidence, honors current consent/preferences/time zones and inactive/deleted state, and repeated runs are deduplicated. Outbox claims, lease recovery, retries, terminal dead-letter/cancellation, provider IDs, and failure evidence update atomically. | Migration `0059` applies cleanly with repeat 0; focused reminder/outbox/preferences tests 15/15, full unit 326/326, TypeScript, zero-warning lint, production build/artifact validation, and packaged local D1/R2 reminder CRUD/scheduler/retry/lease/dead-letter/preference/duplicate/tenant scenarios passed | Resend remains provider-configured at deployment; production-scale report benchmarking and hosted provider/UAT release gates remain |
| 2026-08-14 | P2-REPORT-PERF-01 | Added reproducible stock, sales, expense, and home-delivery benchmarks at 10k/100k/1m synthetic rows with query plans, timings, pagination, totals, tenant scope, export cap, and candidate-bound evidence. Added the justified vendor/method/date delivery index and explicit overflow behavior; documented production-scale methodology and hosted release gates. | `npm run benchmark:reports` completed all three scales; focused report-performance tests 3/3; migration `0060` clean/repeat; TypeScript, zero-warning lint, full unit, production build/artifact, and packaged local D1/R2 integration validation passed | Hosted D1/provider/UAT, backup/restore, browser/accessibility/privacy/performance gates remain external; synthetic timings are not production SLAs |
| 2026-08-14 | P7-02 local quarantine slice | Added deterministic local malware scanning for EICAR and active-content markers, `pending_scan`/`clean`/`quarantined` states, isolated quarantine R2 keys, private quarantine responses, activation guards, and packaged D1/R2 evidence for clean plus quarantined uploads. | Migration `0061` applies cleanly and repeats with zero work; focused document-malware/upload tests 8/8, full unit 334/334, TypeScript, zero-warning lint, production build/artifact validation, and packaged D1/R2 integration passed | Hosted AV provider integration, asynchronous scan retry/retention, and production malware certification remain external release gates |
| 2026-08-14 | P7-05 local backup/restore slice | Added `backup:local` and `restore:verify` commands with a versioned D1/R2 format, deterministic SHA-256 manifest, migration/schema/foreign-key/tenant checks, staged restore publication, corruption/unexpected-artifact rejection, idempotent verified reruns, and recovery evidence. Packaged integration now backs up and restores the completed local Worker state. | Focused backup/restore tests 2/2, TypeScript, zero-warning lint, production build/artifact validation, migration validation, and packaged local D1/R2 backup/restore drill passed; no migration was required | Hosted Cloudflare backup policy, encryption/versioning, retention, disaster-recovery objectives, and production restore authorization remain external release gates |
| 2026-08-14 | P7-06 local monitoring and release-gate slice | Added append-only sanitized operational events, bounded deduplicated alerts with severity escalation and optimistic admin lifecycle controls, scheduled-job success/failure health evidence, webhook replay/failure evidence, transactional email outcome evidence, private admin monitoring API/UI, and local external-release-gate documentation. | Migration `0063` applies cleanly and repeats with zero work; focused monitoring tests 4/4, full unit 343/343, TypeScript, zero-warning lint, production build/artifact validation, and packaged local D1/R2 monitoring scenario passed | Hosted observability/alert delivery, Cloudflare-scale benchmarks, backup/DR, accountant policy approval, bank-feed/reconciliation, provider UAT, and browser/accessibility/privacy/rollback gates remain external |
| 2026-08-15 | P1-MULTISTORE-01 | Added explicit vendor-owned operational branches with deterministic `PRIMARY` backfill, branch-scoped batch inventory, order/purchase/POS ownership, staff branch assignment and authorization, published branch customer locations, branch-ranked offers, branch-aware single-branch checkout, vendor/admin branch management, and branch-filtered operational reports. | Migrations `0064` and `0065` apply cleanly and repeat with zero work; focused branch/marketplace/report tests pass; full unit 354/354, TypeScript, zero-warning lint, production build/artifact validation, and packaged local D1/R2 integration passed | Cross-branch split-order fulfillment remains intentionally deferred pending product/accounting policy; hosted authentication, payment, and UAT remain external gates |
