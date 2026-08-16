import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  completeSupplierReturn,
  listReturnablePurchases,
  PurchaseLifecycleError,
} from "../lib/supplier-returns.ts";

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
    CREATE TABLE suppliers (
      id INTEGER PRIMARY KEY,
      vendor_id INTEGER NOT NULL,
      business_name TEXT NOT NULL
    );
    CREATE TABLE products (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE purchase_orders (
      id INTEGER PRIMARY KEY,
      purchase_number TEXT NOT NULL,
      vendor_id INTEGER NOT NULL,
      supplier_id INTEGER NOT NULL,
      invoice_date TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      posted_at TEXT
    );
    CREATE TABLE pharmacy_inventory (
      id INTEGER PRIMARY KEY,
      vendor_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      reserved_quantity INTEGER DEFAULT 0 NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
    CREATE TABLE purchase_order_items (
      id INTEGER PRIMARY KEY,
      purchase_order_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      inventory_id INTEGER NOT NULL,
      batch_number TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      free_quantity INTEGER DEFAULT 0 NOT NULL,
      received_quantity INTEGER DEFAULT 0 NOT NULL,
      received_free_quantity INTEGER DEFAULT 0 NOT NULL,
      purchase_price_paise INTEGER NOT NULL
    );
    CREATE TABLE supplier_returns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      return_number TEXT UNIQUE NOT NULL,
      vendor_id INTEGER NOT NULL,
      supplier_id INTEGER NOT NULL,
      purchase_order_id INTEGER NOT NULL,
      debit_note_number TEXT UNIQUE NOT NULL,
      reason TEXT NOT NULL,
      total_paise INTEGER NOT NULL,
      status TEXT DEFAULT 'completed' NOT NULL,
      created_by_profile_id INTEGER NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
    CREATE TABLE supplier_return_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_return_id INTEGER NOT NULL,
      purchase_order_item_id INTEGER NOT NULL,
      inventory_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      amount_paise INTEGER NOT NULL,
      disposition TEXT NOT NULL
    );
    CREATE TABLE stock_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor_id INTEGER NOT NULL,
      inventory_id INTEGER NOT NULL,
      movement_type TEXT NOT NULL,
      quantity_delta INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      reference_type TEXT NOT NULL,
      reference_id INTEGER NOT NULL,
      reason TEXT NOT NULL,
      actor_profile_id INTEGER NOT NULL
    );
    CREATE TABLE ledger_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor_id INTEGER NOT NULL,
      account_code TEXT NOT NULL,
      entry_date TEXT NOT NULL,
      description TEXT NOT NULL,
      debit_paise INTEGER NOT NULL,
      credit_paise INTEGER NOT NULL,
      reference_type TEXT NOT NULL,
      reference_id INTEGER NOT NULL,
      created_by_profile_id INTEGER NOT NULL
    );
    CREATE TABLE audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor_id INTEGER,
      actor_profile_id INTEGER,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      before_json TEXT NOT NULL,
      after_json TEXT NOT NULL,
      reason TEXT NOT NULL,
      request_id TEXT NOT NULL,
      previous_event_hash TEXT NOT NULL,
      event_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TRIGGER supplier_return_quantity_guard
    BEFORE INSERT ON supplier_return_items
    WHEN NEW.quantity < 1
      OR NEW.inventory_id <> COALESCE((SELECT inventory_id FROM purchase_order_items WHERE id = NEW.purchase_order_item_id), -1)
      OR NEW.quantity > COALESCE((SELECT quantity FROM pharmacy_inventory WHERE id = NEW.inventory_id), 0)
      OR NEW.quantity > (
        COALESCE((SELECT received_quantity + received_free_quantity FROM purchase_order_items WHERE id = NEW.purchase_order_item_id), 0)
        - COALESCE((SELECT SUM(items.quantity) FROM supplier_return_items items JOIN supplier_returns ret ON ret.id = items.supplier_return_id WHERE items.purchase_order_item_id = NEW.purchase_order_item_id AND ret.status <> 'cancelled'), 0)
      )
    BEGIN
      SELECT RAISE(ABORT, 'supplier_return_quantity_invalid');
    END;
  `);
  const db = new TestD1Database(sqlite);
  t.after(() => sqlite.close());
  return { db, sqlite };
}

function seedPurchase(sqlite, {
  vendorId = 1,
  supplierId = vendorId * 10,
  purchaseOrderId = vendorId * 1000,
  purchaseOrderItemId = vendorId * 5000,
  inventoryId = vendorId * 100,
  status = "received",
  quantity = 5,
  freeQuantity = 0,
  currentQuantity = 10,
  reservedQuantity = 0,
} = {}) {
  sqlite.prepare("INSERT OR IGNORE INTO suppliers (id,vendor_id,business_name) VALUES (?,?,?)")
    .run(supplierId, vendorId, `Supplier ${vendorId}`);
  sqlite.prepare("INSERT OR IGNORE INTO products (id,name) VALUES (1,'Regression Medicine')").run();
  sqlite.prepare("INSERT INTO purchase_orders (id,purchase_number,vendor_id,supplier_id,invoice_date,status) VALUES (?,?,?,?,?,?)")
    .run(purchaseOrderId, `PO-${purchaseOrderId}`, vendorId, supplierId, "2026-08-01", status);
  sqlite.prepare("INSERT INTO pharmacy_inventory (id,vendor_id,product_id,quantity,reserved_quantity) VALUES (?,?,1,?,?)")
    .run(inventoryId, vendorId, currentQuantity, reservedQuantity);
  sqlite.prepare(`INSERT INTO purchase_order_items
    (id,purchase_order_id,product_id,inventory_id,batch_number,quantity,free_quantity,
      received_quantity,received_free_quantity,purchase_price_paise)
    VALUES (?,?,1,?,'BATCH-1',?,?,?,?,1000)`)
    .run(purchaseOrderItemId, purchaseOrderId, inventoryId, quantity, freeQuantity, quantity, freeQuantity);
  return { purchaseOrderItemId, inventoryId };
}

async function expectLifecycleError(promise, status, message) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof PurchaseLifecycleError);
    assert.equal(error.status, status);
    assert.match(error.message, message);
    return true;
  });
}

test("received purchases appear in the supplier-return selector with legacy posted compatibility", async (t) => {
  const { db, sqlite } = createFixture(t);
  seedPurchase(sqlite, { purchaseOrderId: 1000, purchaseOrderItemId: 5000, inventoryId: 100, status: "received" });
  seedPurchase(sqlite, { purchaseOrderId: 1001, purchaseOrderItemId: 5001, inventoryId: 101, status: "posted" });
  seedPurchase(sqlite, { purchaseOrderId: 1002, purchaseOrderItemId: 5002, inventoryId: 102, status: "draft" });
  seedPurchase(sqlite, { purchaseOrderId: 1003, purchaseOrderItemId: 5003, inventoryId: 103, status: "partially_received", quantity: 8, currentQuantity: 3 });
  sqlite.prepare("UPDATE purchase_order_items SET received_quantity=3 WHERE id=5003").run();
  seedPurchase(sqlite, { vendorId: 2, purchaseOrderId: 2000, purchaseOrderItemId: 6000, inventoryId: 200, status: "received" });

  const items = await listReturnablePurchases(db, 1);
  assert.deepEqual(items.map((item) => item.purchaseOrderItemId).sort(), [5000, 5001, 5003]);
  assert.equal(items.find((item) => item.purchaseOrderItemId === 5003).purchasedQuantity, 3);
});

test("a completed received-purchase return updates stock, debit note, ledgers and audit", async (t) => {
  const { db, sqlite } = createFixture(t);
  const { purchaseOrderItemId, inventoryId } = seedPurchase(sqlite);

  const result = await completeSupplierReturn({
    db,
    vendorId: 1,
    actorProfileId: 11,
    purchaseOrderItemId,
    quantity: 3,
    reason: "Supplier quality recall",
    requestId: "test-request",
  });

  assert.equal(result.created, true);
  assert.equal(result.totalPaise, 3000);
  assert.match(result.debitNoteNumber, /^DN-/);
  assert.equal(sqlite.prepare("SELECT quantity FROM pharmacy_inventory WHERE id=?").get(inventoryId).quantity, 7);
  assert.deepEqual(
    { ...sqlite.prepare("SELECT quantity_delta AS quantityDelta,balance_after AS balanceAfter,movement_type AS movementType FROM stock_ledger").get() },
    { quantityDelta: -3, balanceAfter: 7, movementType: "supplier_return" },
  );
  const supplierReturn = sqlite.prepare("SELECT debit_note_number AS debitNoteNumber,total_paise AS totalPaise,status FROM supplier_returns").get();
  assert.equal(supplierReturn.debitNoteNumber, result.debitNoteNumber);
  assert.equal(supplierReturn.totalPaise, 3000);
  assert.equal(supplierReturn.status, "completed");
  assert.deepEqual(
    sqlite.prepare("SELECT account_code AS accountCode,debit_paise AS debitPaise,credit_paise AS creditPaise FROM ledger_entries ORDER BY id").all().map((row) => ({ ...row })),
    [
      { accountCode: "SUPPLIER_PAYABLE", debitPaise: 3000, creditPaise: 0 },
      { accountCode: "PURCHASE_RETURNS", debitPaise: 0, creditPaise: 3000 },
    ],
  );
  const audit = sqlite.prepare("SELECT action,entity_type AS entityType,request_id AS requestId FROM audit_events").get();
  assert.deepEqual({ ...audit }, { action: "supplier_return.completed", entityType: "supplier_return", requestId: "test-request" });
});

test("supplier returns reject quantities above current or originally received stock", async (t) => {
  const { db, sqlite } = createFixture(t);
  const { purchaseOrderItemId } = seedPurchase(sqlite, { quantity: 5, currentQuantity: 4 });

  await expectLifecycleError(completeSupplierReturn({
    db,
    vendorId: 1,
    actorProfileId: 11,
    purchaseOrderItemId,
    quantity: 5,
    reason: "Damaged shipment",
  }), 409, /current batch stock/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM supplier_returns").get().count, 0);
});

test("supplier returns cannot consume reserved stock", async (t) => {
  const { db, sqlite } = createFixture(t);
  const { purchaseOrderItemId, inventoryId } = seedPurchase(sqlite, { quantity: 5, currentQuantity: 10, reservedQuantity: 8 });

  await expectLifecycleError(completeSupplierReturn({
    db,
    vendorId: 1,
    actorProfileId: 11,
    purchaseOrderItemId,
    quantity: 3,
    reason: "Reserved stock protection",
  }), 409, /current batch stock/);
  assert.deepEqual({
    quantity: sqlite.prepare("SELECT quantity FROM pharmacy_inventory WHERE id=?").get(inventoryId).quantity,
    returns: sqlite.prepare("SELECT COUNT(*) AS count FROM supplier_returns").get().count,
  }, { quantity: 10, returns: 0 });
});

test("a vendor cannot return another vendor's received purchase", async (t) => {
  const { db, sqlite } = createFixture(t);
  const { purchaseOrderItemId } = seedPurchase(sqlite, { vendorId: 1 });

  await expectLifecycleError(completeSupplierReturn({
    db,
    vendorId: 2,
    actorProfileId: 22,
    purchaseOrderItemId,
    quantity: 1,
    reason: "Wrong supplier item",
  }), 404, /Received purchase item not found/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM supplier_returns").get().count, 0);
});

test("previously returned purchase quantities cannot be returned twice", async (t) => {
  const { db, sqlite } = createFixture(t);
  const { purchaseOrderItemId, inventoryId } = seedPurchase(sqlite, { quantity: 5, currentQuantity: 10 });

  await completeSupplierReturn({
    db,
    vendorId: 1,
    actorProfileId: 11,
    purchaseOrderItemId,
    quantity: 3,
    reason: "First damaged quantity",
  });
  await expectLifecycleError(completeSupplierReturn({
    db,
    vendorId: 1,
    actorProfileId: 11,
    purchaseOrderItemId,
    quantity: 3,
    reason: "Duplicate damaged quantity",
  }), 409, /unreturned purchased stock/);

  assert.equal(sqlite.prepare("SELECT quantity FROM pharmacy_inventory WHERE id=?").get(inventoryId).quantity, 7);
  assert.equal(sqlite.prepare("SELECT SUM(quantity) AS quantity FROM supplier_return_items").get().quantity, 3);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM supplier_returns").get().count, 1);
});
