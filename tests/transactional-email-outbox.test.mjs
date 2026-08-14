import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  enqueueTransactionalEmail,
  listTransactionalEmailOutbox,
  processTransactionalEmailOutbox,
  retryDeadLetterEmail,
} from "../lib/transactional-email-outbox.ts";

class Statement {
  constructor(owner, sql) { this.owner = owner; this.sql = sql; this.values = []; }
  bind(...values) { this.values = values; return this; }
  async first() { return this.owner.sqlite.prepare(this.sql).get(...this.values) ?? null; }
  async all() { return { results: this.owner.sqlite.prepare(this.sql).all(...this.values) }; }
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
    CREATE TABLE account_profiles (id INTEGER PRIMARY KEY,email TEXT NOT NULL,email_verified INTEGER NOT NULL,status TEXT NOT NULL);
    CREATE TABLE notification_preferences (profile_id INTEGER NOT NULL,category TEXT NOT NULL,in_app_enabled INTEGER NOT NULL,email_enabled INTEGER NOT NULL,time_zone TEXT NOT NULL,UNIQUE(profile_id,category));
    CREATE TABLE data_consents (id INTEGER PRIMARY KEY AUTOINCREMENT,profile_id INTEGER NOT NULL,purpose TEXT NOT NULL,consent_status TEXT NOT NULL);
    CREATE TABLE audit_events (id INTEGER PRIMARY KEY AUTOINCREMENT,vendor_id INTEGER,actor_profile_id INTEGER,action TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,before_json TEXT NOT NULL,after_json TEXT NOT NULL,reason TEXT NOT NULL,request_id TEXT NOT NULL,previous_event_hash TEXT NOT NULL,event_hash TEXT UNIQUE NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE transactional_email_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,profile_id INTEGER NOT NULL,recipient_email TEXT NOT NULL,category TEXT NOT NULL,event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,dedupe_key TEXT NOT NULL UNIQUE,status TEXT NOT NULL DEFAULT 'queued',attempt_count INTEGER NOT NULL DEFAULT 0,max_attempts INTEGER NOT NULL DEFAULT 5,
      next_attempt_at TEXT NOT NULL,lease_owner TEXT NOT NULL DEFAULT '',lease_expires_at TEXT,provider_message_id TEXT NOT NULL DEFAULT '',last_error_code TEXT NOT NULL DEFAULT '',last_error_reason TEXT NOT NULL DEFAULT '',
      sent_at TEXT,dead_lettered_at TEXT,cancelled_at TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE reminder_delivery_evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT, reminder_type TEXT NOT NULL, reminder_id INTEGER NOT NULL,
      profile_id INTEGER NOT NULL, local_date TEXT NOT NULL, channel TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE,
      outbox_id INTEGER, status TEXT NOT NULL DEFAULT 'queued', provider_message_id TEXT NOT NULL DEFAULT '',
      attempt_count INTEGER NOT NULL DEFAULT 0, last_error_code TEXT NOT NULL DEFAULT '', last_error_reason TEXT NOT NULL DEFAULT '',
      sent_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO account_profiles VALUES (1,'customer@example.test',1,'active'),(2,'unverified@example.test',0,'active');
    INSERT INTO notification_preferences VALUES (1,'transactional',1,1,'Asia/Kolkata'),(1,'reminder',0,1,'Asia/Kolkata'),(2,'transactional',1,1,'Asia/Kolkata');
    INSERT INTO data_consents(profile_id,purpose,consent_status) VALUES (1,'health_reminders','granted');
  `);
  t.after(() => sqlite.close());
  return { sqlite, db: new Database(sqlite) };
}

function enqueueInput(overrides = {}) {
  return {
    profileId: 1,
    eventType: "order_placed",
    payload: { orderNumber: "ORD-1", totalPaise: 118000, taxPaise: 18000 },
    dedupeKey: "order_placed:ORD-1",
    now: "2026-08-13T04:35:00.000Z",
    ...overrides,
  };
}

test("enqueue is provider-independent, preference-gated, and idempotent", async (t) => {
  const { sqlite, db } = fixture(t);
  assert.deepEqual(await enqueueTransactionalEmail(db, enqueueInput()), { queued: true });
  assert.deepEqual(await enqueueTransactionalEmail(db, enqueueInput()), { queued: false });
  assert.deepEqual(await enqueueTransactionalEmail(db, enqueueInput({ profileId: 2, dedupeKey: "order_placed:ORD-2" })), { queued: false });
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM transactional_email_outbox").get().count, 1);
});

test("worker processing sends exactly once and repeated runs are no-ops", async (t) => {
  const { sqlite, db } = fixture(t);
  await enqueueTransactionalEmail(db, enqueueInput());
  const calls = [];
  const sender = async (...args) => { calls.push(args); return { sent: true, providerMessageId: "msg_1" }; };
  const first = await processTransactionalEmailOutbox({ db, leaseOwner: "test-worker", now: "2026-08-13T04:36:00.000Z", sender });
  assert.equal(first.sent, 1);
  assert.equal(calls.length, 1);
  assert.equal(sqlite.prepare("SELECT status,provider_message_id AS providerMessageId,attempt_count AS attemptCount FROM transactional_email_outbox").get().status, "sent");
  const repeated = await processTransactionalEmailOutbox({ db, leaseOwner: "test-worker-2", now: "2026-08-13T04:37:00.000Z", sender });
  assert.equal(repeated.claimed, 0);
  assert.equal(calls.length, 1);
});

test("retryable provider failures back off and dead-letter after max attempts", async (t) => {
  const { sqlite, db } = fixture(t);
  await enqueueTransactionalEmail(db, enqueueInput({ maxAttempts: 2 }));
  const sender = async () => ({ sent: false, retryable: true, code: "temporary", reason: "provider unavailable" });
  const first = await processTransactionalEmailOutbox({ db, leaseOwner: "worker-a", now: "2026-08-13T04:36:00.000Z", sender, random: () => 0.5 });
  assert.equal(first.retryWaiting, 1);
  const due = sqlite.prepare("SELECT next_attempt_at AS nextAttemptAt FROM transactional_email_outbox").get().nextAttemptAt;
  const second = await processTransactionalEmailOutbox({ db, leaseOwner: "worker-b", now: new Date(new Date(due).getTime() + 1000).toISOString(), sender, random: () => 0.5 });
  assert.equal(second.deadLettered, 1);
  assert.equal(sqlite.prepare("SELECT status FROM transactional_email_outbox").get().status, "dead_letter");
});

test("expired leases are recovered and dead letters can be retried with audit evidence", async (t) => {
  const { sqlite, db } = fixture(t);
  await enqueueTransactionalEmail(db, enqueueInput());
  sqlite.prepare("UPDATE transactional_email_outbox SET status='processing',attempt_count=1,lease_owner='old',lease_expires_at=? WHERE id=1").run("2026-08-13T04:00:00.000Z");
  const recovered = await processTransactionalEmailOutbox({ db, leaseOwner: "new", now: "2026-08-13T04:36:00.000Z", sender: async () => ({ sent: false, retryable: false, code: "bad_request", reason: "rejected" }) });
  assert.equal(recovered.recoveredLeases, 1);
  assert.equal(recovered.deadLettered, 1);
  await retryDeadLetterEmail({ db, id: 1, actorProfileId: 1, now: "2026-08-13T04:37:00.000Z" });
  assert.equal(sqlite.prepare("SELECT status,attempt_count AS attemptCount FROM transactional_email_outbox").get().status, "retry_wait");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action='transactional_email.manual_retry'").get().count, 1);
});

test("admin listing masks recipients and exposes bounded failure state", async (t) => {
  const { db } = fixture(t);
  await enqueueTransactionalEmail(db, enqueueInput());
  const listed = await listTransactionalEmailOutbox(db, "queued");
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].recipient, "c***@example.test");
  assert.equal(listed.items[0].payloadJson, undefined);
});
