import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { BankAccountReviewError, reviewVendorBankAccount } from "../lib/bank-account-review.ts";

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
  constructor(sqlite) { this.sqlite = sqlite; this.beforeNextBatch = null; }
  prepare(sql) { return new Statement(this, sql); }
  async batch(statements) {
    if (this.beforeNextBatch) { const callback = this.beforeNextBatch; this.beforeNextBatch = null; callback(); }
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
    CREATE TABLE vendor_bank_accounts (
      id INTEGER PRIMARY KEY,vendor_id INTEGER NOT NULL,bank_name TEXT NOT NULL,account_name TEXT NOT NULL,
      account_number_encrypted TEXT NOT NULL,account_last4 TEXT NOT NULL,ifsc_code TEXT NOT NULL,
      verification_status TEXT NOT NULL,active INTEGER NOT NULL,updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
    CREATE TABLE audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,vendor_id INTEGER,actor_profile_id INTEGER,
      action TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,
      before_json TEXT NOT NULL,after_json TEXT NOT NULL,reason TEXT NOT NULL,request_id TEXT NOT NULL,
      previous_event_hash TEXT NOT NULL,event_hash TEXT NOT NULL,created_at TEXT NOT NULL
    );
    INSERT INTO vendor_bank_accounts VALUES
      (10,7,'Safe Bank','URMED Pharmacy','encrypted-secret-never-returned','4321','SAFE0001234','pending',1,CURRENT_TIMESTAMP),
      (11,7,'Old Bank','URMED Pharmacy','old-encrypted-secret','9999','OLDB0001234','pending',0,CURRENT_TIMESTAMP);
  `);
  t.after(() => sqlite.close());
  return { sqlite, db: new Database(sqlite) };
}

test("active bank review is guarded, idempotent, and atomically audited without full account data", async (t) => {
  const { sqlite, db } = fixture(t);
  const result = await reviewVendorBankAccount({ db, id: 10, decision: "verified", reason: "Name and IFSC checked", actorProfileId: 1, requestId: "bank-review" });
  assert.deepEqual(result, { vendorId: 7, duplicate: false });
  assert.equal(sqlite.prepare("SELECT verification_status FROM vendor_bank_accounts WHERE id=10").get().verification_status, "verified");
  const audit = sqlite.prepare("SELECT action,after_json AS afterJson FROM audit_events").get();
  assert.equal(audit.action, "admin.vendor_bank_account.verified");
  assert.match(audit.afterJson, /4321/);
  assert.doesNotMatch(audit.afterJson, /encrypted-secret/);
  assert.equal((await reviewVendorBankAccount({ db, id: 10, decision: "verified", reason: "retry", actorProfileId: 1 })).duplicate, true);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events").get().count, 1);
});

test("inactive, opposing, concurrent, and audit-failing bank decisions leave no false state", async (t) => {
  const { sqlite, db } = fixture(t);
  await assert.rejects(reviewVendorBankAccount({ db, id: 11, decision: "verified", reason: "stale", actorProfileId: 1 }),
    (error) => error instanceof BankAccountReviewError && error.status === 404);
  db.beforeNextBatch = () => sqlite.prepare("UPDATE vendor_bank_accounts SET verification_status='verified' WHERE id=10").run();
  await assert.rejects(reviewVendorBankAccount({ db, id: 10, decision: "rejected", reason: "conflicting decision", actorProfileId: 2 }), /changed during review/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events").get().count, 0);

  sqlite.prepare("UPDATE vendor_bank_accounts SET verification_status='pending' WHERE id=10").run();
  sqlite.exec("CREATE TRIGGER fail_bank_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'forced_bank_audit_failure'); END;");
  await assert.rejects(reviewVendorBankAccount({ db, id: 10, decision: "rejected", reason: "Invalid beneficiary", actorProfileId: 2 }), /forced_bank_audit_failure/);
  assert.equal(sqlite.prepare("SELECT verification_status FROM vendor_bank_accounts WHERE id=10").get().verification_status, "pending");
});

test("admin bank review returns only masked details and uses shared authorization", async () => {
  const [route, component] = await Promise.all([
    readFile(new URL("../app/api/admin/vendor-compliance/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/vendor-compliance.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(route, /requireAdminProfile\(request\)/);
  assert.match(route, /reviewVendorBankAccount/);
  assert.match(route, /account_last4 AS accountLast4/);
  assert.doesNotMatch(route, /account_number_encrypted AS/);
  assert.match(component, /Encrypted account numbers are never returned/);
  assert.match(component, /bank_account/);
});
