import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { canRequestFullRefund } from "../lib/payment-lifecycle.ts";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

function refundable(overrides = {}) {
  return {
    paymentMethod: "online", paymentStatus: "paid", inventoryStatus: "committed",
    orderStatus: "placed", deliveryStatus: "awaiting_confirmation", providerPaymentId: "pay_test",
    ...overrides,
  };
}

test("canonical full-refund eligibility protects fulfilment and captured stock boundaries", () => {
  assert.equal(canRequestFullRefund(refundable(), "customer"), true);
  assert.equal(canRequestFullRefund(refundable({ deliveryStatus: "confirmed" }), "customer"), false);
  assert.equal(canRequestFullRefund(refundable({ deliveryStatus: "confirmed", orderStatus: "accepted" }), "vendor"), true);
  assert.equal(canRequestFullRefund(refundable({ deliveryStatus: "picked_up", orderStatus: "processing" }), "vendor"), false);
  assert.equal(canRequestFullRefund(refundable({ paymentStatus: "failed" }), "customer"), false);
  assert.equal(canRequestFullRefund(refundable({ inventoryStatus: "released" }), "customer"), false);
  assert.equal(canRequestFullRefund(refundable({ orderStatus: "cancelled" }), "admin"), false);
});

test("0042 enforces refund ownership, amount, terminal state, evidence relation, and immutability", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE account_profiles (id INTEGER PRIMARY KEY);
    CREATE TABLE vendors (id INTEGER PRIMARY KEY);
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY,vendor_id INTEGER NOT NULL,customer_profile_id INTEGER NOT NULL,
      payment_method TEXT NOT NULL,payment_status TEXT NOT NULL,inventory_status TEXT NOT NULL,
      razorpay_payment_id TEXT NOT NULL,total_paise INTEGER NOT NULL
    );
    CREATE TABLE sales_returns (
      id INTEGER PRIMARY KEY,vendor_id INTEGER NOT NULL,source_type TEXT NOT NULL,
      source_id INTEGER NOT NULL,refund_paise INTEGER NOT NULL
    );
  `);
  database.exec(read("../drizzle/0042_solid_hardball.sql").replaceAll("--> statement-breakpoint", ""));
  database.exec(`INSERT INTO account_profiles VALUES (1),(2);
    INSERT INTO vendors VALUES (10);
    INSERT INTO orders VALUES (100,10,1,'online','paid','committed','pay_100',11800);
    INSERT INTO orders VALUES (101,10,1,'online','paid','committed','pay_101',5900);
  `);
  const insert = database.prepare(`INSERT INTO payment_refunds
    (order_id,vendor_id,customer_profile_id,provider_payment_id,refund_receipt,amount_paise,reason,requested_by_profile_id)
    VALUES (?,?,?,?,?,?,?,?)`);
  insert.run(100, 10, 1, "pay_100", "URMED-RF-100", 11800, "Customer cancelled", 1);
  assert.throws(() => insert.run(101, 10, 2, "pay_101", "URMED-RF-WRONG-TENANT", 5900, "Wrong customer", 2), /payment_refund_order_mismatch/);
  assert.throws(() => insert.run(101, 10, 1, "pay_101", "URMED-RF-WRONG-AMOUNT", 5901, "Wrong amount", 1), /payment_refund_order_mismatch/);

  database.prepare("INSERT INTO sales_returns VALUES (500,10,'online',100,11800)").run();
  database.prepare("UPDATE payment_refunds SET sales_return_id=500 WHERE order_id=100").run();
  assert.throws(() => database.prepare("UPDATE payment_refunds SET sales_return_id=999 WHERE order_id=100").run(), /payment_refund_invalid_transition/);
  database.prepare(`UPDATE payment_refunds SET provider_refund_id='rfnd_100',status='processed',
    processed_at=CURRENT_TIMESTAMP WHERE order_id=100`).run();
  assert.equal(database.prepare("SELECT status FROM payment_refunds WHERE order_id=100").get().status, "processed");
  assert.throws(() => database.prepare(`UPDATE payment_refunds SET status='failed',failure_reason='late failure',
    failed_at=CURRENT_TIMESTAMP WHERE order_id=100`).run(), /payment_refund_invalid_transition/);
  assert.throws(() => database.prepare("DELETE FROM payment_refunds WHERE order_id=100").run(), /payment_refund_delete_forbidden/);

  insert.run(101, 10, 1, "pay_101", "URMED-RF-101", 5900, "Duplicate retry test", 1);
  assert.throws(() => insert.run(101, 10, 1, "pay_101", "URMED-RF-101-B", 5900, "Duplicate retry test", 1), /UNIQUE/);
  database.prepare(`UPDATE payment_refunds SET status='failed',failure_reason='provider unavailable',
    failed_at=CURRENT_TIMESTAMP WHERE order_id=101`).run();
  database.prepare(`UPDATE payment_refunds SET status='pending',failure_reason='',failed_at=NULL
    WHERE order_id=101`).run();
  assert.equal(database.prepare("SELECT status FROM payment_refunds WHERE order_id=101").get().status, "pending");
  database.close();
});

test("payment HTTP contracts verify provider values, separate events, refunds, retries, and receipt ownership", () => {
  const verify = read("../app/api/payments/razorpay/verify/route.ts");
  const webhook = read("../app/api/webhooks/razorpay/route.ts");
  const refund = read("../app/api/payments/razorpay/refund/route.ts");
  const receipt = read("../app/api/customer/orders/[id]/receipt/route.ts");
  const tracking = read("../app/api/orders/[id]/tracking/route.ts");
  assert.match(verify, /fetchRazorpayPayment/);
  assert.match(verify, /providerPayment\.amount !== order\.totalPaise/);
  assert.match(verify, /providerPayment\.currency !== "INR"/);
  assert.match(webhook, /eventType === "payment\.captured"/);
  assert.doesNotMatch(webhook, /eventType === "payment\.captured" \|\| payment\.status/);
  assert.match(webhook, /payload\?\.refund\?\.entity/);
  assert.match(webhook, /refund\.currency !== "INR"/);
  assert.match(refund, /X-Refund-Idempotency|createRazorpayRefund/);
  assert.match(refund, /beginFullOrderRefund/);
  assert.match(read("../lib/payment-lifecycle.ts"), /refund\.vendor_id,'online',refund\.order_id/);
  assert.match(read("../drizzle/0042_solid_hardball.sql"), /return_record\.source_type = 'online'/);
  assert.match(tracking, /Use the verified refund action/);
  assert.match(receipt, /current_order\.customer_profile_id=\?/);
  assert.match(receipt, /Payment evidence only/);
});

test("packaged Worker covers local Razorpay checkout, refund failure/retry, signed finality, races, and evidence", () => {
  const harness = read("../scripts/test-integration.mjs");
  const integration = read("./integration/phase0-api.integration.test.mjs");
  assert.match(harness, /url\.hostname !== "api\.razorpay\.com"/);
  assert.match(harness, /x-refund-idempotency/);
  assert.match(integration, /checkout and signed webhook race is idempotent/);
  assert.match(integration, /deterministic Razorpay refund failure/);
  assert.match(integration, /retry failed refund with identical idempotency body/);
  assert.match(integration, /refund\.created after local failure/);
  assert.match(integration, /signed refund processed webhook/);
  assert.match(integration, /late failed webhook cannot reverse processed refund/);
  assert.match(integration, /concurrent processed refund requests remain idempotent/);
  assert.match(integration, /cross-customer payment receipt isolation/);
  assert.match(integration, /refundLedgerAccounts/);
});
