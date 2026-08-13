import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ComplianceReviewError, reviewVendorCompliance } from "../lib/vendor-compliance-review.ts";

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
    CREATE TABLE vendors (
      id INTEGER PRIMARY KEY,compliance_status TEXT NOT NULL,approval_status TEXT NOT NULL,
      suspension_reason TEXT NOT NULL,suspended_at TEXT,updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
    CREATE TABLE vendor_licences (
      id INTEGER PRIMARY KEY,vendor_id INTEGER NOT NULL,verification_status TEXT NOT NULL,
      valid_from TEXT NOT NULL,valid_until TEXT NOT NULL,suspended_at TEXT,updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
    CREATE TABLE pharmacists (
      id INTEGER PRIMARY KEY,vendor_id INTEGER NOT NULL,verification_status TEXT NOT NULL,
      valid_from TEXT,valid_until TEXT,active INTEGER NOT NULL
    );
    CREATE TABLE audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,vendor_id INTEGER,actor_profile_id INTEGER,
      action TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,
      before_json TEXT NOT NULL,after_json TEXT NOT NULL,reason TEXT NOT NULL,request_id TEXT NOT NULL,
      previous_event_hash TEXT NOT NULL,event_hash TEXT NOT NULL,created_at TEXT NOT NULL
    );
    INSERT INTO vendors VALUES (10,'pending','testing','',NULL,CURRENT_TIMESTAMP);
    INSERT INTO vendor_licences VALUES (100,10,'pending',date('now','-1 day'),date('now','+1 year'),NULL,CURRENT_TIMESTAMP);
    INSERT INTO pharmacists VALUES (200,10,'pending',date('now','-1 day'),date('now','+1 year'),1);
  `);
  t.after(() => sqlite.close());
  return { sqlite, db: new Database(sqlite) };
}

test("guarded compliance decisions update aggregate readiness and append one audit each", async (t) => {
  const { sqlite, db } = fixture(t);
  const licence = await reviewVendorCompliance({
    db, entity: "licence", id: 100, decision: "verified", reason: "Checked licence",
    actorProfileId: 1, requestId: "review-licence",
  });
  assert.equal(licence.duplicate, false);
  assert.deepEqual({ ...sqlite.prepare("SELECT compliance_status AS complianceStatus,approval_status AS approvalStatus FROM vendors WHERE id=10").get() }, {
    complianceStatus: "pending", approvalStatus: "testing",
  });
  const pharmacist = await reviewVendorCompliance({
    db, entity: "pharmacist", id: 200, decision: "verified", reason: "Checked registration",
    actorProfileId: 1, requestId: "review-pharmacist",
  });
  assert.equal(pharmacist.duplicate, false);
  assert.deepEqual({ ...sqlite.prepare("SELECT compliance_status AS complianceStatus,approval_status AS approvalStatus FROM vendors WHERE id=10").get() }, {
    complianceStatus: "verified", approvalStatus: "approved",
  });
  assert.deepEqual(sqlite.prepare("SELECT action FROM audit_events ORDER BY id").all().map((row) => row.action), [
    "admin.licence.verified", "admin.pharmacist.verified",
  ]);
  assert.equal((await reviewVendorCompliance({
    db, entity: "pharmacist", id: 200, decision: "verified", reason: "Same decision retry",
    actorProfileId: 1,
  })).duplicate, true);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events").get().count, 2);
});

test("opposing and concurrent compliance reviews cannot overwrite a completed decision", async (t) => {
  const { sqlite, db } = fixture(t);
  db.beforeNextBatch = () => sqlite.prepare("UPDATE vendor_licences SET verification_status='verified' WHERE id=100").run();
  await assert.rejects(reviewVendorCompliance({
    db, entity: "licence", id: 100, decision: "rejected", reason: "Conflicting rejection",
    actorProfileId: 2,
  }), (error) => error instanceof ComplianceReviewError && /changed during review/.test(error.message));
  assert.equal(sqlite.prepare("SELECT verification_status FROM vendor_licences WHERE id=100").get().verification_status, "verified");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events").get().count, 0);
  await assert.rejects(reviewVendorCompliance({
    db, entity: "licence", id: 100, decision: "rejected", reason: "Late rejection attempt",
    actorProfileId: 2,
  }), /already reviewed/);
});

test("audit failure rolls back both the record decision and vendor aggregate", async (t) => {
  const { sqlite, db } = fixture(t);
  sqlite.exec(`CREATE TRIGGER reject_compliance_audit BEFORE INSERT ON audit_events
    BEGIN SELECT RAISE(ABORT,'forced_audit_failure'); END;`);
  await assert.rejects(reviewVendorCompliance({
    db, entity: "licence", id: 100, decision: "verified", reason: "Checked licence",
    actorProfileId: 1,
  }), /forced_audit_failure/);
  assert.equal(sqlite.prepare("SELECT verification_status FROM vendor_licences WHERE id=100").get().verification_status, "pending");
  assert.deepEqual({ ...sqlite.prepare("SELECT compliance_status AS complianceStatus,approval_status AS approvalStatus FROM vendors WHERE id=10").get() }, {
    complianceStatus: "pending", approvalStatus: "testing",
  });
});

test("a compliance review never clears an independent vendor suspension", async (t) => {
  const { sqlite, db } = fixture(t);
  sqlite.prepare("UPDATE vendors SET suspended_at=CURRENT_TIMESTAMP,suspension_reason='Fraud review' WHERE id=10").run();
  await reviewVendorCompliance({
    db, entity: "licence", id: 100, decision: "verified", reason: "Checked licence",
    actorProfileId: 1,
  });
  const vendor = sqlite.prepare("SELECT suspended_at AS suspendedAt,suspension_reason AS suspensionReason FROM vendors WHERE id=10").get();
  assert.ok(vendor.suspendedAt);
  assert.equal(vendor.suspensionReason, "Fraud review");
});

test("admin compliance route delegates to the guarded atomic review service", async () => {
  const { readFile } = await import("node:fs/promises");
  const route = await readFile(new URL("../app/api/admin/vendor-compliance/route.ts", import.meta.url), "utf8");
  assert.match(route, /reviewVendorCompliance/);
  assert.match(route, /l\.suspended_at IS NULL/);
  assert.match(route, /date\(l\.valid_from\) <= date\('now'\)/);
  assert.doesNotMatch(route, /UPDATE \$\{table\} SET verification_status/);
});
