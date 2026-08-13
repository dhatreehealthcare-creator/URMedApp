import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CANONICAL_DOSAGE_FORMS,
  LEGACY_CATEGORY_TO_DOSAGE_FORM,
} from "../lib/dosage-forms.ts";

const migrationPath = new URL("../drizzle/0037_young_jack_flag.sql", import.meta.url);
const schemaPath = new URL("../db/schema.ts", import.meta.url);
const taxonomyDocPath = new URL("../docs/DOSAGE_FORM_TAXONOMY.md", import.meta.url);

const migrationSql = readFileSync(migrationPath, "utf8");
const executableMigrationSql = migrationSql.replaceAll("--> statement-breakpoint", "");

test("canonical dosage forms use stable governed identifiers", () => {
  assert.deepEqual(CANONICAL_DOSAGE_FORMS, [
    { id: 1, code: "TAB", slug: "tablet", name: "Tablet", status: "active", sortOrder: 10, legacyCategoryId: 1 },
    { id: 2, code: "CAP", slug: "capsule", name: "Capsule", status: "active", sortOrder: 20, legacyCategoryId: 2 },
    { id: 3, code: "INJ", slug: "injection", name: "Injection", status: "active", sortOrder: 30, legacyCategoryId: 3 },
    { id: 4, code: "OINT", slug: "ointment", name: "Ointment", status: "active", sortOrder: 40, legacyCategoryId: 4 },
    { id: 5, code: "CRM", slug: "cream", name: "Cream", status: "active", sortOrder: 50, legacyCategoryId: 5 },
    { id: 6, code: "AER", slug: "aerosol", name: "Aerosol", status: "active", sortOrder: 60, legacyCategoryId: 6 },
    { id: 7, code: "TDP", slug: "transdermal-patch", name: "Transdermal Patch", status: "active", sortOrder: 70, legacyCategoryId: 7 },
    { id: 8, code: "SYR", slug: "syrup", name: "Syrup", status: "active", sortOrder: 80, legacyCategoryId: 8 },
  ]);

  for (const key of ["id", "code", "slug", "name", "sortOrder"]) {
    assert.equal(new Set(CANONICAL_DOSAGE_FORMS.map((form) => form[key])).size, 8);
  }
  assert.deepEqual(LEGACY_CATEGORY_TO_DOSAGE_FORM, {
    1: 1,
    2: 2,
    3: 3,
    4: 4,
    5: 5,
    6: 6,
    7: 7,
    8: 8,
  });
});

test("migration is repeatable and seeds the exact canonical dosage forms", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(executableMigrationSql);
  database.exec(executableMigrationSql);

  const rows = database.prepare(`
    SELECT id, code, slug, name, status, sort_order AS sortOrder
    FROM dosage_forms
    ORDER BY sort_order
  `).all().map((row) => ({ ...row }));
  assert.deepEqual(rows, CANONICAL_DOSAGE_FORMS.map((form) => ({
    id: form.id,
    code: form.code,
    slug: form.slug,
    name: form.name,
    status: form.status,
    sortOrder: form.sortOrder,
  })));

  const indexes = database.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'index' AND tbl_name = 'dosage_forms'
    ORDER BY name
  `).all().map((row) => row.name);
  assert.deepEqual(indexes, [
    "dosage_forms_code_uidx",
    "dosage_forms_name_uidx",
    "dosage_forms_slug_uidx",
    "dosage_forms_sort_order_uidx",
  ]);
  database.close();
});

test("dosage forms remain separate from legacy commercial categories", () => {
  const schema = readFileSync(schemaPath, "utf8");
  const documentation = readFileSync(taxonomyDocPath, "utf8");

  assert.match(schema, /categories = sqliteTable\("categories"/);
  assert.match(schema, /dosageForms = sqliteTable\("dosage_forms"/);
  assert.match(schema, /categoryId: integer\("category_id"\)\.references\(\(\) => categories\.id\)/);
  assert.match(schema, /dosageFormId: integer\("dosage_form_id"\)\.references\(\(\) => dosageForms\.id\)/);
  assert.doesNotMatch(migrationSql, /ALTER TABLE [`"]?products|UPDATE [`"]?categories/iu);
  assert.match(documentation, /They are not commercial product categories\./);
  assert.match(documentation, /leaves those foreign keys and the legacy `categories` rows unchanged/);
  assert.match(documentation, /P2-02/);
});
