import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { listOperationalMonitoring, recordOperationalEvent, recordScheduledJobEvent, sanitizeOperationalDetail, updateOperationalAlert } from "../lib/operational-monitoring.ts";

class Statement {
  constructor(owner, sql) { this.owner = owner; this.sql = sql; this.values = []; }
  bind(...values) { this.values = values; return this; }
  async first() { return this.owner.sqlite.prepare(this.sql).get(...this.values) ?? null; }
  async all() { return { results: this.owner.sqlite.prepare(this.sql).all(...this.values) }; }
  async run() { const result = this.owner.sqlite.prepare(this.sql).run(...this.values); return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } }; }
}
class Db { constructor(sqlite) { this.sqlite = sqlite; } prepare(sql) { return new Statement(this, sql); } }

function fixture(t) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE operational_events (id INTEGER PRIMARY KEY AUTOINCREMENT,event_key TEXT UNIQUE NOT NULL,category TEXT NOT NULL,severity TEXT NOT NULL,status TEXT NOT NULL,provider TEXT NOT NULL,vendor_id INTEGER,profile_id INTEGER,reference_type TEXT NOT NULL,reference_id TEXT NOT NULL,error_code TEXT NOT NULL,attempt_count INTEGER NOT NULL,retryable INTEGER NOT NULL,request_id TEXT NOT NULL,detail_json TEXT NOT NULL,occurred_at TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE operational_alerts (id INTEGER PRIMARY KEY AUTOINCREMENT,fingerprint TEXT UNIQUE NOT NULL,category TEXT NOT NULL,severity TEXT NOT NULL,status TEXT NOT NULL,provider TEXT NOT NULL,vendor_id INTEGER,occurrence_count INTEGER NOT NULL,first_seen TEXT NOT NULL,last_seen TEXT NOT NULL,sample_event_id INTEGER,last_error_code TEXT NOT NULL,version INTEGER NOT NULL,resolved_at TEXT,resolution_reason TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TRIGGER operational_events_immutable_update BEFORE UPDATE ON operational_events BEGIN SELECT RAISE(ABORT, 'operational_event_immutable'); END;
  `);
  t.after(() => sqlite.close()); return { sqlite, db: new Db(sqlite) };
}

test("operational detail redacts credentials, PII and payloads", () => {
  const value = sanitizeOperationalDetail({ password: "x", accessToken: "y", address: "secret", latitude: 17.3, nested: { providerMessage: "safe" }, count: 2 });
  assert.deepEqual(value, { password: "[redacted]", accessToken: "[redacted]", address: "[redacted]", latitude: "[redacted]", nested: { providerMessage: "safe" }, count: 2 });
});

test("events are immutable, deduplicated and bounded into an alert", async (t) => {
  const { db, sqlite } = fixture(t);
  const base = { db, category: "payment", severity: "error", provider: "razorpay", errorCode: "provider_timeout", vendorId: 7, referenceType: "payment", referenceId: 11, detail: { token: "never-store", amount: 100 }, occurredAt: "2026-08-14T00:00:00.000Z" };
  assert.equal((await recordOperationalEvent({ ...base, eventKey: "payment:1" })).inserted, true);
  assert.equal((await recordOperationalEvent({ ...base, eventKey: "payment:1" })).inserted, false);
  assert.equal((await recordOperationalEvent({ ...base, eventKey: "payment:2", severity: "critical" })).inserted, true);
  const alert = sqlite.prepare("SELECT occurrence_count AS count,severity FROM operational_alerts").get();
  assert.equal(alert.count, 2); assert.equal(alert.severity, "critical");
  const stored = sqlite.prepare("SELECT detail_json FROM operational_events").get().detail_json;
  assert.doesNotMatch(stored, /never-store|100/);
  assert.throws(() => sqlite.prepare("UPDATE operational_events SET detail_json='{}' WHERE id=1").run(), /immutable/);
});

test("scheduled event keys make repeated runs idempotent and alert status is optimistic", async (t) => {
  const { db, sqlite } = fixture(t);
  await recordScheduledJobEvent({ db, cron: "*/5 * * * *", scheduledTime: 123, ok: false, errorCode: "job_failed" });
  await recordScheduledJobEvent({ db, cron: "*/5 * * * *", scheduledTime: 123, ok: false, errorCode: "job_failed" });
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM operational_events").get().count, 1);
  const alert = sqlite.prepare("SELECT id,version FROM operational_alerts").get();
  const listed = await listOperationalMonitoring(db, { status: "all" });
  assert.equal(listed.scheduledHealth[0].cron, "*/5 * * * *");
  assert.equal(listed.scheduledHealth[0].lastFailure !== null, true);
  const resolved = await updateOperationalAlert({ db, id: alert.id, action: "resolve", version: alert.version, reason: "recovered", actorProfileId: 1 });
  assert.equal(resolved.status, "resolved");
  await assert.rejects(updateOperationalAlert({ db, id: alert.id, action: "reopen", version: alert.version, actorProfileId: 1 }), /changed/);
});

test("monitoring list is bounded and filterable without exposing detail payloads", async (t) => {
  const { db } = fixture(t);
  await recordOperationalEvent({ db, eventKey: "auth:1", category: "auth", severity: "warning", errorCode: "invalid_session", detail: { email: "person@example.test" } });
  const listed = await listOperationalMonitoring(db, { category: "auth", pageSize: 1 });
  assert.equal(listed.alerts.length, 1); assert.equal(listed.events.length, 1); assert.equal("detailJson" in listed.events[0], false);
});
