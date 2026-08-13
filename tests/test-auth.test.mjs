import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  isTestAuthenticationEnabled,
  randomTestToken,
  requireIntegrationTestRequest,
  sha256,
  TEST_AUTH_HEADER,
  TEST_TOKEN_PREFIX,
} from "../lib/test-auth.ts";
import { requireAuthUser } from "../lib/auth-server.ts";

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

test("test authentication requires the integration stage and a strong runtime-only secret", () => {
  assert.equal(isTestAuthenticationEnabled({}), false);
  assert.equal(isTestAuthenticationEnabled({ APP_STAGE: "production", INTEGRATION_TEST_AUTH_SECRET: "x".repeat(64) }), false);
  assert.equal(isTestAuthenticationEnabled({ APP_STAGE: "testing", INTEGRATION_TEST_AUTH_SECRET: "x".repeat(64) }), false);
  assert.equal(isTestAuthenticationEnabled({ APP_STAGE: "integration" }), false);
  assert.equal(isTestAuthenticationEnabled({ APP_STAGE: "integration", INTEGRATION_TEST_AUTH_SECRET: "too-short" }), false);
  assert.equal(isTestAuthenticationEnabled({ APP_STAGE: "integration", INTEGRATION_TEST_AUTH_SECRET: "x".repeat(32) }), true);
});

test("the integration test-login route requires its private request secret", async () => {
  const secret = "unit-test-auth-secret-that-is-long-enough";
  globalThis.__URMED_RUNTIME__ = { APP_STAGE: "integration", INTEGRATION_TEST_AUTH_SECRET: secret };
  try {
    await assert.rejects(
      requireIntegrationTestRequest(new Request("https://urmed.example/api/auth/test-login")),
      (error) => error instanceof Response && error.status === 404,
    );
    await assert.rejects(
      requireIntegrationTestRequest(new Request("https://urmed.example/api/auth/test-login", { headers: { [TEST_AUTH_HEADER]: "wrong-secret-that-is-also-long-enough" } })),
      (error) => error instanceof Response && error.status === 404,
    );
    await requireIntegrationTestRequest(new Request("https://urmed.example/api/auth/test-login", { headers: { [TEST_AUTH_HEADER]: secret } }));
  } finally {
    delete globalThis.__URMED_RUNTIME__;
  }
});

test("production rejects the test-login route and test bearer tokens before database access", async () => {
  const route = readFileSync(new URL("../app/api/auth/test-login/route.ts", import.meta.url), "utf8");
  const guardPosition = route.indexOf("await requireIntegrationTestRequest(request)");
  assert.ok(guardPosition >= 0);
  assert.ok(guardPosition < route.indexOf("await request.json()"));
  assert.ok(guardPosition < route.indexOf("const db = getD1()"));
  globalThis.__URMED_RUNTIME__ = {
    APP_STAGE: "production",
    INTEGRATION_TEST_AUTH_SECRET: "must-not-enable-outside-integration-stage",
  };
  delete globalThis.__URMED_D1__;
  try {
    await assert.rejects(
      requireAuthUser(new Request("https://urmed.example/api/admin/operations", {
        headers: { authorization: "Bearer urmed_test_known-token" },
      })),
      (error) => error instanceof Response && error.status === 401,
    );
  } finally {
    delete globalThis.__URMED_RUNTIME__;
  }
});
