import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { currentOperationalVendorPredicate } from "../lib/operational-vendor.ts";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE vendors (
      id INTEGER PRIMARY KEY, registration_status TEXT, approval_status TEXT,
      compliance_status TEXT, suspended_at TEXT
    );
    CREATE TABLE vendor_licences (
      vendor_id INTEGER, verification_status TEXT, suspended_at TEXT,
      valid_from TEXT, valid_until TEXT
    );
    CREATE TABLE pharmacists (
      vendor_id INTEGER, verification_status TEXT, active INTEGER,
      valid_from TEXT, valid_until TEXT
    );
  `);
  return db;
}

function seedVendor(db, overrides = {}) {
  const vendor = {
    registrationStatus: "submitted", approvalStatus: "approved",
    complianceStatus: "verified", suspendedAt: null,
    licenceFrom: "2025-01-01", licenceUntil: "2027-01-01",
    licenceStatus: "verified", licenceSuspendedAt: null,
    pharmacistFrom: "2025-01-01", pharmacistUntil: "2027-01-01",
    pharmacistStatus: "verified", pharmacistActive: 1,
    ...overrides,
  };
  db.prepare("INSERT INTO vendors VALUES (1,?,?,?,?)").run(
    vendor.registrationStatus, vendor.approvalStatus, vendor.complianceStatus, vendor.suspendedAt,
  );
  if (vendor.licenceUntil !== false) db.prepare("INSERT INTO vendor_licences VALUES (1,?,?,?,?)").run(
    vendor.licenceStatus, vendor.licenceSuspendedAt, vendor.licenceFrom, vendor.licenceUntil,
  );
  if (vendor.pharmacistUntil !== false) db.prepare("INSERT INTO pharmacists VALUES (1,?,?,?,?)").run(
    vendor.pharmacistStatus, vendor.pharmacistActive, vendor.pharmacistFrom, vendor.pharmacistUntil,
  );
}

function eligible(db) {
  return Boolean(db.prepare(`SELECT 1 FROM vendors v WHERE v.id=1 AND ${currentOperationalVendorPredicate("v")}`).get());
}

test("the canonical customer-facing vendor predicate requires current governed compliance", () => {
  const current = database();
  seedVendor(current);
  assert.equal(eligible(current), true);
  current.close();

  for (const [label, override] of [
    ["testing approval", { approvalStatus: "testing" }],
    ["draft registration", { registrationStatus: "draft" }],
    ["pending compliance", { complianceStatus: "pending" }],
    ["suspension", { suspendedAt: "2026-01-01" }],
    ["expired licence", { licenceUntil: "2025-01-01" }],
    ["future licence", { licenceFrom: "2027-01-01" }],
    ["suspended licence", { licenceSuspendedAt: "2026-01-01" }],
    ["expired pharmacist", { pharmacistUntil: "2025-01-01" }],
    ["future pharmacist", { pharmacistFrom: "2027-01-01" }],
    ["inactive pharmacist", { pharmacistActive: 0 }],
  ]) {
    const db = database();
    seedVendor(db, override);
    assert.equal(eligible(db), false, label);
    db.close();
  }
});

test("public reads are side-effect free and all customer transaction paths use the canonical rule", () => {
  const catalog = read("../app/api/catalog/route.ts");
  const inventory = read("../app/api/inventory/route.ts");
  const orders = read("../app/api/orders/route.ts");
  const prescriptions = read("../app/api/prescriptions/route.ts");
  for (const route of [catalog, inventory]) {
    assert.doesNotMatch(route, /releaseExpiredReservations/);
    assert.match(route, /currentOperationalVendorPredicate/);
  }
  assert.match(orders, /currentOperationalVendorPredicate/);
  assert.match(prescriptions, /currentOperationalVendorPredicate/);
  assert.doesNotMatch(prescriptions, /approval_status IN \('approved', 'testing'\)/);
});

test("delivery checkout cannot fall back to the vendor private legal location", () => {
  const orders = read("../app/api/orders/route.ts");
  assert.doesNotMatch(orders, /v\.latitude|v\.longitude|deliveryRadiusKm/);
  assert.match(orders, /Delivery is unavailable until this pharmacy publishes a customer service point/);
  assert.match(orders, /haversineKm\(publicServicePoint/);
});
