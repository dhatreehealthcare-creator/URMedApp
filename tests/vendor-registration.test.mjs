import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  validateVendorRegistration,
  VendorRegistrationValidationError,
} from "../lib/vendor-registration.ts";

const validRegistration = {
  businessName: "P1 Pharmacy",
  ownerName: "P1 Owner",
  phone: "9876543210",
  landline: "0401234567",
  gstNumber: "36ABCDE1234F1Z5",
  address: "Private legal address, Hyderabad",
  latitude: "17.431800",
  longitude: "78.407300",
  homeDelivery: "1",
  deliveryRadiusKm: "7",
  licenceNumber: "DL-P1-001",
  formType: "20B",
  issuingAuthority: "Drugs Control Administration",
  issuedOn: "2025-01-01",
  validFrom: "2025-01-01",
  validUntil: "2030-01-01",
  documentId: 42,
};

function expectValidation(input, message) {
  assert.throws(() => validateVendorRegistration({ ...validRegistration, ...input }), (error) => {
    assert.ok(error instanceof VendorRegistrationValidationError);
    assert.match(error.message, message);
    return true;
  });
}

test("vendor registration normalizes one complete business, location, and licence submission", () => {
  assert.deepEqual(validateVendorRegistration(validRegistration), {
    businessName: "P1 Pharmacy",
    ownerName: "P1 Owner",
    phone: "9876543210",
    landline: "0401234567",
    gstNumber: "36ABCDE1234F1Z5",
    address: "Private legal address, Hyderabad",
    latitude: "17.431800",
    longitude: "78.407300",
    homeDelivery: true,
    deliveryRadiusKm: 7,
    licenceNumber: "DL-P1-001",
    formType: "20B",
    issuingAuthority: "Drugs Control Administration",
    issuedOn: "2025-01-01",
    validFrom: "2025-01-01",
    validUntil: "2030-01-01",
    documentId: 42,
  });
});

test("landline and GSTIN are optional but validated when supplied", () => {
  const optional = validateVendorRegistration({ ...validRegistration, landline: "", gstNumber: "" });
  assert.equal(optional.landline, "");
  assert.equal(optional.gstNumber, "");
  expectValidation({ landline: "12345" }, /Landline.*exactly 10 digits/i);
  expectValidation({ gstNumber: "invalid" }, /GSTIN format/i);
});

test("registration requires a valid private location and complete current licence", () => {
  expectValidation({ latitude: "91" }, /valid private pharmacy location/i);
  expectValidation({ address: "" }, /private registered address/i);
  expectValidation({ formType: "99" }, /approved form type/i);
  expectValidation({ validUntil: "2024-12-31" }, /expiry.*after/i);
  expectValidation({ documentId: 0 }, /Upload the drug licence/i);
});

test("authenticated vendor onboarding uses one four-step registration submission", () => {
  const component = readFileSync(new URL("../app/vendor-setup.tsx", import.meta.url), "utf8");
  const route = readFileSync(new URL("../app/api/vendor/setup/route.ts", import.meta.url), "utf8");
  assert.match(component, /UNIFIED VENDOR REGISTRATION/);
  assert.match(component, /<small>Step \{number\}<\/small>/);
  assert.match(component, /Private registered address/);
  assert.match(component, /\.jpg,\.jpeg,\.png,\.pdf,\.doc,\.docx/);
  assert.match(component, /save\("registration"/);
  assert.match(route, /action === "registration"/);
  assert.match(route, /vendor\.registration\.submitted/);
  assert.match(route, /registration_status='submitted'/);
  assert.match(route, /!profile\.emailVerified/);
  assert.match(route, /!profile\.phoneVerified/);
  assert.match(route, /approval_status=CASE WHEN approval_status='approved'/);
});

test("new vendor accounts remain drafts until the unified registration is submitted", () => {
  const profileRoute = readFileSync(new URL("../app/api/auth/profile/route.ts", import.meta.url), "utf8");
  assert.match(profileRoute, /SELECT id, \?, \?, \?, \?, 'draft', 'pending' FROM account_profiles/);
  assert.doesNotMatch(profileRoute, /String\(body\.address/);
  assert.match(profileRoute, /IdentityConflictError\(\["email"\]\)/);
  assert.match(profileRoute, /ON CONFLICT\(profile_id\) DO NOTHING/);
});
