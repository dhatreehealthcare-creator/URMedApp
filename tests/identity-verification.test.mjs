import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  getIdentityVerificationStatus,
  getVendorAccessStatus,
  normalizeIndianMobile,
  providerVerificationState,
} from "../lib/identity-verification.ts";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("provider claims are the only identity verification authority", () => {
  assert.deepEqual(providerVerificationState({
    email: " Vendor@Example.COM ",
    phone: "+91 98765 43210",
    email_confirmed_at: "2026-08-12T00:00:00Z",
    phone_confirmed_at: "2026-08-12T00:00:00Z",
  }), {
    email: "vendor@example.com",
    phone: "9876543210",
    emailVerified: true,
    phoneVerified: true,
    identityVerificationStatus: "verified",
  });
  assert.equal(normalizeIndianMobile("0091-9876543210"), "");
  assert.equal(providerVerificationState({ email: "vendor@example.com", phone: "+919876543210" }).identityVerificationStatus, "email_and_phone_pending");
});

test("identity and vendor lifecycle states remain independent", () => {
  assert.equal(getIdentityVerificationStatus(false, false), "email_and_phone_pending");
  assert.equal(getIdentityVerificationStatus(false, true), "email_pending");
  assert.equal(getIdentityVerificationStatus(true, false), "phone_pending");
  assert.equal(getIdentityVerificationStatus(true, true), "verified");

  const base = { status: "active", emailVerified: true, phoneVerified: true };
  assert.equal(getVendorAccessStatus({ ...base, vendorRegistrationStatus: "draft" }), "registration_draft");
  assert.equal(getVendorAccessStatus({ ...base, vendorRegistrationStatus: "submitted", vendorApprovalStatus: "pending", vendorComplianceStatus: "pending" }), "review_pending");
  assert.equal(getVendorAccessStatus({ ...base, vendorRegistrationStatus: "submitted", vendorApprovalStatus: "approved", vendorComplianceStatus: "verified" }), "operational");
  assert.equal(getVendorAccessStatus({ ...base, status: "suspended", vendorRegistrationStatus: "submitted", vendorApprovalStatus: "approved", vendorComplianceStatus: "verified" }), "account_inactive");
});

test("profile synchronization ignores browser verification fields and preserves account status", () => {
  const route = read("../app/api/auth/profile/route.ts");
  const auth = read("../lib/auth-server.ts");
  assert.match(route, /providerVerificationState\(user\)/);
  assert.doesNotMatch(route, /body\.emailVerified|body\.phoneVerified/);
  assert.match(auth, /providerVerificationState\(user\)/);
  assert.match(auth, /WHERE auth_user_id=\? AND status='active'/);
  assert.doesNotMatch(auth, /FROM customers/);
});

test("vendor operations require verified submitted approved onboarding while setup stays available", () => {
  const vendorAccess = read("../lib/vendor-access.ts");
  const setup = read("../app/api/vendor/setup/route.ts");
  assert.match(vendorAccess, /profile\.vendorAccessStatus !== "operational"/);
  assert.match(vendorAccess, /allowIncompleteVendor: true/);
  assert.match(setup, /!profile\.emailVerified/);
  assert.match(setup, /!profile\.phoneVerified \|\| profile\.phone !== registration\.phone/);
  assert.match(setup, /registration_status='submitted'/);
  assert.doesNotMatch(setup, /phone_verified=1/);
});

test("vendor registration cannot use phone-only account creation", () => {
  const authPanel = read("../app/auth-panel.tsx");
  const profileRoute = read("../app/api/auth/profile/route.ts");
  assert.match(authPanel, /mode === "register" && role === "vendor"/);
  assert.match(authPanel, /Create the vendor email and password account first/);
  assert.match(profileRoute, /Vendor registration requires an email and password account/);
});

test("P1-02 migration backfills only linked live test profiles and preserves approved vendors", () => {
  const migration = read("../drizzle/0034_little_sunfire.sql");
  assert.match(migration, /registration_status/);
  assert.match(migration, /registration_submitted_at/);
  assert.match(migration, /FROM `account_profiles` profile/);
  assert.doesNotMatch(migration, /FROM `customers`/);
  assert.match(migration, /WHERE `approval_status` = 'approved' AND `compliance_status` = 'verified'/);
});

