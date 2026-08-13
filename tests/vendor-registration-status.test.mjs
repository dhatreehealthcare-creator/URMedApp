import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  getVendorRegistrationNextAction,
  vendorVerificationReturnUrl,
} from "../lib/vendor-registration-status.ts";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const ready = {
  emailVerified: true,
  phoneVerified: true,
  registrationStatus: "submitted",
  approvalStatus: "pending",
  complianceStatus: "pending",
  currentLicenceCount: 1,
  verifiedLicenceCount: 0,
  pharmacistCount: 1,
  verifiedPharmacistCount: 0,
};

test("vendor registration milestones produce one deterministic next action", () => {
  assert.equal(getVendorRegistrationNextAction({ ...ready, emailVerified: false }), "verify_email");
  assert.equal(getVendorRegistrationNextAction({ ...ready, phoneVerified: false }), "verify_phone");
  assert.equal(getVendorRegistrationNextAction({ ...ready, registrationStatus: "draft" }), "complete_registration");
  assert.equal(getVendorRegistrationNextAction({ ...ready, complianceStatus: "rejected" }), "resolve_rejection");
  assert.equal(getVendorRegistrationNextAction({ ...ready, pharmacistCount: 0 }), "add_pharmacist");
  assert.equal(getVendorRegistrationNextAction(ready), "awaiting_review");
  assert.equal(getVendorRegistrationNextAction({ ...ready, approvalStatus: "approved", complianceStatus: "verified", verifiedLicenceCount: 1, verifiedPharmacistCount: 1 }), "operational");
});

test("vendor verification mail targets the dedicated same-origin return route", () => {
  assert.equal(vendorVerificationReturnUrl("https://urmed.example"), "https://urmed.example/vendor/verification-return");
  const panel = read("../app/auth-panel.tsx");
  assert.match(panel, /vendorVerificationReturnUrl\(window\.location\.origin\)/);
  assert.match(panel, /options: \{ emailRedirectTo/);
  assert.equal(panel.match(/vendorVerificationReturnUrl\(window\.location\.origin\)/g)?.length, 2);
});

test("dedicated registration status and verification-return pages are routed", () => {
  const statusPage = read("../app/vendor/registration/status/page.tsx");
  const returnPage = read("../app/vendor/verification-return/page.tsx");
  const problemPage = read("../app/vendor/verification-return/problem/page.tsx");
  const statusUi = read("../app/vendor-registration-status.tsx");
  const returnUi = read("../app/vendor-verification-return.tsx");
  assert.match(statusPage, /<VendorRegistrationStatus \/>/);
  assert.match(returnPage, /<VendorVerificationReturn \/>/);
  assert.match(returnPage, /redirect\(problem \? "\/vendor\/verification-return\/problem" : "\/vendor\/verification-return"\)/);
  assert.match(problemPage, /<VendorVerificationReturn initialProblem \/>/);
  assert.match(statusUi, /\/api\/vendor\/registration\/status/);
  assert.match(statusUi, /DRUG LICENCE/);
  assert.match(statusUi, /PHARMACIST/);
  assert.match(statusUi, /ADMINISTRATOR REVIEW/);
  assert.match(returnUi, /window\.history\.replaceState/);
  assert.match(returnUi, /Sign in with vendor email/);
});

test("registration status API is owner-scoped and excludes private location", () => {
  const route = read("../app/api/vendor/registration/status/route.ts");
  assert.match(route, /requireVendorOnboardingAccess\(request\)/);
  assert.match(route, /Cache-Control": "private, no-store/);
  assert.match(route, /getVendorRegistrationNextAction/);
  assert.doesNotMatch(route, /v\.address|v\.latitude|v\.longitude/);
});

test("submitted vendors can finish required pharmacist onboarding without operational access", () => {
  const setupRoute = read("../app/api/vendor/setup/route.ts");
  const documentRoute = read("../app/api/documents/route.ts");
  const vendorAccess = read("../lib/vendor-access.ts");
  assert.match(setupRoute, /\["registration", "registration_draft", "licence", "pharmacist"\]\.includes\(action\)/);
  assert.match(documentRoute, /purpose === "drug_licence" \|\| purpose === "pharmacist_registration"/);
  assert.match(documentRoute, /requireVendorOnboardingAccess\(request\)/);
  assert.match(vendorAccess, /Only the pharmacy owner can complete vendor onboarding/);
  assert.match(vendorAccess, /profile\.vendorAccessStatus !== "operational"/);
});

test("successful submission moves to the persistent status route", () => {
  const setup = read("../app/vendor-setup.tsx");
  assert.match(setup, /window\.location\.assign\("\/vendor\/registration\/status"\)/);
  assert.match(setup, /href="\/vendor\/registration\/status"/);
  assert.match(setup, /REQUIRED FOR APPROVAL/);
});
