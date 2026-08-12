import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isWorkspaceRoleAuthorized } from "../lib/role-access.ts";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("each role has a dedicated route wired to its exact protected workspace", () => {
  for (const role of ["vendor", "customer", "admin", "delivery"]) {
    const page = read(`../app/${role}/page.tsx`);
    assert.match(page, new RegExp(`<ProtectedRoleRoute role=["']${role}["']`));
  }
});

test("workspace authorization requires exact active role and completed vendor onboarding", () => {
  for (const role of ["customer", "admin", "delivery"]) {
    assert.equal(isWorkspaceRoleAuthorized({ role, status: "active", vendorAccessStatus: null }, role), true);
    assert.equal(isWorkspaceRoleAuthorized({ role, status: "inactive", vendorAccessStatus: null }, role), false);
  }
  assert.equal(isWorkspaceRoleAuthorized({ role: "vendor", status: "active", vendorAccessStatus: "operational" }, "vendor"), true);
  assert.equal(isWorkspaceRoleAuthorized({ role: "vendor", status: "active", vendorAccessStatus: "registration_draft" }, "vendor"), false);
  assert.equal(isWorkspaceRoleAuthorized({ role: "vendor", status: "active", vendorAccessStatus: "review_pending" }, "vendor"), false);
  assert.equal(isWorkspaceRoleAuthorized({ role: "customer", status: "active", vendorAccessStatus: null }, "admin"), false);
  assert.equal(isWorkspaceRoleAuthorized({ role: "admin", status: "active", vendorAccessStatus: null }, "vendor"), false);
  assert.equal(isWorkspaceRoleAuthorized(null, "delivery"), false);
});

test("the shared route gate mounts workspace content only after exact-role authorization", () => {
  const gate = read("../app/protected-role-route.tsx");
  assert.match(gate, /const authorized = isWorkspaceRoleAuthorized\(profile, role\)/);
  assert.match(gate, /setProfile\(isRoleSessionAuthorized\(nextProfile, role\) \? nextProfile : null\)/);
  assert.match(gate, /role === "vendor" && !authorized/);
  assert.match(gate, /<VendorSetup registrationMode/);
  assert.match(gate, /<AuthPanel role=\{role\} onProfileChange=\{updateProfile\}/);
  assert.match(gate, /authorized && \(role === "delivery"/);
  assert.match(gate, /<RequirementsPortal initialRole=\{role\}/);
  assert.match(gate, /<DeliveryOperationsCenter \/>/);
});

test("admin and delivery are login-only while public profile creation remains customer/vendor only", () => {
  const authPanel = read("../app/auth-panel.tsx");
  const profileRoute = read("../app/api/auth/profile/route.ts");
  assert.match(authPanel, /role === "admin" \|\| role === "delivery"/);
  assert.match(authPanel, /!provisionedRole/);
  assert.match(profileRoute, /new Set\(\["customer", "vendor"\]\)/);
});

test("the production role switch and duplicate delivery login are removed", () => {
  const home = read("../app/page.tsx");
  const portal = read("../app/requirements-portal.tsx");
  const delivery = read("../app/operations-centers.tsx");
  const styles = read("../app/globals.css");

  assert.match(home, /href="\/vendor"/);
  assert.match(home, /href="\/customer"/);
  assert.doesNotMatch(home, /setMode|AppMode|RequirementsPortal|DeliveryOperationsCenter/);
  assert.doesNotMatch(portal, /role-switch|setRole|<AuthPanel/);
  assert.doesNotMatch(portal, /NEW CUSTOMER|CUSTOMER LOGIN/);
  assert.doesNotMatch(styles, /\.role-switch/);
  assert.doesNotMatch(delivery, /setTestAccessToken|clearTestAccessToken|Sign in as test rider/);
});
