import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  channelRules,
  emailChannelEligibility,
  listNotificationPreferences,
  normalizeIanaTimeZone,
  notificationPreferenceSettings,
  NotificationPreferenceError,
  updateNotificationPreference,
} from "../lib/notification-preferences.ts";

class Statement {
  constructor(owner, sql) { this.owner = owner; this.sql = sql; this.values = []; }
  bind(...values) { this.values = values; return this; }
  async first() { return this.owner.sqlite.prepare(this.sql).get(...this.values) ?? null; }
  async all() { return { results: this.owner.sqlite.prepare(this.sql).all(...this.values) }; }
  async run() {
    if (this.owner.failAudit && /INSERT INTO audit_events/i.test(this.sql)) throw new Error("injected audit failure");
    const result = this.owner.sqlite.prepare(this.sql).run(...this.values);
    return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }
}
class Database {
  constructor(sqlite) { this.sqlite = sqlite; this.tail = Promise.resolve(); this.failAudit = false; }
  prepare(sql) { return new Statement(this, sql); }
  batch(statements) {
    const execute = async () => {
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
    };
    const result = this.tail.then(execute, execute);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

function fixture(t) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE account_profiles (id INTEGER PRIMARY KEY,email_verified INTEGER NOT NULL,status TEXT NOT NULL);
    CREATE TABLE data_consents (id INTEGER PRIMARY KEY AUTOINCREMENT,profile_id INTEGER NOT NULL,purpose TEXT NOT NULL,consent_status TEXT NOT NULL);
    CREATE TABLE notification_preferences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,profile_id INTEGER NOT NULL,category TEXT NOT NULL,
      in_app_enabled INTEGER DEFAULT 1 NOT NULL,email_enabled INTEGER DEFAULT 0 NOT NULL,
      sms_enabled INTEGER DEFAULT 0 NOT NULL,time_zone TEXT DEFAULT 'Asia/Kolkata' NOT NULL,
      version INTEGER DEFAULT 0 NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,UNIQUE(profile_id,category),
      CHECK((category NOT IN ('transactional','safety') OR in_app_enabled=1) AND sms_enabled=0 AND version>=0)
    );
    CREATE TABLE audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,vendor_id INTEGER,actor_profile_id INTEGER,action TEXT NOT NULL,
      entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,before_json TEXT NOT NULL,after_json TEXT NOT NULL,
      reason TEXT NOT NULL,request_id TEXT NOT NULL,previous_event_hash TEXT NOT NULL,event_hash TEXT UNIQUE NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT INTO account_profiles VALUES (1,1,'active'),(2,0,'active'),(3,1,'active');
    INSERT INTO data_consents(profile_id,purpose,consent_status) VALUES
      (1,'health_reminders','granted'),(1,'marketing','withdrawn'),
      (2,'health_reminders','granted'),(3,'health_reminders','granted');
    INSERT INTO notification_preferences(profile_id,category,in_app_enabled) VALUES
      (1,'transactional',1),(1,'safety',1),(1,'reminder',0),(1,'marketing',0),
      (2,'transactional',1),(2,'safety',1),(2,'reminder',0),(2,'marketing',0),
      (3,'transactional',1),(3,'safety',1),(3,'reminder',0),(3,'marketing',0);
  `);
  t.after(() => sqlite.close());
  return { sqlite, db: new Database(sqlite) };
}

test("IANA time zones are strictly validated without accepting arbitrary labels", () => {
  assert.equal(normalizeIanaTimeZone("Asia/Kolkata"), "Asia/Kolkata");
  assert.equal(normalizeIanaTimeZone("America/New_York"), "America/New_York");
  assert.equal(normalizeIanaTimeZone("UTC"), "UTC");
  assert.throws(() => normalizeIanaTimeZone("IST"), /supported IANA/);
  assert.throws(() => normalizeIanaTimeZone("Mars/Olympus"), /supported IANA/);
});

test("D-11 keeps essential in-app available, makes optional categories consent-controlled, and disables SMS", () => {
  assert.equal(channelRules("transactional").inAppRequired, true);
  assert.equal(channelRules("safety").inAppRequired, true);
  assert.equal(channelRules("reminder").inAppRequired, false);
  assert.equal(channelRules("marketing").inAppRequired, false);
  for (const category of ["transactional", "safety", "reminder", "marketing"]) assert.equal(channelRules(category).smsAvailable, false);
  assert.equal(channelRules("reminder").emailConsentPurpose, "health_reminders");
  assert.equal(channelRules("marketing").emailConsentPurpose, "marketing");
});

test("settings are profile scoped and expose conservative defaults", async (t) => {
  const { db } = fixture(t);
  const settings = await notificationPreferenceSettings(db, 1);
  assert.equal(settings.emailVerified, true);
  assert.equal(settings.smsAvailable, false);
  assert.equal(settings.preferences.length, 4);
  assert.ok(settings.preferences.filter((preference) => ["transactional", "safety"].includes(preference.category))
    .every((preference) => preference.inAppEnabled));
  assert.ok(settings.preferences.filter((preference) => ["reminder", "marketing"].includes(preference.category))
    .every((preference) => !preference.inAppEnabled));
  assert.ok(settings.preferences.every((preference) => !preference.emailEnabled && !preference.smsEnabled));
  assert.equal(settings.preferences.find((preference) => preference.category === "reminder").requiredConsentGranted, true);
  assert.equal(settings.preferences.find((preference) => preference.category === "marketing").requiredConsentGranted, false);
  assert.ok((await listNotificationPreferences(db, 2)).every((preference) => !preference.emailEnabled));
});

test("email needs a verified address, explicit preference, and category consent", async (t) => {
  const { db } = fixture(t);
  await assert.rejects(updateNotificationPreference({ db, profileId: 2, emailVerified: false,
    category: "transactional", inAppEnabled: true, emailEnabled: true, smsEnabled: false, timeZone: "Asia/Kolkata", expectedVersion: 0 }),
  /Verify your account email/);
  await assert.rejects(updateNotificationPreference({ db, profileId: 1, emailVerified: true,
    category: "marketing", inAppEnabled: false, emailEnabled: true, smsEnabled: false, timeZone: "Asia/Kolkata", expectedVersion: 0 }),
  /marketing consent/);
  await assert.rejects(updateNotificationPreference({ db, profileId: 1, emailVerified: true,
    category: "reminder", inAppEnabled: false, emailEnabled: true, smsEnabled: true, timeZone: "Asia/Kolkata", expectedVersion: 0 }),
  /SMS notifications are unavailable/);

  const saved = await updateNotificationPreference({ db, profileId: 1, emailVerified: true,
    category: "reminder", inAppEnabled: false, emailEnabled: true, smsEnabled: false, timeZone: "America/New_York", expectedVersion: 0 });
  assert.equal(saved.updated, true);
  assert.deepEqual(await emailChannelEligibility(db, 1, "reminder"), {
    inApp: false, email: true, sms: false, timeZone: "America/New_York",
  });
  assert.equal((await emailChannelEligibility(db, 2, "reminder")).email, false);
});

test("preference transitions are idempotent, race-safe, and atomically audited", async (t) => {
  const { sqlite, db } = fixture(t);
  const first = await updateNotificationPreference({ db, profileId: 1, emailVerified: true,
    category: "safety", inAppEnabled: true, emailEnabled: true, smsEnabled: false, timeZone: "Asia/Kolkata", expectedVersion: 0 });
  assert.equal(first.updated, true);
  const repeated = await updateNotificationPreference({ db, profileId: 1, emailVerified: true,
    category: "safety", inAppEnabled: true, emailEnabled: true, smsEnabled: false, timeZone: "Asia/Kolkata", expectedVersion: 0 });
  assert.equal(repeated.unchanged, true);
  await assert.rejects(updateNotificationPreference({ db, profileId: 1, emailVerified: true,
    category: "safety", inAppEnabled: true, emailEnabled: false, smsEnabled: false, timeZone: "UTC", expectedVersion: 0 }),
  (error) => error instanceof NotificationPreferenceError && error.status === 409);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events").get().count, 1);

  db.failAudit = true;
  await assert.rejects(updateNotificationPreference({ db, profileId: 3, emailVerified: true,
    category: "safety", inAppEnabled: true, emailEnabled: true, smsEnabled: false, timeZone: "UTC", expectedVersion: 0 }), /injected audit failure/);
  assert.deepEqual({ ...sqlite.prepare("SELECT email_enabled AS emailEnabled,time_zone AS timeZone,version FROM notification_preferences WHERE profile_id=3 AND category='safety'").get() },
    { emailEnabled: 0, timeZone: "Asia/Kolkata", version: 0 });
});

test("migration, API, UI, and notification call sites encode the profile-owned channel policy", async () => {
  const [migration, route, ui, docs, orderCreate, orderTracking, prescriptionReview] = await Promise.all([
    readFile(new URL("../drizzle/0047_normal_wrecker.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/api/notification-preferences/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/notification-preferences.tsx", import.meta.url), "utf8"),
    readFile(new URL("../docs/NOTIFICATION_CHANNEL_POLICY.md", import.meta.url), "utf8"),
    readFile(new URL("../app/api/orders/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/orders/[id]/tracking/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/prescriptions/[id]/review/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(migration, /CASE WHEN category\.`value` IN \('transactional','safety'\) THEN 1 ELSE 0 END,0,0,'Asia\/Kolkata'/);
  assert.match(migration, /invalid notification preference transition/);
  assert.match(route, /requireLocalProfile\(request, \["customer", "vendor"\]/);
  assert.match(ui, /SMS is unavailable/);
  assert.match(docs, /P5-05 defines eligibility only/);
  assert.match(orderCreate, /prepareTransactionalEmailEnqueueStatement\(db, \{/);
  assert.match(orderTracking, /prepareTransactionalEmailEnqueueStatement\(db, \{/);
  assert.match(prescriptionReview, /prepareTransactionalEmailEnqueueStatement\(db, \{/);
});
