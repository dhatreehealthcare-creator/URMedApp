import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  canonicalPositiveDecimal,
  escapeProductSqlLike,
  insertPendingProduct,
  loadProductReferences,
  parseProductMasterQuery,
  parseStructuredProductInput,
  productDuplicatePredicate,
  structuredLegacyFields,
  vendorProductSource,
} from "../lib/product-master.ts";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

class TestD1Statement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async first() {
    return this.database.prepare(this.sql).get(...this.values) ?? null;
  }

  async all() {
    return { results: this.database.prepare(this.sql).all(...this.values).map((row) => ({ ...row })) };
  }

  async run() {
    const result = this.database.prepare(this.sql).run(...this.values);
    return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }
}

class TestD1Database {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    return new TestD1Statement(this.database, sql);
  }

  async batch(statements) {
    const results = [];
    for (const statement of statements) results.push(await statement.all());
    return results;
  }
}

function validProduct(overrides = {}) {
  return {
    genericName: "Paracetamol",
    tradeName: "URMED Para 650",
    dosageFormId: 1,
    manufacturerId: 7,
    strengthValue: "650.00",
    strengthUnit: "MG",
    packType: "Strip",
    packSizeValue: "10",
    packSizeUnit: "Tablet",
    dispensingUom: "Tablet",
    prescriptionRequired: false,
    gstPercent: 5,
    hsnCode: "300490",
    drugSchedule: "OTC",
    productInformation: "Governed fever and pain product.",
    coldChainRequired: false,
    ...overrides,
  };
}

test("product query, text, and numeric inputs are normalized and bounded", () => {
  assert.deepEqual(parseProductMasterQuery(new URL("https://urmed.test/api/vendor/products?q=%20Para%20%20Acme%20&status=pending&manufacturerQ=%20Acme%20&page=3&pageSize=500")), {
    query: "Para Acme",
    status: "pending",
    manufacturerQuery: "acme",
    page: 3,
    pageSize: 50,
  });
  const invalid = parseProductMasterQuery(new URL("https://urmed.test/api/admin/products?status=DROP&page=-2&pageSize=x"));
  assert.equal(invalid.status, "all");
  assert.equal(invalid.page, 1);
  assert.equal(invalid.pageSize, 12);
  assert.equal(escapeProductSqlLike("50%_off\\today"), "50\\%\\_off\\\\today");
  assert.equal(canonicalPositiveDecimal("650.00", "Strength"), "650");
  assert.throws(() => canonicalPositiveDecimal("10mg", "Strength"), (error) => error instanceof Response && error.status === 400);
});

test("structured product validation enforces governed fields", () => {
  const parsed = parseStructuredProductInput(validProduct());
  assert.equal(parsed.normalizedGenericName, "paracetamol");
  assert.equal(parsed.normalizedTradeName, "urmed para 650");
  assert.equal(parsed.strengthValue, "650");
  assert.equal(parsed.strengthUnit, "mg");
  assert.equal(parsed.packSizeUnit, "tablet");
  assert.equal(parsed.gstPercent, 5);
  assert.throws(() => parseStructuredProductInput(validProduct({ gstPercent: 7 })), (error) => error instanceof Response && error.status === 400);
  assert.throws(() => parseStructuredProductInput(validProduct({ hsnCode: "30A4" })), (error) => error instanceof Response && error.status === 400);
  assert.throws(() => parseStructuredProductInput(validProduct({ prescriptionRequired: "yes" })), (error) => error instanceof Response && error.status === 400);
});

test("active master references are required and legacy compatibility text is deterministic", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE dosage_forms (id INTEGER PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TABLE manufacturers (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE manufacturer_canonical_state (manufacturer_id INTEGER PRIMARY KEY, status TEXT NOT NULL);
    INSERT INTO dosage_forms VALUES (1, 'Tablet', 'active'), (2, 'Capsule', 'inactive');
    INSERT INTO manufacturers VALUES (7, 'Acme Pharma');
    INSERT INTO manufacturer_canonical_state VALUES (7, 'active');
  `);
  const database = new TestD1Database(sqlite);
  const input = parseStructuredProductInput(validProduct());
  const references = await loadProductReferences(database, input);
  assert.deepEqual(references, { dosageFormName: "Tablet", manufacturerName: "Acme Pharma" });
  assert.deepEqual(structuredLegacyFields(input, references), {
    name: "URMED Para 650",
    normalizedName: "urmed para 650 paracetamol",
    composition: "Paracetamol(650mg)",
    manufacturer: "Acme Pharma",
    packaging: "Strip of 10tablet",
  });
  await assert.rejects(loadProductReferences(database, { ...input, dosageFormId: 2 }), (error) => error instanceof Response && error.status === 400);
  sqlite.close();
});

test("pending inserts allocate compatibility IDs atomically and reject duplicate variants", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      legacy_id INTEGER NOT NULL UNIQUE,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      composition TEXT NOT NULL DEFAULT '',
      manufacturer TEXT NOT NULL DEFAULT '',
      manufacturer_id INTEGER,
      dosage_form_id INTEGER,
      strength_value TEXT,
      strength_unit TEXT,
      pack_type TEXT,
      pack_size_value TEXT,
      pack_size_unit TEXT,
      dispensing_uom TEXT,
      normalized_generic_name TEXT NOT NULL DEFAULT '',
      normalized_trade_name TEXT NOT NULL DEFAULT '',
      prescription_required INTEGER NOT NULL DEFAULT 0,
      gst_percent INTEGER NOT NULL DEFAULT 0,
      hsn_code TEXT NOT NULL DEFAULT '',
      packaging TEXT NOT NULL DEFAULT '',
      generic_name TEXT NOT NULL DEFAULT '',
      trade_name TEXT NOT NULL DEFAULT '',
      product_information TEXT NOT NULL DEFAULT '',
      drug_schedule TEXT NOT NULL DEFAULT 'UNCLASSIFIED',
      cold_chain_required INTEGER NOT NULL DEFAULT 0,
      governance_status TEXT NOT NULL DEFAULT 'pending',
      active INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO products (legacy_id, name, normalized_name, source, governance_status, active)
    VALUES (100041, 'Recovered product', 'recovered product', 'legacy_backup', 'approved', 1);
  `);
  const database = new TestD1Database(sqlite);
  const references = { dosageFormName: "Tablet", manufacturerName: "Acme Pharma" };
  const firstInput = parseStructuredProductInput(validProduct());
  const first = await insertPendingProduct(database, firstInput, references, 42);
  const second = await insertPendingProduct(database, parseStructuredProductInput(validProduct({ tradeName: "URMED Para 500", strengthValue: "500" })), references, 42);
  const duplicate = await insertPendingProduct(database, firstInput, references, 99);
  assert.deepEqual({ ...first }, { id: 2, compatibilityId: 900000000 });
  assert.deepEqual({ ...second }, { id: 3, compatibilityId: 900000001 });
  assert.equal(duplicate, null);
  const rows = sqlite.prepare("SELECT legacy_id AS compatibilityId, source, governance_status AS status, active FROM products WHERE legacy_id >= 900000000 ORDER BY legacy_id").all().map((row) => ({ ...row }));
  assert.deepEqual(rows, [
    { compatibilityId: 900000000, source: "vendor_submission:42", status: "pending", active: 0 },
    { compatibilityId: 900000001, source: "vendor_submission:42", status: "pending", active: 0 },
  ]);
  sqlite.close();
});

test("vendor and admin product routes enforce governance, ownership, conflicts, and atomic compatibility IDs", () => {
  const vendorRoute = read("../app/api/vendor/products/route.ts");
  const adminRoute = read("../app/api/admin/products/route.ts");
  const helper = read("../lib/product-master.ts");
  const vendorAccess = read("../lib/vendor-access.ts");
  assert.equal(vendorRoute.match(/requireVendorPermission\(request, "product\.submit"\)/g)?.length, 3);
  assert.equal(adminRoute.match(/requireAdminProfile\(request\)/g)?.length, 2);
  assert.match(vendorAccess, /\| "product\.submit"/);
  assert.match(helper, /CASE WHEN COALESCE\(MAX\(allocation\.legacy_id\), 0\) < 900000000/);
  assert.match(helper, /RETURNING id, legacy_id AS compatibilityId/);
  assert.match(vendorRoute, /WHERE id = \? AND source = \?/);
  assert.match(vendorRoute, /action: "product\.submitted"/);
  assert.match(adminRoute, /action: `admin\.product\.\$\{action\}`/);
  assert.match(adminRoute, /FROM pharmacy_inventory/);
  assert.match(adminRoute, /quantity > 0 OR reserved_quantity > 0/);
  assert.match(productDuplicatePredicate(), /governance_status IN \('pending', 'approved'\)/);
  assert.equal(vendorProductSource(42), "vendor_submission:42");
  assert.doesNotMatch(vendorRoute, /INSERT INTO product_alternates|governance_status = 'approved'/);
  assert.match(adminRoute, /deactivateAlternatesForProduct/);
});

test("live product UI replaces the local-state prototype and uses authenticated APIs", () => {
  const portal = read("../app/requirements-portal.tsx");
  const component = read("../app/product-master.tsx");
  assert.match(portal, /<ProductMaster role="vendor"/);
  assert.match(portal, /<ProductMaster role="admin"/);
  assert.doesNotMatch(portal, /function ProductMaster\(/);
  assert.doesNotMatch(portal, /Paracip 650 Tablet|Calpol 650 Tablet|P-650 Tablet/);
  assert.match(component, /authenticatedFetch\(`\$\{endpoint\}\?\$\{parameters\}`/);
  assert.match(component, /authenticatedFetch\(endpoint, \{ method/);
  assert.match(component, /active administrator approves it/);
  assert.match(component, /Compatibility #\{product\.compatibilityId\}/);
  assert.match(component, /<ProductAlternates role="vendor"/);
  assert.match(component, /<ProductAlternates role="admin"/);
});

test("the current packaged Worker must contain both product API routes after the verified build", { skip: !read("../dist/server/index.js").includes("route:/api/vendor/products") }, () => {
  const worker = read("../dist/server/index.js");
  assert.match(worker, /route:\/api\/vendor\/products/);
  assert.match(worker, /route:\/api\/admin\/products/);
});
