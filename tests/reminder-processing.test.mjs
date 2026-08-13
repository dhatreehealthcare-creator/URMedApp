import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  getDueReminderCounts,
  processDueReminders,
  REMINDER_PROCESSING_CRON,
  reminderProcessingWindow,
} from "../lib/reminder-processing.ts";

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
    CREATE TABLE account_profiles (
      id INTEGER PRIMARY KEY,email TEXT NOT NULL,email_verified INTEGER NOT NULL,status TEXT NOT NULL
    );
    CREATE TABLE data_consents (
      id INTEGER PRIMARY KEY,profile_id INTEGER NOT NULL,purpose TEXT NOT NULL,consent_status TEXT NOT NULL
    );
    CREATE TABLE notification_preferences (
      profile_id INTEGER NOT NULL,category TEXT NOT NULL,in_app_enabled INTEGER NOT NULL,email_enabled INTEGER NOT NULL,
      time_zone TEXT NOT NULL,UNIQUE(profile_id,category)
    );
    CREATE TABLE refill_reminders (
      id INTEGER PRIMARY KEY,customer_profile_id INTEGER NOT NULL,vendor_id INTEGER NOT NULL,
      medicine_name TEXT NOT NULL,due_date TEXT NOT NULL,reminder_lead_days INTEGER NOT NULL,
      status TEXT NOT NULL,snoozed_until TEXT,last_notified_at TEXT,updated_at TEXT
    );
    CREATE TABLE pill_reminders (
      id INTEGER PRIMARY KEY,customer_profile_id INTEGER NOT NULL,medicine_name TEXT NOT NULL,
      dosage_instructions TEXT NOT NULL,reminder_time TEXT NOT NULL,start_date TEXT NOT NULL,
      end_date TEXT,recurrence_rule TEXT NOT NULL,active INTEGER NOT NULL
    );
    CREATE TABLE notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,profile_id INTEGER,vendor_id INTEGER,
      notification_type TEXT NOT NULL,severity TEXT NOT NULL,title TEXT NOT NULL,message TEXT NOT NULL,
      reference_type TEXT NOT NULL,reference_id INTEGER,read_at TEXT,created_at TEXT NOT NULL
    );
    CREATE TABLE audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,vendor_id INTEGER,actor_profile_id INTEGER,
      action TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,
      before_json TEXT NOT NULL,after_json TEXT NOT NULL,reason TEXT NOT NULL,request_id TEXT NOT NULL,
      previous_event_hash TEXT NOT NULL,event_hash TEXT NOT NULL,created_at TEXT NOT NULL
    );
    INSERT INTO account_profiles VALUES
      (1,'active@example.test',1,'active'),
      (2,'revoked@example.test',1,'active'),
      (3,'inactive@example.test',1,'inactive'),
      (4,'in-app-only@example.test',1,'active');
    INSERT INTO data_consents VALUES
      (1,1,'health_reminders','granted'),
      (2,2,'health_reminders','granted'),
      (3,2,'health_reminders','revoked'),
      (4,3,'health_reminders','granted'),
      (5,4,'health_reminders','granted');
    INSERT INTO notification_preferences VALUES
      (1,'reminder',1,1,'Asia/Kolkata'),
      (2,'reminder',1,1,'Asia/Kolkata'),
      (3,'reminder',1,1,'Asia/Kolkata'),
      (4,'reminder',0,1,'America/New_York');
    INSERT INTO refill_reminders VALUES
      (10,1,20,'Refill medicine','2026-08-15',3,'active',NULL,NULL,NULL),
      (11,2,20,'No consent refill','2026-08-15',3,'active',NULL,NULL,NULL),
      (12,3,20,'Inactive refill','2026-08-15',3,'active',NULL,NULL,NULL);
    INSERT INTO pill_reminders VALUES
      (20,1,'Morning tablet','After breakfast','08:30','2026-08-01',NULL,'daily',1),
      (21,1,'Future tablet','After lunch','10:30','2026-08-01',NULL,'daily',1),
      (22,2,'No consent tablet','','08:00','2026-08-01',NULL,'daily',1),
      (23,3,'Inactive tablet','','08:00','2026-08-01',NULL,'daily',1),
      (24,4,'New York tablet','','00:30','2026-08-01',NULL,'daily',1);
  `);
  t.after(() => sqlite.close());
  return { sqlite, db: new Database(sqlite) };
}

const scheduledAt = "2026-08-13T04:35:00.000Z"; // 10:05 in the deployment's India default.

test("reminder schedule uses a deterministic India-local processing window", () => {
  assert.equal(REMINDER_PROCESSING_CRON, "*/15 * * * *");
  assert.deepEqual(reminderProcessingWindow(scheduledAt), {
    localDate: "2026-08-13",
    localTime: "10:05",
    timeZone: "Asia/Kolkata",
  });
});

test("scheduled reminders enforce latest consent, active accounts, due time, and once-per-day delivery", async (t) => {
  const { sqlite, db } = fixture(t);
  const due = await getDueReminderCounts({ db, now: scheduledAt });
  assert.deepEqual(due.status, { dueRefills: 1, duePills: 2 });
  const emailCalls = [];
  const input = {
    db,
    now: scheduledAt,
    requestId: "scheduled-reminders-test",
    sendEmail: async (to, subject, html) => {
      emailCalls.push({ to, subject, html });
      return { sent: true };
    },
  };
  const first = await processDueReminders(input);
  assert.deepEqual(first.processed, { refills: 1, pills: 2, total: 3 });
  assert.deepEqual(first.email, { sent: 3, unavailableOrFailed: 0, notEnabled: 0 });
  assert.equal(emailCalls.length, 3);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM notifications").get().count, 2,
    "email-only reminder delivery must not create an in-app event after opt-out");
  assert.equal(sqlite.prepare("SELECT last_notified_at AS value FROM refill_reminders WHERE id=10").get().value, "2026-08-13T10:05:00");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action='reminders.processed'").get().count, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action='reminder.email_sent'").get().count, 1);

  const repeated = await processDueReminders(input);
  assert.deepEqual(repeated.processed, { refills: 0, pills: 0, total: 0 });
  assert.equal(emailCalls.length, 3);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM notifications").get().count, 2);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events").get().count, 2,
    "a no-op scheduler retry must not amplify audit storage");
});

test("Worker dispatches recovery, reminder, and vendor-alert cron events independently", async () => {
  const [worker, vite, artifact, route] = await Promise.all([
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../vite.config.ts", import.meta.url), "utf8"),
    readFile(new URL("../scripts/validate-artifact.sh", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/reminders/process/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(worker, /controller\.cron === RESERVATION_RECOVERY_CRON/);
  assert.match(worker, /controller\.cron === REMINDER_PROCESSING_CRON/);
  assert.match(worker, /controller\.cron === VENDOR_INVENTORY_ALERT_CRON/);
  assert.match(worker, /processDueReminders\(\{[\s\S]*now: controller\.scheduledTime/);
  assert.match(worker, /generateVendorInventoryAlerts\(\{[\s\S]*processingDate/);
  assert.match(vite, /crons: \[RESERVATION_RECOVERY_CRON, REMINDER_PROCESSING_CRON, VENDOR_INVENTORY_ALERT_CRON\]/);
  assert.match(artifact, /wrangler\.triggers\?\.crons\?\.includes\("\*\/15 \* \* \* \*"\)/);
  assert.match(artifact, /wrangler\.triggers\?\.crons\?\.includes\("30 0 \* \* \*"\)/);
  assert.match(route, /getDueReminderCounts/);
  assert.match(route, /processDueReminders/);
  assert.match(route, /getRuntimeEnv\(\)\.REMINDER_JOB_SECRET/);
});
