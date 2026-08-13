import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { postAdminExpense } from "../lib/admin-expense.ts";

class Statement {
  constructor(owner, sql) { this.owner = owner; this.sql = sql; this.values = []; }
  bind(...values) { this.values = values; return this; }
  async first() { return this.owner.sqlite.prepare(this.sql).get(...this.values) ?? null; }
  async run() {
    const result = this.owner.sqlite.prepare(this.sql).run(...this.values);
    return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }
}

class Database {
  constructor(sqlite) { this.sqlite = sqlite; }
  prepare(sql) { return new Statement(this, sql); }
  async batch(statements) {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

function fixture(t) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE expenses (
      id INTEGER PRIMARY KEY,vendor_id INTEGER,purpose TEXT NOT NULL,expense_head TEXT NOT NULL,
      amount_paise INTEGER NOT NULL,expense_date TEXT NOT NULL,payment_mode TEXT NOT NULL,
      reference_number TEXT NOT NULL,created_by_profile_id INTEGER NOT NULL
    );
    CREATE TABLE ledger_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,vendor_id INTEGER,account_code TEXT NOT NULL,
      entry_date TEXT NOT NULL,description TEXT NOT NULL,debit_paise INTEGER NOT NULL,
      credit_paise INTEGER NOT NULL,reference_type TEXT NOT NULL,reference_id INTEGER NOT NULL,
      created_by_profile_id INTEGER NOT NULL
    );
    CREATE TABLE audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,vendor_id INTEGER,actor_profile_id INTEGER,
      action TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,
      before_json TEXT NOT NULL,after_json TEXT NOT NULL,reason TEXT NOT NULL,request_id TEXT NOT NULL,
      previous_event_hash TEXT NOT NULL,event_hash TEXT NOT NULL,created_at TEXT NOT NULL
    );
  `);
  t.after(() => sqlite.close());
  return { sqlite, db: new Database(sqlite) };
}

const input = (db) => ({
  db, vendorId: null, purpose: "Cloud hosting", expenseHead: "Infrastructure",
  amountPaise: 11_800, expenseDate: "2026-08-12", paymentMode: "Bank transfer",
  referenceNumber: "INV-2026-08", actorProfileId: 1, requestId: "expense-test",
});

test("admin expense, balanced ledger, and audit evidence commit in one batch", async (t) => {
  const { sqlite, db } = fixture(t);
  const result = await postAdminExpense(input(db));
  assert.equal(result.expenseId, 1);
  assert.deepEqual(sqlite.prepare(`SELECT account_code AS accountCode,debit_paise AS debitPaise,
    credit_paise AS creditPaise FROM ledger_entries ORDER BY id`).all().map((row) => ({ ...row })), [
    { accountCode: "EXPENSE", debitPaise: 11_800, creditPaise: 0 },
    { accountCode: "CASH_BANK", debitPaise: 0, creditPaise: 11_800 },
  ]);
  assert.deepEqual({ ...sqlite.prepare("SELECT action,entity_type AS entityType,entity_id AS entityId FROM audit_events").get() }, {
    action: "expense.created", entityType: "expense", entityId: "1",
  });
});

test("a ledger failure rolls back the expense and audit evidence", async (t) => {
  const { sqlite, db } = fixture(t);
  sqlite.exec(`CREATE TRIGGER reject_cash_ledger BEFORE INSERT ON ledger_entries
    WHEN NEW.account_code='CASH_BANK' BEGIN SELECT RAISE(ABORT,'forced_ledger_failure'); END;`);
  await assert.rejects(postAdminExpense(input(db)), /forced_ledger_failure/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM expenses").get().count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM ledger_entries").get().count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events").get().count, 0);
});

test("admin operations delegates expense posting to the atomic service", async () => {
  const { readFile } = await import("node:fs/promises");
  const route = await readFile(new URL("../app/api/admin/operations/route.ts", import.meta.url), "utf8");
  assert.match(route, /postAdminExpense\(\{db,vendorId,purpose,expenseHead,amountPaise/);
  assert.match(route, /"Cache-Control": "private, no-store"/);
  assert.doesNotMatch(route, /const result=await db\.prepare\(`INSERT INTO expenses/);
});
