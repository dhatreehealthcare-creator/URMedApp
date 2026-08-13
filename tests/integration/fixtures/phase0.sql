PRAGMA foreign_keys = ON;

UPDATE pharmacy_inventory
SET quantity = 100,
    reserved_quantity = 0,
    expiry_date = date('now', '+730 day'),
    manufacturing_date = date('now', '-180 day'),
    quarantine_status = 'available',
    cold_chain_status = 'not_applicable',
    active = 1
WHERE batch_number = 'TEST-URMED-001';

UPDATE products
SET prescription_required = 0,
    gst_percent = 5,
    hsn_code = '3004',
    drug_schedule = 'OTC',
    active = 1
WHERE id = (SELECT product_id FROM pharmacy_inventory WHERE batch_number = 'TEST-URMED-001');

INSERT INTO account_profiles
  (auth_user_id, role, name, email, phone, email_verified, phone_verified, status)
VALUES
  ('test:customer-two', 'customer', 'P009 Second Customer', 'customer-two@urmed.test', '0000000011', 1, 1, 'active'),
  ('test:vendor-two', 'vendor', 'P009 Second Vendor', 'vendor-two@urmed.test', '0000000012', 1, 1, 'active'),
  ('test:vendor-operational-two', 'vendor', 'P009 Other Operational Vendor', 'vendor-operational-two@urmed.test', '0000000014', 1, 1, 'active'),
  ('test:vendor-email-pending', 'vendor', 'P102 Email Pending Vendor', 'vendor-email-pending@urmed.test', '0000000015', 0, 1, 'active'),
  ('test:vendor-phone-pending', 'vendor', 'P102 Phone Pending Vendor', 'vendor-phone-pending@urmed.test', '0000000016', 1, 0, 'active'),
  ('test:vendor-both-pending', 'vendor', 'P102 Both Pending Vendor', 'vendor-both-pending@urmed.test', '0000000017', 0, 0, 'active'),
  ('test:customer-phone-pending', 'customer', 'P110 Resumable Customer', 'customer-phone-pending@urmed.test', '0000000018', 1, 0, 'active'),
  ('test:vendor-inventory-staff', 'vendor', 'P009 Inventory Staff', 'vendor-inventory-staff@urmed.test', '0000000019', 1, 1, 'active'),
  ('test:vendor-delivery-coordinator', 'vendor', 'P009 Delivery Coordinator', 'vendor-delivery-coordinator@urmed.test', '0000000020', 1, 1, 'active'),
  ('test:vendor-counter-staff', 'vendor', 'P009 Counter Staff', 'vendor-counter-staff@urmed.test', '0000000021', 1, 1, 'active'),
  ('test:vendor-expired-pos', 'vendor', 'P304 Expired POS Vendor', 'vendor-expired-pos@urmed.test', '0000000023', 1, 1, 'active'),
  ('test:delivery-two', 'delivery', 'P009 Other Rider', 'delivery-two@urmed.test', '0000000022', 1, 1, 'active'),
  ('test:inactive', 'customer', 'P009 Inactive Customer', 'inactive@urmed.test', '0000000013', 1, 1, 'inactive');

INSERT INTO test_accounts (profile_id, email, phone, email_confirmed, phone_confirmed, password_sha256, active)
SELECT id, email, phone, email_verified, phone_verified, '82653beae118d41e23e29c582a86f50675468ed1b588c284704a7a3491e32184', 1
FROM account_profiles
WHERE auth_user_id IN (
  'test:customer-two', 'test:vendor-two', 'test:vendor-operational-two',
  'test:vendor-email-pending', 'test:vendor-phone-pending', 'test:vendor-both-pending',
  'test:customer-phone-pending', 'test:vendor-inventory-staff',
  'test:vendor-delivery-coordinator', 'test:vendor-counter-staff', 'test:delivery-two', 'test:inactive'
  , 'test:vendor-expired-pos'
);

INSERT INTO delivery_agents
  (profile_id, vehicle_type, vehicle_number, licence_number, availability_status, current_latitude, current_longitude)
SELECT id, 'bike', 'TS09-OTHER-2026', 'P009-OTHER-RIDER', 'available', '', ''
FROM account_profiles WHERE auth_user_id='test:delivery-two';

INSERT INTO vendor_staff (vendor_id, profile_id, staff_role, permissions_json, status, joined_at)
SELECT vendor.id, profile.id,
  CASE profile.auth_user_id
    WHEN 'test:vendor-inventory-staff' THEN 'inventory_manager'
    WHEN 'test:vendor-delivery-coordinator' THEN 'delivery_coordinator'
    ELSE 'counter_staff'
  END,
  '[]', 'active', CURRENT_TIMESTAMP
FROM account_profiles profile
JOIN vendors vendor ON vendor.profile_id = (
  SELECT owner.id FROM account_profiles owner WHERE owner.auth_user_id = 'test:vendor'
)
WHERE profile.auth_user_id IN (
  'test:vendor-inventory-staff', 'test:vendor-delivery-coordinator', 'test:vendor-counter-staff'
);

INSERT INTO test_sessions (test_account_id, token_hash, expires_at)
SELECT account.id, '0b01f7032dd263e352e2392ec03b52010a89e10280f9d0ee0e3e4716d5a5097b', datetime('now', '+8 hours')
FROM test_accounts account
WHERE account.email = 'inactive@urmed.test';

INSERT INTO customer_addresses (id, profile_id, label, address, latitude, longitude, is_default)
SELECT 900010, id, 'Integration home', 'P4 integration customer home', '17.431800', '78.407300', 1
FROM account_profiles WHERE auth_user_id = 'test:customer';

INSERT INTO customer_addresses (id, profile_id, label, address, latitude, longitude, is_default)
SELECT 900011, id, 'Second customer home', 'P4 second customer home', '17.441800', '78.417300', 1
FROM account_profiles WHERE auth_user_id = 'test:customer-two';

INSERT INTO vendors
  (profile_id, business_name, owner_name, phone, email, gst_number, licence_number,
   address, latitude, longitude, home_delivery, registration_status, registration_submitted_at,
   approval_status, compliance_status, delivery_radius_km)
SELECT id, 'P009 Second Pharmacy', name, phone, email, '36ABCDE1234F1Z6', 'P009-DL-SECOND',
  'Second integration pharmacy', '17.4318', '78.4073', 1, 'draft', NULL, 'draft', 'pending', 10
FROM account_profiles
WHERE auth_user_id = 'test:vendor-two';

INSERT INTO vendors
  (profile_id, business_name, owner_name, phone, email, gst_number, licence_number,
   address, latitude, longitude, home_delivery, registration_status, registration_submitted_at,
   approval_status, compliance_status, delivery_radius_km)
SELECT id, 'P009 Other Operational Pharmacy', name, phone, email, '', 'P009-DL-OTHER',
  'Other integration pharmacy', '17.4518', '78.4273', 1, 'submitted', CURRENT_TIMESTAMP, 'approved', 'verified', 10
FROM account_profiles
WHERE auth_user_id = 'test:vendor-operational-two';

-- Explicit test-only publication. Production migration intentionally does not
-- copy vendors.address/latitude/longitude into this customer-facing table.
INSERT INTO vendor_public_locations
  (vendor_id, label, address, latitude, longitude, pickup_enabled, service_enabled,
   service_radius_km, publication_status, publication_consent_at, published_at)
SELECT id, 'P009 Customer Pickup', 'P009 explicitly public pickup point',
  '17.432100', '78.407600', 1, 1, 10, 'published', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM vendors
WHERE profile_id = (SELECT id FROM account_profiles WHERE auth_user_id = 'test:vendor');

INSERT INTO vendors
  (profile_id, business_name, owner_name, phone, email, registration_status, approval_status, compliance_status)
SELECT id, name || ' Pharmacy', name, phone, email, 'draft', 'draft', 'pending'
FROM account_profiles
WHERE auth_user_id IN ('test:vendor-email-pending', 'test:vendor-phone-pending', 'test:vendor-both-pending');

INSERT INTO pharmacists
  (vendor_id, profile_id, full_name, council_name, registration_number, valid_from, valid_until,
   verification_status, active)
SELECT vendor.id, profile.id, profile.name, 'P009 State Pharmacy Council', 'P009-PHARM-001',
  date('now', '-1 year'), date('now', '+1 year'), 'verified', 1
FROM account_profiles profile
JOIN vendors vendor ON vendor.profile_id = profile.id
WHERE profile.auth_user_id = 'test:vendor';

INSERT INTO vendor_licences
  (vendor_id, licence_number, form_type, licence_category, issuing_authority, valid_from, valid_until,
   verification_status)
SELECT vendor.id, 'P009-LIC-CURRENT', '20B', 'retail', 'P009 State Drug Control',
  date('now', '-1 year'), date('now', '+1 year'), 'verified'
FROM vendors vendor
JOIN account_profiles profile ON profile.id = vendor.profile_id
WHERE profile.auth_user_id = 'test:vendor';

INSERT INTO pharmacists
  (vendor_id, profile_id, full_name, council_name, registration_number, valid_from, valid_until,
   verification_status, active)
SELECT vendor.id, profile.id, profile.name, 'P009 State Pharmacy Council', 'P009-PHARM-OTHER',
  date('now', '-1 year'), date('now', '+1 year'), 'verified', 1
FROM account_profiles profile
JOIN vendors vendor ON vendor.profile_id = profile.id
WHERE profile.auth_user_id = 'test:vendor-operational-two';

INSERT INTO vendor_licences
  (vendor_id, licence_number, form_type, licence_category, issuing_authority, valid_from, valid_until,
   verification_status)
SELECT vendor.id, 'P009-LIC-OTHER', '20B', 'retail', 'P009 State Drug Control',
  date('now', '-1 year'), date('now', '+1 year'), 'verified'
FROM vendors vendor
JOIN account_profiles profile ON profile.id = vendor.profile_id
WHERE profile.auth_user_id = 'test:vendor-operational-two';

INSERT INTO vendors
  (id, business_name, owner_name, phone, email, registration_status, registration_submitted_at,
   approval_status, compliance_status, address, latitude, longitude, home_delivery)
VALUES
  (900020, 'P009 Expired Licence Pharmacy', 'Expired Owner', '9000009020', 'expired-p009@urmed.test',
   'submitted', CURRENT_TIMESTAMP, 'approved', 'verified', 'Private expired address', '17.43', '78.40', 1),
  (900021, 'P009 Noncompliant Pharmacy', 'Pending Owner', '9000009021', 'noncompliant-p009@urmed.test',
   'submitted', CURRENT_TIMESTAMP, 'approved', 'pending', 'Private pending address', '17.43', '78.40', 1),
  (900022, 'P009 Testing Pharmacy', 'Testing Owner', '9000009022', 'testing-p009@urmed.test',
   'submitted', CURRENT_TIMESTAMP, 'testing', 'verified', 'Private testing address', '17.43', '78.40', 1),
  (900023, 'P009 Draft Pharmacy', 'Draft Owner', '9000009023', 'draft-p009@urmed.test',
   'draft', NULL, 'approved', 'verified', 'Private draft address', '17.43', '78.40', 1);

UPDATE vendors SET profile_id = (SELECT id FROM account_profiles WHERE auth_user_id='test:vendor-expired-pos')
WHERE id = 900020;

INSERT INTO vendor_licences
  (vendor_id, licence_number, form_type, licence_category, issuing_authority, valid_from, valid_until,
   verification_status)
VALUES
  (900020, 'P009-LIC-EXPIRED', '20B', 'retail', 'P009 State Drug Control', date('now', '-2 years'), date('now', '-1 day'), 'verified'),
  (900021, 'P009-LIC-NONCOMPLIANT', '20B', 'retail', 'P009 State Drug Control', date('now', '-1 year'), date('now', '+1 year'), 'verified'),
  (900022, 'P009-LIC-TESTING', '20B', 'retail', 'P009 State Drug Control', date('now', '-1 year'), date('now', '+1 year'), 'verified'),
  (900023, 'P009-LIC-DRAFT', '20B', 'retail', 'P009 State Drug Control', date('now', '-1 year'), date('now', '+1 year'), 'verified');

INSERT INTO pharmacists
  (vendor_id, full_name, council_name, registration_number, valid_from, valid_until, verification_status, active)
VALUES
  (900020, 'P009 Expired Vendor Pharmacist', 'P009 State Pharmacy Council', 'P009-PHARM-EXPIRED', date('now', '-1 year'), date('now', '+1 year'), 'verified', 1),
  (900021, 'P009 Noncompliant Vendor Pharmacist', 'P009 State Pharmacy Council', 'P009-PHARM-NONCOMPLIANT', date('now', '-1 year'), date('now', '+1 year'), 'verified', 1),
  (900022, 'P009 Testing Vendor Pharmacist', 'P009 State Pharmacy Council', 'P009-PHARM-TESTING', date('now', '-1 year'), date('now', '+1 year'), 'verified', 1),
  (900023, 'P009 Draft Vendor Pharmacist', 'P009 State Pharmacy Council', 'P009-PHARM-DRAFT', date('now', '-1 year'), date('now', '+1 year'), 'verified', 1);

INSERT INTO pharmacy_inventory
  (id, vendor_id, product_id, batch_number, expiry_date, manufacturing_date, dosage,
   purchase_price_paise, sale_price_paise, mrp_paise, quantity, reserved_quantity, gst_percent,
   quarantine_status, cold_chain_status, active)
SELECT bad.id, bad.id, source.product_id, 'P009-NONSELLABLE-' || bad.id,
  date('now', '+1 year'), date('now', '-1 year'), 'P009 security fixture',
  1000, 1200, 1500, 10, 0, 5, 'available', 'not_applicable', 1
FROM vendors bad
CROSS JOIN (SELECT product_id FROM pharmacy_inventory WHERE batch_number = 'TEST-URMED-001') source
WHERE bad.id IN (900020, 900021, 900022, 900023);

INSERT INTO customers
  (legacy_id, name, email, mobile, registered_at, address, city, state, pincode,
   email_verified, mobile_verified, password_reset_required, source)
VALUES
  (900009, 'P009 Recovered Customer', 'recovered-only@urmed.test', '9000000009', '2020-01-02',
   'Recovery archive only', 'Hyderabad', 'Telangana', '500001', 1, 1, 1, 'p009_integration_fixture');

INSERT INTO suppliers
  (id, vendor_id, business_name, contact_name, phone, email, address, status)
SELECT 900009, id, 'P009 Integration Supplier', 'Supplier Contact', '9000000101',
  'supplier-p009@example.test', 'P009 supplier address', 'active'
FROM vendors WHERE profile_id=(SELECT id FROM account_profiles WHERE auth_user_id='test:vendor');

INSERT INTO stored_documents
  (id, owner_profile_id, vendor_id, purpose, object_key, original_filename, mime_type,
   size_bytes, sha256, malware_status, status)
SELECT 900009, id, NULL, 'prescription', 'p009/fixture-placeholder.png', 'p009-fixture.png',
  'image/png', 1, 'fixture-placeholder', 'content_validated', 'active'
FROM account_profiles WHERE auth_user_id='test:customer';

INSERT INTO stored_documents
  (id, owner_profile_id, vendor_id, purpose, object_key, original_filename, mime_type,
   size_bytes, sha256, malware_status, status)
SELECT 900010, customer.id, vendor.id, 'prescription', 'p4/fixture-placeholder-two.png', 'p4-fixture-two.png',
  'image/png', 1, 'fixture-placeholder-two', 'content_validated', 'active'
FROM account_profiles customer
JOIN vendors vendor ON vendor.profile_id=(SELECT id FROM account_profiles WHERE auth_user_id='test:vendor')
WHERE customer.auth_user_id='test:customer';

INSERT INTO prescriptions
  (id, prescription_number, customer_profile_id, vendor_id, document_id, patient_name,
   patient_address, prescriber_name, prescriber_address, prescribed_on, serial_number, status)
SELECT 900009, 'RX-P009-FIXTURE', customer.id, vendor.id, 900009, customer.name,
  'P009 patient address', 'P009 Test Doctor', 'P009 clinic', date('now'), 'P009-RX-FIXTURE', 'uploaded'
FROM account_profiles customer
JOIN vendors vendor ON vendor.profile_id=(SELECT id FROM account_profiles WHERE auth_user_id='test:vendor')
WHERE customer.auth_user_id='test:customer';

INSERT INTO prescriptions
  (id, prescription_number, customer_profile_id, vendor_id, document_id, patient_name,
   patient_address, prescriber_name, prescriber_address, prescribed_on, serial_number, status)
SELECT 900010, 'RX-P4-RACE-FIXTURE', customer.id, vendor.id, 900010, customer.name,
  'P4 patient address', 'P4 Test Doctor', 'P4 clinic', date('now'), 'P4-RX-RACE', 'uploaded'
FROM account_profiles customer
JOIN vendors vendor ON vendor.profile_id=(SELECT id FROM account_profiles WHERE auth_user_id='test:vendor')
WHERE customer.auth_user_id='test:customer';

INSERT INTO products
  (legacy_id, name, normalized_name, composition, manufacturer, prescription_required,
   gst_percent, hsn_code, packaging, source, governance_status, drug_schedule, active)
VALUES
  (900009, 'P009 Prescription Fixture Medicine', 'p009 prescription fixture medicine',
   'Integration fixture', 'P009 Manufacturer', 1, 5, '3004', '10 tablets', 'p009_integration_fixture', 'approved', 'H', 1);

INSERT INTO products
  (legacy_id, name, normalized_name, composition, manufacturer, prescription_required,
   gst_percent, hsn_code, packaging, source, governance_status, drug_schedule, active)
VALUES
  (900010, 'P4 Second Rx Fixture Medicine', 'p4 second rx fixture medicine',
   'Integration fixture two', 'P4 Manufacturer', 1, 12, '3004', '6 tablets', 'p4_integration_fixture', 'approved', 'H1', 1),
  (900011, 'P4 Other Pharmacy Fixture', 'p4 other pharmacy fixture',
   'Cross pharmacy fixture', 'P4 Manufacturer', 0, 5, '3004', '10 tablets', 'p4_integration_fixture', 'approved', 'OTC', 1),
  (900012, 'P4 Second OTC Fixture Medicine', 'p4 second otc fixture medicine',
   'Second cart line fixture', 'P4 Manufacturer', 0, 0, '3004', '20 tablets', 'p4_integration_fixture', 'approved', 'OTC', 1);

INSERT INTO products
  (legacy_id, name, normalized_name, composition, manufacturer, prescription_required,
   gst_percent, hsn_code, packaging, source, governance_status, drug_schedule, active)
VALUES
  (900030, 'P304 Counter OTC Fixture', 'p304 counter otc fixture',
   'Counter integration fixture', 'P304 Manufacturer', 0, 5, '3004', '10 tablets', 'p304_integration_fixture', 'approved', 'OTC', 1),
  (900031, 'P304 Counter Rx Fixture', 'p304 counter rx fixture',
   'Counter prescription fixture', 'P304 Manufacturer', 1, 12, '3004', '6 tablets', 'p304_integration_fixture', 'approved', 'H', 1),
  (900032, 'P304 Counter Second OTC', 'p304 counter second otc',
   'Counter second-line fixture', 'P304 Manufacturer', 0, 0, '3004', '20 tablets', 'p304_integration_fixture', 'approved', 'OTC', 1);

INSERT INTO products
  (legacy_id, name, normalized_name, composition, manufacturer, prescription_required,
   gst_percent, hsn_code, packaging, source, governance_status, drug_schedule, active)
VALUES
  (900050, 'P308 Fulfilment Return Fixture', 'p308 fulfilment return fixture',
   'Fulfilment and returns integration fixture', 'P308 Manufacturer', 0, 5, '3004', '10 tablets',
   'p308_integration_fixture', 'approved', 'OTC', 1);
INSERT INTO products
  (legacy_id, name, normalized_name, composition, manufacturer, prescription_required,
   gst_percent, hsn_code, packaging, source, governance_status, drug_schedule, active)
VALUES
  (900060, 'P209 Pricing Governance Fixture', 'p209 pricing governance fixture',
   'Pricing/UOM integration fixture', 'P209 Manufacturer', 0, 5, '3004', '10 tablets',
   'p209_integration_fixture', 'approved', 'OTC', 1);

INSERT INTO pharmacy_inventory
  (id, vendor_id, product_id, batch_number, expiry_date, manufacturing_date, dosage,
   purchase_price_paise, sale_price_paise, mrp_paise, quantity, reserved_quantity,
   gst_percent, reorder_level, quarantine_status, cold_chain_status, active)
SELECT 900009, vendor.id, product.id, 'P009-RX-BATCH', date('now', '+730 day'),
  date('now', '-180 day'), 'Integration fixture', 1000, 1200, 1500, 50, 0,
  5, 5, 'available', 'not_applicable', 1
FROM vendors vendor JOIN products product ON product.legacy_id=900009
WHERE vendor.profile_id=(SELECT id FROM account_profiles WHERE auth_user_id='test:vendor');

INSERT INTO pharmacy_inventory
  (id, vendor_id, product_id, batch_number, expiry_date, manufacturing_date, dosage,
   purchase_price_paise, sale_price_paise, mrp_paise, quantity, reserved_quantity,
   gst_percent, reorder_level, quarantine_status, cold_chain_status, active)
SELECT 900030, vendor.id, product.id, 'P304-OTC-EARLY', date('now', '+300 day'),
  date('now', '-100 day'), 'Counter integration', 700, 1000, 1200, 20, 2,
  5, 2, 'available', 'not_applicable', 1
FROM vendors vendor JOIN products product ON product.legacy_id=900030
WHERE vendor.profile_id=(SELECT id FROM account_profiles WHERE auth_user_id='test:vendor');

INSERT INTO pharmacy_inventory
  (id, vendor_id, product_id, batch_number, expiry_date, manufacturing_date, dosage,
   purchase_price_paise, sale_price_paise, mrp_paise, quantity, reserved_quantity,
   gst_percent, reorder_level, quarantine_status, cold_chain_status, active)
SELECT 900031, vendor.id, product.id, 'P304-OTC-LATE', date('now', '+600 day'),
  date('now', '-100 day'), 'Counter integration', 700, 1100, 1300, 20, 0,
  5, 2, 'available', 'not_applicable', 1
FROM vendors vendor JOIN products product ON product.legacy_id=900030
WHERE vendor.profile_id=(SELECT id FROM account_profiles WHERE auth_user_id='test:vendor');

INSERT INTO pharmacy_inventory
  (id, vendor_id, product_id, batch_number, expiry_date, manufacturing_date, dosage,
   purchase_price_paise, sale_price_paise, mrp_paise, quantity, reserved_quantity,
   gst_percent, reorder_level, quarantine_status, cold_chain_status, active)
SELECT 900032, vendor.id, product.id, 'P304-RX-BATCH', date('now', '+500 day'),
  date('now', '-100 day'), 'Counter Rx integration', 1400, 2000, 2300, 10, 0,
  12, 2, 'available', 'not_applicable', 1
FROM vendors vendor JOIN products product ON product.legacy_id=900031
WHERE vendor.profile_id=(SELECT id FROM account_profiles WHERE auth_user_id='test:vendor');

INSERT INTO pharmacy_inventory
  (id, vendor_id, product_id, batch_number, expiry_date, manufacturing_date, dosage,
   purchase_price_paise, sale_price_paise, mrp_paise, quantity, reserved_quantity,
   gst_percent, reorder_level, quarantine_status, cold_chain_status, active)
SELECT 900033, vendor.id, product.id, 'P304-OTC-SECOND', date('now', '+550 day'),
  date('now', '-100 day'), 'Counter second-line integration', 300, 500, 600, 10, 0,
  0, 2, 'available', 'not_applicable', 1
FROM vendors vendor JOIN products product ON product.legacy_id=900032
WHERE vendor.profile_id=(SELECT id FROM account_profiles WHERE auth_user_id='test:vendor');

INSERT INTO pharmacy_inventory
  (id, vendor_id, product_id, batch_number, expiry_date, manufacturing_date, dosage,
   purchase_price_paise, sale_price_paise, mrp_paise, quantity, reserved_quantity,
   gst_percent, reorder_level, quarantine_status, cold_chain_status, active)
SELECT 900050, vendor.id, product.id, 'P308-FULFILMENT-BATCH', date('now', '+500 day'),
  date('now', '-100 day'), 'Fulfilment integration', 700, 1000, 1200, 20, 0,
  5, 2, 'available', 'not_applicable', 1
FROM vendors vendor JOIN products product ON product.legacy_id=900050
WHERE vendor.profile_id=(SELECT id FROM account_profiles WHERE auth_user_id='test:vendor');

INSERT INTO pharmacy_inventory
  (id, vendor_id, product_id, batch_number, expiry_date, manufacturing_date, dosage,
   purchase_price_paise, sale_price_paise, mrp_paise, quantity, reserved_quantity,
   gst_percent, reorder_level, quarantine_status, cold_chain_status, active)
SELECT 900060, vendor.id, product.id, 'P209-PRICE-BATCH', date('now', '+500 day'),
  date('now', '-100 day'), 'Pricing integration', 700, 1000, 1200, 25, 0,
  5, 2, 'available', 'not_applicable', 1
FROM vendors vendor JOIN products product ON product.legacy_id=900060
WHERE vendor.profile_id=(SELECT id FROM account_profiles WHERE auth_user_id='test:vendor');

INSERT INTO pharmacy_inventory
  (id, vendor_id, product_id, batch_number, expiry_date, manufacturing_date, dosage,
   purchase_price_paise, sale_price_paise, mrp_paise, quantity, reserved_quantity,
   gst_percent, reorder_level, quarantine_status, cold_chain_status, active)
SELECT 900010, vendor.id, product.id, 'P4-RX-BATCH-2', date('now', '+700 day'),
  date('now', '-160 day'), 'Integration fixture', 1800, 2400, 2800, 50, 0,
  12, 5, 'available', 'not_applicable', 1
FROM vendors vendor JOIN products product ON product.legacy_id=900010
WHERE vendor.profile_id=(SELECT id FROM account_profiles WHERE auth_user_id='test:vendor');

INSERT INTO pharmacy_inventory
  (id, vendor_id, product_id, batch_number, expiry_date, manufacturing_date, dosage,
   purchase_price_paise, sale_price_paise, mrp_paise, quantity, reserved_quantity,
   gst_percent, reorder_level, quarantine_status, cold_chain_status, active)
SELECT 900011, vendor.id, product.id, 'P4-OTHER-BATCH', date('now', '+700 day'),
  date('now', '-160 day'), 'Integration fixture', 900, 1400, 1600, 50, 0,
  5, 5, 'available', 'not_applicable', 1
FROM vendors vendor JOIN products product ON product.legacy_id=900011
WHERE vendor.profile_id=(SELECT id FROM account_profiles WHERE auth_user_id='test:vendor-operational-two');

INSERT INTO pharmacy_inventory
  (id, vendor_id, product_id, batch_number, expiry_date, manufacturing_date, dosage,
   purchase_price_paise, sale_price_paise, mrp_paise, quantity, reserved_quantity,
   gst_percent, reorder_level, quarantine_status, cold_chain_status, active)
SELECT 900012, vendor.id, product.id, 'P4-OTC-BATCH-2', date('now', '+720 day'),
  date('now', '-140 day'), 'Integration fixture', 700, 1100, 1300, 50, 0,
  0, 5, 'available', 'not_applicable', 1
FROM vendors vendor JOIN products product ON product.legacy_id=900012
WHERE vendor.profile_id=(SELECT id FROM account_profiles WHERE auth_user_id='test:vendor');

-- Dedicated P5-03 alert fixtures. Each product has exactly one zero-stock batch
-- expiring within 90 days so the real scheduled handler deterministically
-- creates both a near-expiry and zero-stock alert for each vendor tenant.
INSERT INTO products
  (legacy_id, name, normalized_name, composition, manufacturer, prescription_required,
   gst_percent, hsn_code, packaging, source, governance_status, drug_schedule, active)
VALUES
  (900040, 'P503 Primary Vendor Alert Fixture', 'p503 primary vendor alert fixture',
   'Notification lifecycle fixture', 'P503 Manufacturer', 0, 5, '3004', '10 tablets',
   'p503_integration_fixture', 'approved', 'OTC', 1),
  (900041, 'P503 Other Vendor Alert Fixture', 'p503 other vendor alert fixture',
   'Notification tenant fixture', 'P503 Manufacturer', 0, 5, '3004', '10 tablets',
   'p503_integration_fixture', 'approved', 'OTC', 1);

INSERT INTO pharmacy_inventory
  (id, vendor_id, product_id, batch_number, expiry_date, manufacturing_date, dosage,
   purchase_price_paise, sale_price_paise, mrp_paise, quantity, reserved_quantity,
   gst_percent, reorder_level, quarantine_status, cold_chain_status, active)
SELECT 900040, vendor.id, product.id, 'P503-PRIMARY-ALERT', date('now', '+60 day'),
  date('now', '-60 day'), 'Alert integration fixture', 1000, 1200, 1500, 0, 0,
  5, 5, 'available', 'not_applicable', 1
FROM vendors vendor JOIN products product ON product.legacy_id=900040
WHERE vendor.profile_id=(SELECT id FROM account_profiles WHERE auth_user_id='test:vendor');

INSERT INTO pharmacy_inventory
  (id, vendor_id, product_id, batch_number, expiry_date, manufacturing_date, dosage,
   purchase_price_paise, sale_price_paise, mrp_paise, quantity, reserved_quantity,
   gst_percent, reorder_level, quarantine_status, cold_chain_status, active)
SELECT 900041, vendor.id, product.id, 'P503-OTHER-ALERT', date('now', '+60 day'),
  date('now', '-60 day'), 'Alert tenant fixture', 1000, 1200, 1500, 0, 0,
  5, 5, 'available', 'not_applicable', 1
FROM vendors vendor JOIN products product ON product.legacy_id=900041
WHERE vendor.profile_id=(SELECT id FROM account_profiles WHERE auth_user_id='test:vendor-operational-two');

-- Deterministic P6-11 operational-report rows for store and platform scoping.
INSERT INTO expenses
  (id, vendor_id, purpose, expense_head, amount_paise, expense_date, payment_mode,
   reference_number, created_by_profile_id)
SELECT 900040, vendor.id, 'P611 Primary store expense', 'P611 Operations', 12345,
  date('now'), 'cash', 'P611-PRIMARY', admin.id
FROM vendors vendor
JOIN account_profiles owner ON owner.id=vendor.profile_id AND owner.auth_user_id='test:vendor'
CROSS JOIN account_profiles admin
WHERE admin.auth_user_id='test:admin';

INSERT INTO expenses
  (id, vendor_id, purpose, expense_head, amount_paise, expense_date, payment_mode,
   reference_number, created_by_profile_id)
SELECT 900041, vendor.id, 'P611 Other store expense', 'P611 Courier', 23456,
  date('now'), 'upi', 'P611-OTHER', admin.id
FROM vendors vendor
JOIN account_profiles owner ON owner.id=vendor.profile_id AND owner.auth_user_id='test:vendor-operational-two'
CROSS JOIN account_profiles admin
WHERE admin.auth_user_id='test:admin';

INSERT INTO expenses
  (id, vendor_id, purpose, expense_head, amount_paise, expense_date, payment_mode,
   reference_number, created_by_profile_id)
SELECT 900042, NULL, 'P611 Platform expense', 'P611 Hosting', 34567,
  date('now'), 'card', 'P611-PLATFORM', admin.id
FROM account_profiles admin WHERE admin.auth_user_id='test:admin';

CREATE TRIGGER p009_fail_document_metadata
BEFORE INSERT ON stored_documents
WHEN NEW.original_filename='metadata-failure.png'
BEGIN
  SELECT RAISE(ABORT, 'p009_metadata_failure');
END;

CREATE TRIGGER p304_fail_atomic_audit
BEFORE INSERT ON audit_events
WHEN NEW.request_id='p304-fail-audit'
BEGIN
  SELECT RAISE(ABORT, 'p304_audit_failure');
END;
