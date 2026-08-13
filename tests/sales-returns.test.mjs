import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { completeSalesReturn, SalesReturnError } from "../lib/sales-returns.ts";

class D1Statement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  async first() { return this.db.prepare(this.sql).get(...this.args) ?? null; }
  async run() { const result = this.db.prepare(this.sql).run(...this.args); return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } }; }
}
class D1 {
  constructor(db) { this.db = db; }
  prepare(sql) { return new D1Statement(this.db, sql); }
  async batch(statements) {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = []; for (const statement of statements) result.push(await statement.run()); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}

function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE orders(id INTEGER PRIMARY KEY,order_number TEXT,vendor_id INTEGER,order_status TEXT,delivery_status TEXT,payment_status TEXT,inventory_status TEXT);
    CREATE TABLE order_items(id INTEGER PRIMARY KEY,order_id INTEGER,inventory_id INTEGER,quantity INTEGER,unit_price_paise INTEGER,discount_paise INTEGER,taxable_paise INTEGER,cgst_paise INTEGER,sgst_paise INTEGER,igst_paise INTEGER);
    CREATE TABLE offline_sales(id INTEGER PRIMARY KEY,sale_number TEXT,vendor_id INTEGER);
    CREATE TABLE offline_sale_events(id INTEGER PRIMARY KEY,offline_sale_id INTEGER,event_type TEXT);
    CREATE TABLE offline_sale_items(id INTEGER PRIMARY KEY,offline_sale_id INTEGER,inventory_id INTEGER,quantity INTEGER,unit_price_paise INTEGER,discount_paise INTEGER,taxable_paise INTEGER,cgst_paise INTEGER,sgst_paise INTEGER,igst_paise INTEGER);
    CREATE TABLE tax_invoices(id INTEGER PRIMARY KEY,source_type TEXT,source_id INTEGER);
    CREATE TABLE pharmacy_inventory(id INTEGER PRIMARY KEY,vendor_id INTEGER,quantity INTEGER,reserved_quantity INTEGER,active INTEGER DEFAULT 1,updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE sales_returns(id INTEGER PRIMARY KEY AUTOINCREMENT,return_number TEXT UNIQUE,vendor_id INTEGER,source_type TEXT,source_id INTEGER,reason TEXT,credit_note_number TEXT,refund_paise INTEGER,discount_paise INTEGER DEFAULT 0,tax_paise INTEGER DEFAULT 0,delivery_fee_paise INTEGER DEFAULT 0,refund_method TEXT DEFAULT 'credit',refund_status TEXT DEFAULT 'recorded',refund_reference TEXT DEFAULT '',provider_refund_id TEXT,idempotency_key TEXT DEFAULT '',status TEXT,created_by_profile_id INTEGER);
    CREATE UNIQUE INDEX sales_returns_vendor_key ON sales_returns(vendor_id,idempotency_key) WHERE idempotency_key<>'';
    CREATE TABLE sales_return_items(id INTEGER PRIMARY KEY AUTOINCREMENT,sales_return_id INTEGER,inventory_id INTEGER,quantity INTEGER,condition TEXT,disposition TEXT,amount_paise INTEGER,source_item_id INTEGER DEFAULT 0,gross_paise INTEGER DEFAULT 0,discount_paise INTEGER DEFAULT 0,taxable_paise INTEGER DEFAULT 0,tax_paise INTEGER DEFAULT 0,cgst_paise INTEGER DEFAULT 0,sgst_paise INTEGER DEFAULT 0,igst_paise INTEGER DEFAULT 0);
    CREATE TABLE return_quarantine_holds(id INTEGER PRIMARY KEY AUTOINCREMENT,vendor_id INTEGER,sales_return_item_id INTEGER,inventory_id INTEGER,quantity INTEGER,condition TEXT,status TEXT DEFAULT 'held',reason TEXT,created_by_profile_id INTEGER);
    CREATE TABLE stock_ledger(id INTEGER PRIMARY KEY AUTOINCREMENT,vendor_id INTEGER,inventory_id INTEGER,movement_type TEXT,quantity_delta INTEGER,balance_after INTEGER,reference_type TEXT,reference_id INTEGER,reason TEXT,actor_profile_id INTEGER);
    CREATE TABLE ledger_entries(id INTEGER PRIMARY KEY AUTOINCREMENT,vendor_id INTEGER,account_code TEXT,entry_date TEXT,description TEXT,debit_paise INTEGER,credit_paise INTEGER,reference_type TEXT,reference_id INTEGER,created_by_profile_id INTEGER);
    CREATE TABLE audit_events(id INTEGER PRIMARY KEY AUTOINCREMENT,vendor_id INTEGER,actor_profile_id INTEGER,action TEXT,entity_type TEXT,entity_id TEXT,before_json TEXT,after_json TEXT,reason TEXT,request_id TEXT,previous_event_hash TEXT,event_hash TEXT,created_at TEXT);
    INSERT INTO orders VALUES (10,'ORD-10',1,'completed','delivered','paid','committed');
    INSERT INTO order_items VALUES (100,10,500,2,1000,100,1800,90,90,0);
    INSERT INTO offline_sales VALUES (20,'POS-20',1);
    INSERT INTO offline_sale_events VALUES (1,20,'completed');
    INSERT INTO offline_sale_items VALUES (200,20,600,2,1200,0,2400,120,120,0);
    INSERT INTO tax_invoices VALUES (1,'offline_sale',20);
    INSERT INTO pharmacy_inventory(id,vendor_id,quantity,reserved_quantity,active) VALUES (500,1,8,0,1),(600,1,5,0,1);
  `);
  return new D1(sqlite);
}

test("finalized online returns snapshot tax, quarantine only the returned quantity, and are idempotent", async () => {
  const db = fixture();
  const result = await completeSalesReturn({ db, vendorId: 1, actorProfileId: 9, sourceType: "online", sourceId: 10, inventoryId: 500, quantity: 1, condition: "damaged", reason: "Customer returned damaged pack", idempotencyKey: "return-online-1" });
  assert.equal(result.amountPaise, 1000);
  assert.equal(result.taxPaise, 90);
  assert.equal(result.disposition, "quarantined");
  assert.equal((await db.prepare("SELECT quantity FROM pharmacy_inventory WHERE id=500").first()).quantity, 8);
  assert.equal((await db.prepare("SELECT quantity FROM return_quarantine_holds WHERE inventory_id=500").first()).quantity, 1);
  assert.equal((await db.prepare("SELECT tax_paise FROM sales_returns WHERE id=?").bind(result.id).first()).tax_paise, 90);
  assert.deepEqual(await completeSalesReturn({ db, vendorId: 1, actorProfileId: 9, sourceType: "online", sourceId: 10, inventoryId: 500, quantity: 1, condition: "damaged", reason: "Customer returned damaged pack", idempotencyKey: "return-online-1" }).then((value) => value.duplicate), true);
  await assert.rejects(() => completeSalesReturn({ db, vendorId: 1, actorProfileId: 9, sourceType: "online", sourceId: 10, inventoryId: 500, quantity: 2, condition: "sealed", reason: "Second return exceeds remaining quantity", idempotencyKey: "return-online-2" }), SalesReturnError);
});

test("offline finalized sale can be restocked and undelivered online sale is rejected", async () => {
  const db = fixture();
  const result = await completeSalesReturn({ db, vendorId: 1, actorProfileId: 9, sourceType: "offline", sourceId: 20, inventoryId: 600, quantity: 1, condition: "sealed", reason: "Customer returned sealed pack", idempotencyKey: "return-offline-1" });
  assert.equal(result.disposition, "restocked");
  assert.equal((await db.prepare("SELECT quantity FROM pharmacy_inventory WHERE id=600").first()).quantity, 6);
  assert.equal((await db.prepare("SELECT quantity_delta FROM stock_ledger WHERE reference_id=?").bind(result.id).first()).quantity_delta, 1);
  await db.prepare("UPDATE orders SET delivery_status='confirmed' WHERE id=10").run();
  await assert.rejects(() => completeSalesReturn({ db, vendorId: 1, actorProfileId: 9, sourceType: "online", sourceId: 10, inventoryId: 500, quantity: 1, condition: "sealed", reason: "Not yet delivered", idempotencyKey: "return-undelivered" }), /finalized paid sale/);
});
