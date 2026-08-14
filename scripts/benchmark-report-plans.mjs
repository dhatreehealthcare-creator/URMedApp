#!/usr/bin/env node

/* Reproducible local report benchmark. Synthetic SQLite evidence is not a
 * substitute for approved anonymized Cloudflare D1 measurements. */
import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const allowedSizes = [10_000, 100_000, 1_000_000];
const sizeArg = process.argv.includes("--sizes") ? process.argv[process.argv.indexOf("--sizes") + 1] : "";
const sizes = (sizeArg ? String(sizeArg).split(",").map(Number) : allowedSizes)
  .filter((size) => allowedSizes.includes(size));
if (!sizes.length) throw new Error("Use --sizes with one or more of 10000,100000,1000000");

const TENANT_ID = 2;
const RANGE_FROM = "2026-01-01T00:00:00";
const RANGE_TO = "2027-01-01T00:00:00";
const EXPORT_CAP = 5_000;
const DELIVERY_CANDIDATE_CAP = 100_001;

function timestamp(index) {
  const day = new Date(Date.UTC(2026, 0, 1));
  day.setUTCDate(day.getUTCDate() + (index % 365));
  return day.toISOString().slice(0, 19);
}

function createDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    PRAGMA journal_mode=MEMORY;
    PRAGMA synchronous=OFF;
    CREATE TABLE vendors(id INTEGER PRIMARY KEY,business_name TEXT NOT NULL);
    CREATE TABLE products(id INTEGER PRIMARY KEY,name TEXT NOT NULL,manufacturer TEXT NOT NULL);
    CREATE TABLE pharmacy_inventory(id INTEGER PRIMARY KEY,vendor_id INTEGER NOT NULL,product_id INTEGER NOT NULL,quantity INTEGER NOT NULL,reserved_quantity INTEGER NOT NULL,active INTEGER NOT NULL,expiry_date TEXT,reorder_level INTEGER NOT NULL,quarantine_status TEXT NOT NULL);
    CREATE TABLE orders(id INTEGER PRIMARY KEY,vendor_id INTEGER NOT NULL,created_at TEXT NOT NULL,order_status TEXT NOT NULL,delivery_method TEXT NOT NULL,total_paise INTEGER NOT NULL);
    CREATE TABLE order_items(id INTEGER PRIMARY KEY,order_id INTEGER NOT NULL,product_id INTEGER NOT NULL,quantity INTEGER NOT NULL,line_total_paise INTEGER NOT NULL);
    CREATE TABLE tax_invoices(id INTEGER PRIMARY KEY,source_type TEXT NOT NULL,source_id INTEGER NOT NULL,issued_at TEXT NOT NULL);
    CREATE TABLE expenses(id INTEGER PRIMARY KEY,vendor_id INTEGER,expense_date TEXT NOT NULL,expense_head TEXT NOT NULL,amount_paise INTEGER NOT NULL);
    CREATE TABLE delivery_assignments(id INTEGER PRIMARY KEY,order_id INTEGER NOT NULL,status TEXT NOT NULL,assigned_at TEXT NOT NULL);
    CREATE INDEX orders_vendor_date_idx ON orders(vendor_id,created_at);
    CREATE INDEX orders_delivery_date_vendor_idx ON orders(delivery_method,created_at,vendor_id);
    CREATE INDEX orders_vendor_delivery_date_idx ON orders(vendor_id,delivery_method,created_at,id);
    CREATE INDEX orders_status_date_vendor_idx ON orders(order_status,created_at,vendor_id);
    CREATE INDEX order_items_order_idx ON order_items(order_id,product_id);
    CREATE INDEX tax_invoices_source_date_idx ON tax_invoices(source_type,issued_at,source_id);
    CREATE INDEX expenses_vendor_date_idx ON expenses(vendor_id,expense_date);
    CREATE INDEX pharmacy_inventory_vendor_idx ON pharmacy_inventory(vendor_id,active,expiry_date);
    CREATE INDEX delivery_assignments_order_idx ON delivery_assignments(order_id,status);
  `);
  const vendor = db.prepare("INSERT INTO vendors(id,business_name) VALUES(?,?)");
  for (let id = 1; id <= 8; id += 1) vendor.run(id, `Benchmark Pharmacy ${id}`);
  const product = db.prepare("INSERT INTO products(id,name,manufacturer) VALUES(?,?,?)");
  for (let id = 1; id <= 1_000; id += 1) product.run(id, `Benchmark Medicine ${id}`, `Manufacturer ${id % 20}`);
  return db;
}

function loadRows(db, size) {
  const inventory = db.prepare("INSERT INTO pharmacy_inventory VALUES(?,?,?,?,?,?,?,?,?)");
  const order = db.prepare("INSERT INTO orders VALUES(?,?,?,?,?,?)");
  const item = db.prepare("INSERT INTO order_items VALUES(?,?,?,?,?)");
  const invoice = db.prepare("INSERT INTO tax_invoices VALUES(?,?,?,?)");
  const expense = db.prepare("INSERT INTO expenses VALUES(?,?,?,?,?)");
  const assignment = db.prepare("INSERT INTO delivery_assignments VALUES(?,?,?,?)");
  db.exec("BEGIN");
  for (let index = 1; index <= size; index += 1) {
    const vendorId = (index % 8) + 1;
    const productId = (index % 1_000) + 1;
    const createdAt = timestamp(index);
    inventory.run(index, vendorId, productId, 20 + (index % 30), index % 3, 1, createdAt, 10, "available");
    order.run(index, vendorId, createdAt, "completed", index % 2 ? "delivery" : "pickup", 1_000 + index);
    item.run(index, index, productId, 1 + (index % 4), 1_000 + index);
    invoice.run(index, "online_order", index, createdAt);
    expense.run(index, index % 10 ? vendorId : null, createdAt.slice(0, 10), `head-${index % 12}`, 100 + index);
    if (index % 2) assignment.run(index, index, index % 16 === 1 ? "assigned" : "delivered", createdAt);
  }
  db.exec("COMMIT");
}

function plan(db, sql, binds) {
  return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...binds).map((row) => String(row.detail ?? row[3] ?? ""));
}

function execute(db, sql, binds) {
  const started = performance.now();
  const rows = db.prepare(sql).all(...binds);
  return { elapsedMs: Number((performance.now() - started).toFixed(2)), rows: rows.length };
}

function benchmarkReport(db, name, sql, countSql, binds) {
  const page1 = execute(db, `${sql} LIMIT 100 OFFSET 0`, binds);
  const page100 = execute(db, `${sql} LIMIT 100 OFFSET 10000`, binds);
  const totalStarted = performance.now();
  const total = Number(db.prepare(countSql).get(...binds)?.total ?? 0);
  const details = plan(db, sql, binds);
  return {
    name, tenantId: TENANT_ID, page1, page100,
    total: { rows: total, elapsedMs: Number((performance.now() - totalStarted).toFixed(2)) },
    plan: details,
    risks: {
      fullScan: details.some((detail) => /\bSCAN\s+(?!.*USING INDEX)/i.test(detail)),
      temporaryBTree: details.some((detail) => /TEMP B-TREE/i.test(detail)),
      dateFunctionOnPredicate: /WHERE[\s\S]*\b(date|substr)\s*\(/i.test(sql.split(/GROUP BY/i)[0]),
      offsetDegradation: page100.elapsedMs > page1.elapsedMs * 2 && page100.rows > 0,
    },
  };
}

function benchmark(size) {
  const db = createDatabase();
  const loadStarted = performance.now();
  loadRows(db, size);
  const loadMs = Number((performance.now() - loadStarted).toFixed(2));
  const stockSql = `SELECT p.id,p.name,SUM(i.quantity) AS quantity,SUM(MAX(i.quantity-i.reserved_quantity,0)) AS available
    FROM pharmacy_inventory i JOIN products p ON p.id=i.product_id
    WHERE i.vendor_id=? AND i.active=1 GROUP BY p.id,p.name ORDER BY p.name`;
  const stockCount = `SELECT COUNT(*) AS total FROM (SELECT p.id FROM pharmacy_inventory i JOIN products p ON p.id=i.product_id WHERE i.vendor_id=? AND i.active=1 GROUP BY p.id)`;
  const salesSql = `SELECT date(o.created_at) AS activity_date,SUM(item.quantity) AS quantity,SUM(item.line_total_paise) AS gross
    FROM orders o JOIN order_items item ON item.order_id=o.id JOIN tax_invoices invoice ON invoice.source_type='online_order' AND invoice.source_id=o.id
    WHERE o.vendor_id=? AND o.created_at>=? AND o.created_at<? AND o.order_status='completed'
    GROUP BY date(o.created_at) ORDER BY activity_date`;
  const salesCount = `SELECT COUNT(*) AS total FROM (SELECT date(o.created_at) FROM orders o JOIN order_items item ON item.order_id=o.id JOIN tax_invoices invoice ON invoice.source_type='online_order' AND invoice.source_id=o.id WHERE o.vendor_id=? AND o.created_at>=? AND o.created_at<? AND o.order_status='completed' GROUP BY date(o.created_at))`;
  const expenseSql = `SELECT e.expense_date,e.expense_head,SUM(e.amount_paise) AS amount
    FROM expenses e WHERE e.vendor_id=? AND e.expense_date>=? AND e.expense_date<?
    GROUP BY e.expense_date,e.expense_head ORDER BY e.expense_date`;
  const expenseCount = `SELECT COUNT(*) AS total FROM (SELECT e.expense_date,e.expense_head FROM expenses e WHERE e.vendor_id=? AND e.expense_date>=? AND e.expense_date<? GROUP BY e.expense_date,e.expense_head)`;
  const deliverySql = `SELECT o.id,o.created_at,assignment.status,o.total_paise
    FROM orders o JOIN delivery_assignments assignment ON assignment.order_id=o.id
    WHERE o.vendor_id=? AND o.delivery_method='delivery' AND o.created_at>=? AND o.created_at<?
    ORDER BY o.created_at,o.id`;
  const deliveryCount = `SELECT COUNT(*) AS total FROM orders o JOIN delivery_assignments assignment ON assignment.order_id=o.id WHERE o.vendor_id=? AND o.delivery_method='delivery' AND o.created_at>=? AND o.created_at<?`;
  const deliveryPostFilterCount = `${deliveryCount} AND assignment.status='delivered'`;
  const dates = [TENANT_ID, RANGE_FROM, RANGE_TO];
  const reports = {
    stock: benchmarkReport(db, "stock", stockSql, stockCount, [TENANT_ID]),
    sales: benchmarkReport(db, "sales", salesSql, salesCount, dates),
    expenses: benchmarkReport(db, "expenses", expenseSql, expenseCount, dates),
    homeDelivery: benchmarkReport(db, "home_delivery", deliverySql, deliveryCount, dates),
  };
  const candidateRows = Number(db.prepare(deliveryCount).get(...dates)?.total ?? 0);
  const postFilterRows = Number(db.prepare(deliveryPostFilterCount).get(...dates)?.total ?? 0);
  reports.homeDelivery.candidateBound = {
    candidateRows, postFilterRows, cap: 100_001, overflow: candidateRows > DELIVERY_CANDIDATE_CAP,
    privacySafeColumns: true,
  };
  db.close();
  return { datasetRowsPerEntity: size, loadMs, exportCap: EXPORT_CAP, reports };
}

const result = {
  generatedAt: new Date().toISOString(),
  methodology: {
    engine: "SQLite node:sqlite in-memory", tenantId: TENANT_ID,
    dateRange: [RANGE_FROM, RANGE_TO], pages: [{ limit: 100, offset: 0 }, { limit: 100, offset: 10000 }],
    exportCap: EXPORT_CAP, deliveryCandidateCap: DELIVERY_CANDIDATE_CAP,
    disclaimer: "Synthetic local evidence; hosted D1 performance requires an approved anonymized snapshot and provider UAT.",
  },
  scales: Object.fromEntries(sizes.map((size) => [String(size), benchmark(size)])),
};
const output = process.env.URMED_REPORT_BENCHMARK_OUTPUT || join(process.cwd(), "scripts", "report-performance.latest.json");
writeFileSync(output, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
