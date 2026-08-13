import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { generateVendorOrderSlaNotifications, prepareVendorNewOrderNotificationStatement } from "../lib/vendor-order-notifications.ts";

class S { constructor(db, sql) { this.db=db; this.sql=sql; this.args=[]; } bind(...args){this.args=args;return this;} async run(){const r=this.db.prepare(this.sql).run(...this.args);return {meta:{changes:Number(r.changes)}};} async first(){return this.db.prepare(this.sql).get(...this.args)??null;} }
class D { constructor(db){this.db=db;} prepare(sql){return new S(this.db,sql);} async batch(xs){this.db.exec("BEGIN");try{const r=[];for(const x of xs)r.push(await x.run());this.db.exec("COMMIT");return r;}catch(e){this.db.exec("ROLLBACK");throw e;}} }

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE orders(id INTEGER PRIMARY KEY,order_number TEXT,vendor_id INTEGER,order_status TEXT,delivery_status TEXT,created_at TEXT);
    CREATE TABLE notifications(id INTEGER PRIMARY KEY AUTOINCREMENT,profile_id INTEGER,vendor_id INTEGER,notification_type TEXT,severity TEXT,title TEXT,message TEXT,reference_type TEXT,reference_id INTEGER,created_at TEXT,lifecycle_status TEXT DEFAULT 'unread');
    INSERT INTO orders VALUES(1,'ORD-1',7,'placed','awaiting_confirmation','2026-08-12T10:00:00.000Z');`);
  return new D(db);
}

test("new order notification is idempotent and overdue generation is bounded", async () => {
  const db = fixture();
  const statement = prepareVendorNewOrderNotificationStatement(db, { orderNumber: "ORD-1", orderId: 1, vendorId: 7, now: "2026-08-13T00:00:00.000Z" });
  await db.batch([statement]); await db.batch([prepareVendorNewOrderNotificationStatement(db, { orderNumber: "ORD-1", orderId: 1, vendorId: 7, now: "2026-08-13T00:00:00.000Z" })]);
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM notifications WHERE notification_type='vendor_order_new'").first()).count, 1);
  assert.deepEqual(await generateVendorOrderSlaNotifications({ db, now: "2026-08-13T00:00:00.000Z" }), { processingAt: "2026-08-13T00:00:00.000Z", generated: 1 });
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM notifications WHERE notification_type='vendor_order_sla_overdue'").first()).count, 1);
  assert.equal((await generateVendorOrderSlaNotifications({ db, now: "2026-08-13T00:00:00.000Z" })).generated, 0);
});
