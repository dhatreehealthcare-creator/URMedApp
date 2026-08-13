import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { CategoryGovernanceError, saveProductCategory } from "../lib/category-governance.ts";

class Statement {
  constructor(owner, sql) { this.owner = owner; this.sql = sql; this.values = []; }
  bind(...values) { this.values = values; return this; }
  async first() { return this.owner.sqlite.prepare(this.sql).get(...this.values) ?? null; }
  async run() { const result = this.owner.sqlite.prepare(this.sql).run(...this.values); return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } }; }
}
class D1 {
  constructor(sqlite) { this.sqlite = sqlite; }
  prepare(sql) { return new Statement(this, sql); }
  async batch(statements) {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try { const results=[]; for(const statement of statements)results.push(await statement.run());this.sqlite.exec("COMMIT");return results; }
    catch(error){this.sqlite.exec("ROLLBACK");throw error;}
  }
}

function fixture(t) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE categories (id INTEGER PRIMARY KEY,name TEXT NOT NULL,status TEXT NOT NULL);
    CREATE TABLE audit_events (id INTEGER PRIMARY KEY AUTOINCREMENT,vendor_id INTEGER,actor_profile_id INTEGER,
      action TEXT,entity_type TEXT,entity_id TEXT,before_json TEXT,after_json TEXT,reason TEXT,request_id TEXT,
      previous_event_hash TEXT,event_hash TEXT,created_at TEXT);
    INSERT INTO categories VALUES (1,'Tablet','active');`);
  t.after(() => sqlite.close());
  return { sqlite, db: new D1(sqlite) };
}

test("category create and edit commit immutable audit evidence in the same batch", async (t) => {
  const { sqlite, db } = fixture(t);
  const created = await saveProductCategory({ db, name: "Capsule", status: "active", actorProfileId: 9 });
  assert.deepEqual(created, { id: 2, created: true });
  await saveProductCategory({ db, id: 2, name: "Capsules", status: "inactive", actorProfileId: 9 });
  assert.deepEqual({ ...sqlite.prepare("SELECT name,status FROM categories WHERE id=2").get() }, { name: "Capsules", status: "inactive" });
  assert.deepEqual(sqlite.prepare("SELECT action FROM audit_events ORDER BY id").all().map((row) => row.action), ["category.created", "category.updated"]);
});

test("case-insensitive duplicates and missing records are rejected without false audit evidence", async (t) => {
  const { sqlite, db } = fixture(t);
  await assert.rejects(saveProductCategory({ db, name: " tablet ", status: "active", actorProfileId: 9 }),
    (error) => error instanceof CategoryGovernanceError && error.status === 409);
  await assert.rejects(saveProductCategory({ db, id: 999, name: "Missing", status: "active", actorProfileId: 9 }),
    (error) => error instanceof CategoryGovernanceError && error.status === 404);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events").get().count, 0);
});

test("category governance is editable in the live admin screen and keeps dosage forms separate", async () => {
  const { readFile } = await import("node:fs/promises");
  const [route, ui] = await Promise.all([
    readFile(new URL("../app/api/admin/operations/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/operations-centers.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(route, /saveProductCategory/);
  assert.match(route, /COALESCE\(product\.display_category_id,product\.category_id\)/);
  assert.match(ui, /Categories are a commercial browsing taxonomy, separate from governed pharmaceutical dosage forms/);
  assert.match(ui, /setCategoryDraft\(\{id:row\.id,name:row\.name,status:row\.status\}\)/);
});
