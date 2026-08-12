import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { RECOVERED_CUSTOMER_IDENTITY_POLICY } from "../lib/customer-identity.ts";

const root = new URL("..", import.meta.url);
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

function filesBelow(path) {
  const directory = new URL(path, import.meta.url).pathname;
  const files = [];
  for (const entry of readdirSync(directory)) {
    const absolute = join(directory, entry);
    if (statSync(absolute).isDirectory()) files.push(...filesBelow(`../${relative(root.pathname, absolute)}`));
    else files.push(absolute);
  }
  return files;
}

test("the identity policy names Supabase and account_profiles as the live authorities", () => {
  assert.deepEqual(RECOVERED_CUSTOMER_IDENTITY_POLICY, {
    credentialAuthority: "supabase_auth",
    liveProfileAuthority: "account_profiles",
    recoveredCustomerClassification: "admin_only_reference",
    recoveredCustomersCanAuthenticate: false,
    automaticLinking: false,
    linkingStatus: "not_implemented",
  });
});

test("live authentication and customer-owned schema use account_profiles, never legacy customers", () => {
  const auth = read("../lib/auth-server.ts");
  const schema = read("../db/schema.ts");
  assert.match(auth, /WHERE p\.auth_user_id = \? LIMIT 1/);
  assert.match(auth, /if \(profile\.status !== "active"\)/);
  assert.doesNotMatch(auth, /\bcustomers\b/);
  assert.doesNotMatch(schema, /references\(\(\) => customers\.id\)/);
  assert.match(schema, /customerProfileId:[\s\S]*?references\(\(\) => accountProfiles\.id\)/);
});

test("the legacy customers archive has no operational API consumer", () => {
  const sqlCustomerReference = /\b(?:FROM|JOIN|INTO|UPDATE|DELETE\s+FROM)\s+`?customers`?\b/i;
  const consumers = filesBelow("../app/api")
    .filter((file) => file.endsWith("route.ts") && sqlCustomerReference.test(readFileSync(file, "utf8")))
    .map((file) => relative(root.pathname, file).replaceAll("\\", "/"));
  assert.deepEqual(consumers, ["app/api/admin/recovery/route.ts"]);

  const recovery = read("../app/api/admin/recovery/route.ts");
  assert.match(recovery, /await requireAdminProfile\(request\)/);
  assert.match(recovery, /identityPolicy: RECOVERED_CUSTOMER_IDENTITY_POLICY/);
});

test("legacy import skips credentials and the decision forbids automatic matching", () => {
  const importer = read("../scripts/import-urmed-backup.mjs");
  const decision = read("../docs/ACCOUNT_IDENTITY_SOURCE_OF_TRUTH.md");
  assert.match(importer, /\[legacyId, nameRaw, emailRaw, , mobileRaw/);
  assert.match(importer, /Legacy password hashes were deliberately excluded/);
  assert.match(decision, /must never be used as a fallback identity or login source/);
  assert.match(decision, /must never create a link or overwrite live profile data automatically/);
  assert.match(decision, /No migration is required/);
});
