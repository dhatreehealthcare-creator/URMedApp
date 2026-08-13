import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  accountAccessPaths,
  accountPasswordPolicyMessage,
  GENERIC_LOGIN_FAILURE,
  GENERIC_PASSWORD_RECOVERY_NOTICE,
  GENERIC_VERIFICATION_RESEND_NOTICE,
  inspectAccountRecoveryReturn,
  postLoginPath,
} from "../lib/account-access.ts";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("vendor and customer account routes stay inside their own role", () => {
  assert.deepEqual(accountAccessPaths("vendor"), {
    root: "/vendor",
    login: "/vendor/login",
    verificationPending: "/vendor/verification-pending",
    forgotPassword: "/vendor/forgot-password",
    resetPassword: "/vendor/reset-password",
    signOut: "/vendor/sign-out",
    postLogin: "/vendor/registration/status",
  });
  assert.equal(accountAccessPaths("customer").postLogin, "/customer");
  assert.equal(postLoginPath("vendor", { role: "vendor", status: "active", emailVerified: true }), "/vendor/registration/status");
  assert.equal(postLoginPath("vendor", { role: "vendor", status: "active", emailVerified: true, vendorAccessStatus: "operational" }), "/vendor");
  assert.equal(postLoginPath("customer", { role: "customer", status: "active", emailVerified: true }), "/customer");
  assert.equal(postLoginPath("vendor", { role: "customer", status: "active", emailVerified: true }), null);
  assert.equal(postLoginPath("vendor", { role: "vendor", status: "inactive", emailVerified: true }), null);
  assert.equal(postLoginPath("vendor", { role: "vendor", status: "active", emailVerified: false }), "/vendor/verification-pending");
});

test("only complete provider recovery fragments are accepted", () => {
  assert.deepEqual(inspectAccountRecoveryReturn("https://urmed.example/vendor/reset-password#access_token=access&refresh_token=refresh&type=recovery"), {
    kind: "session", accessToken: "access", refreshToken: "refresh",
  });
  assert.deepEqual(inspectAccountRecoveryReturn("https://urmed.example/vendor/reset-password#access_token=access&refresh_token=refresh&type=signup"), { kind: "invalid" });
  assert.deepEqual(inspectAccountRecoveryReturn("https://urmed.example/vendor/reset-password#access_token=access&type=recovery"), { kind: "invalid" });
  assert.deepEqual(inspectAccountRecoveryReturn("https://urmed.example/vendor/reset-password?error=access_denied&error_description=private"), { kind: "provider_error" });
  assert.deepEqual(inspectAccountRecoveryReturn("https://urmed.example/vendor/reset-password"), { kind: "none" });
});

test("account recovery password policy is deterministic", () => {
  assert.match(accountPasswordPolicyMessage("Short1!") ?? "", /12 characters/i);
  assert.match(accountPasswordPolicyMessage("lowercase-only-123") ?? "", /uppercase/i);
  assert.equal(accountPasswordPolicyMessage("Recovery-Secure-2026!"), null);
});

test("dedicated provider flows are generic and test-login-free", () => {
  const component = read("../app/account-access.tsx");
  assert.match(component, /auth\.signInWithPassword/);
  assert.match(component, /auth\.resend\(\{ type: "signup"/);
  assert.match(component, /auth\.resetPasswordForEmail/);
  assert.match(component, /auth\.setSession/);
  assert.match(component, /window\.history\.replaceState/);
  assert.match(component, /auth\.updateUser\(\{ password \}\)/);
  assert.match(component, /auth\.signOut\(\)/);
  assert.match(component, /activeProfile\(session\.access_token\)/);
  assert.match(component, /profile\.role !== role/);
  assert.match(component, /GENERIC_LOGIN_FAILURE/);
  assert.match(component, /GENERIC_VERIFICATION_RESEND_NOTICE/);
  assert.match(component, /GENERIC_PASSWORD_RECOVERY_NOTICE/);
  assert.doesNotMatch(component, /test-login|@urmed\.test|Urmed@Test/);
  assert.doesNotMatch(`${GENERIC_LOGIN_FAILURE} ${GENERIC_VERIFICATION_RESEND_NOTICE} ${GENERIC_PASSWORD_RECOVERY_NOTICE}`, /not found|already registered|does not exist/i);
});

test("all ten vendor and customer account pages use fixed role and mode props", () => {
  for (const role of ["vendor", "customer"]) {
    for (const [directory, mode] of [
      ["login", "login"],
      ["verification-pending", "verification-pending"],
      ["forgot-password", "forgot-password"],
      ["reset-password", "reset-password"],
      ["sign-out", "sign-out"],
    ]) {
      const page = read(`../app/${role}/${directory}/page.tsx`);
      assert.match(page, new RegExp(`<AccountAccessPage mode="${mode}" role="${role}"`));
      assert.doesNotMatch(page, /searchParams|\{ params \}/);
    }
  }
});
