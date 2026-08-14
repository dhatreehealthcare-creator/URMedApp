import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { sha256 } from "../lib/test-auth.ts";

test("local admin, vendor, and customer credentials are deterministic fixture-only identities", async () => {
  const [identityMigration, adminMigration, fixture, route, authUi, guide] = await Promise.all([
    readFile("drizzle/0028_mature_namorita.sql", "utf8"),
    readFile("drizzle/0029_petite_sprite.sql", "utf8"),
    readFile("tests/integration/fixtures/phase0.sql", "utf8"),
    readFile("app/api/auth/test-login/route.ts", "utf8"),
    readFile("app/auth-panel.tsx", "utf8"),
    readFile("docs/LOCAL_TEST_CREDENTIALS.md", "utf8"),
  ]);
  const passwordHash = await sha256("Urmed@Test2026!");
  for (const email of ["customer@urmed.test", "vendor@urmed.test", "admin@urmed.test"]) {
    assert.match(`${identityMigration}\n${adminMigration}`, new RegExp(email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(`${identityMigration}\n${adminMigration}`, new RegExp(`${passwordHash}`));
  }
  assert.match(identityMigration, /'test:customer', 'customer'/);
  assert.match(identityMigration, /'test:vendor', 'vendor'/);
  assert.match(adminMigration, /'test:admin', 'admin'/);
  assert.match(fixture, /INSERT INTO suppliers/);
  assert.match(fixture, /INSERT INTO customer_addresses/);
  assert.match(fixture, /INSERT INTO pharmacists/);
  assert.match(fixture, /INSERT INTO vendor_licences/);
  assert.match(route, /requireIntegrationTestRequest\(request\)/);
  assert.match(route, /APP_STAGE|integration/i);
  assert.doesNotMatch(authUi, /@urmed\.test|Urmed@Test2026|test-login/);
  assert.match(guide, /must\s+never be created in Supabase, Cloudflare, or any hosted\/production database/i);
});

test("integration suite logs in all three primary fixture roles and exercises wrong-role boundaries", async () => {
  const suite = await readFile("tests/integration/phase0-api.integration.test.mjs", "utf8");
  for (const email of ["customer@urmed.test", "vendor@urmed.test", "admin@urmed.test"]) {
    assert.match(suite, new RegExp(`login\\(\\"${email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\"\\)`));
  }
  assert.match(suite, /customer admin access/);
  assert.match(suite, /vendor admin access/);
  assert.match(suite, /cross-vendor/);
});
