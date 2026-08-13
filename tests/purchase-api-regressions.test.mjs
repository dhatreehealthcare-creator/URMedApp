import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  calculatePurchaseLineAmounts,
  hasConflictingPurchaseBatch,
  isDuplicateSupplierInvoiceError,
} from "../lib/purchase-conflicts.ts";

test("supplier invoice uniqueness is race-safe within one vendor and supplier", () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec(`CREATE TABLE purchase_orders (
      id INTEGER PRIMARY KEY, vendor_id INTEGER NOT NULL, supplier_id INTEGER NOT NULL,
      invoice_number TEXT NOT NULL
    );
    CREATE UNIQUE INDEX purchase_orders_vendor_invoice_uidx
      ON purchase_orders(vendor_id,supplier_id,invoice_number);`);
    sqlite.prepare("INSERT INTO purchase_orders VALUES (1,1,10,'INV-100')").run();
    assert.throws(
      () => sqlite.prepare("INSERT INTO purchase_orders VALUES (2,1,10,'INV-100')").run(),
      (error) => isDuplicateSupplierInvoiceError(error),
    );
    sqlite.prepare("INSERT INTO purchase_orders VALUES (3,1,11,'INV-100')").run();
    sqlite.prepare("INSERT INTO purchase_orders VALUES (4,2,10,'INV-100')").run();
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM purchase_orders").get().count, 3);
  } finally {
    sqlite.close();
  }
});

test("only the supplier-invoice unique constraint maps to the stable purchase conflict", () => {
  assert.equal(isDuplicateSupplierInvoiceError(new Error(
    "D1_ERROR: UNIQUE constraint failed: purchase_orders.vendor_id, purchase_orders.supplier_id, purchase_orders.invoice_number",
  )), true);
  assert.equal(isDuplicateSupplierInvoiceError(new Error(
    "UNIQUE constraint failed: purchase_orders.purchase_number",
  )), false);
});

test("batch identity compares both manufacturing and expiry dates", () => {
  const batch = { expiryDate: "2030-08-01", manufacturingDate: "2026-01-01" };
  assert.equal(hasConflictingPurchaseBatch(batch, { ...batch }), false);
  assert.equal(hasConflictingPurchaseBatch(batch, { ...batch, expiryDate: "2031-08-01" }), true);
  assert.equal(hasConflictingPurchaseBatch(batch, { ...batch, manufacturingDate: "2026-02-01" }), true);
  assert.equal(hasConflictingPurchaseBatch(batch, { ...batch, manufacturingDate: null }), false);
});

test("purchase GST uses integer paise and rounds once per line", () => {
  assert.deepEqual(calculatePurchaseLineAmounts(1001, 3, 5), {
    taxablePaise: 3003,
    taxPaise: 150,
    lineTotalPaise: 3153,
  });
  assert.deepEqual(calculatePurchaseLineAmounts(999, 1, 18), {
    taxablePaise: 999,
    taxPaise: 180,
    lineTotalPaise: 1179,
  });
});

test("purchase API normalizes invoices and maps unique-index races to HTTP 409", async () => {
  const route = await readFile(new URL("../app/api/purchases/route.ts", import.meta.url), "utf8");
  assert.match(route, /clean\(body\.invoiceNumber, 100\)\.toUpperCase\(\)/);
  assert.match(route, /invoice_number = \? COLLATE NOCASE/);
  assert.match(route, /isDuplicateSupplierInvoiceError\(error\)/);
  assert.match(route, /status: 409/);
  assert.match(route, /the same product and batch appears twice/);
});
