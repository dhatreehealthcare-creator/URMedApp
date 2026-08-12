import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  captureOnlineOrderPayment,
  ensureOnlineReservationPayable,
  InventoryReservationError,
  prepareOnlineOrderReservation,
  reservationExpiresAt,
} from "../lib/inventory-reservations.ts";

class TestD1Statement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async first() {
    return this.database.prepare(this.sql).get(...this.values) ?? null;
  }

  async all() {
    return { results: this.database.prepare(this.sql).all(...this.values) };
  }

  async run() {
    const result = this.database.prepare(this.sql).run(...this.values);
    return {
      success: true,
      meta: {
        changes: Number(result.changes),
        last_row_id: Number(result.lastInsertRowid),
      },
    };
  }
}

class TestD1Database {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    return new TestD1Statement(this.database, sql);
  }

  async batch(statements) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function createFixture(t) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE account_profiles (id INTEGER PRIMARY KEY);
    CREATE TABLE vendors (id INTEGER PRIMARY KEY);
    CREATE TABLE pharmacy_inventory (
      id INTEGER PRIMARY KEY,
      vendor_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      reserved_quantity INTEGER DEFAULT 0 NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY,
      order_number TEXT UNIQUE NOT NULL,
      vendor_id INTEGER NOT NULL,
      payment_method TEXT NOT NULL,
      payment_status TEXT DEFAULT 'pending' NOT NULL,
      order_status TEXT DEFAULT 'awaiting_payment' NOT NULL,
      delivery_status TEXT DEFAULT 'awaiting_confirmation' NOT NULL,
      razorpay_payment_id TEXT DEFAULT '' NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
    CREATE TABLE order_items (
      id INTEGER PRIMARY KEY,
      order_id INTEGER NOT NULL,
      inventory_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      batch_number TEXT NOT NULL,
      quantity INTEGER NOT NULL
    );
    CREATE TABLE stock_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor_id INTEGER NOT NULL,
      inventory_id INTEGER NOT NULL,
      movement_type TEXT NOT NULL,
      quantity_delta INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      reference_type TEXT NOT NULL,
      reference_id INTEGER,
      reason TEXT NOT NULL,
      actor_profile_id INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
    CREATE TABLE delivery_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      actor_profile_id INTEGER,
      note TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
    INSERT INTO account_profiles (id) VALUES (11);
    INSERT INTO vendors (id) VALUES (1);
  `);
  sqlite.exec(readFileSync(new URL("../drizzle/0032_perfect_sunset_bain.sql", import.meta.url), "utf8"));
  const db = new TestD1Database(sqlite);
  t.after(() => sqlite.close());
  return { db, sqlite };
}

async function seedReservedOrder(fixture, {
  orderId = 1,
  orderNumber = `ORD-${orderId}`,
  orderItemId = orderId * 10,
  inventoryId = orderId * 100,
  quantity = 3,
  physicalQuantity = 10,
  expiresAt = reservationExpiresAt(),
} = {}) {
  const { db, sqlite } = fixture;
  sqlite.prepare("INSERT INTO pharmacy_inventory (id,vendor_id,quantity,reserved_quantity) VALUES (?,1,?,0)")
    .run(inventoryId, physicalQuantity);
  sqlite.prepare(`INSERT INTO orders
    (id,order_number,vendor_id,payment_method,payment_status,order_status,delivery_status,inventory_status,reservation_expires_at)
    VALUES (?, ?, 1, 'online', 'pending', 'awaiting_payment', 'awaiting_confirmation', 'reserved', ?)`)
    .run(orderId, orderNumber, expiresAt);
  sqlite.prepare("INSERT INTO order_items (id,order_id,inventory_id,product_id,batch_number,quantity) VALUES (?,?,?,1,'BATCH-1',?)")
    .run(orderItemId, orderId, inventoryId, quantity);
  await prepareOnlineOrderReservation(db, { orderNumber, inventoryId, expiresAt }).run();
  return { orderId, orderNumber, orderItemId, inventoryId, expiresAt };
}

async function expectReservationError(promise, message) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof InventoryReservationError);
    assert.equal(error.status, 409);
    assert.match(error.message, message);
    return true;
  });
}

test("reservation expiry is fifteen minutes after creation", () => {
  const createdAt = new Date("2026-08-12T00:00:00.000Z");
  assert.equal(reservationExpiresAt(createdAt), "2026-08-12T00:15:00.000Z");
});

test("reservation migration installs the active-expiry lookup index", (t) => {
  const { sqlite } = createFixture(t);
  const plan = sqlite.prepare(`EXPLAIN QUERY PLAN SELECT id FROM inventory_reservations
    WHERE status='active' AND expires_at<=?`).all("2026-08-12T00:15:00.000Z");
  assert.match(plan.map((row) => row.detail).join(" "), /inventory_reservations_active_expiry_idx/);
});

test("online order creation reserves sellable stock without decrementing physical quantity", async (t) => {
  const fixture = createFixture(t);
  const { sqlite } = fixture;
  const { inventoryId } = await seedReservedOrder(fixture, { quantity: 3, physicalQuantity: 10 });

  const inventory = sqlite.prepare("SELECT quantity,reserved_quantity AS reservedQuantity,quantity-reserved_quantity AS availableQuantity FROM pharmacy_inventory WHERE id=?").get(inventoryId);
  assert.deepEqual({ ...inventory }, { quantity: 10, reservedQuantity: 3, availableQuantity: 7 });
  assert.deepEqual(
    { ...sqlite.prepare("SELECT status,quantity FROM inventory_reservations").get() },
    { status: "active", quantity: 3 },
  );
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM stock_ledger").get().count, 0);
});

test("a competing order cannot reserve more than remaining available stock", async (t) => {
  const fixture = createFixture(t);
  const { db, sqlite } = fixture;
  await seedReservedOrder(fixture, { orderId: 1, inventoryId: 100, quantity: 7, physicalQuantity: 10 });
  const expiresAt = reservationExpiresAt();
  sqlite.prepare(`INSERT INTO orders
    (id,order_number,vendor_id,payment_method,payment_status,order_status,delivery_status,inventory_status,reservation_expires_at)
    VALUES (2,'ORD-2',1,'online','pending','awaiting_payment','awaiting_confirmation','reserved',?)`).run(expiresAt);
  sqlite.prepare("INSERT INTO order_items (id,order_id,inventory_id,product_id,batch_number,quantity) VALUES (20,2,100,1,'BATCH-1',4)").run();

  await assert.rejects(
    prepareOnlineOrderReservation(db, { orderNumber: "ORD-2", inventoryId: 100, expiresAt }).run(),
    /reservation_stock_unavailable/,
  );
  assert.equal(sqlite.prepare("SELECT reserved_quantity AS quantity FROM pharmacy_inventory WHERE id=100").get().quantity, 7);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM inventory_reservations").get().count, 1);
});

test("payment atomically commits a reservation to physical stock and is idempotent", async (t) => {
  const fixture = createFixture(t);
  const { db, sqlite } = fixture;
  const { orderId, inventoryId } = await seedReservedOrder(fixture, { quantity: 3, physicalQuantity: 10 });

  const first = await captureOnlineOrderPayment({
    db,
    orderId,
    paymentId: "pay-regression-1",
    actorProfileId: 11,
    note: "Online payment verified",
  });
  const duplicate = await captureOnlineOrderPayment({
    db,
    orderId,
    paymentId: "pay-regression-1",
    actorProfileId: 11,
    note: "Online payment verified",
  });

  assert.deepEqual(first, { committed: true, duplicate: false });
  assert.deepEqual(duplicate, { committed: false, duplicate: true });
  assert.deepEqual(
    { ...sqlite.prepare("SELECT quantity,reserved_quantity AS reservedQuantity FROM pharmacy_inventory WHERE id=?").get(inventoryId) },
    { quantity: 7, reservedQuantity: 0 },
  );
  assert.deepEqual(
    { ...sqlite.prepare("SELECT payment_status AS paymentStatus,inventory_status AS inventoryStatus,razorpay_payment_id AS paymentId FROM orders WHERE id=?").get(orderId) },
    { paymentStatus: "paid", inventoryStatus: "committed", paymentId: "pay-regression-1" },
  );
  assert.deepEqual(
    { ...sqlite.prepare("SELECT status,committed_by_profile_id AS actorProfileId FROM inventory_reservations").get() },
    { status: "committed", actorProfileId: 11 },
  );
  assert.deepEqual(
    { ...sqlite.prepare("SELECT quantity_delta AS quantityDelta,balance_after AS balanceAfter,movement_type AS movementType FROM stock_ledger").get() },
    { quantityDelta: -3, balanceAfter: 7, movementType: "online_sale" },
  );
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM stock_ledger").get().count, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM delivery_events WHERE status='payment_confirmed'").get().count, 1);
});

test("an expired reservation cannot be paid or decrement physical stock", async (t) => {
  const fixture = createFixture(t);
  const { db, sqlite } = fixture;
  const { orderId, inventoryId } = await seedReservedOrder(fixture, { quantity: 3, physicalQuantity: 10 });
  sqlite.prepare("UPDATE inventory_reservations SET expires_at='2020-01-01T00:00:00.000Z'").run();
  sqlite.prepare("UPDATE orders SET reservation_expires_at='2020-01-01T00:00:00.000Z' WHERE id=?").run(orderId);

  await expectReservationError(ensureOnlineReservationPayable(db, orderId), /expired/);
  await expectReservationError(captureOnlineOrderPayment({
    db,
    orderId,
    paymentId: "pay-too-late",
    actorProfileId: 11,
    note: "Late payment",
  }), /expired/);
  assert.deepEqual(
    { ...sqlite.prepare("SELECT quantity,reserved_quantity AS reservedQuantity FROM pharmacy_inventory WHERE id=?").get(inventoryId) },
    { quantity: 10, reservedQuantity: 3 },
  );
  assert.equal(sqlite.prepare("SELECT payment_status AS status FROM orders WHERE id=?").get(orderId).status, "pending");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM stock_ledger").get().count, 0);
});

test("legacy online orders already committed before migration remain payable", async (t) => {
  const { db, sqlite } = createFixture(t);
  sqlite.prepare("INSERT INTO pharmacy_inventory (id,vendor_id,quantity,reserved_quantity) VALUES (100,1,7,0)").run();
  sqlite.prepare(`INSERT INTO orders
    (id,order_number,vendor_id,payment_method,payment_status,order_status,delivery_status)
    VALUES (1,'LEGACY-1',1,'online','pending','awaiting_payment','awaiting_confirmation')`).run();
  sqlite.prepare("INSERT INTO order_items (id,order_id,inventory_id,product_id,batch_number,quantity) VALUES (10,1,100,1,'BATCH-1',3)").run();

  const result = await captureOnlineOrderPayment({ db, orderId: 1, paymentId: "pay-legacy", actorProfileId: 11, note: "Legacy payment" });
  assert.deepEqual(result, { committed: false, duplicate: false });
  assert.equal(sqlite.prepare("SELECT quantity FROM pharmacy_inventory WHERE id=100").get().quantity, 7);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM inventory_reservations").get().count, 0);
});
