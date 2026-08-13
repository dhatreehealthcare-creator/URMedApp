import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  validateVendorOnboardingDraft,
  VendorOnboardingDraftError,
} from "../lib/vendor-onboarding-draft.ts";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("vendor onboarding drafts normalize safe scalar progress without contact claims", () => {
  assert.deepEqual(validateVendorOnboardingDraft({
    businessName: " Resumable Pharmacy ",
    ownerName: " Resumable Owner ",
    landline: "0401234567",
    homeDelivery: "0",
    deliveryRadiusKm: 70,
    phone: "9999999999",
    email: "spoofed@example.test",
  }), {
    businessName: "Resumable Pharmacy",
    ownerName: "Resumable Owner",
    landline: "0401234567",
    gstNumber: "",
    address: "",
    latitude: "",
    longitude: "",
    homeDelivery: false,
    deliveryRadiusKm: 50,
    licenceNumber: "",
  });

  const location = validateVendorOnboardingDraft({
    businessName: "Resumable Pharmacy",
    ownerName: "Resumable Owner",
    gstNumber: "36ABCDE1234F1Z5",
    address: "Private registration address",
    latitude: "17.431800",
    longitude: "78.407300",
    homeDelivery: true,
    licenceNumber: "dl-draft-1",
  });
  assert.equal(location.homeDelivery, true);
  assert.equal(location.licenceNumber, "DL-DRAFT-1");
  assert.equal(Object.hasOwn(location, "phone"), false);
  assert.equal(Object.hasOwn(location, "email"), false);
});

test("vendor onboarding drafts reject incomplete or invalid saved steps", () => {
  for (const [input, message] of [
    [{ ownerName: "Owner" }, /business name and owner name/i],
    [{ businessName: "Business", ownerName: "Owner", landline: "123" }, /Landline.*10 digits/i],
    [{ businessName: "Business", ownerName: "Owner", gstNumber: "invalid" }, /GSTIN/i],
    [{ businessName: "Business", ownerName: "Owner", latitude: "17.4", longitude: "78.4" }, /address/i],
    [{ businessName: "Business", ownerName: "Owner", address: "Private", latitude: "91", longitude: "78.4" }, /valid private pharmacy location/i],
  ]) {
    assert.throws(() => validateVendorOnboardingDraft(input), (error) => {
      assert.ok(error instanceof VendorOnboardingDraftError);
      assert.match(error.message, message);
      return true;
    });
  }
});

test("vendor draft API is tenant-scoped, draft-only, audited, and restored by the UI", () => {
  const route = read("../app/api/vendor/setup/route.ts");
  const component = read("../app/vendor-setup.tsx");
  assert.match(route, /action === "registration_draft"/);
  assert.match(route, /registration_status='draft'/);
  assert.match(route, /vendor\.registration\.draft\.saved/);
  assert.match(route, /requireVendorOnboardingAccess\(request\)/);
  assert.match(component, /storedDraft = result\.registrationDraft/);
  assert.match(component, /save\("registration_draft", \{ \.\.\.registrationDraft, latitude, longitude \}\)/);
  assert.match(component, /Uploaded files are selected only for final submission/);
});

test("packaged Worker harness can advance only seeded test claims for resume coverage", () => {
  const harness = read("../scripts/test-integration.mjs");
  const integration = read("./integration/phase0-api.integration.test.mjs");
  assert.match(harness, /runtime\.getD1Database\(databaseBinding\)/);
  assert.match(harness, /__URMED_INTEGRATION_SET_TEST_CLAIMS__/);
  assert.match(harness, /UPDATE test_accounts SET email_confirmed=\?,phone_confirmed=\?/);
  assert.doesNotMatch(harness, /api\/.*set.*claims/i);
  assert.match(integration, /interrupted customer verification resumes from provider-backed state/);
  assert.match(integration, /vendor registration draft survives interruption/);
  assert.match(integration, /idempotent customer verification sync/);
});
