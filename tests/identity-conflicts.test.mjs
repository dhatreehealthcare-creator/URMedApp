import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  isProviderIdentityConflict,
  SAFE_EMAIL_REGISTRATION_NOTICE,
  verifiedContactConflictMessage,
} from "../lib/auth-identity-messages.ts";
import { errorResponse } from "../lib/api-errors.ts";
import {
  IdentityConflictError,
  identityConflictFromDatabaseError,
} from "../lib/identity-conflicts.ts";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("database identity constraint failures become structured, non-enumerating conflicts", async () => {
  const email = identityConflictFromDatabaseError(new Error(
    "D1_ERROR: UNIQUE constraint failed: index 'account_profiles_normalized_email_uidx': SQLITE_CONSTRAINT",
  ));
  assert.ok(email instanceof IdentityConflictError);
  assert.deepEqual(email.fields, ["email"]);

  const phone = identityConflictFromDatabaseError(new Error(
    "D1_ERROR: UNIQUE constraint failed: account_profiles.phone: SQLITE_CONSTRAINT",
  ));
  assert.ok(phone instanceof IdentityConflictError);
  assert.deepEqual(phone.fields, ["phone"]);
  assert.equal(identityConflictFromDatabaseError(new Error("UNIQUE constraint failed: purchase_orders.invoice_number")), null);

  const response = await errorResponse(email);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "This verified email is already linked to another URMED account",
    code: "identity_conflict",
    fields: ["email"],
  });
});

test("provider duplicate signals use safe public registration and verified-contact messages", () => {
  assert.equal(isProviderIdentityConflict({ code: "user_already_exists", message: "User already registered" }), true);
  assert.equal(isProviderIdentityConflict(new Error("Password should be at least 8 characters")), false);
  assert.match(SAFE_EMAIL_REGISTRATION_NOTICE, /If this email can be registered/i);
  assert.doesNotMatch(SAFE_EMAIL_REGISTRATION_NOTICE, /is already registered/i);
  assert.match(verifiedContactConflictMessage("phone"), /cannot be linked/i);
});

test("the normalized live-email index rejects case and whitespace variants", () => {
  const migration = read("../drizzle/0035_outstanding_krista_starr.sql");
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE account_profiles (id INTEGER PRIMARY KEY, email TEXT NOT NULL DEFAULT '');
      CREATE INDEX account_profiles_email_idx ON account_profiles(email);
      ${migration.replaceAll("--> statement-breakpoint", "")}
    `);
    database.prepare("INSERT INTO account_profiles (id,email) VALUES (?,?)").run(1, "Owner@Example.Test");
    assert.throws(
      () => database.prepare("INSERT INTO account_profiles (id,email) VALUES (?,?)").run(2, "  owner@example.test  "),
      /unique constraint/i,
    );
    database.prepare("INSERT INTO account_profiles (id,email) VALUES (?,?)").run(3, "");
    database.prepare("INSERT INTO account_profiles (id,email) VALUES (?,?)").run(4, "   ");
  } finally {
    database.close();
  }
});

test("the P1-03 migration preserves the old lookup index until uniqueness is proven", () => {
  const migration = read("../drizzle/0035_outstanding_krista_starr.sql");
  assert.match(migration, /lower\(trim\("email"\)\)/);
  assert.match(migration, /WHERE trim\("account_profiles"\."email"\) <> ''/);
  assert.ok(migration.indexOf("CREATE UNIQUE INDEX") < migration.indexOf("DROP INDEX"));
  assert.doesNotMatch(migration, /UPDATE account_profiles|DELETE FROM account_profiles|FROM customers/i);
});

test("profile creation remains idempotent while the final D1 constraints close races", () => {
  const route = read("../app/api/auth/profile/route.ts");
  const schema = read("../db/schema.ts");
  assert.match(route, /lower\(trim\(email\)\) = \?/);
  assert.match(route, /throw new IdentityConflictError\(\["email"\]\)/);
  assert.match(route, /throw new IdentityConflictError\(\["phone"\]\)/);
  assert.match(route, /await db\.batch\(\[/);
  assert.match(route, /ON CONFLICT\(profile_id\) DO NOTHING/);
  assert.match(schema, /account_profiles_normalized_email_uidx/);
  assert.match(schema, /account_profiles_phone_uidx/);
});

test("public email signup does not distinguish duplicate from accepted pending registration", () => {
  const authPanel = read("../app/auth-panel.tsx");
  assert.match(authPanel, /isProviderIdentityConflict\(authError\)/);
  assert.equal(authPanel.match(/setMessage\(SAFE_EMAIL_REGISTRATION_NOTICE\)/g)?.length, 2);
  assert.doesNotMatch(authPanel, /This email address is already registered/);
});

