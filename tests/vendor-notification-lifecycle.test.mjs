import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { generateVendorInventoryAlerts } from "../lib/vendor-inventory-alerts.ts";
import {
  listVendorNotifications,
  transitionVendorNotification,
  VendorNotificationError,
} from "../lib/vendor-notifications.ts";

class Statement {
  constructor(owner, sql) { this.owner = owner; this.sql = sql; this.values = []; }
  bind(...values) { this.values = values; return this; }
  async first() { return this.owner.sqlite.prepare(this.sql).get(...this.values) ?? null; }
  async all() { return { results: this.owner.sqlite.prepare(this.sql).all(...this.values) }; }
  async run() {
    if (this.owner.failAudit && /INSERT INTO audit_events/i.test(this.sql)) throw new Error("injected audit failure");
    const result = this.owner.sqlite.prepare(this.sql).run(...this.values);
    return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }
  queryResult() { return { results: this.owner.sqlite.prepare(this.sql).all(...this.values) }; }
}

class Database {
  constructor(sqlite) { this.sqlite = sqlite; this.tail = Promise.resolve(); this.failAudit = false; }
  prepare(sql) { return new Statement(this, sql); }
  batch(statements) {
    const execute = async () => {
      this.sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        for (const statement of statements) {
          if (/^\s*SELECT\b/i.test(statement.sql)) results.push(statement.queryResult());
          else results.push(await statement.run());
        }
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
    CREATE TABLE vendors (id INTEGER PRIMARY KEY,registration_status TEXT,approval_status TEXT,compliance_status TEXT,suspended_at TEXT);
    CREATE TABLE vendor_licences (vendor_id INTEGER,verification_status TEXT,suspended_at TEXT,valid_from TEXT,valid_until TEXT);
    CREATE TABLE pharmacists (vendor_id INTEGER,verification_status TEXT,active INTEGER,valid_from TEXT,valid_until TEXT);
    CREATE TABLE products (id INTEGER PRIMARY KEY,name TEXT NOT NULL,active INTEGER NOT NULL);
    CREATE TABLE pharmacy_inventory (
      id INTEGER PRIMARY KEY,vendor_id INTEGER NOT NULL,product_id INTEGER NOT NULL,batch_number TEXT NOT NULL,
      expiry_date TEXT,quantity INTEGER NOT NULL,reserved_quantity INTEGER NOT NULL,reorder_level INTEGER NOT NULL,
      quarantine_status TEXT NOT NULL,cold_chain_status TEXT NOT NULL,active INTEGER NOT NULL
    );
    CREATE TABLE account_profiles (id INTEGER PRIMARY KEY);
    CREATE TABLE notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,profile_id INTEGER,vendor_id INTEGER,notification_type TEXT NOT NULL,
      severity TEXT NOT NULL,title TEXT NOT NULL,message TEXT NOT NULL,reference_type TEXT NOT NULL,reference_id INTEGER,
      read_at TEXT,lifecycle_status TEXT DEFAULT 'unread' NOT NULL,acknowledged_at TEXT,snoozed_until TEXT,resolved_at TEXT,
      resolution_reason TEXT DEFAULT '' NOT NULL,lifecycle_version INTEGER DEFAULT 0 NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
    CREATE INDEX notifications_vendor_lifecycle_idx ON notifications(vendor_id,lifecycle_status,snoozed_until,created_at);
    CREATE UNIQUE INDEX notifications_vendor_inventory_active_uidx ON notifications(vendor_id,reference_type,reference_id)
      WHERE vendor_id IS NOT NULL AND notification_type IN ('inventory_near_expiry','inventory_low_stock','inventory_zero_stock') AND lifecycle_status<>'resolved';
    CREATE TABLE audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,vendor_id INTEGER,actor_profile_id INTEGER,action TEXT NOT NULL,
      entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,before_json TEXT NOT NULL,after_json TEXT NOT NULL,
      reason TEXT NOT NULL,request_id TEXT NOT NULL,previous_event_hash TEXT NOT NULL,event_hash TEXT UNIQUE NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT INTO vendors VALUES (1,'submitted','approved','verified',NULL),(2,'submitted','approved','verified',NULL);
    INSERT INTO vendor_licences VALUES (1,'verified',NULL,'2025-01-01','2027-01-01'),(2,'verified',NULL,'2025-01-01','2027-01-01');
    INSERT INTO pharmacists VALUES (1,'verified',1,'2025-01-01','2027-01-01'),(2,'verified',1,'2025-01-01','2027-01-01');
    INSERT INTO products VALUES (10,'Alert Medicine',1);
    INSERT INTO pharmacy_inventory VALUES
      (100,1,10,'BATCH-100','2026-11-01',2,0,5,'available','not_applicable',1),
      (200,2,10,'BATCH-200','2026-11-01',2,0,5,'available','not_applicable',1);
    INSERT INTO account_profiles VALUES (11),(22);
  `);
  t.after(() => sqlite.close());
  return { sqlite, db: new Database(sqlite) };
}

const now = "2026-08-13T10:00:00.000Z";

test("vendor inbox is tenant scoped and exposes only validated safe action metadata", async (t) => {
  const { db } = fixture(t);
  await generateVendorInventoryAlerts({ db, processingDate: "2026-08-13" });
  const vendorOne = await listVendorNotifications(db, 1, { now });
  assert.equal(vendorOne.summary.unreadCount, 2);
  assert.equal(vendorOne.notifications.length, 2);
  assert.ok(vendorOne.notifications.every((notification) => notification.action?.referenceId === 100 || notification.action?.referenceId === 10));
  assert.deepEqual(new Set(vendorOne.notifications.map((notification) => notification.action?.targetSection)), new Set(["reports", "purchase"]));
  const vendorTwo = await listVendorNotifications(db, 2, { now });
  assert.ok(vendorTwo.notifications.every((notification) => notification.action?.referenceId === 200 || notification.action?.referenceId === 10));
  await assert.rejects(transitionVendorNotification({
    db, vendorId: 2, actorProfileId: 22, notificationId: vendorOne.notifications[0].id,
    expectedVersion: 0, action: "read", now,
  }), (error) => error instanceof VendorNotificationError && error.status === 404);
});

test("read, acknowledge, snooze and resolve transitions are versioned, audited and idempotent", async (t) => {
  const { sqlite, db } = fixture(t);
  await generateVendorInventoryAlerts({ db, processingDate: "2026-08-13" });
  let alert = (await listVendorNotifications(db, 1, { now })).notifications[0];

  const read = await transitionVendorNotification({ db, vendorId: 1, actorProfileId: 11, notificationId: alert.id, expectedVersion: alert.version, action: "read", now });
  assert.equal(read.notification.lifecycleStatus, "read");
  const repeatedRead = await transitionVendorNotification({ db, vendorId: 1, actorProfileId: 11, notificationId: alert.id, expectedVersion: alert.version, action: "read", now });
  assert.equal(repeatedRead.unchanged, true);
  alert = read.notification;

  const acknowledged = await transitionVendorNotification({ db, vendorId: 1, actorProfileId: 11, notificationId: alert.id, expectedVersion: alert.version, action: "acknowledge", now });
  assert.equal(acknowledged.notification.lifecycleStatus, "acknowledged");
  alert = acknowledged.notification;
  const snoozedUntil = "2026-08-14T10:00:00.000Z";
  const snoozed = await transitionVendorNotification({ db, vendorId: 1, actorProfileId: 11, notificationId: alert.id, expectedVersion: alert.version, action: "snooze", snoozedUntil, now });
  assert.equal(snoozed.notification.snoozedUntil, snoozedUntil);
  alert = snoozed.notification;
  const resolved = await transitionVendorNotification({ db, vendorId: 1, actorProfileId: 11, notificationId: alert.id, expectedVersion: alert.version, action: "resolve", reason: "Purchase order submitted", now });
  assert.equal(resolved.notification.lifecycleStatus, "resolved");
  const history = await listVendorNotifications(db, 1, { now, includeResolved: true });
  assert.equal(history.notifications.find((item) => item.id === alert.id).resolutionReason, "Purchase order submitted");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE entity_type='notification'").get().count, 4);
  await assert.rejects(transitionVendorNotification({ db, vendorId: 1, actorProfileId: 11, notificationId: alert.id, expectedVersion: alert.version, action: "acknowledge", now }), /resolved notification cannot be changed/);
});

test("stale competing transitions have one winner and no duplicate audit evidence", async (t) => {
  const { sqlite, db } = fixture(t);
  await generateVendorInventoryAlerts({ db, processingDate: "2026-08-13" });
  const alert = (await listVendorNotifications(db, 1, { now })).notifications[0];
  const results = await Promise.allSettled([
    transitionVendorNotification({ db, vendorId: 1, actorProfileId: 11, notificationId: alert.id, expectedVersion: 0, action: "acknowledge", now }),
    transitionVendorNotification({ db, vendorId: 1, actorProfileId: 11, notificationId: alert.id, expectedVersion: 0, action: "snooze", snoozedUntil: "2026-08-14T10:00:00.000Z", now }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal(sqlite.prepare("SELECT lifecycle_version AS version FROM notifications WHERE id=?").get(alert.id).version, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE entity_id=?").get(String(alert.id)).count, 1);
});

test("audit failure rolls back the notification lifecycle mutation", async (t) => {
  const { sqlite, db } = fixture(t);
  await generateVendorInventoryAlerts({ db, processingDate: "2026-08-13" });
  const alert = (await listVendorNotifications(db, 1, { now })).notifications[0];
  db.failAudit = true;
  await assert.rejects(transitionVendorNotification({
    db, vendorId: 1, actorProfileId: 11, notificationId: alert.id,
    expectedVersion: 0, action: "acknowledge", now,
  }), /injected audit failure/);
  assert.deepEqual({ ...sqlite.prepare(`SELECT lifecycle_status AS lifecycleStatus,lifecycle_version AS version
    FROM notifications WHERE id=?`).get(alert.id) }, { lifecycleStatus: "unread", version: 0 });
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events").get().count, 0);
});

test("active alerts dedupe across states and resolution permits one new active occurrence", async (t) => {
  const { sqlite, db } = fixture(t);
  await generateVendorInventoryAlerts({ db, processingDate: "2026-08-13" });
  const lowStock = (await listVendorNotifications(db, 1, { now })).notifications.find((notification) => notification.referenceType === "inventory_reorder_product");
  assert.ok(lowStock);
  await transitionVendorNotification({ db, vendorId: 1, actorProfileId: 11, notificationId: lowStock.id, expectedVersion: 0, action: "snooze", snoozedUntil: "2026-08-14T10:00:00.000Z", now });
  assert.equal((await generateVendorInventoryAlerts({ db, processingDate: "2026-08-14" })).generated.stock, 0);
  const snoozed = (await listVendorNotifications(db, 1, { now })).notifications.find((notification) => notification.id === lowStock.id);
  await transitionVendorNotification({ db, vendorId: 1, actorProfileId: 11, notificationId: lowStock.id, expectedVersion: snoozed.version, action: "resolve", reason: "Reorder completed", now });
  assert.equal((await generateVendorInventoryAlerts({ db, processingDate: "2026-08-14" })).generated.stock, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM notifications WHERE vendor_id=1 AND reference_type='inventory_reorder_product'").get().count, 2);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM notifications WHERE vendor_id=1 AND reference_type='inventory_reorder_product' AND lifecycle_status<>'resolved'").get().count, 1);
});

test("migration 0046 is notification-only and routes enforce least privilege", async () => {
  const [migration, route, component] = await Promise.all([
    readFile(new URL("../drizzle/0046_tearful_mauler.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/api/vendor/notifications/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/vendor-notification-inbox.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(migration, /notifications_vendor_inventory_active_uidx/);
  assert.match(migration, /invalid notification lifecycle transition/);
  assert.doesNotMatch(migration, /ALTER TABLE `(?!notifications`)/);
  assert.match(route, /action === "read" \? "inventory\.read" : "inventory\.write"/);
  assert.match(route, /requireVendorPermission/);
  assert.match(component, /notification\.action\.label/);
  assert.match(component, /Stock and expiry inbox/);
});
