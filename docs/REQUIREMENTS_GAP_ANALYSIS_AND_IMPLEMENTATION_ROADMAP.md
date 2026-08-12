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

The main gap is that the application currently mixes three maturity levels in one interface:

1. real database-backed workflows;
2. static demonstration panels with hard-coded data; and
3. requirement-shaped forms that only show a local success message.

This makes the application look more complete than it is. The highest-value next step is to consolidate each role into a single authenticated, database-backed workflow and remove or clearly retire duplicate prototype screens.

### Baseline verification

- Production Vinext artifact: **build and artifact validation passed**.
- Lint: **passed**.
- Automated tests: **24 of 24 passed**.
- Test coverage is mainly unit-level workflow logic. There is no complete browser-level registration-to-order or purchase-to-report test.
- The repository has no local `.env` file. Hosted environment values may exist outside the repository, but local Supabase, Resend, Razorpay, encryption, and scheduled-job integration readiness cannot be assumed.

## 3. Current architecture

| Area | Current implementation | Assessment |
|---|---|---|
| Web application | Next-compatible App Router on Vinext/Vite with a public marketplace and dedicated `/vendor`, `/customer`, `/admin`, and `/delivery` workspaces | Each role workspace has a direct URL and mounts only after an active exact-role profile is confirmed |
| Structured data | Cloudflare D1 with Drizzle schema and SQL migrations | Strong foundation; several tables are ahead of their UI |
| Files | Cloudflare R2 plus `stored_documents` metadata | Suitable foundation; malware scanning is not actually implemented |
| Public authentication | Supabase Auth; Twilio is expected through Supabase phone provider configuration | Partial end-to-end onboarding; vendor and customer registration are fragmented |
| Email | Supabase verification email plus Resend helper for transactional messages | Provider-dependent; failures are not queued or retried |
| Payments | Razorpay order, browser verification, webhook endpoints, and expiring D1 stock reservations | Phase 0 reservation creation, commit, release, expiry, and recovery controls are implemented and integration-tested |
| Maps/geolocation | Browser geolocation and Leaflet-based picker | Implemented in forms; privacy and saved-address behavior need completion |
| Authorization | Active local role profiles, exact-role route gates, role-scoped APIs, vendor permissions, and test sessions | Human admin bypasses and the production role switch are removed; server/API authorization remains the security boundary |
| Tests | 66 unit/regression tests plus isolated packaged-Worker D1/R2 HTTP integration coverage | Phase 0 controls and the P1-01 vendor-registration package are covered; later provider/browser flows remain |

## 4. Immediate defects and risks

These should be addressed before adding broad new features.

| Priority | Finding | Impact | Required action |
|---|---|---|---|
| Resolved P0-01 | Purchase receiving formerly saved `received`, while supplier-return queries required `posted` | Valid received stock could be absent from the selector | `received` is canonical, legacy `posted` remains compatible/normalized, and real-D1 HTTP coverage proves selector and return side effects |
| Resolved P0-02–P0-04 | Online orders formerly decremented stock before payment and did not recover abandoned reservations | Unpaid or abandoned orders could remove sellable stock indefinitely | Expiring reservations now commit/release once and scheduled recovery handles no-traffic periods; real-D1 coverage proves each terminal path |
| Resolved P0-05 | Vendor compliance UI formerly relied on inconsistent owner-only authorization | Signed-in administrators could fail while a special header succeeded | All human admin APIs/UI calls use active administrator bearer sessions; role and inactive-session boundaries are integration-tested |
| Resolved P0-06 | Public auth UI formerly allowed role switching inside one page instead of enforcing route and role access | Users could see irrelevant workspaces; authorization behavior was hard to reason about | Dedicated exact-role routes and a shared active-profile gate are now in place; the production switch and duplicate delivery login were removed |
| P1 | Vendor registration is split between `AuthPanel` and post-login `VendorSetup` | The required registration form and success journey do not exist as one coherent process | Build a guided registration wizard with persisted draft/status and explicit completion page |
| P1 | Customer registration cannot collect name, phone OTP, email, and password in one path | Neither current email registration nor phone registration satisfies the supplied form | Build a unified customer registration and verification flow |
| P1 | Product master is a local-state prototype; no product CRUD API is connected | Vendors/admin cannot maintain the requested product fields or alternates | Implement governed product/variant CRUD and connect the form |
| P1 | Admin APIs fetch stock, sales, ledger, store, and delivery data, but most are not rendered as usable filtered reports | Core admin requirements are visibly missing | Create dedicated report endpoints/views with filters, pagination, totals, and export |
| P1 | Public inventory responses expose exact pharmacy latitude and longitude | The private registered location may be disclosed even though the requirement says it is not customer-visible | Separate legal/private address from public service location, or return only server-calculated distance/serviceability |
| P1 | Uploaded documents are marked `content_validated`, but no antivirus/malware scanner exists | File signatures are checked, but malicious content could still be stored and opened | Add quarantine and asynchronous malware scanning; do not label signature checks as malware validation |
| Resolved P0-08 | `npm run build` formerly depended on Linux GNU `timeout`, and `vinext start` did not inject local D1/R2 bindings | macOS production-like local verification was confusing and database/file APIs returned HTTP 500 | Build now uses a portable bounded runner; production preview runs the packaged Worker with persistent local D1/R2 bindings and applies packaged migrations |
| P2 | Resend failures return `sent: false` but are not retried or surfaced | Verification-adjacent and order messages can be silently lost | Add an outbox, retry policy, delivery status, and admin visibility |
| P2 | The live product/order flow supports only one selected product even though the order API accepts multiple items | The required cart is not implemented end to end | Add persistent server-validated cart lines grouped by pharmacy |
| Resolved P0-07 | `customers` legacy records and live `account_profiles` formerly lacked an explicit ownership policy | Reporting and identity ownership could become ambiguous | Supabase Auth now has the documented credential authority, `account_profiles` is the live application identity/ownership source, and `customers` is an unlinked admin-only reference archive |

## 5. Requirement traceability matrix

### 5.1 Vendor registration, login, and profile

| ID | Requirement | Status | Current evidence | Gap / required completion | Phase |
|---|---|---|---|---|---|
| V-REG-01 | Shop/business name | Implemented foundation | Collected in the unified authenticated vendor-registration wizard and saved in one review submission | Persist/resume pre-submission drafts under P1-10 | 1 |
| V-REG-02 | Owner name | Implemented foundation | Collected and length-bounded in the unified wizard and shared server validation | Add stronger legal-name guidance if compliance requires it | 1 |
| V-REG-03 | Phone, exactly 10 digits | Partial | Client and server validation exist | Registration must not create a usable vendor until phone ownership is verified | 1 |
| V-REG-04 | Ask for and verify phone OTP | Partial | Supabase OTP exists; profile phone-change OTP exists | Email registration currently creates the account before the required vendor OTP is completed; unify the sequence | 1 |
| V-REG-05 | Validate phone already registered | Partial | Conditional unique indexes and conflict checks exist during profile creation/update | Add a clear, safe availability result in the registration flow and integration tests for races | 1 |
| V-REG-06 | Landline, 10 digits | Implemented | Included in onboarding; optional under D-04 and validated as exactly 10 digits when entered | None for the stated requirement | 1 |
| V-REG-07 | Email and duplicate validation | Partial | Supabase handles email accounts; vendor email has a unique D1 index | Add coherent duplicate-account UX without unsafe account enumeration; test provider behavior | 1 |
| V-REG-08 | Password | Implemented foundation | Supabase email/password registration and login exist | Add password policy, confirmation, strength guidance, rate limiting verification, and recovery flow | 1 |
| V-REG-09 | GST number | Implemented foundation | Optional GSTIN is included in registration and format-validated under D-05 | Enforce the GST-rated selling gate in the sales phase | 1 |
| V-REG-10 | Required licence upload; JPG/JPEG/PNG/PDF/DOC/DOCX | Implemented foundation | The wizard requires the exact allowed formats; signature/MIME checks, 8 MB limit, R2 metadata, licence record, and pending review are wired | Add upload progress/retry and Phase 7 quarantine/malware scanning | 1, 7 |
| V-REG-11 | Private address with geolocation, latitude, longitude | Implemented foundation | Unified wizard requires a private address and map/coordinates; server validation persists them with the review package under D-06 | Persist/resume drafts and finish the public-location API privacy audit under P1-09/P1-10 | 1 |
| V-REG-12 | Registration success page | Missing | Only inline messages/cards exist | Add a dedicated success/status route showing phone, email, licence, pharmacist, and admin-review state | 1 |
| V-REG-13 | Email verification link sent | Partial | Supabase signup/resend is wired | Verify template, redirect URL, expiry, resend limits, and delivery observability | 1 |
| V-REG-14 | Verification link returns user and auto-logs in | Partial | Supabase client enables session URL detection | No dedicated callback/success path or end-to-end test proves this behavior | 1 |
| V-LOGIN-01 | Vendor email/password login | Implemented foundation | Supabase password login and test login exist | Move to a dedicated route and add forgot-password, lockout/rate-limit UX, and session-expiry handling | 1 |
| V-LOGIN-02 | Only verified email can login; otherwise resend link | Partial | Login catches “email not confirmed” and resends | Confirm provider settings prevent unverified sessions; add resend throttling and E2E test | 1 |
| V-PRO-01 | Editable business/owner/phone/landline/GST | Implemented | Live D1-backed vendor setup form and API exist | Add field-level errors and concurrent-update handling | 1 |
| V-PRO-02 | Phone re-verification and duplicate validation | Implemented foundation | Supabase phone change OTP plus D1 conflict check | Add E2E coverage and recovery when OTP expires | 1 |
| V-PRO-03 | Email read-only | Implemented | Email is read-only in vendor setup | Document support/admin process for a legal email change | 1 |
| V-PRO-04 | Licence replacement/upload | Implemented foundation | Multiple licences, documents, status, and admin review exist | Add expiry replacement journey, malware scan, and clearer active/current licence rule | 1, 5 |
| V-PRO-05 | Private geo address and coordinates | Partial | Stored and editable | Enforce privacy boundary and distinguish registered address from public pickup/service location | 1 |
| V-PRO-06 | Home delivery Yes/No | Implemented | Stored with delivery radius and enforced for pharmacy delivery | Add customer-facing availability derived from server policy | 1 |
| V-PRO-07 | Bank name, account name/no, IFSC | Implemented foundation | Account number is encrypted; only last four digits are returned | Add admin verification/rejection workflow, key rotation plan, and audit tests | 1, 7 |
| V-PRO-08 | Change password | Implemented foundation | Supabase password update exists | Consider requiring recent authentication/current password and add recovery flow | 1 |

### 5.2 Vendor orders, offline sales, stock, and procurement

| ID | Requirement | Status | Current evidence | Gap / required completion | Phase |
|---|---|---|---|---|---|
| V-ORD-01 | Customer details and order details | Partial | Live order API returns scoped customer/order/items/payment/delivery data | Add dedicated detail page, filters, search, pagination, printable invoice, and remove hard-coded duplicate order table | 3 |
| V-ORD-02 | Vendor order workflow | Implemented foundation | Payment/prescription gates and controlled status transitions exist | Add SLA indicators, cancellation/refund policy, idempotency tests, and operational notifications | 3 |
| V-SALE-01 | Offline sale with customer name | Partial | Live counter sale exists and posts stock, GST invoice, and ledgers | Supports only one line; add cart/line items, discounts, optional customer, Rx safety, receipt print/download, and returns lookup | 3 |
| V-STK-01 | Purchase order: stockist, invoice number, date | Implemented | Live supplier invoice receiving exists | Rename consistently as purchase/GRN if immediate receiving is intended; add draft/approve/receive states if true PO workflow is required | 2 |
| V-STK-02 | Product rows with batch, expiry, manufacture date, dosage, prices, quantity, GST | Implemented through procurement | Multi-line form and server validation exist | Add barcode/search ergonomics, UOM/pack conversion, duplicate-line handling, and integration tests | 2 |
| V-STK-03 | Amount = purchase price × quantity + GST | Implemented | Client preview and server-authoritative paise calculation exist | Add rounding policy acceptance tests and invoice-level discount/freight decision | 2 |
| V-STK-04 | Amount/tax/total summary | Implemented | Summary and persisted totals exist | Add printable purchase voucher and supplier balance update | 2 |
| V-STK-05 | Direct/opening stock entry | Partial | Inventory API supports opening stock with audit record | UI lacks manufacture date and dosage fields; define when direct stock is allowed versus purchase receiving | 2 |
| V-STK-06 | Stock ledger | Implemented foundation | Purchase, online sale, offline sale, cancel, and return movements are recorded | Add adjustment/count workflow and reconciliation report; fix reservation lifecycle | 0, 2 |

### 5.3 Product, supplier, and manufacturer masters

| ID | Requirement | Status | Current evidence | Gap / required completion | Phase |
|---|---|---|---|---|---|
| V-PRD-01 | Categories dropdown: tablet, capsule, injection, ointment, cream, aerosols, transdermal patches, syrup | Prototype / decision required | Options are hard-coded in a non-persisting form; admin category table also exists | Decide whether these are dosage forms or commercial categories. Implement a governed master and seed normalized values | 2 |
| V-PRD-02 | Drug name and trade name | Prototype | Schema has generic/trade fields, but no connected editor | Implement API, uniqueness/search rules, approval ownership, and UI | 2 |
| V-PRD-03 | Product information | Prototype | Schema field exists | Connect CRUD and sanitization/length rules | 2 |
| V-PRD-04 | Alternate products with right-side search/select | Prototype | `product_alternates` table exists; UI list is hard-coded | Add clinical/governance rules, search endpoint, create/delete API, and prevent self/circular duplicates | 2 |
| V-PRD-05 | Dosage units such as 1 mg / 50 mg | Partial / decision required | Free-text dosage exists on inventory/purchase rows | Strength belongs to product/variant, not batch. Define structured value, unit, form, and pack/UOM model | 2 |
| V-PRD-06 | Purchase and sale price per unit | Partial | Stored per inventory batch and editable at receipt/opening stock | Keep pricing out of the global product master; add price history and authorization | 2 |
| V-PRD-07 | Batch number | Implemented in inventory | Unique by vendor/product/batch | Keep as inventory data, not a shared product-master field | 2 |
| V-PRD-08 | Manufacturer | Partial | Shared manufacturer table and product manufacturer text exist | Normalize product foreign key; restrict who may edit the global master; support explicit rename/merge | 2 |
| V-PRD-09 | Prescription mandatory | Partial | Product field is enforced in online ordering | No connected master editor; offline sale does not enforce prescription capture | 2, 3 |
| V-PRD-10 | GST 0/5/12/18/28 | Partial | Validated in stock/purchase and used in billing | Product-default editor is missing; define override rules and effective-date history | 2 |
| V-SUP-01 | Add supplier/stockist | Implemented | Vendor-scoped supplier create exists | Add duplicate policy for GSTIN/phone and optional documents if required | 2 |
| V-SUP-02 | Business name, contact name, phone, email, address | Implemented | UI/API validation and persistence exist | Confirm required/optional fields against final policy | 2 |
| V-SUP-03 | Edit and view suppliers | Implemented foundation | Edit and list exist; inactive status is supported | Add search, pagination, supplier detail, balances, purchase history, and audit view | 2 |
| V-MFR-01 | Add manufacturer business name | Implemented foundation | Upsert and list exist | Global writes by any vendor are risky; introduce admin approval or vendor suggestions | 2 |
| V-MFR-02 | Edit/view manufacturer | Partial | View exists; same-name upsert exists | Add explicit ID-based edit, rename/merge, duplicate handling, and audit UI | 2 |

### 5.4 Vendor alerts and reports

| ID | Requirement | Status | Current evidence | Gap / required completion | Phase |
|---|---|---|---|---|---|
| V-ALT-01 | Near-expiry reminder three months prior as popup | Partial | 90-day query, count, and alert table exist | No popup/inbox/email job for vendors. Add deduplicated vendor notifications, read/snooze/action state, and scheduler | 5 |
| V-ALT-02 | Zero-stock reminder | Partial | Zero/low-stock rows and reorder levels exist | Add deduplicated vendor notifications, acknowledgement, supplier/PO action, and scheduler | 5 |
| V-RPT-01 | Offline sales report | Partial | Daily channel aggregates exist and a total is shown | Add date/product/customer/payment filters, line detail, totals, pagination, export, and returns/net-sales handling | 6 |
| V-RPT-02 | Online sales report | Partial | Daily channel aggregates and completed-order totals exist | Add date/product/order/payment/delivery filters, tax/net values, refunds, and export | 6 |

### 5.5 Customer registration, login, ordering, and reminders

| ID | Requirement | Status | Current evidence | Gap / required completion | Phase |
|---|---|---|---|---|---|
| C-REG-01 | Name | Partial | Collected by both auth methods | Must be part of one unified registration form | 1 |
| C-REG-02 | Phone, exact 10 digits, OTP | Partial | Phone-only OTP path exists | Email/password path does not collect/verify phone; combine into one journey | 1 |
| C-REG-03 | Validate phone already registered | Partial | Live profile phone has a conditional unique index | Add user-facing safe duplicate handling and concurrent signup tests | 1 |
| C-REG-04 | Email and duplicate validation | Partial | Supabase email signup exists | Add unified UX, provider behavior tests, and safe duplicate messaging | 1 |
| C-REG-05 | Password | Partial | Email path supports password | Phone path creates a session without the required email/password; unify the model | 1 |
| C-LOGIN-01 | Customer email/password login | Implemented foundation | Supabase password login exists | Dedicated route, forgot password, session expiry, and error states are missing | 1 |
| C-LOGIN-02 | Verified email gate; resend verification link | Partial | Same behavior as vendor login | Add dedicated verification status/success route and E2E proof | 1 |
| C-ORD-01 | Name and phone | Implemented in checkout | Server validates both | Prefill from verified profile and restrict unverified phone edits or reverify changes | 4 |
| C-ORD-02 | Address with geolocation, latitude, longitude | Partial | Live checkout map and server service-radius check exist | `customer_addresses` table is unused; add save/select/edit/default address flow | 4 |
| C-ORD-03 | Search and add to cart | Partial | Search is live, API supports multiple items, but checkout accepts one selected item in the UI | Implement multi-line cart, quantity editing, pharmacy grouping, price/stock revalidation, and persistence | 4 |
| C-ORD-04 | Upload prescription order | Implemented foundation | Secure upload and pharmacist review exist | Integrate cleanly with cart containing multiple Rx items and enforce document reuse/expiry policy | 4 |
| C-ORD-05 | Cart | Prototype / partial | Public drawer uses demo products; live order screen does not use it | Replace demo cart with authenticated/database-backed cart state | 4 |
| C-ORD-06 | Payment | Implemented foundation | Razorpay/COD flows and reservation expiry/failure release exist | Complete provider retry/refund handling, reconciliation, receipts, and browser E2E sandbox tests | 4 |
| C-ORD-07 | Pickup or home delivery | Implemented foundation | Pickup, pharmacy, and URMED delivery modes exist with radius enforcement | Clarify “home delivery” choices in UX and calculate configurable fees/promises server-side | 4 |
| C-HIS-01 | Purchase history | Partial | Live scoped orders and delivery timeline are shown | Add order detail, filters, cancellation eligibility, reorder, and pagination | 4 |
| C-HIS-02 | Invoice access | Missing in customer UI | Tax invoice records are created after delivery | Add authenticated HTML/PDF invoice endpoint and download button | 4 |
| C-REM-01 | Pill reminder: drug name and reminder date | Implemented beyond minimum | Medicine, time, start/end date, recurrence, toggle, consent, and notification inbox exist | Add edit/delete, timezone handling, job automation, delivery channels, and tests | 5 |
| C-REM-02 | Refill/reorder reminder | Implemented foundation | Delivered orders create estimated reminders; customers can confirm/snooze/cancel/reorder | Automate scheduling, provider delivery, and prescription-expiry decisions | 5 |

### 5.6 Administrator panel

| ID | Requirement | Status | Current evidence | Gap / required completion | Phase |
|---|---|---|---|---|---|
| A-REG-01 | List registrations | Implemented foundation | Vendor compliance queue lists pharmacies, licences, and pharmacists | Add customer/vendor/all-registration views, pagination, and consistent admin auth | 0, 6 |
| A-REG-02 | Required filters: product category, name, status | Missing | No registration filter API/UI | Clarify whether product category applies to registrations or product list; implement query filters and indexed search | 6 |
| A-REG-03 | View registered stores by location | Partial | Store coordinates are returned to admin | Add admin-only map/list, radius/region/status filters, and coordinate quality checks | 6 |
| A-CAT-01 | Product categories | Partial | Add/list API and UI exist | Add edit/deactivate, uniqueness, normalized name, usage count, and taxonomy decision | 2, 6 |
| A-LED-01 | Ledgers for individual stores | Partial | Ledger entries are vendor-scoped and generated by purchases/sales/expenses | No ledger-account/party master or store drilldown. Add chart of accounts, opening balances, filters, reconciliation, and exports | 6 |
| A-RPT-01 | Stock report medicine-wise | Partial | Backend aggregate by product exists | Render dedicated report with filters, totals, expiry/batch drilldown, pagination, and export | 6 |
| A-RPT-02 | Stock report manufacturer-wise | Partial | Manufacturer is returned by aggregate query | Add grouped view, normalized manufacturer key, filters, totals, and export | 6 |
| A-RPT-03 | Sales report date-wise | Partial | Backend returns daily online/offline aggregates | Render report with date range, channel, tax, refund, net total, and export | 6 |
| A-RPT-04 | Sales report medicine-wise | Missing | Current aggregate has no item/product grouping | Add order/offline line union query with product/manufacturer/category filters | 6 |
| A-EXP-01 | Expense purpose, amount, date, payment mode | Implemented foundation | Admin expense form posts balanced entries | Add vendor selector, edit/reversal policy, attachments, filters, and exports | 6 |
| A-EXP-02 | Expenses date-wise and head-wise report | Partial | Data is stored and recent rows are returned | Add grouping/filtering/totals/pagination/export | 6 |
| A-BAL-01 | Balance sheet | Missing | UI only computes sales less expenses, which is not a balance sheet | Define chart of accounts, assets/liabilities/equity, opening balances, period close, trial balance, P&L, and balance sheet | 6 |
| A-DEL-01 | Home delivery report | Partial | Backend and UI show recent deliveries and assignments | Add date/store/method/status/agent filters, delivery SLA, fee/COD reconciliation, distance, and export | 6 |

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
- [ ] P1-02 Require phone OTP and email verification before onboarding is marked complete.
- [ ] P1-03 Add safe duplicate phone/email handling and race-condition tests.
- [ ] P1-04 Add vendor registration success/status and verification-return routes.
- [ ] P1-05 Confirm auto-login after email verification; provide an explicit login fallback.
- [ ] P1-06 Build unified customer registration with name, phone OTP, email, password, and confirmation.
- [ ] P1-07 Add dedicated vendor/customer login, verification pending, resend, forgot-password, reset-password, and sign-out pages.
- [ ] P1-08 Finish vendor profile, bank verification status, phone change, password change, and licence renewal UX.
- [ ] P1-09 Separate private legal address from any public pickup/service location and stop returning private coordinates publicly.
- [ ] P1-10 Add onboarding integration and end-to-end tests, including interrupted/resumed signup.

**Exit criteria:** A new vendor and customer can complete all required fields, verification, auto-login, and profile retrieval without using a test account or hidden role switch.

**P1-01 vendor-registration decision (2026-08-12):** Public email/password account creation remains the authentication boundary and creates only a draft vendor shell. Once authenticated, one four-step wizard collects business/owner names, required 10-digit mobile verification, optional exact-10-digit landline, read-only account email, optional format-checked GSTIN, private legal address and coordinates, home-delivery policy, and the required current drug-licence document/details. The final server action validates the complete package, confirms the authenticated phone, rejects duplicate phone ownership, verifies the vendor-owned R2 document, atomically writes the vendor/profile/licence records, moves non-approved vendors to pending review, and writes one registration-submitted audit event. D-04, D-05, and D-06 are accepted as documented. Email/phone completion policy, availability/race handling, dedicated status/verification routes, resumable drafts, and public-location separation remain P1-02 through P1-05 and P1-09/P1-10.

### Phase 2 — Complete masters, procurement, and inventory

**Goal:** Establish reliable master data and stock creation before broad sales rollout.

- [ ] P2-01 Decide category versus dosage-form taxonomy and seed the approved values.
- [ ] P2-02 Introduce a structured product/variant model for drug name, trade name, form, strength/unit, packaging, manufacturer, Rx requirement, and GST default.
- [ ] P2-03 Implement governed product create/edit/view/deactivate APIs and UI.
- [ ] P2-04 Implement alternate product search/link/unlink with clinical/admin governance.
- [ ] P2-05 Normalize manufacturer linkage and add controlled rename/merge.
- [ ] P2-06 Finish supplier list/search/detail, balances, and purchase history.
- [ ] P2-07 Define purchase lifecycle: draft, approved, received, returned, and cancelled/reversed.
- [ ] P2-08 Add stock adjustments, cycle counts, reason codes, and reconciliation.
- [ ] P2-09 Add price history, UOM/pack conversion, barcode support decision, and MRP enforcement.
- [ ] P2-10 Add API/integration tests for purchases, duplicate invoices, batches, tax rounding, and returns.

**Exit criteria:** Authorized users can maintain master data and receive, adjust, trace, and return stock without manual database work.

### Phase 3 — Complete vendor sales and order operations

**Goal:** Make online fulfilment and counter sales operational for pharmacy staff.

- [ ] P3-01 Create a filterable online order queue and full order detail page.
- [ ] P3-02 Remove static order cards/tables once live views replace them.
- [ ] P3-03 Build multi-line offline POS cart with customer lookup, discounts, payment mode, totals, and receipt.
- [ ] P3-04 Enforce prescription capture/review for Rx offline sales.
- [ ] P3-05 Add GST invoice HTML/PDF generation and authenticated download/print.
- [ ] P3-06 Complete returns/refunds/credit notes for online and offline sources.
- [ ] P3-07 Add order/SLA/vendor notifications and payment/COD reconciliation.
- [ ] P3-08 Add end-to-end tests for online fulfilment, self-delivery, pickup, URMED delivery, cancellation, POS, and returns.

**Exit criteria:** A vendor can process each valid order path and perform a multi-item counter sale with correct stock, tax, ledger, invoice, and audit results.

### Phase 4 — Complete customer commerce

**Goal:** Replace the demonstration cart with a real search-to-payment journey.

- [ ] P4-01 Implement a real cart with multiple lines, quantity changes, removal, and pharmacy grouping.
- [ ] P4-02 Revalidate stock, FEFO allocation, price, GST, prescription, and serviceability at checkout.
- [ ] P4-03 Use `customer_addresses` for saved/default addresses and map selection.
- [ ] P4-04 Prefill verified customer identity and require re-verification for phone changes.
- [ ] P4-05 Integrate prescription selection for one or more Rx cart items.
- [ ] P4-06 Complete Razorpay sandbox flow, failure/retry, webhook reconciliation, refunds, and receipts.
- [ ] P4-07 Add order history/detail, delivery timeline, invoice download, cancellation rules, and reorder.
- [ ] P4-08 Remove demo product/cart/order-success data from the public site.
- [ ] P4-09 Add end-to-end tests from search through payment/delivery and purchase history.

**Exit criteria:** A verified customer can place and pay for a multi-item order, upload required prescriptions, choose pickup/delivery, track it, and retrieve its invoice.

### Phase 5 — Alerts, reminders, and communication reliability

**Goal:** Turn existing alert queries and reminder tables into reliable actions.

- [ ] P5-01 Generate deduplicated 90-day near-expiry vendor notifications.
- [ ] P5-02 Generate zero/low-stock vendor notifications with direct reorder actions.
- [ ] P5-03 Add vendor notification inbox/popup, read, acknowledge, snooze, and resolution state.
- [ ] P5-04 Automate pill/refill scheduling in the hosting environment with authenticated job execution.
- [ ] P5-05 Add notification preferences, consent checks, timezone handling, and channel rules.
- [ ] P5-06 Add transactional email outbox, retries, provider IDs, failure visibility, and dead-letter handling.
- [ ] P5-07 Add idempotency and scheduler tests to prevent duplicate alerts/messages.

**Exit criteria:** Due alerts appear once, can be acted on, and have auditable delivery/read state; provider failure does not silently lose a message.

### Phase 6 — Administrator reporting and accounting

**Goal:** Fulfil the complete administrator panel and reporting requirements.

- [ ] P6-01 Add filterable registration lists with status, name, date, role, and clarified category filter.
- [ ] P6-02 Add admin-only registered-store map and location/status filters.
- [ ] P6-03 Complete category and manufacturer governance screens.
- [ ] P6-04 Add store-ledger drilldown, chart of accounts, opening balances, and reconciliation.
- [ ] P6-05 Add medicine-wise and manufacturer-wise stock reports.
- [ ] P6-06 Add date-wise and medicine-wise online/offline sales reports with returns/net values.
- [ ] P6-07 Add date/head/store expense reports.
- [ ] P6-08 Implement trial balance, profit and loss, and a genuine balance sheet.
- [ ] P6-09 Add home-delivery report with store, method, status, rider, distance, SLA, fee, and COD filters.
- [ ] P6-10 Add CSV/XLSX/PDF export where operationally required, plus pagination and indexed queries.
- [ ] P6-11 Add authorization and tenant-isolation tests for every report.

**Exit criteria:** Admin users can filter, reconcile, and export the requested operational and accounting reports without accessing raw database tools.

### Phase 7 — Production hardening and release

**Goal:** Prove security, compliance, reliability, and operability before public release.

- [ ] P7-01 Configure and verify Supabase, Twilio, Resend, Razorpay, R2, encryption key, and scheduled jobs in each environment.
- [ ] P7-02 Add R2 upload quarantine and malware scanning before documents become viewable.
- [ ] P7-03 Add rate limits, abuse controls, account recovery, session revocation, and security headers review.
- [ ] P7-04 Review pharmacy, prescription, GST, privacy/consent, retention, and audit requirements with qualified legal/compliance owners.
- [ ] P7-05 Add automated backup, checksum, restore drill, and recovery evidence.
- [ ] P7-06 Add structured monitoring for auth, payments, webhooks, jobs, emails, storage, and database errors.
- [ ] P7-07 Complete accessibility, responsive behavior, performance, privacy, and browser QA.
- [ ] P7-08 Run role-based UAT with vendor, customer, admin, pharmacist, and delivery-agent scenarios.
- [ ] P7-09 Remove test credentials, test role switching, development metadata, and demo records from production surfaces.
- [ ] P7-10 Complete release checklist, rollback plan, and production smoke test.

**Exit criteria:** Production integrations are verified, critical end-to-end tests pass, operational recovery is proven, and no demo/test-only access is exposed.

## 7. Recommended data and API changes

The following changes should be designed during the named phases rather than added all at once.

### Identity and onboarding

- Keep credentials and verification tokens in Supabase; do not store passwords in D1.
- Treat `account_profiles` as the only live application identity and ownership table; keep legacy `customers` as unlinked admin-only reference data unless a separately approved proof-based claim migration is implemented.
- Add registration/onboarding status fields or a dedicated onboarding table so an account can be verified but still incomplete.
- Add conditional uniqueness for normalized live email if D1 needs to enforce cross-role business rules; do not rely only on UI checks.
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

## 9. Test strategy and definition of done

### Existing automated coverage

The current 66 unit/regression tests validate portable build timeout behavior, production-preview binding wiring, administrator-role enforcement, exact-role routing, identity/archive isolation, date/geo/error controls, supplier-return arithmetic, reservation creation/commit/release/expiry/recovery, FEFO, GST, delivery, refill, test-token behavior, and P1-01 vendor-registration validation/wiring. The suite-level packaged-Worker runtime adds real local D1/R2 and HTTP coverage for purchase/return transactions, authorization and tenant isolation, reservation/payment/release/recovery paths, recovered-customer non-ownership, prescription-document controls, and the vendor business/private-location/licence review package.

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
