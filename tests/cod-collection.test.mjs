import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { collectCodPayment, transitionCodCustody, CodCollectionError } from "../lib/cod-collection.ts";

class D1Statement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.values = []; }
  bind(...values) { this.values = values; return this; }
  async first() { return this.db.prepare(this.sql).get(...this.values) ?? null; }
  async run() { const result = this.db.prepare(this.sql).run(...this.values); return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } }; }
}
class D1 {
  constructor(db) { this.db = db; }
  prepare(sql) { return new D1Statement(this.db, sql); }
  async batch(statements) { this.db.exec("BEGIN IMMEDIATE"); try { const results = []; for (const statement of statements) results.push(await statement.run()); this.db.exec("COMMIT"); return results; } catch (error) { this.db.exec("ROLLBACK"); throw error; } }
}

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE account_profiles(id INTEGER PRIMARY KEY);
    CREATE TABLE vendors(id INTEGER PRIMARY KEY);
    CREATE TABLE orders(id INTEGER PRIMARY KEY,order_number TEXT,vendor_id INTEGER,customer_profile_id INTEGER,total_paise INTEGER,payment_method TEXT,payment_status TEXT,order_status TEXT,delivery_status TEXT,updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE ledger_entries(id INTEGER PRIMARY KEY AUTOINCREMENT,vendor_id INTEGER,account_code TEXT,entry_date TEXT,description TEXT,debit_paise INTEGER,credit_paise INTEGER,reference_type TEXT,reference_id INTEGER,created_by_profile_id INTEGER);
    CREATE TABLE audit_events(id INTEGER PRIMARY KEY AUTOINCREMENT,vendor_id INTEGER,actor_profile_id INTEGER,action TEXT,entity_type TEXT,entity_id TEXT,before_json TEXT,after_json TEXT,reason TEXT,request_id TEXT,previous_event_hash TEXT,event_hash TEXT,created_at TEXT);
    CREATE TABLE cod_collection_evidence(id INTEGER PRIMARY KEY AUTOINCREMENT,order_id INTEGER,vendor_id INTEGER,amount_paise INTEGER,tender_mode TEXT,receipt_reference TEXT,idempotency_key TEXT,collector_profile_id INTEGER,collection_status TEXT DEFAULT 'collected',custody_status TEXT DEFAULT 'on_hand',collected_at TEXT DEFAULT CURRENT_TIMESTAMP,deposit_reference TEXT DEFAULT '',deposited_at TEXT,deposited_by_profile_id INTEGER,reconciliation_reference TEXT DEFAULT '',reconciled_at TEXT,reconciled_by_profile_id INTEGER,notes TEXT DEFAULT '',created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE UNIQUE INDEX cod_collection_order_uidx ON cod_collection_evidence(order_id);
    INSERT INTO account_profiles VALUES (1),(2); INSERT INTO vendors VALUES (10);
    INSERT INTO orders (id,order_number,vendor_id,customer_profile_id,total_paise,payment_method,payment_status,order_status,delivery_status)
      VALUES (100,'ORD-COD-100',10,1,11800,'cod','cod_due','processing','out_for_delivery');`);
  return { db, d1: new D1(db) };
}

test("COD collection requires exact evidence, is atomic/idempotent, and records tender ledger", async () => {
  const { db, d1 } = fixture();
  const input = { db: d1, orderId: 100, actorProfileId: 2, amountPaise: 11800, tenderMode: "cash", receiptReference: "CASH-100", idempotencyKey: "cod-idempotency-100" };
  const result = await collectCodPayment(input);
  assert.equal(result.collected, true);
  assert.equal(db.prepare("SELECT payment_status FROM orders WHERE id=100").get().payment_status, "paid");
  assert.deepEqual({ ...db.prepare("SELECT account_code,debit_paise,reference_type FROM ledger_entries WHERE reference_id=100").get() }, { account_code: "CASH_ON_HAND", debit_paise: 11800, reference_type: "cod_collection" });
  assert.equal((await collectCodPayment(input)).duplicate, true);
  await assert.rejects(() => collectCodPayment({ ...input, idempotencyKey: "cod-idempotency-101", receiptReference: "CASH-101" }), (error) => error instanceof CodCollectionError && error.status === 409);
  await assert.rejects(() => collectCodPayment({ ...input, amountPaise: 11799, idempotencyKey: "cod-idempotency-102", receiptReference: "CASH-102" }), /order total/);
  db.close();
});

test("COD custody transitions require deposit then reconciliation and cannot be replayed", async () => {
  const { db, d1 } = fixture();
  const input = { db: d1, orderId: 100, actorProfileId: 2, amountPaise: 11800, tenderMode: "upi", receiptReference: "UPI-100", idempotencyKey: "cod-idempotency-200" };
  await collectCodPayment(input);
  await assert.rejects(() => transitionCodCustody({ db: d1, orderId: 100, actorProfileId: 2, action: "reconcile", reference: "REC-100" }), /not allowed/);
  assert.equal((await transitionCodCustody({ db: d1, orderId: 100, actorProfileId: 2, action: "deposit", reference: "DEP-100" })).custodyStatus, "deposited");
  assert.equal((await transitionCodCustody({ db: d1, orderId: 100, actorProfileId: 2, action: "reconcile", reference: "REC-100" })).custodyStatus, "reconciled");
  await assert.rejects(() => transitionCodCustody({ db: d1, orderId: 100, actorProfileId: 2, action: "reconcile", reference: "REC-101" }), /not allowed/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE entity_type='cod_collection'").get().count, 3);
  db.close();
});

test("COD delivery transition requires collection evidence and removes implicit payment finality", async () => {
  const tracking = await (await import("node:fs/promises")).readFile(new URL("../app/api/orders/[id]/tracking/route.ts", import.meta.url), "utf8");
  const route = await (await import("node:fs/promises")).readFile(new URL("../app/api/orders/[id]/cod-collection/route.ts", import.meta.url), "utf8");
  assert.match(tracking, /Record and verify COD collection evidence/);
  assert.doesNotMatch(tracking, /payment_status = CASE WHEN \? = 'delivered' AND payment_method = 'cod' THEN 'paid'/);
  assert.match(route, /Only an assigned delivery operator or vendor can record COD collection/);
  assert.match(route, /private, no-store/);
});
