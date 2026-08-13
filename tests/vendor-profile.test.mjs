import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  isVerifiedPhoneChangeReady,
  licenceDisplayState,
  passwordPolicyMessage,
  selectCurrentLicence,
} from "../lib/vendor-profile.ts";

const fixedToday = new Date("2026-08-12T00:00:00.000Z");

test("vendor password changes require a strong password", () => {
  assert.match(passwordPolicyMessage("Short1!") ?? "", /12 characters/i);
  assert.match(passwordPolicyMessage("alllowercase123!") ?? "", /uppercase/i);
  assert.equal(passwordPolicyMessage("Vendor-Secure-2026!"), null);
});

test("licence status distinguishes current, expiring, expired, review, and rejection", () => {
  assert.equal(licenceDisplayState({ validUntil: "2027-01-01", verificationStatus: "verified" }, fixedToday), "current");
  assert.equal(licenceDisplayState({ validUntil: "2026-10-31", verificationStatus: "verified" }, fixedToday), "expiring_soon");
  assert.equal(licenceDisplayState({ validUntil: "2026-08-11", verificationStatus: "verified" }, fixedToday), "expired");
  assert.equal(licenceDisplayState({ validUntil: "2027-01-01", verificationStatus: "pending" }, fixedToday), "pending_review");
  assert.equal(licenceDisplayState({ validUntil: "2027-01-01", verificationStatus: "rejected" }, fixedToday), "rejected");
});

test("the current licence prioritizes a verified usable record over replacement history", () => {
  const current = selectCurrentLicence([
    { id: 1, validUntil: "2026-08-11", verificationStatus: "verified" },
    { id: 2, validUntil: "2027-06-01", verificationStatus: "pending" },
    { id: 3, validUntil: "2027-01-01", verificationStatus: "verified" },
  ], fixedToday);
  assert.equal(current?.id, 3);
});

test("an unchanged verified phone remains saveable but a changed phone needs the matching provider claim", () => {
  assert.equal(isVerifiedPhoneChangeReady({ originalPhone: "9876543210", originalPhoneVerified: true, draftPhone: "9876543210", providerVerifiedPhone: "" }), true);
  assert.equal(isVerifiedPhoneChangeReady({ originalPhone: "9876543210", originalPhoneVerified: false, draftPhone: "9876543210", providerVerifiedPhone: "" }), false);
  assert.equal(isVerifiedPhoneChangeReady({ originalPhone: "9876543210", originalPhoneVerified: true, draftPhone: "9123456780", providerVerifiedPhone: "" }), false);
  assert.equal(isVerifiedPhoneChangeReady({ originalPhone: "9876543210", originalPhoneVerified: true, draftPhone: "9123456780", providerVerifiedPhone: "9000000000" }), false);
  assert.equal(isVerifiedPhoneChangeReady({ originalPhone: "9876543210", originalPhoneVerified: true, draftPhone: "9123456780", providerVerifiedPhone: "9123456780" }), true);
});

test("vendor profile UI and API enforce provider and review boundaries", () => {
  const component = readFileSync(new URL("../app/vendor-setup.tsx", import.meta.url), "utf8");
  const route = readFileSync(new URL("../app/api/vendor/setup/route.ts", import.meta.url), "utf8");
  assert.match(component, /auth\.verifyOtp\(\{ phone: `\+91\$\{phoneDraft\}`, token: phoneOtp, type: "phone_change" \}\)/);
  assert.match(component, /userResult\.user\?\.phone_confirmed_at/);
  assert.match(component, /auth\.reauthenticate\(\)/);
  assert.match(component, /updateUser\(\{ password, nonce: passwordNonce \}\)/);
  assert.match(route, /Settlement account is awaiting administrator verification/);
  assert.match(component, /Licence renewal and replacement/);
  assert.match(route, /profile\.phone !== phone/);
  assert.match(route, /verificationStatus: "pending"/);
  assert.match(route, /vendor\.licence\.replacement_submitted/);
  assert.match(route, /A replacement licence must not already be expired/);
  assert.match(route, /current_licence\.verification_status = 'verified'/);
  assert.doesNotMatch(route, /account_number_encrypted AS|accountNumberEncrypted/);
});
