import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { approveManufacturerRequest, loadManufacturerRequest, parseManufacturerGovernanceQuery, parseManufacturerProposal } from "../lib/manufacturer-governance.ts";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const migrationSql = read("../drizzle/0043_tired_millenium_guard.sql");

class Statement {
  constructor(database, sql) { this.database = database; this.sql = sql; this.values = []; }
  bind(...values) { this.values = values; return this; }
  async first() { return this.database.prepare(this.sql).get(...this.values) ?? null; }
  async all() { return { results: this.database.prepare(this.sql).all(...this.values).map((row) => ({ ...row })) }; }
  async run() { const result = this.database.prepare(this.sql).run(...this.values); return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } }; }
}
class D1 {
  constructor(database) { this.database = database; }
  prepare(sql) { return new Statement(this.database, sql); }
  async batch(statements) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
}

function governanceDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE manufacturers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, normalized_name TEXT NOT NULL UNIQUE);
    CREATE TABLE manufacturer_canonical_state (manufacturer_id INTEGER PRIMARY KEY, status TEXT NOT NULL, merged_into_manufacturer_id INTEGER, source TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE manufacturer_aliases (id INTEGER PRIMARY KEY AUTOINCREMENT, manufacturer_id INTEGER NOT NULL, alias_name TEXT NOT NULL, normalized_alias TEXT NOT NULL UNIQUE, provenance TEXT NOT NULL, source_manufacturer_id INTEGER, created_by_profile_id INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE manufacturer_change_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, request_type TEXT NOT NULL, submitted_vendor_id INTEGER NOT NULL, created_by_profile_id INTEGER NOT NULL, manufacturer_id INTEGER, target_manufacturer_id INTEGER, proposed_name TEXT NOT NULL DEFAULT '', normalized_proposed_name TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', reviewed_by_profile_id INTEGER, review_reason TEXT NOT NULL DEFAULT '', reviewed_at TEXT, version INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE manufacturer_governance_events (id INTEGER PRIMARY KEY AUTOINCREMENT, request_id INTEGER NOT NULL, event_type TEXT NOT NULL, actor_profile_id INTEGER NOT NULL, manufacturer_id INTEGER, target_manufacturer_id INTEGER, detail_json TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(request_id,event_type));
    CREATE TABLE products (id INTEGER PRIMARY KEY, manufacturer_id INTEGER, manufacturer TEXT NOT NULL, updated_at TEXT);
    CREATE TABLE audit_events (id INTEGER PRIMARY KEY AUTOINCREMENT, vendor_id INTEGER, actor_profile_id INTEGER, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, before_json TEXT NOT NULL, after_json TEXT NOT NULL, reason TEXT NOT NULL, request_id TEXT NOT NULL, previous_event_hash TEXT NOT NULL, event_hash TEXT NOT NULL, created_at TEXT NOT NULL);
    INSERT INTO manufacturers VALUES (1,'Acme Pharma','acme pharma'),(2,'Acme Labs','acme labs'),(3,'Beta Pharma','beta pharma'),(4,'Acme Legacy','acme legacy');
    INSERT INTO manufacturer_canonical_state (manufacturer_id,status,merged_into_manufacturer_id,source) VALUES (1,'active',NULL,'recovered_catalogue'),(2,'active',NULL,'recovered_catalogue'),(3,'active',NULL,'recovered_catalogue'),(4,'merged',2,'recovered_catalogue');
    INSERT INTO manufacturer_aliases (manufacturer_id,alias_name,normalized_alias,provenance,source_manufacturer_id) VALUES (1,'Acme Pharma','acme pharma','recovered_catalogue',1),(2,'Acme Labs','acme labs','recovered_catalogue',2),(3,'Beta Pharma','beta pharma','recovered_catalogue',3),(2,'Acme Legacy','acme legacy','merge',4);
    INSERT INTO products VALUES (1,2,'Acme Labs',CURRENT_TIMESTAMP);
    INSERT INTO manufacturer_change_requests (request_type,submitted_vendor_id,created_by_profile_id,manufacturer_id,proposed_name,normalized_proposed_name) VALUES ('rename',7,10,1,'Acme India','acme india');
    INSERT INTO manufacturer_change_requests (request_type,submitted_vendor_id,created_by_profile_id,manufacturer_id,target_manufacturer_id) VALUES ('merge',7,10,2,1);
    INSERT INTO manufacturer_change_requests (request_type,submitted_vendor_id,created_by_profile_id,proposed_name,normalized_proposed_name) VALUES ('new',7,10,'Gamma Pharma','gamma pharma');
  `);
  return { sqlite, database: new D1(sqlite) };
}

function migrationDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE account_profiles (id INTEGER PRIMARY KEY, role TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TABLE vendors (id INTEGER PRIMARY KEY, profile_id INTEGER);
    CREATE TABLE vendor_staff (id INTEGER PRIMARY KEY, vendor_id INTEGER, profile_id INTEGER, status TEXT NOT NULL);
    CREATE TABLE manufacturers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, normalized_name TEXT NOT NULL UNIQUE);
    CREATE TABLE products (id INTEGER PRIMARY KEY, manufacturer_id INTEGER, manufacturer TEXT NOT NULL, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE audit_events (id INTEGER PRIMARY KEY AUTOINCREMENT, vendor_id INTEGER, actor_profile_id INTEGER, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, before_json TEXT NOT NULL, after_json TEXT NOT NULL, reason TEXT NOT NULL, request_id TEXT NOT NULL, previous_event_hash TEXT NOT NULL, event_hash TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE migration_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, source_file TEXT NOT NULL, source_sha256 TEXT NOT NULL, entity TEXT NOT NULL, source_rows INTEGER NOT NULL, imported_rows INTEGER NOT NULL, rejected_rows INTEGER NOT NULL, notes TEXT NOT NULL, completed_at TEXT DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO account_profiles VALUES (10,'vendor','active'),(99,'admin','active'),(100,'admin','inactive');
    INSERT INTO vendors VALUES (7,10);
    INSERT INTO manufacturers VALUES (1,'Recovered Acme','recovered acme'),(2,'Recovered Beta','recovered beta');
    INSERT INTO products (id,manufacturer_id,manufacturer) VALUES (1,1,'stale display'),(2,NULL,'Unknown');
  `);
  sqlite.exec(migrationSql.replaceAll("--> statement-breakpoint", ""));
  return sqlite;
}

test("manufacturer proposal validation normalizes names and rejects invalid merge shapes", () => {
  assert.deepEqual(parseManufacturerProposal({ requestType: "new", proposedName: "  Acme  Pharma Pvt. Ltd. " }), {
    requestType: "new", manufacturerId: null, targetManufacturerId: null,
    proposedName: "Acme Pharma Pvt. Ltd.", normalizedProposedName: "acme pharma pvt ltd",
  });
  assert.deepEqual(parseManufacturerProposal({ requestType: "rename", manufacturerId: 9, proposedName: "Acme India" }), {
    requestType: "rename", manufacturerId: 9, targetManufacturerId: null,
    proposedName: "Acme India", normalizedProposedName: "acme india",
  });
  assert.deepEqual(parseManufacturerProposal({ requestType: "merge", manufacturerId: 9, targetManufacturerId: 4 }), {
    requestType: "merge", manufacturerId: 9, targetManufacturerId: 4,
    proposedName: "", normalizedProposedName: "",
  });
  assert.throws(() => parseManufacturerProposal({ requestType: "merge", manufacturerId: 9, targetManufacturerId: 9 }), (error) => error instanceof Response && error.status === 400);
  assert.throws(() => parseManufacturerProposal({ requestType: "new", proposedName: "!" }), (error) => error instanceof Response && error.status === 400);
});

test("manufacturer governance query inputs are bounded", () => {
  assert.deepEqual(parseManufacturerGovernanceQuery(new URL("https://urmed.test/api?q=%20Acme%20&status=pending&page=-3&pageSize=500")), {
    query: "Acme", status: "pending", page: 1, pageSize: 50,
  });
  assert.equal(parseManufacturerGovernanceQuery(new URL("https://urmed.test/api?status=drop")).status, "all");
});

test("0043 contains only manufacturer governance, deterministic backfill, and database lifecycle guards", () => {
  assert.match(migrationSql, /manufacturer_governance_backfill/);
  assert.match(migrationSql, /SELECT `id`, 'active', 'recovered_catalogue' FROM `manufacturers`/);
  assert.match(migrationSql, /'recovered_catalogue', `id`\s+FROM `manufacturers`/);
  assert.match(migrationSql, /manufacturer_requests_pending_new_name_uidx/);
  assert.match(migrationSql, /manufacturer_requests_pending_source_uidx/);
  assert.match(migrationSql, /reviewer\.`role` = 'admin' AND reviewer\.`status` = 'active'/);
  assert.match(migrationSql, /manufacturer_aliases_insert_guard/);
  assert.match(migrationSql, /manufacturer_aliases_update_guard/);
  assert.match(migrationSql, /manufacturer_events_insert_guard/);
  assert.match(migrationSql, /manufacturer_history_immutable/);
  assert.match(migrationSql, /UPDATE `products`\s+SET `manufacturer`/);
  assert.doesNotMatch(migrationSql, /payment_refunds|inventory_adjustments|inventory_count_sessions/);
  assert.doesNotMatch(migrationSql, /DELETE FROM `?manufacturers|DELETE FROM `?manufacturer_aliases/);
});

test("0043 backfill retains recovered identity, synchronizes product display, and rejects unauthorized lifecycle changes", () => {
  const sqlite = migrationDatabase();
  assert.deepEqual(sqlite.prepare("SELECT manufacturer_id AS manufacturerId, status, source FROM manufacturer_canonical_state ORDER BY manufacturer_id").all().map((row) => ({ ...row })), [
    { manufacturerId: 1, status: "active", source: "recovered_catalogue" },
    { manufacturerId: 2, status: "active", source: "recovered_catalogue" },
  ]);
  assert.deepEqual(sqlite.prepare("SELECT alias_name AS aliasName, normalized_alias AS normalizedAlias, provenance FROM manufacturer_aliases ORDER BY id").all().map((row) => ({ ...row })), [
    { aliasName: "Recovered Acme", normalizedAlias: "recovered acme", provenance: "recovered_catalogue" },
    { aliasName: "Recovered Beta", normalizedAlias: "recovered beta", provenance: "recovered_catalogue" },
  ]);
  assert.equal(sqlite.prepare("SELECT manufacturer FROM products WHERE id=1").get().manufacturer, "Recovered Acme");
  assert.deepEqual({ ...sqlite.prepare("SELECT source_rows AS sourceRows, imported_rows AS importedRows, rejected_rows AS rejectedRows FROM migration_audit WHERE entity='manufacturer_governance_backfill'").get() }, { sourceRows: 2, importedRows: 2, rejectedRows: 0 });

  assert.throws(() => sqlite.prepare("INSERT INTO manufacturers (name,normalized_name) VALUES ('Bypass','bypass')").run(), /manufacturer_governance_required/);
  assert.throws(() => sqlite.prepare("UPDATE manufacturers SET name='Bypass' WHERE id=1").run(), /manufacturer_governance_required/);
  assert.throws(() => sqlite.prepare("DELETE FROM manufacturers WHERE id=1").run(), /manufacturer_history_immutable/);
  assert.throws(() => sqlite.prepare("INSERT INTO manufacturer_change_requests (request_type,submitted_vendor_id,created_by_profile_id,manufacturer_id,target_manufacturer_id) VALUES ('merge',7,10,1,1)").run(), /manufacturer_request_invalid|CHECK constraint/);
  sqlite.prepare("INSERT INTO manufacturer_change_requests (request_type,submitted_vendor_id,created_by_profile_id,manufacturer_id,target_manufacturer_id) VALUES ('merge',7,10,1,2)").run();
  assert.throws(() => sqlite.prepare("INSERT INTO manufacturer_change_requests (request_type,submitted_vendor_id,created_by_profile_id,manufacturer_id,proposed_name,normalized_proposed_name) VALUES ('rename',7,10,1,'Renamed','renamed')").run(), /UNIQUE constraint/);
  assert.throws(() => sqlite.prepare("UPDATE manufacturer_change_requests SET status='approved',reviewed_by_profile_id=100,review_reason='Inactive administrator',reviewed_at=CURRENT_TIMESTAMP,version=2 WHERE id=1").run(), /manufacturer_request_lifecycle_invalid/);
  sqlite.prepare("UPDATE manufacturer_change_requests SET status='approved',reviewed_by_profile_id=99,review_reason='Confirmed duplicate identity',reviewed_at=CURRENT_TIMESTAMP,version=2 WHERE id=1").run();
  assert.throws(() => sqlite.prepare("UPDATE manufacturer_canonical_state SET status='merged',merged_into_manufacturer_id=1,version=2 WHERE manufacturer_id=1").run(), /manufacturer_state_transition_invalid|CHECK constraint/);
  sqlite.close();
});

test("0043 guards accept the transactional helper exactly once for create, rename, and merge", async () => {
  const sqlite = migrationDatabase();
  const database = new D1(sqlite);
  sqlite.prepare("INSERT INTO manufacturer_change_requests (request_type,submitted_vendor_id,created_by_profile_id,proposed_name,normalized_proposed_name) VALUES ('new',7,10,'Governed Gamma','governed gamma')").run();
  const create = await loadManufacturerRequest(database, 1);
  const created = await approveManufacturerRequest(database, create, 99, "Validated legal manufacturer");
  sqlite.prepare("INSERT INTO manufacturer_change_requests (request_type,submitted_vendor_id,created_by_profile_id,manufacturer_id,proposed_name,normalized_proposed_name) VALUES ('rename',7,10,?,'Governed Gamma India','governed gamma india')").run(created.manufacturerId);
  const rename = await loadManufacturerRequest(database, 2);
  await approveManufacturerRequest(database, rename, 99, "Confirmed corporate rename");
  sqlite.prepare("INSERT INTO products (id,manufacturer_id,manufacturer) VALUES (3,?,'Governed Gamma India')").run(created.manufacturerId);
  sqlite.prepare("INSERT INTO manufacturer_change_requests (request_type,submitted_vendor_id,created_by_profile_id,manufacturer_id,target_manufacturer_id) VALUES ('merge',7,10,?,1)").run(created.manufacturerId);
  const merge = await loadManufacturerRequest(database, 3);
  await approveManufacturerRequest(database, merge, 99, "Confirmed duplicate legal identity");
  assert.deepEqual({ ...sqlite.prepare("SELECT manufacturer_id AS manufacturerId,manufacturer FROM products WHERE id=3").get() }, { manufacturerId: 1, manufacturer: "Recovered Acme" });
  assert.deepEqual(sqlite.prepare("SELECT alias_name AS aliasName FROM manufacturer_aliases WHERE manufacturer_id=1 AND normalized_alias LIKE 'governed gamma%' ORDER BY normalized_alias").all().map((row) => row.aliasName), ["Governed Gamma", "Governed Gamma India"]);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM manufacturer_governance_events").get().count, 3);
  await assert.rejects(approveManufacturerRequest(database, merge, 99, "Repeated merge approval"), (error) => error instanceof Response && error.status === 409);
  sqlite.close();
});

test("vendor proposals are tenant-scoped and cannot mutate the global manufacturer master", () => {
  const route = read("../app/api/vendor/manufacturers/route.ts");
  const legacyMasterRoute = read("../app/api/vendor/masters/route.ts");
  assert.equal(route.match(/requireVendorPermission\(request, "product\.submit"\)/g)?.length, 3);
  assert.match(route, /submitted_vendor_id\s*=\s*\?/);
  assert.match(route, /WHERE id=\? AND submitted_vendor_id=\? AND status='pending'/);
  assert.match(route, /manufacturer_change_requests/);
  assert.doesNotMatch(route, /UPDATE manufacturers|DELETE FROM manufacturers/);
  assert.doesNotMatch(legacyMasterRoute, /ON CONFLICT\(normalized_name\) DO UPDATE/);
  assert.match(legacyMasterRoute, /manufacturer\.new\.proposed/);
});

test("active admin governance uses atomic D1 batches, optimistic request versions and retained evidence", () => {
  const route = read("../app/api/admin/manufacturers/route.ts");
  const helper = read("../lib/manufacturer-governance.ts");
  assert.equal(route.match(/requireAdminProfile\(request\)/g)?.length, 2);
  assert.match(helper, /await database\.batch\(statements\)/);
  assert.match(helper, /status='pending' AND version=\?/);
  assert.match(helper, /version=version\+1/);
  assert.match(helper, /UPDATE products SET manufacturer_id=\?, manufacturer=/);
  assert.match(helper, /UPDATE manufacturer_aliases SET manufacturer_id=\?/);
  assert.match(helper, /manufacturer_governance_events/);
  assert.match(helper, /merged_into_manufacturer_id=\?/);
  assert.match(helper, /status='active'/);
  assert.doesNotMatch(helper + route, /DELETE FROM manufacturers|DELETE FROM manufacturer_aliases/);
});

test("rename, merge and create approvals commit canonical links, aliases and audit evidence exactly once", async () => {
  const { sqlite, database } = governanceDatabase();
  const rename = await loadManufacturerRequest(database, 1);
  await approveManufacturerRequest(database, rename, 99, "Verified corporate rename");
  assert.deepEqual({ ...sqlite.prepare("SELECT name, normalized_name AS normalizedName FROM manufacturers WHERE id=1").get() }, { name: "Acme India", normalizedName: "acme india" });
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM manufacturer_aliases WHERE manufacturer_id=1").get().count, 1);

  const merge = await loadManufacturerRequest(database, 2);
  await approveManufacturerRequest(database, merge, 99, "Confirmed duplicate legal entity");
  assert.deepEqual({ ...sqlite.prepare("SELECT manufacturer_id AS manufacturerId, manufacturer FROM products WHERE id=1").get() }, { manufacturerId: 1, manufacturer: "Acme India" });
  assert.deepEqual({ ...sqlite.prepare("SELECT status, merged_into_manufacturer_id AS mergedInto FROM manufacturer_canonical_state WHERE manufacturer_id=2").get() }, { status: "merged", mergedInto: 1 });
  assert.deepEqual({ ...sqlite.prepare("SELECT merged_into_manufacturer_id AS mergedInto, version FROM manufacturer_canonical_state WHERE manufacturer_id=4").get() }, { mergedInto: 1, version: 2 });
  assert.equal(sqlite.prepare("SELECT manufacturer_id FROM manufacturer_aliases WHERE normalized_alias='acme labs'").get().manufacturer_id, 1);

  const create = await loadManufacturerRequest(database, 3);
  const created = await approveManufacturerRequest(database, create, 99, "Validated manufacturer identity");
  assert.equal(created.manufacturerName, "Gamma Pharma");
  assert.equal(sqlite.prepare("SELECT status FROM manufacturer_canonical_state WHERE manufacturer_id=?").get(created.manufacturerId).status, "active");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM manufacturer_governance_events").get().count, 3);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events").get().count, 3);
  await assert.rejects(approveManufacturerRequest(database, rename, 99, "Repeated approval attempt"), (error) => error instanceof Response && error.status === 409);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM manufacturer_governance_events").get().count, 3);
  sqlite.close();
});

test("catalogue, inventory, procurement and product search use canonical manufacturer IDs and aliases", () => {
  const productHelper = read("../lib/product-master.ts");
  const catalog = read("../app/api/catalog/route.ts");
  const inventory = read("../app/api/inventory/route.ts");
  const masters = read("../app/api/vendor/masters/route.ts");
  for (const source of [productHelper, catalog, inventory, masters]) {
    assert.match(source, /manufacturer_canonical_state/);
    assert.match(source, /manufacturer_aliases/);
  }
  assert.match(productHelper, /canonical\.id = p\.manufacturer_id/);
  assert.match(catalog, /canonical_manufacturer\.id = p\.manufacturer_id/);
  assert.match(inventory, /canonical_manufacturer\.id = p\.manufacturer_id/);
  assert.match(masters, /p\.manufacturer_id = m\.id/);
  assert.doesNotMatch(catalog, /lower\(p\.manufacturer\) LIKE/);
  assert.doesNotMatch(inventory, /lower\(p\.manufacturer\) LIKE/);
  assert.doesNotMatch(masters, /lower\(p\.manufacturer\) =/);
});

test("live ProductMaster exposes role-aware manufacturer governance through authenticated requests", () => {
  const productMaster = read("../app/product-master.tsx");
  const manufacturerMaster = read("../app/manufacturer-master.tsx");
  const procurement = read("../app/procurement-center.tsx");
  assert.match(productMaster, /<ManufacturerMaster role=\{role\}/);
  assert.match(manufacturerMaster, /authenticatedFetch/);
  assert.match(manufacturerMaster, /only an active administrator changes the global master/);
  assert.match(manufacturerMaster, /Merge duplicate manufacturer/);
  assert.match(procurement, /submitted for administrator governance review/);
  assert.doesNotMatch(procurement, /Add or update manufacturer/);
});
