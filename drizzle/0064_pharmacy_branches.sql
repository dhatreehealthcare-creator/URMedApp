-- P1-MULTISTORE-01: explicit operational pharmacy branches.
-- Existing vendor-owned records are assigned to one deterministic primary branch;
-- no stock is copied or merged.
CREATE TABLE IF NOT EXISTS pharmacy_branches (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  vendor_id INTEGER NOT NULL REFERENCES vendors(id),
  branch_code TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  address TEXT NOT NULL DEFAULT '',
  latitude TEXT NOT NULL DEFAULT '',
  longitude TEXT NOT NULL DEFAULT '',
  public_label TEXT NOT NULL DEFAULT '',
  public_address TEXT NOT NULL DEFAULT '',
  public_latitude TEXT NOT NULL DEFAULT '',
  public_longitude TEXT NOT NULL DEFAULT '',
  public_location_status TEXT NOT NULL DEFAULT 'draft' CHECK (public_location_status IN ('draft','published')),
  public_location_consent_at TEXT,
  public_published_at TEXT,
  pickup_enabled INTEGER NOT NULL DEFAULT 0 CHECK (pickup_enabled IN (0,1)),
  service_enabled INTEGER NOT NULL DEFAULT 0 CHECK (service_enabled IN (0,1)),
  service_radius_km INTEGER NOT NULL DEFAULT 5 CHECK (service_radius_km BETWEEN 1 AND 50),
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(vendor_id, branch_code)
);
CREATE UNIQUE INDEX IF NOT EXISTS pharmacy_branches_one_primary_uidx
  ON pharmacy_branches(vendor_id) WHERE is_primary = 1;
CREATE INDEX IF NOT EXISTS pharmacy_branches_vendor_status_idx
  ON pharmacy_branches(vendor_id, status, id);
CREATE INDEX IF NOT EXISTS pharmacy_branches_public_idx
  ON pharmacy_branches(public_location_status, status, vendor_id);

-- Vendors created by local fixtures or later onboarding receive the same
-- deterministic primary branch without copying a second stock record.
CREATE TRIGGER IF NOT EXISTS vendors_primary_branch_default
AFTER INSERT ON vendors
BEGIN
  INSERT INTO pharmacy_branches (vendor_id, branch_code, name, address, latitude, longitude,
    service_radius_km, is_primary)
  VALUES (NEW.id, 'PRIMARY', NEW.business_name, NEW.address, NEW.latitude, NEW.longitude,
    CASE WHEN NEW.delivery_radius_km BETWEEN 1 AND 50 THEN NEW.delivery_radius_km ELSE 5 END, 1)
  ON CONFLICT(vendor_id, branch_code) DO NOTHING;
END;

INSERT INTO pharmacy_branches
  (vendor_id, branch_code, name, status, address, latitude, longitude,
   public_label, public_address, public_latitude, public_longitude,
   public_location_status, public_location_consent_at, public_published_at,
   pickup_enabled, service_enabled, service_radius_km, is_primary)
SELECT v.id, 'PRIMARY', v.business_name, 'active', v.address, v.latitude, v.longitude,
  COALESCE(pl.label, ''), COALESCE(pl.address, ''), COALESCE(pl.latitude, ''), COALESCE(pl.longitude, ''),
  COALESCE(pl.publication_status, 'draft'), pl.publication_consent_at, pl.published_at,
  COALESCE(pl.pickup_enabled, 0), COALESCE(pl.service_enabled, 0),
  COALESCE(pl.service_radius_km, v.delivery_radius_km, 5), 1
FROM vendors v
LEFT JOIN vendor_public_locations pl ON pl.vendor_id = v.id
WHERE NOT EXISTS (SELECT 1 FROM pharmacy_branches existing WHERE existing.vendor_id = v.id AND existing.is_primary = 1);

CREATE TRIGGER IF NOT EXISTS vendor_public_location_branch_sync_insert
AFTER INSERT ON vendor_public_locations
BEGIN
  UPDATE pharmacy_branches SET public_label=NEW.label, public_address=NEW.address,
    public_latitude=NEW.latitude, public_longitude=NEW.longitude,
    pickup_enabled=NEW.pickup_enabled, service_enabled=NEW.service_enabled,
    service_radius_km=NEW.service_radius_km, public_location_status=NEW.publication_status,
    public_location_consent_at=NEW.publication_consent_at, public_published_at=NEW.published_at,
    updated_at=CURRENT_TIMESTAMP
  WHERE vendor_id=NEW.vendor_id AND is_primary=1;
END;
CREATE TRIGGER IF NOT EXISTS vendor_public_location_branch_sync_update
AFTER UPDATE ON vendor_public_locations
BEGIN
  UPDATE pharmacy_branches SET public_label=NEW.label, public_address=NEW.address,
    public_latitude=NEW.latitude, public_longitude=NEW.longitude,
    pickup_enabled=NEW.pickup_enabled, service_enabled=NEW.service_enabled,
    service_radius_km=NEW.service_radius_km, public_location_status=NEW.publication_status,
    public_location_consent_at=NEW.publication_consent_at, public_published_at=NEW.published_at,
    updated_at=CURRENT_TIMESTAMP
  WHERE vendor_id=NEW.vendor_id AND is_primary=1;
END;

ALTER TABLE pharmacy_inventory ADD COLUMN branch_id INTEGER REFERENCES pharmacy_branches(id);
ALTER TABLE orders ADD COLUMN branch_id INTEGER REFERENCES pharmacy_branches(id);
ALTER TABLE offline_sales ADD COLUMN branch_id INTEGER REFERENCES pharmacy_branches(id);
ALTER TABLE purchase_orders ADD COLUMN branch_id INTEGER REFERENCES pharmacy_branches(id);
ALTER TABLE vendor_staff ADD COLUMN branch_id INTEGER REFERENCES pharmacy_branches(id);

UPDATE pharmacy_inventory SET branch_id = (
  SELECT b.id FROM pharmacy_branches b WHERE b.vendor_id = pharmacy_inventory.vendor_id AND b.is_primary = 1
) WHERE branch_id IS NULL;
UPDATE orders SET branch_id = (
  SELECT b.id FROM pharmacy_branches b WHERE b.vendor_id = orders.vendor_id AND b.is_primary = 1
) WHERE branch_id IS NULL;
UPDATE offline_sales SET branch_id = (
  SELECT b.id FROM pharmacy_branches b WHERE b.vendor_id = offline_sales.vendor_id AND b.is_primary = 1
) WHERE branch_id IS NULL;
UPDATE purchase_orders SET branch_id = (
  SELECT b.id FROM pharmacy_branches b WHERE b.vendor_id = purchase_orders.vendor_id AND b.is_primary = 1
) WHERE branch_id IS NULL;
UPDATE vendor_staff SET branch_id = (
  SELECT b.id FROM pharmacy_branches b WHERE b.vendor_id = vendor_staff.vendor_id AND b.is_primary = 1
) WHERE branch_id IS NULL;

DROP INDEX IF EXISTS pharmacy_inventory_batch_uidx;
CREATE UNIQUE INDEX IF NOT EXISTS pharmacy_inventory_branch_batch_uidx
  ON pharmacy_inventory(branch_id, product_id, batch_number);
CREATE INDEX IF NOT EXISTS pharmacy_inventory_branch_product_idx
  ON pharmacy_inventory(branch_id, product_id, active, quantity);
CREATE INDEX IF NOT EXISTS orders_branch_date_idx ON orders(branch_id, created_at, id);
CREATE INDEX IF NOT EXISTS offline_sales_branch_date_idx ON offline_sales(branch_id, created_at, id);
CREATE INDEX IF NOT EXISTS purchase_orders_branch_date_idx ON purchase_orders(branch_id, invoice_date, id);
CREATE INDEX IF NOT EXISTS vendor_staff_branch_idx ON vendor_staff(vendor_id, branch_id, status);

CREATE TRIGGER IF NOT EXISTS pharmacy_inventory_branch_vendor_guard
BEFORE INSERT ON pharmacy_inventory
WHEN NEW.branch_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM pharmacy_branches b WHERE b.id = NEW.branch_id AND b.vendor_id = NEW.vendor_id
)
BEGIN SELECT RAISE(ABORT, 'inventory_branch_vendor_mismatch'); END;
CREATE TRIGGER IF NOT EXISTS pharmacy_inventory_primary_branch_default
AFTER INSERT ON pharmacy_inventory
WHEN NEW.branch_id IS NULL
BEGIN
  UPDATE pharmacy_inventory SET branch_id = (SELECT id FROM pharmacy_branches WHERE vendor_id = NEW.vendor_id AND is_primary = 1)
  WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS pharmacy_inventory_branch_vendor_update_guard
BEFORE UPDATE OF branch_id, vendor_id ON pharmacy_inventory
WHEN NEW.branch_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM pharmacy_branches b WHERE b.id = NEW.branch_id AND b.vendor_id = NEW.vendor_id
)
BEGIN SELECT RAISE(ABORT, 'inventory_branch_vendor_mismatch'); END;
CREATE TRIGGER IF NOT EXISTS orders_branch_vendor_guard
BEFORE INSERT ON orders
WHEN NEW.branch_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM pharmacy_branches b WHERE b.id = NEW.branch_id AND b.vendor_id = NEW.vendor_id
)
BEGIN SELECT RAISE(ABORT, 'order_branch_vendor_mismatch'); END;
CREATE TRIGGER IF NOT EXISTS orders_primary_branch_default
AFTER INSERT ON orders
WHEN NEW.branch_id IS NULL
BEGIN
  UPDATE orders SET branch_id = (SELECT id FROM pharmacy_branches WHERE vendor_id = NEW.vendor_id AND is_primary = 1)
  WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS orders_branch_vendor_update_guard
BEFORE UPDATE OF branch_id, vendor_id ON orders
WHEN NEW.branch_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM pharmacy_branches b WHERE b.id = NEW.branch_id AND b.vendor_id = NEW.vendor_id
)
BEGIN SELECT RAISE(ABORT, 'order_branch_vendor_mismatch'); END;
CREATE TRIGGER IF NOT EXISTS offline_sales_branch_vendor_guard
BEFORE INSERT ON offline_sales
WHEN NEW.branch_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM pharmacy_branches b WHERE b.id = NEW.branch_id AND b.vendor_id = NEW.vendor_id
)
BEGIN SELECT RAISE(ABORT, 'offline_sale_branch_vendor_mismatch'); END;
CREATE TRIGGER IF NOT EXISTS offline_sales_primary_branch_default
AFTER INSERT ON offline_sales
WHEN NEW.branch_id IS NULL
BEGIN
  UPDATE offline_sales SET branch_id = (SELECT id FROM pharmacy_branches WHERE vendor_id = NEW.vendor_id AND is_primary = 1)
  WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS purchase_orders_branch_vendor_guard
BEFORE INSERT ON purchase_orders
WHEN NEW.branch_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM pharmacy_branches b WHERE b.id = NEW.branch_id AND b.vendor_id = NEW.vendor_id
)
BEGIN SELECT RAISE(ABORT, 'purchase_branch_vendor_mismatch'); END;
CREATE TRIGGER IF NOT EXISTS purchase_orders_primary_branch_default
AFTER INSERT ON purchase_orders
WHEN NEW.branch_id IS NULL
BEGIN
  UPDATE purchase_orders SET branch_id = (SELECT id FROM pharmacy_branches WHERE vendor_id = NEW.vendor_id AND is_primary = 1)
  WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS vendor_staff_branch_vendor_guard
BEFORE INSERT ON vendor_staff
WHEN NEW.branch_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM pharmacy_branches b WHERE b.id = NEW.branch_id AND b.vendor_id = NEW.vendor_id
)
BEGIN SELECT RAISE(ABORT, 'staff_branch_vendor_mismatch'); END;
CREATE TRIGGER IF NOT EXISTS vendor_staff_branch_vendor_update_guard
BEFORE UPDATE OF branch_id, vendor_id ON vendor_staff
WHEN NEW.branch_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM pharmacy_branches b WHERE b.id = NEW.branch_id AND b.vendor_id = NEW.vendor_id
)
BEGIN SELECT RAISE(ABORT, 'staff_branch_vendor_mismatch'); END;
