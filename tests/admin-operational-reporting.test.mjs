import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  AdminReportError,
  calculateDeliveryReportRow,
  loadAdminDeliveryReport,
  loadAdminExpenseReport,
  loadAdminSalesReport,
  loadAdminStockReport,
  parseReportDateRange,
  reportCsv,
  wantsCsv,
} from "../lib/admin-reporting.ts";

class Statement {
  constructor(database, sql) { this.database = database; this.sql = sql; this.values = []; }
  bind(...values) { this.values = values; return this; }
  async all() { return { results: this.database.prepare(this.sql).all(...this.values).map((row) => ({ ...row })) }; }
  async first() { const row = this.database.prepare(this.sql).get(...this.values); return row ? { ...row } : null; }
}
class D1 { constructor(database) { this.database = database; } prepare(sql) { return new Statement(this.database, sql); } }

function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE manufacturers(id INTEGER PRIMARY KEY,name TEXT);
    CREATE TABLE vendors(id INTEGER PRIMARY KEY,business_name TEXT,latitude TEXT,longitude TEXT);
    CREATE TABLE products(id INTEGER PRIMARY KEY,name TEXT,manufacturer TEXT,manufacturer_id INTEGER);
    CREATE TABLE pharmacy_inventory(id INTEGER PRIMARY KEY,vendor_id INTEGER,branch_id INTEGER,product_id INTEGER,expiry_date TEXT,
      purchase_price_paise INTEGER,sale_price_paise INTEGER,quantity INTEGER,reserved_quantity INTEGER,
      reorder_level INTEGER,quarantine_status TEXT,cold_chain_status TEXT,active INTEGER);
    CREATE TABLE inventory_price_history(id INTEGER PRIMARY KEY,inventory_id INTEGER,vendor_id INTEGER,product_id INTEGER,
      purchase_price_paise INTEGER,sale_price_paise INTEGER,mrp_paise INTEGER,gst_percent INTEGER,
      effective_from TEXT,effective_until TEXT);
    CREATE TABLE orders(id INTEGER PRIMARY KEY,order_number TEXT,vendor_id INTEGER,branch_id INTEGER,order_status TEXT,
      delivery_method TEXT,delivery_status TEXT,payment_method TEXT,payment_status TEXT,delivery_fee_paise INTEGER,
      total_paise INTEGER,created_at TEXT,latitude TEXT,longitude TEXT);
    CREATE TABLE order_items(id INTEGER PRIMARY KEY,order_id INTEGER,product_id INTEGER,inventory_id INTEGER,
      quantity INTEGER,line_total_paise INTEGER);
    CREATE TABLE tax_invoices(id INTEGER PRIMARY KEY,source_type TEXT,source_id INTEGER,issued_at TEXT);
    CREATE TABLE offline_sales(id INTEGER PRIMARY KEY,vendor_id INTEGER,branch_id INTEGER);
    CREATE TABLE offline_sale_events(id INTEGER PRIMARY KEY,offline_sale_id INTEGER,event_type TEXT,created_at TEXT);
    CREATE TABLE offline_sale_items(id INTEGER PRIMARY KEY,offline_sale_id INTEGER,inventory_id INTEGER,product_id INTEGER,
      quantity INTEGER,line_total_paise INTEGER);
    CREATE TABLE sales_returns(id INTEGER PRIMARY KEY,vendor_id INTEGER,source_type TEXT,status TEXT,created_at TEXT);
    CREATE TABLE sales_return_items(id INTEGER PRIMARY KEY,sales_return_id INTEGER,inventory_id INTEGER,quantity INTEGER,amount_paise INTEGER);
    CREATE TABLE expenses(id INTEGER PRIMARY KEY,vendor_id INTEGER,expense_date TEXT,expense_head TEXT,purpose TEXT,payment_mode TEXT,amount_paise INTEGER);
    CREATE TABLE vendor_public_locations(vendor_id INTEGER,publication_status TEXT,latitude TEXT,longitude TEXT);
    CREATE TABLE account_profiles(id INTEGER PRIMARY KEY,name TEXT);
    CREATE TABLE delivery_agents(id INTEGER PRIMARY KEY,profile_id INTEGER);
    CREATE TABLE delivery_assignments(id INTEGER PRIMARY KEY,order_id INTEGER,agent_id INTEGER,status TEXT,assigned_at TEXT,picked_up_at TEXT,delivered_at TEXT);
    CREATE TABLE delivery_events(id INTEGER PRIMARY KEY,order_id INTEGER,status TEXT,created_at TEXT);
    INSERT INTO manufacturers VALUES(1,'Safe Pharma');
    INSERT INTO vendors VALUES(1,'Central Pharmacy','17.4300','78.4000'),(2,'Other Pharmacy','','');
    INSERT INTO products VALUES(10,'Example Tablet','Legacy Safe',1),(11,'Second Medicine','Other Maker',NULL);
    INSERT INTO pharmacy_inventory VALUES
      (100,1,1,10,'2027-01-01',500,900,10,3,4,'available','not_applicable',1),
      (101,2,2,10,'2025-01-01',500,900,2,0,4,'available','not_applicable',1),
      (102,1,1,11,'2027-02-01',300,500,4,0,2,'quality_hold','not_applicable',1);
    INSERT INTO inventory_price_history VALUES
      (1,100,1,10,500,900,1000,5,'2026-01-01',NULL),
      (2,101,2,10,500,900,1000,5,'2026-01-01',NULL),
      (3,102,1,11,300,500,600,5,'2026-01-01',NULL);
    INSERT INTO orders VALUES
      (200,'ORD-200',1,1,'completed','urmed','delivered','cod','paid',500,2600,'2026-08-01T10:00:00Z','17.4400','78.4100'),
      (201,'ORD-201',1,1,'cancelled','pharmacy','cancelled','online','failed',0,900,'2026-08-02T10:00:00Z','17.4500','78.4200');
    INSERT INTO order_items VALUES(1,200,10,100,2,2100),(2,201,10,100,1,900);
    INSERT INTO tax_invoices VALUES(1,'online_order',200,'2026-08-01T12:00:00Z');
    INSERT INTO offline_sales VALUES(300,1,1);
    INSERT INTO offline_sale_events VALUES(1,300,'completed','2026-08-03T12:00:00Z');
    INSERT INTO offline_sale_items VALUES(1,300,100,10,1,945);
    INSERT INTO sales_returns VALUES(400,1,'online','completed','2026-08-04T12:00:00Z');
    INSERT INTO sales_return_items VALUES(1,400,100,1,1050);
    INSERT INTO expenses VALUES
      (500,1,'2026-08-02','Utilities','Electricity','Bank transfer',3000),
      (501,NULL,'2026-08-03','Hosting','Platform hosting','Card',2000);
    INSERT INTO vendor_public_locations VALUES(1,'published','17.4300','78.4000');
    INSERT INTO account_profiles VALUES(1,'Assigned Rider');
    INSERT INTO delivery_agents VALUES(1,1);
    INSERT INTO delivery_assignments VALUES(1,200,1,'delivered','2026-08-01T10:10:00Z','2026-08-01T10:30:00Z','2026-08-01T11:30:00Z');
  `);
  return { sqlite, d1: new D1(sqlite) };
}

test("report parsers bound dates and CSV neutralizes spreadsheet formula injection", () => {
  assert.deepEqual(parseReportDateRange(new URLSearchParams("dateFrom=2026-01-01&dateTo=2026-01-31"), new Date("2026-08-13")), {
    dateFrom: "2026-01-01", dateTo: "2026-01-31", days: 31,
  });
  assert.throws(() => parseReportDateRange(new URLSearchParams("dateFrom=2025-01-01&dateTo=2026-08-13"), new Date("2026-08-13")), AdminReportError);
  assert.match(reportCsv(["Name"], [["=HYPERLINK(\"bad\")"]]), /'=HYPERLINK/);
  assert.equal(wantsCsv(new URL("https://urmed.test/api?format=xlsx")), false);
  assert.throws(() => wantsCsv(new URL("https://urmed.test/api?format=invalid")), AdminReportError);
});

test("stock report groups governed inventory and distinguishes physical, reserved, available, quarantine, and expiry", async (t) => {
  const { sqlite, d1 } = fixture(); t.after(() => sqlite.close());
  const report = await loadAdminStockReport(d1, new URL("https://urmed.test/api?groupBy=medicine&page=1&pageSize=5&sort=medicine"));
  const tablet = report.rows.find((row) => row.medicineId === 10);
  assert.deepEqual({ physical: tablet.physicalQuantity, reserved: tablet.reservedQuantity, available: tablet.availableQuantity, expired: tablet.expiredQuantity }, {
    physical: 12, reserved: 3, available: 7, expired: 2,
  });
  assert.equal(report.summary.physicalQuantity, 16);
  const manufacturer = await loadAdminStockReport(d1, new URL("https://urmed.test/api?groupBy=manufacturer&stockState=quarantined"));
  assert.deepEqual(manufacturer.rows.map((row) => row.manufacturerName), ["Other Maker"]);
  await assert.rejects(loadAdminStockReport(d1, new URL("https://urmed.test/api?sort=DROP%20TABLE")), AdminReportError);
});

test("sales report recognizes only completed sale evidence and subtracts completed item-level returns", async (t) => {
  const { sqlite, d1 } = fixture(); t.after(() => sqlite.close());
  const report = await loadAdminSalesReport(d1, new URL("https://urmed.test/api?dateFrom=2026-08-01&dateTo=2026-08-31&groupBy=medicine&pageSize=10"));
  assert.equal(report.summary.transactions, 2, "cancelled online order is excluded");
  assert.equal(report.summary.returnTransactions, 1);
  assert.equal(report.summary.grossSalesPaise, 3045);
  assert.equal(report.summary.returnedPaise, 1050);
  assert.equal(report.summary.netSalesPaise, 1995);
  assert.equal(report.summary.soldQuantity, 3);
  assert.equal(report.summary.returnedQuantity, 1);
});

test("expense report filters store/platform scope and groups without claiming financial statements", async (t) => {
  const { sqlite, d1 } = fixture(); t.after(() => sqlite.close());
  const store = await loadAdminExpenseReport(d1, new URL("https://urmed.test/api?dateFrom=2026-08-01&dateTo=2026-08-31&groupBy=store&scope=store"));
  assert.equal(store.rows[0].businessName, "Central Pharmacy");
  assert.equal(store.summary.amountPaise, 3000);
  const platform = await loadAdminExpenseReport(d1, new URL("https://urmed.test/api?dateFrom=2026-08-01&dateTo=2026-08-31&groupBy=head&scope=platform&payment=card"));
  assert.equal(platform.rows[0].expenseHead, "Hosting");
  assert.equal(platform.summary.amountPaise, 2000);
});

test("synchronous exports contain the complete filtered result, not the requested JSON page", async (t) => {
  const { sqlite, d1 } = fixture(); t.after(() => sqlite.close());
  const stock = await loadAdminStockReport(d1, new URL("https://urmed.test/api?groupBy=medicine&format=csv&page=99&pageSize=5"));
  assert.equal(stock.pagination.page, 1);
  assert.equal(stock.rows.length, stock.pagination.total);
  const sales = await loadAdminSalesReport(d1, new URL("https://urmed.test/api?dateFrom=2026-08-01&dateTo=2026-08-31&groupBy=medicine&format=xlsx&page=99&pageSize=5"));
  assert.equal(sales.pagination.page, 1);
  assert.equal(sales.rows.length, sales.pagination.total);
  const expenses = await loadAdminExpenseReport(d1, new URL("https://urmed.test/api?dateFrom=2026-08-01&dateTo=2026-08-31&groupBy=entry&format=pdf&page=99&pageSize=5"));
  assert.equal(expenses.pagination.page, 1);
  assert.equal(expenses.rows.length, expenses.pagination.total);
  const delivery = await loadAdminDeliveryReport(d1, new URL("https://urmed.test/api?dateFrom=2026-08-01&dateTo=2026-08-31&format=csv&page=99&pageSize=5"));
  assert.equal(delivery.pagination.page, 1);
  assert.equal(delivery.rows.length, delivery.pagination.total);
});

test("home-delivery report returns operational metrics without coordinates or customer PII", async (t) => {
  const { sqlite, d1 } = fixture(); t.after(() => sqlite.close());
  const report = await loadAdminDeliveryReport(d1, new URL("https://urmed.test/api?dateFrom=2026-08-01&dateTo=2026-08-31&method=urmed&slaTargetMinutes=120"), new Date("2026-08-13T00:00:00Z"));
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].riderName, "Assigned Rider");
  assert.equal(report.rows[0].slaStatus, "met");
  assert.equal(report.rows[0].elapsedMinutes, 90);
  assert.equal(typeof report.rows[0].estimatedDistanceKm, "number");
  assert.equal("originLatitude" in report.rows[0], false);
  assert.equal("destinationLatitude" in report.rows[0], false);
  assert.equal("customerName" in report.rows[0], false);
  assert.equal("deliveryAddress" in report.rows[0], false);
  const unavailable = calculateDeliveryReportRow({
    orderId: 1, orderNumber: "O", vendorId: 1, branchId: 1, businessName: "S", deliveryMethod: "pharmacy",
    deliveryStatus: "out_for_delivery", paymentMethod: "online", paymentStatus: "paid", deliveryFeePaise: 0,
    orderTotalPaise: 100, createdAt: "2026-08-01T10:00:00Z", riderName: "", assignmentStatus: "",
    assignedAt: null, pickedUpAt: null, deliveredAt: null, originLatitude: "", originLongitude: "",
    destinationLatitude: "", destinationLongitude: "",
  }, 120, new Date("2026-08-01T11:00:00Z"));
  assert.equal(unavailable.estimatedDistanceKm, null);
  assert.equal(unavailable.slaStatus, "pending");
});

test("every dedicated report API is admin-only, private, bounded, and UI uses authenticated requests", () => {
  for (const name of ["stock", "sales", "expenses", "home-delivery"]) {
    const source = readFileSync(new URL(`../app/api/admin/reports/${name}/route.ts`, import.meta.url), "utf8");
    assert.equal(source.match(/requireAdminProfile\(request\)/g)?.length, 1);
    assert.match(source, /"Cache-Control": "private, no-store"/);
    assert.doesNotMatch(source, /customerName|customerPhone|deliveryAddress|latitude AS|longitude AS/);
  }
  const domain = readFileSync(new URL("../lib/admin-reporting.ts", import.meta.url), "utf8");
  assert.match(domain, /pageSize.*100/);
  assert.match(domain, /maximumDays = 366/);
  assert.doesNotMatch(domain, /balance sheet/i);
  const component = readFileSync(new URL("../app/admin-operational-reports.tsx", import.meta.url), "utf8");
  assert.match(component, /authenticatedFetch\(`\/api\/admin\/reports\/\$\{report\}/);
  assert.match(component, /does not represent a balance sheet/i);
  for (const deliveryFilter of ["rider", "sla", "minDistanceKm", "maxDistanceKm", "minFeePaise", "maxFeePaise"]) {
    assert.match(component, new RegExp(`next\\.set\\(\"${deliveryFilter}\"`), `delivery UI must submit ${deliveryFilter}`);
  }
});
