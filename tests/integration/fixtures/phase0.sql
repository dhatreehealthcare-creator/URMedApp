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
    active = 1
WHERE id = (SELECT product_id FROM pharmacy_inventory WHERE batch_number = 'TEST-URMED-001');

INSERT INTO account_profiles
  (auth_user_id, role, name, email, phone, email_verified, phone_verified, status)
VALUES
  ('test:customer-two', 'customer', 'P009 Second Customer', 'customer-two@urmed.test', '0000000011', 1, 1, 'active'),
  ('test:vendor-two', 'vendor', 'P009 Second Vendor', 'vendor-two@urmed.test', '0000000012', 1, 1, 'active'),
  ('test:inactive', 'customer', 'P009 Inactive Customer', 'inactive@urmed.test', '0000000013', 1, 1, 'inactive');

INSERT INTO test_accounts (profile_id, email, password_sha256, active)
SELECT id, email, '82653beae118d41e23e29c582a86f50675468ed1b588c284704a7a3491e32184', 1
FROM account_profiles
WHERE auth_user_id IN ('test:customer-two', 'test:vendor-two', 'test:inactive');

INSERT INTO test_sessions (test_account_id, token_hash, expires_at)
SELECT account.id, '0b01f7032dd263e352e2392ec03b52010a89e10280f9d0ee0e3e4716d5a5097b', datetime('now', '+8 hours')
FROM test_accounts account
WHERE account.email = 'inactive@urmed.test';

INSERT INTO vendors
  (profile_id, business_name, owner_name, phone, email, gst_number, licence_number,
   address, latitude, longitude, home_delivery, approval_status, compliance_status, delivery_radius_km)
SELECT id, 'P009 Second Pharmacy', name, phone, email, '36ABCDE1234F1Z6', 'P009-DL-SECOND',
  'Second integration pharmacy', '17.4318', '78.4073', 1, 'draft', 'pending', 10
FROM account_profiles
WHERE auth_user_id = 'test:vendor-two';

INSERT INTO pharmacists
  (vendor_id, profile_id, full_name, council_name, registration_number, valid_from, valid_until,
   verification_status, active)
SELECT vendor.id, profile.id, profile.name, 'P009 State Pharmacy Council', 'P009-PHARM-001',
  date('now', '-1 year'), date('now', '+1 year'), 'verified', 1
FROM account_profiles profile
JOIN vendors vendor ON vendor.profile_id = profile.id
WHERE profile.auth_user_id = 'test:vendor';

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

INSERT INTO prescriptions
  (id, prescription_number, customer_profile_id, vendor_id, document_id, patient_name,
   patient_address, prescriber_name, prescriber_address, prescribed_on, serial_number, status)
SELECT 900009, 'RX-P009-FIXTURE', customer.id, vendor.id, 900009, customer.name,
  'P009 patient address', 'P009 Test Doctor', 'P009 clinic', date('now'), 'P009-RX-FIXTURE', 'uploaded'
FROM account_profiles customer
JOIN vendors vendor ON vendor.profile_id=(SELECT id FROM account_profiles WHERE auth_user_id='test:vendor')
WHERE customer.auth_user_id='test:customer';

INSERT INTO products
  (legacy_id, name, normalized_name, composition, manufacturer, prescription_required,
   gst_percent, hsn_code, packaging, source, active)
VALUES
  (900009, 'P009 Prescription Fixture Medicine', 'p009 prescription fixture medicine',
   'Integration fixture', 'P009 Manufacturer', 1, 5, '3004', '10 tablets', 'p009_integration_fixture', 1);

INSERT INTO pharmacy_inventory
  (id, vendor_id, product_id, batch_number, expiry_date, manufacturing_date, dosage,
   purchase_price_paise, sale_price_paise, mrp_paise, quantity, reserved_quantity,
   gst_percent, reorder_level, quarantine_status, cold_chain_status, active)
SELECT 900009, vendor.id, product.id, 'P009-RX-BATCH', date('now', '+730 day'),
  date('now', '-180 day'), 'Integration fixture', 1000, 1200, 1500, 50, 0,
  5, 5, 'available', 'not_applicable', 1
FROM vendors vendor JOIN products product ON product.legacy_id=900009
WHERE vendor.profile_id=(SELECT id FROM account_profiles WHERE auth_user_id='test:vendor');

CREATE TRIGGER p009_fail_document_metadata
BEFORE INSERT ON stored_documents
WHEN NEW.original_filename='metadata-failure.png'
BEGIN
  SELECT RAISE(ABORT, 'p009_metadata_failure');
END;

CREATE TRIGGER p009_razorpay_order_fixture
AFTER INSERT ON orders
WHEN NEW.payment_method='online'
BEGIN
  UPDATE orders SET razorpay_order_id='order_p009_' || NEW.id WHERE id=NEW.id;
END;

CREATE TRIGGER p009_fast_reservation_fixture
AFTER INSERT ON inventory_reservations
WHEN NEW.quantity=6
BEGIN
  UPDATE inventory_reservations SET expires_at=datetime('now', '-1 second') WHERE id=NEW.id;
  UPDATE orders SET reservation_expires_at=datetime('now', '-1 second') WHERE id=NEW.order_id;
END;
