import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migrationPath = new URL("../drizzle/0038_pale_shape.sql", import.meta.url);
const schemaPath = new URL("../db/schema.ts", import.meta.url);
const reviewPath = new URL("../docs/PRODUCT_VARIANT_MODEL_AND_0038_MIGRATION.md", import.meta.url);
const integrationFixturePath = new URL("./integration/fixtures/phase0.sql", import.meta.url);
const migrationSql = readFileSync(migrationPath, "utf8").replaceAll("--> statement-breakpoint", "");

function fixtureDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE categories (id INTEGER PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active');
    CREATE TABLE dosage_forms (id INTEGER PRIMARY KEY, code TEXT NOT NULL, slug TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL, sort_order INTEGER NOT NULL);
    CREATE TABLE manufacturers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, normalized_name TEXT NOT NULL UNIQUE);
    CREATE TABLE products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      legacy_id INTEGER NOT NULL UNIQUE,
      category_id INTEGER REFERENCES categories(id),
      display_category_id INTEGER,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      composition TEXT NOT NULL DEFAULT '',
      manufacturer TEXT NOT NULL DEFAULT '',
      prescription_required INTEGER NOT NULL DEFAULT 0,
      gst_percent INTEGER NOT NULL DEFAULT 0,
      hsn_code TEXT NOT NULL DEFAULT '',
      packaging TEXT NOT NULL DEFAULT '',
      generic_name TEXT NOT NULL DEFAULT '',
      trade_name TEXT NOT NULL DEFAULT '',
      product_information TEXT NOT NULL DEFAULT '',
      drug_schedule TEXT NOT NULL DEFAULT 'UNCLASSIFIED',
      cold_chain_required INTEGER NOT NULL DEFAULT 0,
      nppa_ceiling_paise INTEGER,
      active INTEGER NOT NULL DEFAULT 1,
      source TEXT NOT NULL DEFAULT 'legacy_backup',
      migrated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE migration_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_file TEXT NOT NULL,
      source_sha256 TEXT NOT NULL,
      entity TEXT NOT NULL,
      source_rows INTEGER NOT NULL,
      imported_rows INTEGER NOT NULL,
      rejected_rows INTEGER NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO categories (id, name) VALUES (1, 'Legacy catch-all');
    INSERT INTO dosage_forms (id, code, slug, name, status, sort_order) VALUES
      (1, 'TAB', 'tablet', 'Tablet', 'active', 10),
      (2, 'CAP', 'capsule', 'Capsule', 'active', 20),
      (3, 'INJ', 'injection', 'Injection', 'active', 30),
      (4, 'OINT', 'ointment', 'Ointment', 'active', 40),
      (5, 'CRM', 'cream', 'Cream', 'active', 50),
      (6, 'AER', 'aerosol', 'Aerosol', 'active', 60),
      (7, 'TDP', 'transdermal-patch', 'Transdermal Patch', 'active', 70),
      (8, 'SYR', 'syrup', 'Syrup', 'active', 80);
    INSERT INTO manufacturers (id, name, normalized_name) VALUES
      (1, 'Acme Pharma Pvt. Ltd.', 'acme pharma pvt ltd'),
      (2, 'Disinfecto Chemical Industries Pvt. Ltd.', 'disinfecto chemical industries pvt ltd');
    INSERT INTO products
      (legacy_id, category_id, name, normalized_name, composition, manufacturer, prescription_required, gst_percent, packaging, source, active)
    VALUES
      (101, 1, 'Paracip 650 Tablet', 'paracip 650 tablet', 'Paracetamol(650mg)', 'Acme Pharma Pvt. Ltd.', 1, 5, 'Strip of 10 Tablet', 'legacy_backup', 1),
      (102, 1, 'Levo Syrup', 'levo syrup', 'Levocetirizine(2.5mg/5ml)', 'Disinfecto Chemical Industries Pvt Ltd', 0, 12, 'Bottle of 60ml Syrup', 'legacy_backup', 1),
      (103, 1, 'Combination Dilution', 'combination dilution', 'Drug A(20mg), Drug B(10mg)', 'Unknown Laboratories', 0, 0, 'Bottle of 30ml Dilution', 'legacy_backup', 1),
      (104, 1, 'Unreviewed Local Product', 'unreviewed local product', '', 'Unknown Laboratories', 0, 0, '', 'manual', 1);
  `);
  return database;
}

function applyMigrationOnce(database) {
  database.exec("CREATE TABLE IF NOT EXISTS local_migration_ledger (tag TEXT PRIMARY KEY)");
  const applied = database.prepare("SELECT 1 FROM local_migration_ledger WHERE tag = '0038_pale_shape'").get();
  if (applied) return;
  database.exec(migrationSql);
  database.prepare("INSERT INTO local_migration_ledger (tag) VALUES ('0038_pale_shape')").run();
}

test("0038 backfills only deterministic structured product data", () => {
  const database = fixtureDatabase();
  applyMigrationOnce(database);
  applyMigrationOnce(database);

  const products = database.prepare(`
    SELECT legacy_id AS legacyId, manufacturer_id AS manufacturerId, dosage_form_id AS dosageFormId,
      generic_name AS genericName, normalized_generic_name AS normalizedGenericName,
      trade_name AS tradeName, normalized_trade_name AS normalizedTradeName,
      strength_value AS strengthValue, strength_unit AS strengthUnit,
      pack_type AS packType, pack_size_value AS packSizeValue, pack_size_unit AS packSizeUnit,
      dispensing_uom AS dispensingUom, governance_status AS governanceStatus, active
    FROM products ORDER BY legacy_id
  `).all().map((row) => ({ ...row }));

  assert.deepEqual(products[0], {
    legacyId: 101,
    manufacturerId: 1,
    dosageFormId: 1,
    genericName: "Paracetamol",
    normalizedGenericName: "paracetamol",
    tradeName: "Paracip 650 Tablet",
    normalizedTradeName: "paracip 650 tablet",
    strengthValue: "650",
    strengthUnit: "mg",
    packType: "strip",
    packSizeValue: "10",
    packSizeUnit: "tablet",
    dispensingUom: "tablet",
    governanceStatus: "approved",
    active: 1,
  });
  assert.equal(products[1].manufacturerId, 2, "unique normalized fallback should link the display-name variant");
  assert.equal(products[1].dosageFormId, 8);
  assert.equal(products[1].strengthValue, "2.5");
  assert.equal(products[1].strengthUnit, "mg/5ml");
  assert.equal(products[1].packSizeValue, "60");
  assert.equal(products[1].packSizeUnit, "ml");
  assert.equal(products[2].manufacturerId, null);
  assert.equal(products[2].dosageFormId, null);
  assert.equal(products[2].strengthValue, null);
  assert.equal(products[2].genericName, "");
  assert.equal(products[2].packSizeValue, "30");
  assert.equal(products[2].packSizeUnit, "ml");
  assert.equal(products[3].governanceStatus, "pending");
  assert.equal(products[3].active, 0);

  const audit = database.prepare(`
    SELECT source_rows AS sourceRows, notes FROM migration_audit
    WHERE entity = 'product_variant_backfill'
  `).get();
  assert.equal(audit.sourceRows, 4);
  assert.match(audit.notes, /manufacturer_id=2/);
  assert.match(audit.notes, /dosage_form_id=2/);
  assert.match(audit.notes, /ambiguous values intentionally remain NULL/);
  assert.equal(database.prepare("SELECT count(*) AS count FROM migration_audit WHERE entity = 'product_variant_backfill'").get().count, 1);
  database.close();
});

test("structured product guards reject unsafe defaults and partial values", () => {
  const database = fixtureDatabase();
  applyMigrationOnce(database);

  assert.throws(() => database.exec(`
    INSERT INTO products (legacy_id, name, normalized_name, source)
    VALUES (201, 'Pending but active', 'pending but active', 'manual')
  `), /invalid structured product variant/);
  assert.doesNotThrow(() => database.exec(`
    INSERT INTO products (legacy_id, name, normalized_name, source, active)
    VALUES (202, 'Inactive submission', 'inactive submission', 'manual', 0)
  `));
  assert.throws(() => database.exec("UPDATE products SET strength_value = '10' WHERE legacy_id = 202"), /invalid structured product variant/);
  assert.throws(() => database.exec("UPDATE products SET strength_value = '10mg', strength_unit = 'mg' WHERE legacy_id = 202"), /invalid structured product variant/);
  assert.throws(() => database.exec("UPDATE products SET gst_percent = 7 WHERE legacy_id = 202"), /invalid structured product variant/);
  assert.throws(() => database.exec("UPDATE products SET prescription_required = 3 WHERE legacy_id = 202"), /invalid structured product variant/);
  assert.doesNotThrow(() => database.exec(`
    UPDATE products SET strength_value = '10', strength_unit = 'mg', governance_status = 'approved', active = 1
    WHERE legacy_id = 202
  `));
  database.close();
});

test("packaged integration products declare approved governance before activation", () => {
  const fixture = readFileSync(integrationFixturePath, "utf8");
  const productStatements = fixture.match(/INSERT INTO products[\s\S]*?;/g) ?? [];
  assert.ok(productStatements.length >= 1);
  for (const statement of productStatements) {
    assert.match(statement, /source, governance_status,[^)]*active\)/);
    assert.doesNotMatch(statement, /'p(?:009|4|304)_integration_fixture',\s*1\)/);
  }
  const productFixtureSql = productStatements.join("\n");
  const integrationProducts = productFixtureSql.match(/'p(?:009|4|304)_integration_fixture'/g) ?? [];
  const approvedIntegrationProducts = productFixtureSql.match(/'p(?:009|4|304)_integration_fixture',\s*'approved',/g) ?? [];
  assert.ok(integrationProducts.length > 0);
  assert.equal(approvedIntegrationProducts.length, integrationProducts.length);
});

test("schema and review notes preserve compatibility and defer alternate APIs", () => {
  const schema = readFileSync(schemaPath, "utf8");
  const review = readFileSync(reviewPath, "utf8");
  assert.match(schema, /manufacturerId: integer\("manufacturer_id"\)\.references\(\(\) => manufacturers\.id\)/);
  assert.match(schema, /dosageFormId: integer\("dosage_form_id"\)\.references\(\(\) => dosageForms\.id\)/);
  assert.match(schema, /products_equivalence_idx/);
  assert.match(schema, /governanceStatus: text\("governance_status"/);
  assert.match(review, /Legacy `name`, `composition`, `manufacturer`, `packaging`, `category_id`/);
  assert.match(review, /currently requires an active administrator/);
  assert.match(review, /does not change `product_alternates`/);
  assert.match(review, /SQLite does not support portable `ALTER TABLE \.\.\. ADD COLUMN IF NOT EXISTS`/);
  assert.doesNotMatch(migrationSql, /ALTER TABLE [`"]?product_alternates|UPDATE [`"]?product_alternates/iu);
});
