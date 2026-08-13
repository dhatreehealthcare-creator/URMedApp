import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";

const database = new DatabaseSync(":memory:");
database.exec("CREATE TABLE ledger_entries(id INTEGER PRIMARY KEY, vendor_id INTEGER, account_code TEXT, entry_date TEXT, debit_paise INTEGER, credit_paise INTEGER); CREATE INDEX ledger_entries_vendor_date_idx ON ledger_entries(vendor_id,entry_date); CREATE TABLE orders(id INTEGER PRIMARY KEY, vendor_id INTEGER, created_at TEXT, order_status TEXT); CREATE INDEX orders_vendor_date_idx ON orders(vendor_id,created_at);");
const plans = {
  ledger: database.prepare("EXPLAIN QUERY PLAN SELECT account_code,SUM(debit_paise-credit_paise) FROM ledger_entries WHERE vendor_id=? AND date(entry_date) BETWEEN date(?) AND date(?) GROUP BY account_code").all(7, "2026-01-01", "2026-12-31"),
  orders: database.prepare("EXPLAIN QUERY PLAN SELECT date(created_at),COUNT(*) FROM orders WHERE vendor_id=? AND date(created_at) BETWEEN date(?) AND date(?) AND order_status='completed' GROUP BY date(created_at)").all(7, "2026-01-01", "2026-12-31"),
};
const result = { generatedAt: new Date().toISOString(), note: "Local SQLite plan smoke test; production-scale timings require anonymized D1 snapshots.", plans };
writeFileSync("/tmp/urmed-report-query-plans.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
database.close();
