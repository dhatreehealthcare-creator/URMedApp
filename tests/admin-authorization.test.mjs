import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { requireAdminProfile } from "../lib/admin-access.ts";

class AuthStatement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
  }

  bind() {
    return this;
  }

  async first() {
    if (this.sql.includes("FROM test_sessions")) {
      return {
        id: `test:${this.database.role}`,
        email: `${this.database.role}@urmed.test`,
        phone: this.database.role === "admin" ? "0000000003" : "0000000001",
        role: this.database.role,
      };
    }
    if (this.sql.includes("FROM account_profiles p")) {
      return {
        id: this.database.role === "admin" ? 3 : 1,
        authUserId: `test:${this.database.role}`,
        role: this.database.role,
        name: this.database.role === "admin" ? "URMED Test Administrator" : "URMED Test Customer",
        email: `${this.database.role}@urmed.test`,
        phone: this.database.role === "admin" ? "0000000003" : "0000000001",
        status: this.database.status,
        vendorId: null,
      };
    }
    throw new Error(`Unexpected authorization query: ${this.sql}`);
  }
}

class AuthDatabase {
  constructor(role, status = "active") {
    this.role = role;
    this.status = status;
  }

  prepare(sql) {
    return new AuthStatement(this, sql);
  }
}

function installDatabase(role, status = "active") {
  globalThis.__URMED_D1__ = new AuthDatabase(role, status);
  globalThis.__URMED_RUNTIME__ = {
    APP_STAGE: "integration",
    INTEGRATION_TEST_AUTH_SECRET: "unit-test-auth-secret-that-is-long-enough",
  };
}

function authenticatedRequest(role, url = "https://urmed.example/api/admin/operations") {
  return new Request(url, { headers: { Authorization: `Bearer urmed_test_${role}` } });
}

async function expectAuthorizationFailure(promise, status) {
  await assert.rejects(promise, (error) => error instanceof Response && error.status === status);
}

test.after(() => {
  delete globalThis.__URMED_D1__;
  delete globalThis.__URMED_RUNTIME__;
});

test("the shared admin contract accepts only an active admin profile", async () => {
  installDatabase("admin");
  const profile = await requireAdminProfile(authenticatedRequest("admin"));
  assert.equal(profile.id, 3);
  assert.equal(profile.role, "admin");

  installDatabase("customer");
  await expectAuthorizationFailure(requireAdminProfile(authenticatedRequest("customer")), 403);

  installDatabase("admin", "inactive");
  await expectAuthorizationFailure(requireAdminProfile(authenticatedRequest("admin")), 403);
});

test("Sites owner headers and the local hostname no longer bypass administrator authentication", async () => {
  installDatabase("admin");
  await expectAuthorizationFailure(requireAdminProfile(new Request("https://urmed.example/api/admin/recovery", {
    headers: { "oai-authenticated-user-email": "dhatreehealthcare@gmail.com" },
  })), 401);
  await expectAuthorizationFailure(requireAdminProfile(new Request("https://terminal.local/api/admin/recovery")), 401);
});

test("every admin API route uses the shared authorization contract", () => {
  const routes = [
    ["../app/api/admin/architecture/route.ts", 1],
    ["../app/api/admin/operations/route.ts", 2],
    ["../app/api/admin/registrations/route.ts", 1],
    ["../app/api/admin/reports/expenses/route.ts", 1],
    ["../app/api/admin/reports/home-delivery/route.ts", 1],
    ["../app/api/admin/reports/sales/route.ts", 1],
    ["../app/api/admin/reports/stock/route.ts", 1],
    ["../app/api/admin/stores/map/route.ts", 1],
    ["../app/api/admin/manufacturers/route.ts", 2],
    ["../app/api/admin/product-alternates/route.ts", 2],
    ["../app/api/admin/recovery/route.ts", 1],
    ["../app/api/admin/reminders/process/route.ts", 1],
    ["../app/api/admin/products/route.ts", 2],
    ["../app/api/admin/vendor-compliance/route.ts", 2],
  ];
  for (const [route, expectedChecks] of routes) {
    const source = readFileSync(new URL(route, import.meta.url), "utf8");
    assert.match(source, /requireAdminProfile\(request\)/, `${route} must enforce the shared admin contract`);
    assert.equal(source.match(/requireAdminProfile\(request\)/g)?.length, expectedChecks, `${route} has an unaccounted admin handler`);
    assert.doesNotMatch(source, /isAuthorizedOwner|terminal\.local|dhatreehealthcare@gmail\.com/);
  }
  const reminderRoute = readFileSync(new URL("../app/api/admin/reminders/process/route.ts", import.meta.url), "utf8");
  assert.equal(reminderRoute.match(/authorize\(request\)/g)?.length, 2, "both reminder handlers must use admin-or-job authorization");
});

test("every admin UI request uses the authenticated request helper", () => {
  const components = [
    "../app/operations-centers.tsx",
    "../app/admin-registration-list.tsx",
    "../app/admin-operational-reports.tsx",
    "../app/admin-store-map.tsx",
    "../app/manufacturer-master.tsx",
    "../app/product-alternates.tsx",
    "../app/product-master.tsx",
    "../app/requirements-portal.tsx",
    "../app/vendor-compliance.tsx",
  ];
  const endpoints = new Set();
  for (const component of components) {
    const source = readFileSync(new URL(component, import.meta.url), "utf8");
    for (const line of source.split("\n").filter((value) => value.includes("/api/admin/"))) {
      const endpoint = line.match(/\/api\/admin\/[a-z-/]+/)?.[0];
      if (!endpoint) continue;
      endpoints.add(endpoint);
      const directlyRequested = /(?:authenticatedFetch|fetch)\(/.test(line);
      const assignedToAuthenticatedEndpoint = /(?:const|let)\s+endpoint\s*=/.test(line)
        && source.includes("authenticatedFetch(endpoint");
      assert.ok(
        directlyRequested ? line.includes("authenticatedFetch(") : assignedToAuthenticatedEndpoint,
        `${component} has an admin endpoint without an authenticated request path`,
      );
    }
  }
  assert.deepEqual([...endpoints].sort(), [
    "/api/admin/architecture",
    "/api/admin/manufacturers",
    "/api/admin/operations",
    "/api/admin/product-alternates",
    "/api/admin/products",
    "/api/admin/recovery",
    "/api/admin/registrations",
    "/api/admin/reminders/process",
    "/api/admin/reports/",
    "/api/admin/stores/map",
    "/api/admin/vendor-compliance",
  ]);
});

test("the admin workspace is login-gated and public profile creation cannot create admins", () => {
  const gate = readFileSync(new URL("../app/protected-role-route.tsx", import.meta.url), "utf8");
  const adminPage = readFileSync(new URL("../app/admin/page.tsx", import.meta.url), "utf8");
  const authPanel = readFileSync(new URL("../app/auth-panel.tsx", import.meta.url), "utf8");
  const profileRoute = readFileSync(new URL("../app/api/auth/profile/route.ts", import.meta.url), "utf8");
  assert.match(adminPage, /<ProtectedRoleRoute role="admin"/);
  assert.match(gate, /<AuthPanel role=\{role\} onProfileChange=\{updateProfile\}/);
  assert.match(gate, /authorized && \(role === "delivery"/);
  assert.match(authPanel, /allowProfileCreation && !provisionedRole/);
  assert.match(authPanel, /useState<"register" \| "login">\(provisionedRole \? "login" : "register"\)/);
  assert.match(authPanel, /\{!provisionedRole && <div className="auth-switch"/);
  assert.match(profileRoute, /new Set\(\["customer", "vendor"\]\)/);
});
