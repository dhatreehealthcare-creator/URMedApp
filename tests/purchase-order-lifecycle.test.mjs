import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { receivePurchaseOrder, PurchaseTransitionError, transitionPurchaseOrder } from "../lib/purchase-lifecycle.ts";
import { completeSupplierReturn, listReturnablePurchases } from "../lib/supplier-returns.ts";

class TestD1Statement {
  constructor(owner, sql) { this.owner = owner; this.sql = sql; this.values = []; }
  bind(...values) { this.values = values; return this; }
  async first() { return this.owner.sqlite.prepare(this.sql).get(...this.values) ?? null; }
  async all() { return { results: this.owner.sqlite.prepare(this.sql).all(...this.values) }; }
  async run() {
    const result = this.owner.sqlite.prepare(this.sql).run(...this.values);
    return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }
}

class TestD1Database {
  constructor(sqlite) { this.sqlite = sqlite; this.beforeNextBatch = null; }
  prepare(sql) { return new TestD1Statement(this, sql); }
  async batch(statements) {
    if (this.beforeNextBatch) {
      const callback = this.beforeNextBatch;
      this.beforeNextBatch = null;
      callback();
    }
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
  }
}

function fixture(t) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE suppliers (id INTEGER PRIMARY KEY, vendor_id INTEGER NOT NULL, business_name TEXT NOT NULL);
    CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE purchase_orders (
      id INTEGER PRIMARY KEY, purchase_number TEXT NOT NULL, vendor_id INTEGER NOT NULL,
      supplier_id INTEGER NOT NULL, invoice_number TEXT NOT NULL, invoice_date TEXT NOT NULL,
      subtotal_paise INTEGER NOT NULL, tax_paise INTEGER NOT NULL, total_paise INTEGER NOT NULL,
      payment_status TEXT DEFAULT 'unpaid' NOT NULL, status TEXT NOT NULL,
      created_by_profile_id INTEGER NOT NULL, approved_by_profile_id INTEGER, approved_at TEXT,
      cancelled_by_profile_id INTEGER, cancelled_at TEXT, cancellation_reason TEXT DEFAULT '' NOT NULL,
      posted_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
    CREATE TABLE purchase_order_items (
      id INTEGER PRIMARY KEY, purchase_order_id INTEGER NOT NULL, product_id INTEGER NOT NULL,
      inventory_id INTEGER, batch_number TEXT NOT NULL, expiry_date TEXT NOT NULL,
      manufacturing_date TEXT, dosage TEXT DEFAULT '' NOT NULL, quantity INTEGER NOT NULL,
      free_quantity INTEGER DEFAULT 0 NOT NULL, received_quantity INTEGER DEFAULT 0 NOT NULL,
      received_free_quantity INTEGER DEFAULT 0 NOT NULL, purchase_price_paise INTEGER NOT NULL,
      sale_price_paise INTEGER NOT NULL, mrp_paise INTEGER NOT NULL, gst_percent INTEGER NOT NULL,
      taxable_paise INTEGER NOT NULL, tax_paise INTEGER NOT NULL, line_total_paise INTEGER NOT NULL
    );
    CREATE TABLE pharmacy_inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT, vendor_id INTEGER NOT NULL, product_id INTEGER NOT NULL,
      batch_number TEXT NOT NULL, expiry_date TEXT NOT NULL, manufacturing_date TEXT,
      dosage TEXT DEFAULT '' NOT NULL, purchase_price_paise INTEGER NOT NULL,
      sale_price_paise INTEGER NOT NULL, mrp_paise INTEGER NOT NULL, quantity INTEGER NOT NULL,
      gst_percent INTEGER NOT NULL, quarantine_status TEXT NOT NULL, active INTEGER NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      UNIQUE(vendor_id, product_id, batch_number)
    );
    CREATE TABLE purchase_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, receipt_number TEXT UNIQUE NOT NULL,
      vendor_id INTEGER NOT NULL, purchase_order_id INTEGER NOT NULL, received_on TEXT NOT NULL,
      notes TEXT NOT NULL, received_by_profile_id INTEGER NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
    CREATE TABLE purchase_receipt_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, purchase_receipt_id INTEGER NOT NULL,
      purchase_order_item_id INTEGER NOT NULL, inventory_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL, free_quantity INTEGER NOT NULL
    );
    CREATE TABLE supplier_returns (
      id INTEGER PRIMARY KEY AUTOINCREMENT, return_number TEXT UNIQUE NOT NULL,
      vendor_id INTEGER NOT NULL, supplier_id INTEGER NOT NULL, purchase_order_id INTEGER NOT NULL,
      debit_note_number TEXT UNIQUE NOT NULL, reason TEXT NOT NULL, total_paise INTEGER NOT NULL,
      status TEXT NOT NULL, created_by_profile_id INTEGER NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
    CREATE TABLE supplier_return_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_return_id INTEGER NOT NULL,
      purchase_order_item_id INTEGER NOT NULL, inventory_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL, amount_paise INTEGER NOT NULL, disposition TEXT NOT NULL
    );
    CREATE TABLE stock_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT, vendor_id INTEGER NOT NULL, inventory_id INTEGER NOT NULL,
      movement_type TEXT NOT NULL, quantity_delta INTEGER NOT NULL, balance_after INTEGER NOT NULL,
      reference_type TEXT NOT NULL, reference_id INTEGER NOT NULL, reason TEXT NOT NULL,
      actor_profile_id INTEGER NOT NULL
    );
    CREATE TABLE ledger_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, vendor_id INTEGER NOT NULL, account_code TEXT NOT NULL,
      entry_date TEXT NOT NULL, description TEXT NOT NULL, debit_paise INTEGER NOT NULL,
      credit_paise INTEGER NOT NULL, reference_type TEXT NOT NULL, reference_id INTEGER NOT NULL,
      created_by_profile_id INTEGER NOT NULL
    );
    CREATE TABLE audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, vendor_id INTEGER, actor_profile_id INTEGER,
      action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
      before_json TEXT NOT NULL, after_json TEXT NOT NULL, reason TEXT NOT NULL,
      request_id TEXT NOT NULL, previous_event_hash TEXT NOT NULL, event_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TRIGGER purchase_order_item_received_quantity_update_guard
    BEFORE UPDATE OF received_quantity, received_free_quantity ON purchase_order_items
    WHEN NEW.received_quantity < 0 OR NEW.received_free_quantity < 0
      OR NEW.received_quantity > NEW.quantity OR NEW.received_free_quantity > NEW.free_quantity
    BEGIN SELECT RAISE(ABORT, 'purchase receipt quantity invalid'); END;
    CREATE TRIGGER purchase_receipt_vendor_guard
    BEFORE INSERT ON purchase_receipts
    WHEN NEW.vendor_id <> COALESCE((SELECT vendor_id FROM purchase_orders WHERE id=NEW.purchase_order_id), -1)
      OR COALESCE((SELECT status FROM purchase_orders WHERE id=NEW.purchase_order_id), '') NOT IN ('approved','partially_received')
    BEGIN SELECT RAISE(ABORT, 'purchase receipt scope invalid'); END;
    CREATE TRIGGER supplier_return_quantity_guard
    BEFORE INSERT ON supplier_return_items
    WHEN NEW.quantity < 1
      OR NEW.inventory_id <> COALESCE((SELECT inventory_id FROM purchase_order_items WHERE id=NEW.purchase_order_item_id), -1)
      OR NEW.quantity > COALESCE((SELECT quantity FROM pharmacy_inventory WHERE id=NEW.inventory_id), 0)
      OR NEW.quantity > (
        COALESCE((SELECT received_quantity+received_free_quantity FROM purchase_order_items WHERE id=NEW.purchase_order_item_id), 0)
        - COALESCE((SELECT SUM(item.quantity) FROM supplier_return_items item JOIN supplier_returns ret ON ret.id=item.supplier_return_id WHERE item.purchase_order_item_id=NEW.purchase_order_item_id AND ret.status<>'cancelled'), 0)
      )
    BEGIN SELECT RAISE(ABORT, 'supplier_return_quantity_invalid'); END;
  `);
  sqlite.prepare("INSERT INTO suppliers VALUES (10,1,'Lifecycle Stockist'),(20,2,'Other Stockist')").run();
  sqlite.prepare("INSERT INTO products VALUES (1,'Lifecycle Medicine')").run();
  sqlite.prepare(`INSERT INTO purchase_orders
    (id,purchase_number,vendor_id,supplier_id,invoice_number,invoice_date,subtotal_paise,tax_paise,total_paise,status,created_by_profile_id)
    VALUES (100,'PO-LIFECYCLE',1,10,'INV-LIFECYCLE','2024-08-01',10000,1000,11000,'draft',11)`).run();
  sqlite.prepare(`INSERT INTO purchase_order_items
    (id,purchase_order_id,product_id,batch_number,expiry_date,manufacturing_date,dosage,quantity,free_quantity,
      purchase_price_paise,sale_price_paise,mrp_paise,gst_percent,taxable_paise,tax_paise,line_total_paise)
    VALUES (500,100,1,'B-LIFECYCLE','2030-08-01','2024-01-01','10 mg',10,2,1000,1500,1600,10,10000,1000,11000)`).run();
  const db = new TestD1Database(sqlite);
  t.after(() => sqlite.close());
  return { db, sqlite };
}

test("draft approval and partial receipts keep stock/accounting separate and make received units returnable", async (t) => {
  const { db, sqlite } = fixture(t);
  await transitionPurchaseOrder({ db, vendorId: 1, actorProfileId: 11, purchaseOrderId: 100, action: "approve" });
  assert.equal(sqlite.prepare("SELECT status FROM purchase_orders WHERE id=100").get().status, "approved");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM pharmacy_inventory").get().count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM ledger_entries").get().count, 0);

  const partial = await receivePurchaseOrder({
    db, vendorId: 1, actorProfileId: 11, purchaseOrderId: 100, receivedOn: "2024-08-02",
    items: [{ purchaseOrderItemId: 500, quantity: 4, freeQuantity: 1 }],
  });
  assert.equal(partial.status, "partially_received");
  assert.deepEqual({ ...sqlite.prepare("SELECT status FROM purchase_orders WHERE id=100").get() }, { status: "partially_received" });
  assert.deepEqual({ ...sqlite.prepare("SELECT pharmacy_inventory.quantity,received_quantity AS receivedQuantity,received_free_quantity AS receivedFreeQuantity FROM purchase_order_items JOIN pharmacy_inventory ON pharmacy_inventory.id=purchase_order_items.inventory_id WHERE purchase_order_items.id=500").get() }, { quantity: 5, receivedQuantity: 4, receivedFreeQuantity: 1 });
  assert.deepEqual(sqlite.prepare("SELECT quantity_delta AS delta,balance_after AS balance FROM stock_ledger").all().map((row) => ({ ...row })), [{ delta: 5, balance: 5 }]);
  const ledgers = sqlite.prepare("SELECT account_code AS accountCode,debit_paise AS debitPaise,credit_paise AS creditPaise FROM ledger_entries ORDER BY id").all().map((row) => ({ ...row }));
  assert.deepEqual(ledgers, [
    { accountCode: "PURCHASES", debitPaise: 4400, creditPaise: 0 },
    { accountCode: "ACCOUNTS_PAYABLE", debitPaise: 0, creditPaise: 4400 },
  ]);
  const returnable = await listReturnablePurchases(db, 1);
  assert.equal(returnable.length, 1);
  assert.equal(returnable[0].purchasedQuantity, 5);
  await assert.rejects(transitionPurchaseOrder({
    db, vendorId: 1, actorProfileId: 11, purchaseOrderId: 100,
    action: "cancel", reason: "Do not reverse a goods receipt",
  }), (error) => error instanceof PurchaseTransitionError && /cannot be cancelled/.test(error.message));
  assert.equal(sqlite.prepare("SELECT quantity FROM pharmacy_inventory").get().quantity, 5);

  const complete = await receivePurchaseOrder({
    db, vendorId: 1, actorProfileId: 11, purchaseOrderId: 100, receivedOn: "2024-08-03",
    items: [{ purchaseOrderItemId: 500, quantity: 6, freeQuantity: 1 }],
  });
  assert.equal(complete.status, "received");
  assert.equal(sqlite.prepare("SELECT quantity FROM pharmacy_inventory").get().quantity, 12);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM purchase_receipts").get().count, 2);
  assert.deepEqual(sqlite.prepare("SELECT action FROM audit_events ORDER BY id").all().map((row) => row.action), [
    "purchase.approved", "purchase.receipt.completed", "purchase.receipt.completed",
  ]);
});

test("excess and concurrently stale receipts roll back every receipt side effect", async (t) => {
  const { db, sqlite } = fixture(t);
  await transitionPurchaseOrder({ db, vendorId: 1, actorProfileId: 11, purchaseOrderId: 100, action: "approve" });
  await assert.rejects(receivePurchaseOrder({
    db, vendorId: 1, actorProfileId: 11, purchaseOrderId: 100, receivedOn: "2024-08-02",
    items: [{ purchaseOrderItemId: 500, quantity: 11 }],
  }), (error) => error instanceof PurchaseTransitionError && /exceeds/.test(error.message));
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM purchase_receipts").get().count, 0);

  db.beforeNextBatch = () => sqlite.prepare("UPDATE purchase_order_items SET received_quantity=9 WHERE id=500").run();
  await assert.rejects(receivePurchaseOrder({
    db, vendorId: 1, actorProfileId: 11, purchaseOrderId: 100, receivedOn: "2024-08-02",
    items: [{ purchaseOrderItemId: 500, quantity: 2 }],
  }), (error) => error instanceof PurchaseTransitionError && /changed/.test(error.message));
  assert.equal(sqlite.prepare("SELECT received_quantity FROM purchase_order_items WHERE id=500").get().received_quantity, 9);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM purchase_receipts").get().count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM pharmacy_inventory").get().count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM stock_ledger").get().count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM ledger_entries").get().count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action='purchase.receipt.completed'").get().count, 0);
});

test("an existing batch must retain the same manufacturing and expiry identity", async (t) => {
  const { db, sqlite } = fixture(t);
  await transitionPurchaseOrder({ db, vendorId: 1, actorProfileId: 11, purchaseOrderId: 100, action: "approve" });
  sqlite.prepare(`INSERT INTO pharmacy_inventory
    (vendor_id,product_id,batch_number,expiry_date,manufacturing_date,dosage,purchase_price_paise,
      sale_price_paise,mrp_paise,quantity,gst_percent,quarantine_status,active)
    VALUES (1,1,'B-LIFECYCLE','2031-08-01','2024-01-01','10 mg',1000,1500,1600,7,10,'available',1)`).run();

  await assert.rejects(receivePurchaseOrder({
    db, vendorId: 1, actorProfileId: 11, purchaseOrderId: 100, receivedOn: "2024-08-02",
    items: [{ purchaseOrderItemId: 500, quantity: 2 }],
  }), (error) => error instanceof PurchaseTransitionError && /conflicting manufacturing or expiry/.test(error.message));
  assert.equal(sqlite.prepare("SELECT quantity FROM pharmacy_inventory").get().quantity, 7);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM purchase_receipts").get().count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM stock_ledger").get().count, 0);
});

test("a concurrent conflicting batch rolls back the complete receipt", async (t) => {
  const { db, sqlite } = fixture(t);
  await transitionPurchaseOrder({ db, vendorId: 1, actorProfileId: 11, purchaseOrderId: 100, action: "approve" });
  db.beforeNextBatch = () => sqlite.prepare(`INSERT INTO pharmacy_inventory
    (vendor_id,product_id,batch_number,expiry_date,manufacturing_date,dosage,purchase_price_paise,
      sale_price_paise,mrp_paise,quantity,gst_percent,quarantine_status,active)
    VALUES (1,1,'B-LIFECYCLE','2032-08-01','2024-01-01','10 mg',1000,1500,1600,4,10,'available',1)`).run();

  await assert.rejects(receivePurchaseOrder({
    db, vendorId: 1, actorProfileId: 11, purchaseOrderId: 100, receivedOn: "2024-08-02",
    items: [{ purchaseOrderItemId: 500, quantity: 2 }],
  }), (error) => error instanceof PurchaseTransitionError && /changed/.test(error.message));
  assert.equal(sqlite.prepare("SELECT quantity FROM pharmacy_inventory").get().quantity, 4);
  assert.equal(sqlite.prepare("SELECT received_quantity FROM purchase_order_items WHERE id=500").get().received_quantity, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM purchase_receipts").get().count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM ledger_entries").get().count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM stock_ledger").get().count, 0);
});

test("receipt GST rounds once per paid line and the received batch remains returnable", async (t) => {
  const { db, sqlite } = fixture(t);
  sqlite.prepare(`UPDATE purchase_order_items SET quantity=3,free_quantity=1,purchase_price_paise=1001,
    gst_percent=5,taxable_paise=3003,tax_paise=150,line_total_paise=3153 WHERE id=500`).run();
  await transitionPurchaseOrder({ db, vendorId: 1, actorProfileId: 11, purchaseOrderId: 100, action: "approve" });
  const receipt = await receivePurchaseOrder({
    db, vendorId: 1, actorProfileId: 11, purchaseOrderId: 100, receivedOn: "2024-08-02",
    items: [{ purchaseOrderItemId: 500, quantity: 3, freeQuantity: 1 }],
  });
  assert.equal(receipt.status, "received");
  assert.deepEqual(sqlite.prepare(`SELECT account_code AS accountCode,debit_paise AS debitPaise,credit_paise AS creditPaise
    FROM ledger_entries ORDER BY id`).all().map((row) => ({ ...row })), [
    { accountCode: "PURCHASES", debitPaise: 3153, creditPaise: 0 },
    { accountCode: "ACCOUNTS_PAYABLE", debitPaise: 0, creditPaise: 3153 },
  ]);
  assert.equal(sqlite.prepare("SELECT quantity FROM pharmacy_inventory").get().quantity, 4);

  const returned = await completeSupplierReturn({
    db, vendorId: 1, actorProfileId: 11, purchaseOrderItemId: 500,
    quantity: 1, reason: "Damaged received unit", requestId: "p2-10-return",
  });
  assert.equal(returned.totalPaise, 1001);
  assert.equal(sqlite.prepare("SELECT quantity FROM pharmacy_inventory").get().quantity, 3);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM supplier_returns").get().count, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM stock_ledger WHERE movement_type='supplier_return'").get().count, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action='supplier_return.completed'").get().count, 1);
});

test("purchase lifecycle mutations are vendor scoped and cancellation never reverses received stock", async (t) => {
  const { db, sqlite } = fixture(t);
  await assert.rejects(transitionPurchaseOrder({ db, vendorId: 2, actorProfileId: 22, purchaseOrderId: 100, action: "approve" }), (error) => error instanceof PurchaseTransitionError && error.status === 404);
  await transitionPurchaseOrder({ db, vendorId: 1, actorProfileId: 11, purchaseOrderId: 100, action: "cancel", reason: "Supplier unavailable" });
  assert.equal(sqlite.prepare("SELECT status FROM purchase_orders WHERE id=100").get().status, "cancelled");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM pharmacy_inventory").get().count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM ledger_entries").get().count, 0);
  await assert.rejects(receivePurchaseOrder({
    db, vendorId: 1, actorProfileId: 11, purchaseOrderId: 100, receivedOn: "2024-08-02",
    items: [{ purchaseOrderItemId: 500, quantity: 1 }],
  }), /Only an approved or partially received purchase/);
});

test("migration 0039 backfills legacy receipts and enforces received-quantity return guards", async () => {
  const migration = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../drizzle/0039_purchase_lifecycle.sql", import.meta.url), "utf8"));
  assert.match(migration, /WHERE `status` IN \('received', 'posted'\)/);
  assert.match(migration, /received_quantity` \+ `received_free_quantity/);
  assert.match(migration, /DROP TRIGGER IF EXISTS `supplier_return_quantity_guard`/);
  assert.match(migration, /purchase receipt quantity invalid/);
});

test("purchase lifecycle HTTP routes and UI preserve tenant auth and legacy immediate receipt compatibility", async () => {
  const { readFile } = await import("node:fs/promises");
  const [collectionRoute, detailRoute, lifecycle, procurement] = await Promise.all([
    readFile(new URL("../app/api/purchases/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/purchases/[id]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/purchase-lifecycle.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/procurement-center.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(collectionRoute, /requireVendorPermission\(request, "purchase\.write"\)/);
  assert.match(detailRoute, /requireVendorPermission\(request, "purchase\.write"\)/);
  assert.match(detailRoute, /purchase\.vendor_id = \?/);
  assert.match(collectionRoute, /body\.workflow === "draft" \? "draft" : "immediate_receipt"/);
  assert.match(procurement, /workflow: "draft"/);
  assert.match(lifecycle, /guardedUpdateResultIndexes\.push\(statements\.length\)/);
  assert.match(lifecycle, /batchResults\[index\]\?\.meta\.changes/);
});
