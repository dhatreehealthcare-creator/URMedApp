import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { canonicalProductPair, listVendorAlternateCandidates, loadCompatibleAlternatePair, parseAlternateQuery } from "../lib/product-alternates.ts";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

class Statement {
  constructor(database, sql) { this.database = database; this.sql = sql; this.values = []; }
  bind(...values) { this.values = values; return this; }
  async first() { return this.database.prepare(this.sql).get(...this.values) ?? null; }
  async all() { return { results: this.database.prepare(this.sql).all(...this.values).map((row) => ({ ...row })) }; }
  async run() { const result = this.database.prepare(this.sql).run(...this.values); return { meta: { changes: Number(result.changes) } }; }
}
class D1 { constructor(database) { this.database = database; } prepare(sql) { return new Statement(this.database, sql); } }

function migratedFixture() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE account_profiles (id INTEGER PRIMARY KEY);
    CREATE TABLE vendors (id INTEGER PRIMARY KEY);
    CREATE TABLE dosage_forms (id INTEGER PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TABLE manufacturers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, normalized_name TEXT NOT NULL);
    CREATE TABLE manufacturer_canonical_state (manufacturer_id INTEGER PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE products (
      id INTEGER PRIMARY KEY, trade_name TEXT NOT NULL, normalized_trade_name TEXT NOT NULL,
      generic_name TEXT NOT NULL, normalized_generic_name TEXT NOT NULL,
      dosage_form_id INTEGER, manufacturer_id INTEGER, strength_value TEXT, strength_unit TEXT,
      active INTEGER NOT NULL, governance_status TEXT NOT NULL
    );
    CREATE TABLE migration_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source_file TEXT NOT NULL, source_sha256 TEXT NOT NULL,
      entity TEXT NOT NULL, source_rows INTEGER NOT NULL, imported_rows INTEGER NOT NULL,
      rejected_rows INTEGER NOT NULL, notes TEXT NOT NULL
    );
    CREATE TABLE product_alternates (
      id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL,
      alternate_product_id INTEGER NOT NULL, created_by_profile_id INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO account_profiles VALUES (10), (20);
    INSERT INTO vendors VALUES (7), (8);
    INSERT INTO dosage_forms VALUES (1, 'Tablet', 'active'), (2, 'Capsule', 'active');
    INSERT INTO manufacturers VALUES (1, 'Acme Pharma', 'acme pharma');
    INSERT INTO manufacturer_canonical_state VALUES (1, 'active');
    INSERT INTO products VALUES
      (1, 'Para A', 'para a', 'Paracetamol', 'paracetamol', 1, 1, '650', 'mg', 1, 'approved'),
      (2, 'Para B', 'para b', 'Paracetamol', 'paracetamol', 1, 1, '650', 'mg', 1, 'approved'),
      (3, 'Para C', 'para c', 'Paracetamol', 'paracetamol', 1, 1, '500', 'mg', 1, 'approved'),
      (4, 'Para Cap', 'para cap', 'Paracetamol', 'paracetamol', 2, 1, '650', 'mg', 1, 'approved');
    INSERT INTO product_alternates (product_id, alternate_product_id, created_by_profile_id)
      VALUES (1, 2, 10), (2, 1, 20), (1, 1, 10);
  `);
  database.exec(read("../drizzle/0040_milky_grim_reaper.sql").replaceAll("--> statement-breakpoint", ""));
  return database;
}

test("alternate IDs are canonical, distinct, and query inputs are bounded", () => {
  assert.deepEqual(canonicalProductPair(9, 2), { productId: 2, alternateProductId: 9 });
  assert.throws(() => canonicalProductPair(2, 2), (error) => error instanceof Response && error.status === 400);
  assert.deepEqual(parseAlternateQuery(new URL("https://urmed.test/api?q=%20Para%20&status=approved&page=-1&pageSize=999&productId=6")), {
    productId: 6, query: "Para", status: "approved", page: 1, pageSize: 50,
  });
});

test("0040 canonicalizes legacy links and database guards enforce D-09 compatibility and lifecycle", async () => {
  const sqlite = migratedFixture();
  assert.deepEqual(sqlite.prepare("SELECT product_id AS productId, alternate_product_id AS alternateProductId, governance_status AS status FROM product_alternates").all().map((row) => ({ ...row })), [
    { productId: 1, alternateProductId: 2, status: "pending" },
  ]);
  assert.deepEqual({ ...sqlite.prepare("SELECT source_rows AS sourceRows, imported_rows AS importedRows, rejected_rows AS rejectedRows FROM migration_audit").get() }, { sourceRows: 3, importedRows: 1, rejectedRows: 2 });
  const candidates = await listVendorAlternateCandidates(new D1(sqlite), 7, parseAlternateQuery(new URL("https://urmed.test/api?productId=1&q=Para")));
  assert.equal(candidates.candidates.length, 1);
  assert.equal(candidates.candidates[0].id, 2);
  assert.equal(candidates.policy.automaticSubstitution, false);

  sqlite.prepare("DELETE FROM product_alternates").run();
  sqlite.prepare("INSERT INTO product_alternates (product_id, alternate_product_id, submitted_vendor_id, created_by_profile_id) VALUES (1, 2, 7, 10)").run();
  assert.throws(() => sqlite.prepare("INSERT INTO product_alternates (product_id, alternate_product_id, submitted_vendor_id, created_by_profile_id) VALUES (2, 1, 7, 10)").run(), /CHECK constraint/);
  assert.throws(() => sqlite.prepare("INSERT INTO product_alternates (product_id, alternate_product_id, submitted_vendor_id, created_by_profile_id) VALUES (1, 3, 7, 10)").run(), /invalid alternate proposal/);
  assert.throws(() => sqlite.prepare("UPDATE product_alternates SET governance_status='approved' WHERE id=2").run(), /invalid alternate lifecycle/);
  sqlite.prepare("UPDATE product_alternates SET governance_status='approved', reviewed_by_profile_id=20, review_reason='Clinical review complete', reviewed_at=CURRENT_TIMESTAMP WHERE id=2").run();
  assert.throws(() => sqlite.prepare("UPDATE product_alternates SET governance_status='pending' WHERE id=2").run(), /invalid alternate lifecycle/);

  const compatible = await loadCompatibleAlternatePair(new D1(sqlite), 2, 1);
  assert.equal(compatible.normalizedGenericName, "paracetamol");
  await assert.rejects(loadCompatibleAlternatePair(new D1(sqlite), 1, 3), (error) => error instanceof Response && error.status === 409);
  sqlite.close();
});

test("alternate APIs enforce tenant submission and admin-only governance contracts", () => {
  const vendor = read("../app/api/vendor/product-alternates/route.ts");
  const admin = read("../app/api/admin/product-alternates/route.ts");
  const helper = read("../lib/product-alternates.ts");
  assert.equal(vendor.match(/requireAlternateSubmissionAccess\(request\)/g)?.length, 3);
  assert.equal(admin.match(/requireAdminProfile\(request\)/g)?.length, 2);
  assert.match(vendor, /WHERE id = \? AND submitted_vendor_id = \? AND governance_status = 'pending'/);
  assert.match(vendor, /submitted_vendor_id = \? AND governance_status = 'pending'/);
  assert.match(helper, /staffRole !== "pharmacist"/);
  assert.match(helper, /verification_status = 'verified'/);
  assert.match(helper, /link\.governance_status = 'approved' OR link\.submitted_vendor_id = \?/);
  assert.match(admin, /loadCompatibleAlternatePair/);
  assert.doesNotMatch(vendor, /governance_status = 'approved'/);
  assert.match(vendor + admin, /automaticSubstitution: false/);
});

test("live product master delegates governed alternates to authenticated API UI", () => {
  const master = read("../app/product-master.tsx");
  const alternates = read("../app/product-alternates.tsx");
  assert.match(master, /<ProductAlternates role="vendor"/);
  assert.match(master, /<ProductAlternates role="admin"/);
  assert.match(alternates, /authenticatedFetch/);
  assert.match(alternates, /never enables automatic substitution/);
  assert.match(alternates, /Clinical decision required/);
});

test("the packaged Worker contains alternate routes after the next verified build", { skip: !read("../dist/server/index.js").includes("route:/api/vendor/product-alternates") }, () => {
  const worker = read("../dist/server/index.js");
  assert.match(worker, /route:\/api\/vendor\/product-alternates/);
  assert.match(worker, /route:\/api\/admin\/product-alternates/);
});
