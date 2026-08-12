import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { randomTestToken, sha256, TEST_TOKEN_PREFIX } from "../lib/test-auth.ts";

test("dummy password hash matches the seeded test accounts", async () => {
  assert.equal(await sha256("Urmed@Test2026!"), "82653beae118d41e23e29c582a86f50675468ed1b588c284704a7a3491e32184");
});

test("test sessions use unpredictable prefixed tokens", () => {
  const first = randomTestToken();
  const second = randomTestToken();
  assert.ok(first.startsWith(TEST_TOKEN_PREFIX));
  assert.ok(first.length > 50);
  assert.notEqual(first, second);
});

test("test sessions obtain provider verification claims only from explicit fixture columns", () => {
  const auth = readFileSync(new URL("../lib/auth-server.ts", import.meta.url), "utf8");
  assert.match(auth, /account\.email_confirmed AS emailConfirmed/);
  assert.match(auth, /account\.phone_confirmed AS phoneConfirmed/);
  assert.doesNotMatch(auth, /testUser\.email_confirmed_at/);
});
