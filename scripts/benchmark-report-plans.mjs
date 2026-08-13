import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";

const database = new DatabaseSync(":memory:");
database.exec("CREATE TABLE ledger_entries(id INTEGER PRIMARY KEY, vendor_id INTEGER, account_code TEXT, entry_date TEXT, debit_paise INTEGER, credit_paise INTEGER); CREATE INDEX ledger_entries_vendor_date_idx ON ledger_entries(vendor_id,entry_date); CREATE TABLE orders(id INTEGER PRIMARY KEY, vendor_id INTEGER, created_at TEXT, order_status TEXT); CREATE INDEX orders_vendor_date_idx ON orders(vendor_id,created_at);");
const insertLedger = database.prepare("INSERT INTO ledger_entries(vendor_id,account_code,entry_date,debit_paise,credit_paise) VALUES(7,'BANK_CLEARING','2026-01-15',100,0)");
const insertOrder = database.prepare("INSERT INTO orders(vendor_id,created_at,order_status) VALUES(7,'2026-01-15','completed')");
const scale = {};
for (const size of [10_000, 100_000, 1_000_000]) {
  const started = performance.now();
  database.exec("BEGIN");
  for (let index = 0; index < size; index += 1) { insertLedger.run(); insertOrder.run(); }
  database.exec("COMMIT");
  const ledgerStarted = performance.now();
  database.prepare("SELECT account_code,SUM(debit_paise-credit_paise) FROM ledger_entries WHERE vendor_id=? AND date(entry_date) BETWEEN date(?) AND date(?) GROUP BY account_code").all(7, "2026-01-01", "2026-12-31");
  const orderStarted = performance.now();
  database.prepare("SELECT date(created_at),COUNT(*) FROM orders WHERE vendor_id=? AND date(created_at) BETWEEN date(?) AND date(?) AND order_status='completed' GROUP BY date(created_at)").all(7, "2026-01-01", "2026-12-31");
  scale[size] = { loadMs: Math.round(performance.now() - started), ledgerMs: Math.round(orderStarted - ledgerStarted), orderMs: Math.round(performance.now() - orderStarted) };
}
const plans = {
  ledger: database.prepare("EXPLAIN QUERY PLAN SELECT account_code,SUM(debit_paise-credit_paise) FROM ledger_entries WHERE vendor_id=? AND date(entry_date) BETWEEN date(?) AND date(?) GROUP BY account_code").all(7, "2026-01-01", "2026-12-31"),
  orders: database.prepare("EXPLAIN QUERY PLAN SELECT date(created_at),COUNT(*) FROM orders WHERE vendor_id=? AND date(created_at) BETWEEN date(?) AND date(?) AND order_status='completed' GROUP BY date(created_at)").all(7, "2026-01-01", "2026-12-31"),
};
const result = { generatedAt: new Date().toISOString(), note: "Synthetic local SQLite benchmark; production conclusions require anonymized D1 snapshots and Cloudflare D1 measurements.", scale, plans };
writeFileSync("/tmp/urmed-report-query-plans.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
database.close();
