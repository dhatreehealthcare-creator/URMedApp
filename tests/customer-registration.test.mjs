import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  customerVerificationReturnUrl,
  getCustomerOnboardingState,
  getCustomerOnboardingStatus,
} from "../lib/customer-registration.ts";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("customer onboarding requires an active account plus both provider-verified factors", () => {
  assert.equal(getCustomerOnboardingStatus({ status: "inactive", emailVerified: true, phoneVerified: true }), "account_inactive");
  assert.equal(getCustomerOnboardingStatus({ status: "active", emailVerified: false, phoneVerified: false }), "email_pending");
  assert.equal(getCustomerOnboardingStatus({ status: "active", emailVerified: true, phoneVerified: false }), "phone_pending");
  assert.equal(getCustomerOnboardingStatus({ status: "active", emailVerified: true, phoneVerified: true }), "operational");
  assert.deepEqual(getCustomerOnboardingState({ status: "active", emailVerified: true, phoneVerified: false }), {
    status: "phone_pending",
    nextAction: "verify_phone",
    verificationComplete: false,
    resumable: true,
  });
  assert.deepEqual(getCustomerOnboardingState({ status: "active", emailVerified: true, phoneVerified: true }), {
    status: "operational",
    nextAction: "open_workspace",
    verificationComplete: true,
    resumable: true,
  });
  assert.equal(customerVerificationReturnUrl("https://urmed.example"), "https://urmed.example/customer");
});

test("customer registration is one email, password, confirmation, name, and required mobile journey", () => {
  const panel = read("../app/auth-panel.tsx");
  assert.match(panel, /role === "customer" && password !== confirmPassword/);
  assert.match(panel, /Confirm password \*/);
  assert.match(panel, /role === "vendor" \|\| role === "customer"/);
  assert.match(panel, /customerVerificationReturnUrl\(window\.location\.origin\)/);
  assert.match(panel, /options: \{ emailRedirectTo, data: \{ role, name:/);
  assert.match(panel, /mode === "login" && <button className=\{method === "phone"/);
  assert.match(panel, /if \(mode === "register"\) throw new Error/);
});

test("email verification return and phone change OTP stay on the same provider customer", () => {
  const panel = read("../app/auth-panel.tsx");
  assert.match(panel, /inspectEmailVerificationReturn\(window\.location\.href\)/);
  assert.match(panel, /client\.auth\.setSession/);
  assert.match(panel, /user\.email_confirmed_at/);
  assert.match(panel, /metadata\.role !== "customer"/);
  assert.match(panel, /client\.auth\.updateUser\(\{ phone: `\+91\$\{phone\}` \}\)/);
  assert.match(panel, /type: "phone_change"/);
  assert.match(panel, /await syncProfile\(session\.access_token\)/);
  assert.doesNotMatch(panel, /emailVerified\s*:|phoneVerified\s*:/);
});

test("unverified customers are denied both browser and server operations", () => {
  const access = read("../lib/role-access.ts");
  const server = read("../lib/auth-server.ts");
  const gate = read("../app/protected-role-route.tsx");
  assert.match(access, /expectedRole === "customer"/);
  assert.match(access, /profile\?\.emailVerified && profile\.phoneVerified/);
  assert.match(server, /profile\.role === "customer" && \(!profile\.emailVerified \|\| !profile\.phoneVerified\)/);
  assert.match(server, /Verify both the account email and mobile number/);
  assert.match(gate, /Complete customer verification/);
});

test("phone-only provider identities cannot create a customer profile, while existing phone login remains", () => {
  const route = read("../app/api/auth/profile/route.ts");
  const panel = read("../app/auth-panel.tsx");
  assert.match(route, /if \(!email\)/);
  assert.match(route, /Customer.*registration requires an email and password account/);
  assert.match(panel, /client\.auth\.signInWithOtp/);
  assert.match(panel, /shouldCreateUser: false/);
  assert.match(panel, /finishSignIn\(data\.session\.access_token\)/);
  assert.match(panel, /No live \$\{role\} profile is linked/);
});

test("production authentication UI no longer exposes fixture credentials or test-login", () => {
  const panel = read("../app/auth-panel.tsx");
  const styles = read("../app/globals.css");
  assert.doesNotMatch(panel, /@urmed\.test|Urmed@Test2026|\/api\/auth\/test-login|setTestAccessToken|getTestAccessToken|test-credentials-card/);
  assert.doesNotMatch(styles, /\.test-credentials-card/);
});
