import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { PDFDocument } from "pdf-lib";

import {
  getCustomerTaxInvoice,
  getVendorTaxInvoice,
  prepareOfflineTaxInvoiceStatement,
  renderTaxInvoiceHtml,
  renderTaxInvoicePdf,
} from "../lib/tax-invoice.ts";

const migration = readFileSync(new URL("../drizzle/0045_legal_human_torch.sql", import.meta.url), "utf8");
const customerRoute = readFileSync(new URL("../app/api/customer/invoices/[id]/route.ts", import.meta.url), "utf8");
const vendorRoute = readFileSync(new URL("../app/api/vendor/invoices/[id]/route.ts", import.meta.url), "utf8");
const trackingRoute = readFileSync(new URL("../app/api/orders/[id]/tracking/route.ts", import.meta.url), "utf8");

class Statement {
  constructor(database, sql) { this.database = database; this.sql = sql; this.values = []; }
  bind(...values) { this.values = values; return this; }
  async first() { return this.database.prepare(this.sql).get(...this.values) ?? null; }
  async all() { return { results: this.database.prepare(this.sql).all(...this.values).map((row) => ({ ...row })) }; }
  async run() { const result = this.database.prepare(this.sql).run(...this.values); return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } }; }
}
class D1 {
  constructor(database) { this.database = database; }
  prepare(sql) { return new Statement(this.database, sql); }
}

function oldInvoiceDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE account_profiles (id INTEGER PRIMARY KEY, role TEXT, status TEXT);
    CREATE TABLE vendors (id INTEGER PRIMARY KEY, profile_id INTEGER, business_name TEXT, address TEXT, email TEXT, gst_number TEXT);
    CREATE TABLE orders (id INTEGER PRIMARY KEY, order_number TEXT, customer_profile_id INTEGER, vendor_id INTEGER, subtotal_paise INTEGER, tax_paise INTEGER, delivery_fee_paise INTEGER, total_paise INTEGER, payment_method TEXT, payment_status TEXT, delivery_status TEXT, place_of_supply_state_code TEXT, customer_name TEXT, delivery_address TEXT);
    CREATE TABLE order_items (id INTEGER PRIMARY KEY, order_id INTEGER, product_name TEXT, hsn_code TEXT, batch_number TEXT, expiry_date TEXT, quantity INTEGER, unit_price_paise INTEGER, discount_paise INTEGER, taxable_paise INTEGER, gst_percent INTEGER, cgst_paise INTEGER, sgst_paise INTEGER, igst_paise INTEGER, line_total_paise INTEGER);
    CREATE TABLE delivery_events (id INTEGER PRIMARY KEY, order_id INTEGER, status TEXT, actor_profile_id INTEGER);
    CREATE TABLE offline_sales (id INTEGER PRIMARY KEY, sale_number TEXT, vendor_id INTEGER, customer_profile_id INTEGER, customer_name TEXT, payment_mode TEXT, buyer_gstin TEXT, place_of_supply_state_code TEXT, gross_paise INTEGER, discount_paise INTEGER, subtotal_paise INTEGER, tax_paise INTEGER, cgst_paise INTEGER, sgst_paise INTEGER, igst_paise INTEGER, total_paise INTEGER, created_by_profile_id INTEGER, request_fingerprint TEXT, offline_prescription_id INTEGER);
    CREATE TABLE offline_sale_items (id INTEGER PRIMARY KEY, offline_sale_id INTEGER, inventory_id INTEGER, product_id INTEGER, product_name TEXT, hsn_code TEXT, batch_number TEXT, expiry_date TEXT, quantity INTEGER, unit_price_paise INTEGER, discount_paise INTEGER, taxable_paise INTEGER, tax_paise INTEGER, gst_percent INTEGER, cgst_paise INTEGER, sgst_paise INTEGER, igst_paise INTEGER, line_total_paise INTEGER, prescription_required INTEGER, drug_schedule TEXT);
    CREATE TABLE offline_sale_events (id INTEGER PRIMARY KEY, offline_sale_id INTEGER, vendor_id INTEGER, event_type TEXT, actor_profile_id INTEGER, request_fingerprint TEXT);
    CREATE TABLE ledger_entries (id INTEGER PRIMARY KEY, reference_type TEXT, reference_id INTEGER, debit_paise INTEGER, credit_paise INTEGER);
    CREATE TABLE stock_ledger (id INTEGER PRIMARY KEY, reference_type TEXT, reference_id INTEGER, inventory_id INTEGER, quantity_delta INTEGER);
    CREATE TABLE offline_prescription_reviews (id INTEGER PRIMARY KEY, offline_prescription_id INTEGER, decision TEXT);
    CREATE TABLE offline_prescription_review_items (id INTEGER PRIMARY KEY, review_id INTEGER, product_id INTEGER, quantity_approved INTEGER);
    CREATE TABLE statutory_register_entries (id INTEGER PRIMARY KEY, source_type TEXT, source_id INTEGER, product_id INTEGER, batch_number TEXT, quantity_supplied INTEGER);
    CREATE TABLE tax_invoices (id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_number TEXT NOT NULL, vendor_id INTEGER NOT NULL, source_type TEXT NOT NULL, source_id INTEGER NOT NULL, seller_gstin TEXT NOT NULL, buyer_gstin TEXT NOT NULL DEFAULT '', place_of_supply_state_code TEXT NOT NULL, subtotal_paise INTEGER NOT NULL, cgst_paise INTEGER NOT NULL DEFAULT 0, sgst_paise INTEGER NOT NULL DEFAULT 0, igst_paise INTEGER NOT NULL DEFAULT 0, total_paise INTEGER NOT NULL, irn TEXT NOT NULL DEFAULT '', qr_code_payload TEXT NOT NULL DEFAULT '', issued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TRIGGER offline_sale_events_completed_guard BEFORE INSERT ON offline_sale_events BEGIN SELECT 1 FROM tax_invoices; END;
    INSERT INTO account_profiles VALUES (1,'customer','active'),(2,'vendor','active');
    INSERT INTO vendors VALUES (7,2,'Example Pharmacy','12 Legal Road, Hyderabad','seller@example.test','36ABCDE1234F1Z5');
    INSERT INTO orders VALUES (10,'ORD-10',1,7,1000,50,100,1150,'online','paid','delivered','36','Verified Customer','18 Customer Lane');
    INSERT INTO order_items VALUES (20,10,'Example Tablet','3004','B-10','2028-12-31',2,525,50,1000,5,25,25,0,1050);
    INSERT INTO delivery_events VALUES (1,10,'delivered',2);
    INSERT INTO tax_invoices (invoice_number,vendor_id,source_type,source_id,seller_gstin,buyer_gstin,place_of_supply_state_code,subtotal_paise,cgst_paise,sgst_paise,igst_paise,total_paise,issued_at)
      VALUES ('GST-ORD-10',7,'online_order',10,'36ABCDE1234F1Z5','','36',1000,25,25,0,1150,'2026-08-13 09:00:00');
  `);
  sqlite.exec(migration.replaceAll("--> statement-breakpoint", ""));
  return sqlite;
}

test("0045 backfills one immutable header and line snapshot with exact paise totals", async () => {
  const sqlite = oldInvoiceDatabase();
  const database = new D1(sqlite);
  const invoice = await getCustomerTaxInvoice(database, 1, 1);
  assert.ok(invoice);
  assert.equal(invoice.sourceNumber, "ORD-10");
  assert.equal(invoice.sellerName, "Example Pharmacy");
  assert.equal(invoice.sellerAddress, "12 Legal Road, Hyderabad");
  assert.equal(invoice.buyerName, "Verified Customer");
  assert.equal(invoice.deliveryFeePaise, 100);
  assert.deepEqual(invoice.lines.map((line) => ({ product: line.productName, gross: line.grossPaise, discount: line.discountPaise, total: line.lineTotalPaise })), [
    { product: "Example Tablet", gross: 1050, discount: 50, total: 1050 },
  ]);
  assert.equal((await getVendorTaxInvoice(database, 1, 7)).invoiceNumber, "GST-ORD-10");
  assert.equal(await getCustomerTaxInvoice(database, 1, 999), null);
  assert.equal(await getVendorTaxInvoice(database, 1, 999), null);
  assert.throws(() => sqlite.prepare("UPDATE tax_invoices SET total_paise=1 WHERE id=1").run(), /immutable/);
  assert.throws(() => sqlite.prepare("DELETE FROM tax_invoice_lines WHERE invoice_id=1").run(), /immutable/);
  assert.throws(() => sqlite.prepare("INSERT INTO tax_invoice_lines (invoice_id,line_number,source_item_id,product_name,quantity,unit_price_paise,gross_paise,taxable_paise,gst_percent,line_total_paise) VALUES (1,2,999,'Fake',1,1,1,1,0,1)").run(), /invalid tax invoice line/);
  sqlite.close();
});

test("new counter invoices are source-derived exactly once and auto-snapshot their lines", async () => {
  const sqlite = oldInvoiceDatabase();
  sqlite.exec(`
    INSERT INTO offline_sales VALUES (30,'POS-30',7,1,'Verified Customer','cash','','36',2100,100,2000,100,50,50,0,2100,2,'fingerprint',NULL);
    INSERT INTO offline_sale_items VALUES (31,30,41,51,'Second Tablet','3004','POS-B','2029-01-31',2,1050,100,2000,100,5,50,50,0,2100,0,'OTC');
  `);
  const database = new D1(sqlite);
  await prepareOfflineTaxInvoiceStatement(database, "POS-30", 2).run();
  await prepareOfflineTaxInvoiceStatement(database, "POS-30", 2).run();
  const header = sqlite.prepare("SELECT id FROM tax_invoices WHERE source_type='offline_sale' AND source_id=30").get();
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM tax_invoices WHERE source_type='offline_sale' AND source_id=30").get().count, 1);
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM tax_invoice_lines WHERE invoice_id=?").get(header.id).count, 1);
  const invoice = await getCustomerTaxInvoice(database, header.id, 1);
  assert.equal(invoice.sourceNumber, "POS-30");
  assert.equal(invoice.totalPaise, 2100);
  sqlite.close();
});

test("HTML and PDF render only the immutable snapshot and remain byte-stable", async () => {
  const sqlite = oldInvoiceDatabase();
  const invoice = await getCustomerTaxInvoice(new D1(sqlite), 1, 1);
  const html = renderTaxInvoiceHtml(invoice);
  assert.match(html, /GST tax invoice/);
  assert.match(html, /Example Tablet/);
  assert.match(html, /distinct from the payment-provider receipt/);
  assert.doesNotMatch(html, /latitude|longitude|17\.385|78\.486/i);
  const first = await renderTaxInvoicePdf(invoice);
  const second = await renderTaxInvoicePdf(invoice);
  assert.deepEqual(first, second);
  assert.equal(new TextDecoder().decode(first.slice(0, 8)), "%PDF-1.7");
  const parsed = await PDFDocument.load(first);
  assert.equal(parsed.getTitle(), "GST invoice GST-ORD-10");
  assert.ok(parsed.getPageCount() >= 1);
  sqlite.close();
});

test("invoice routes enforce customer ownership or sale.write vendor scope with private render controls", () => {
  assert.match(customerRoute, /requireLocalProfile\(request, \["customer"\]\)/);
  assert.match(customerRoute, /getCustomerTaxInvoice/);
  assert.match(vendorRoute, /requireVendorPermission\(request, "sale\.write"\)/);
  assert.match(vendorRoute, /getVendorTaxInvoice/);
  assert.match(trackingRoute, /prepareOnlineTaxInvoiceStatement/);
  assert.match(migration, /tax_invoices_no_update/);
  assert.match(migration, /tax_invoice_lines_no_update/);
  assert.match(migration, /source\.`delivery_status`='delivered' AND source\.`payment_status`='paid'/);
  assert.doesNotMatch(migration, /latitude|longitude/);
});
