import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  generateVendorInventoryAlerts,
  VENDOR_ALERT_PROCESSING_LIMIT,
  VENDOR_ALERT_REFERENCE_TYPES,
} from "../lib/vendor-inventory-alerts.ts";

class Statement {
  constructor(owner, sql) { this.owner = owner; this.sql = sql; this.values = []; }
  bind(...values) { this.values = values; return this; }
  async run() {
    const result = this.owner.sqlite.prepare(this.sql).run(...this.values);
    return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }
}

class Database {
  constructor(sqlite) { this.sqlite = sqlite; this.tail = Promise.resolve(); }
  prepare(sql) { return new Statement(this, sql); }
  batch(statements) {
    const execute = async () => {
      this.sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        this.sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        this.sqlite.exec("ROLLBACK");
        throw error;
      }
    };
    const result = this.tail.then(execute, execute);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

function fixture(t) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE vendors (
      id INTEGER PRIMARY KEY,registration_status TEXT NOT NULL,approval_status TEXT NOT NULL,
      compliance_status TEXT NOT NULL,suspended_at TEXT
    );
    CREATE TABLE products (id INTEGER PRIMARY KEY,name TEXT NOT NULL,active INTEGER NOT NULL);
    CREATE TABLE pharmacy_inventory (
      id INTEGER PRIMARY KEY,vendor_id INTEGER NOT NULL,product_id INTEGER NOT NULL,batch_number TEXT NOT NULL,
      expiry_date TEXT,quantity INTEGER NOT NULL,reserved_quantity INTEGER NOT NULL,reorder_level INTEGER NOT NULL,
      quarantine_status TEXT NOT NULL,cold_chain_status TEXT NOT NULL,active INTEGER NOT NULL
    );
    CREATE TABLE vendor_licences (
      vendor_id INTEGER NOT NULL,verification_status TEXT NOT NULL,suspended_at TEXT,
      valid_from TEXT NOT NULL,valid_until TEXT NOT NULL
    );
    CREATE TABLE pharmacists (
      vendor_id INTEGER NOT NULL,verification_status TEXT NOT NULL,active INTEGER NOT NULL,
      valid_from TEXT,valid_until TEXT
    );
    CREATE TABLE notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,profile_id INTEGER,vendor_id INTEGER,
      notification_type TEXT NOT NULL,severity TEXT NOT NULL,title TEXT NOT NULL,message TEXT NOT NULL,
      reference_type TEXT NOT NULL,reference_id INTEGER,read_at TEXT,
      lifecycle_status TEXT DEFAULT 'unread' NOT NULL,created_at TEXT NOT NULL
    );
    INSERT INTO vendors VALUES
      (1,'submitted','approved','verified',NULL),
      (2,'submitted','approved','verified',NULL),
      (3,'submitted','testing','verified',NULL),
      (4,'submitted','approved','verified','2026-01-01'),
      (5,'submitted','approved','verified',NULL);
    INSERT INTO vendor_licences VALUES
      (1,'verified',NULL,'2025-01-01','2027-01-01'),
      (2,'verified',NULL,'2025-01-01','2027-01-01'),
      (3,'verified',NULL,'2025-01-01','2027-01-01'),
      (4,'verified',NULL,'2025-01-01','2027-01-01'),
      (5,'verified',NULL,'2025-01-01','2026-08-12');
    INSERT INTO pharmacists VALUES
      (1,'verified',1,'2025-01-01','2027-01-01'),
      (2,'verified',1,'2025-01-01','2027-01-01'),
      (3,'verified',1,'2025-01-01','2027-01-01'),
      (4,'verified',1,'2025-01-01','2027-01-01'),
      (5,'verified',1,'2025-01-01','2027-01-01');
    INSERT INTO products VALUES
      (10,'Low Aggregate Tablet',1),(11,'Excluded Stock Capsule',1),(12,'Healthy Syrup',1),
      (13,'Near Expiry Injection',1),(14,'Inactive Product',0);
    INSERT INTO pharmacy_inventory VALUES
      (100,1,10,'LOW-A','2027-01-01',5,3,5,'available','not_applicable',1),
      (101,1,10,'LOW-B','2027-01-02',4,1,3,'available','within_range',1),
      (110,1,11,'EXPIRED','2026-08-12',50,0,4,'available','not_applicable',1),
      (111,1,11,'QUARANTINED','2027-01-01',40,0,4,'quarantined','not_applicable',1),
      (112,1,11,'COLD-BREACH','2027-01-01',30,0,4,'available','breached',1),
      (113,1,11,'FULLY-RESERVED','2027-01-01',10,10,4,'available','not_applicable',1),
      (114,1,11,'INACTIVE-BATCH','2027-01-01',80,0,4,'available','not_applicable',0),
      (120,1,12,'HEALTHY','2027-01-01',20,2,5,'available','not_applicable',1),
      (130,1,13,'EXP-90','2026-11-11',9,0,2,'available','not_applicable',1),
      (131,1,13,'EXP-91','2026-11-12',9,0,2,'available','not_applicable',1),
      (132,2,13,'TENANT-TWO','2026-11-01',9,0,2,'available','not_applicable',1),
      (133,3,13,'TESTING-VENDOR','2026-11-01',9,0,2,'available','not_applicable',1),
      (134,4,13,'SUSPENDED-VENDOR','2026-11-01',9,0,2,'available','not_applicable',1),
      (135,5,13,'EXPIRED-LICENCE-VENDOR','2026-11-01',9,0,2,'available','not_applicable',1),
      (140,1,14,'INACTIVE-PRODUCT','2026-11-01',0,0,5,'available','not_applicable',1);
  `);
  t.after(() => sqlite.close());
  return { sqlite, db: new Database(sqlite) };
}

const processingDate = "2026-08-13";

test("near-expiry alerts are inclusive at 90 days, bounded, tenant-correct, and directly reference batches", async (t) => {
  const { sqlite, db } = fixture(t);
  const result = await generateVendorInventoryAlerts({ db, processingDate });
  assert.equal(result.generated.nearExpiry, 2);
  const alerts = sqlite.prepare(`SELECT vendor_id AS vendorId,reference_id AS referenceId,
    reference_type AS referenceType,message,created_at AS createdAt FROM notifications
    WHERE notification_type='inventory_near_expiry' ORDER BY vendor_id,reference_id`).all();
  assert.deepEqual(alerts.map((row) => [row.vendorId, row.referenceId]), [[1, 130], [2, 132]]);
  assert.ok(alerts.every((row) => row.referenceType === VENDOR_ALERT_REFERENCE_TYPES.nearExpiryBatch));
  assert.ok(alerts.every((row) => row.createdAt === "2026-08-13T00:00:00.000Z"));
  assert.match(alerts[0].message, /EXP-90.*2026-11-11/);
});

test("stock alerts aggregate eligible available units by product and expose reorder references", async (t) => {
  const { sqlite, db } = fixture(t);
  const result = await generateVendorInventoryAlerts({ db, processingDate });
  assert.equal(result.generated.stock, 2);
  const alerts = sqlite.prepare(`SELECT vendor_id AS vendorId,notification_type AS notificationType,
    severity,reference_type AS referenceType,reference_id AS referenceId,message
    FROM notifications WHERE notification_type IN ('inventory_zero_stock','inventory_low_stock')
    ORDER BY reference_id`).all();
  assert.deepEqual(alerts.map((row) => ({
    vendorId: row.vendorId, type: row.notificationType, severity: row.severity,
    referenceType: row.referenceType, referenceId: row.referenceId,
  })), [
    { vendorId: 1, type: "inventory_low_stock", severity: "warning", referenceType: VENDOR_ALERT_REFERENCE_TYPES.reorderProduct, referenceId: 10 },
    { vendorId: 1, type: "inventory_zero_stock", severity: "critical", referenceType: VENDOR_ALERT_REFERENCE_TYPES.reorderProduct, referenceId: 11 },
  ]);
  assert.match(alerts[0].message, /5 available unit/);
  assert.match(alerts[0].message, /Reorder level: 5/);
  assert.match(alerts[1].message, /0 available unit/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM notifications WHERE reference_id=12").get().count, 0);
});

test("retries and concurrent generators are indefinitely idempotent until P5-03 resolves an alert", async (t) => {
  const { sqlite, db } = fixture(t);
  const [first, concurrent] = await Promise.all([
    generateVendorInventoryAlerts({ db, processingDate }),
    generateVendorInventoryAlerts({ db, processingDate }),
  ]);
  assert.equal(first.generated.total + concurrent.generated.total, 4);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM notifications").get().count, 4);
  const repeated = await generateVendorInventoryAlerts({ db, processingDate });
  assert.equal(repeated.generated.total, 0);
  const nextDay = await generateVendorInventoryAlerts({ db, processingDate: "2026-08-14" });
  assert.equal(nextDay.generated.total, 1, "only the newly entered 90-day batch should alert");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM notifications").get().count, 5);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM notifications WHERE reference_id=131").get().count, 1);
});

test("processing date and limits are validated and bounded", async (t) => {
  const { sqlite, db } = fixture(t);
  await assert.rejects(generateVendorInventoryAlerts({ db, processingDate: "2026-02-30" }), /processing date is invalid/);
  await assert.rejects(generateVendorInventoryAlerts({ db, processingDate: "13-08-2026" }), /YYYY-MM-DD/);
  const result = await generateVendorInventoryAlerts({ db, processingDate, limit: 1 });
  assert.deepEqual(result.generated, { nearExpiry: 1, stock: 1, total: 2 });
  assert.equal(VENDOR_ALERT_PROCESSING_LIMIT, 500);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM notifications").get().count, 2);
});
