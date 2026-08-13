import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  OfflinePosError,
  allocatePosDiscount,
  allocatePosProducts,
  assertPosProductsGoverned,
  assertPrescriptionCoverage,
  calculatePosTotals,
  normalizePosLookup,
  parsePosPrescriptionCapture,
  parsePosPrescriptionReview,
  parsePosSaleDraft,
  posProductRequiresPrescription,
  posRequestFingerprint,
} from "../lib/offline-pos.ts";

const baseDraft = {
  idempotencyKey: "pos:test:12345678",
  customerName: "Walk-in customer",
  customerPhone: "",
  buyerGstin: "",
  placeOfSupplyStateCode: "36",
  paymentMode: "cash",
  discountType: "none",
  items: [{ productId: 7, quantity: 2 }],
};

const allocation = (overrides = {}) => ({
  inventoryId: 1,
  productId: 7,
  productName: "Example tablet",
  batchNumber: "B-1",
  expiryDate: "2028-12-31",
  quantity: 2,
  unitPricePaise: 999,
  gstPercent: 5,
  hsnCode: "3004",
  mrpPaise: 1200,
  prescriptionRequired: false,
  drugSchedule: "OTC",
  expectedQuantity: 10,
  reservedQuantity: 1,
  ...overrides,
});

test("POS sale draft combines duplicate products and normalizes Indian mobile", async () => {
  const result = parsePosSaleDraft({
    ...baseDraft,
    customerPhone: "+91 98765 43210",
    items: [{ productId: 7, quantity: 2 }, { productId: 7, quantity: 3 }, { productId: 8, quantity: 1 }],
  });
  assert.equal(result.customerPhone, "9876543210");
  assert.deepEqual(result.items, [{ productId: 7, quantity: 5 }, { productId: 8, quantity: 1 }]);
  assert.equal((await posRequestFingerprint(result)).length, 64);
  assert.equal(await posRequestFingerprint(result), await posRequestFingerprint({ ...result, items: result.items.toReversed() }));
});

test("POS lookup is exact and never accepts a partial customer identifier", () => {
  assert.deepEqual(normalizePosLookup("+91 98765 43210"), { kind: "phone", value: "9876543210" });
  assert.deepEqual(normalizePosLookup(" CUSTOMER@EXAMPLE.COM "), { kind: "email", value: "customer@example.com" });
  assert.throws(() => normalizePosLookup("98765"), OfflinePosError);
});

test("credit sale requires a linked verified live customer", () => {
  assert.throws(() => parsePosSaleDraft({ ...baseDraft, paymentMode: "credit" }), /verified live customer/);
  assert.equal(parsePosSaleDraft({ ...baseDraft, paymentMode: "credit", customerProfileId: 11 }).customerProfileId, 11);
});

test("percentage discount is allocated deterministically using largest remainders", () => {
  const discounts = allocatePosDiscount([101, 101, 99], { type: "percent", basisPoints: 1_000 });
  assert.deepEqual(discounts, [10, 10, 10]);
  assert.equal(discounts.reduce((sum, value) => sum + value, 0), 30);
  assert.deepEqual(allocatePosDiscount([100, 100, 100], { type: "fixed", amountPaise: 2 }), [1, 1, 0]);
});

test("discount cannot erase the full taxable cart", () => {
  assert.throws(() => allocatePosDiscount([500], { type: "fixed", amountPaise: 500 }), /less than/);
  assert.throws(() => allocatePosDiscount([500], { type: "percent", basisPoints: 10_000 }), /less than/);
});

test("POS totals use post-discount taxable value and exact intra-state GST split", () => {
  const totals = calculatePosTotals([allocation()], { type: "fixed", amountPaise: 98 }, "36", "36");
  assert.equal(totals.grossPaise, 1998);
  assert.equal(totals.discountPaise, 98);
  assert.equal(totals.subtotalPaise, 1900);
  assert.equal(totals.taxPaise, 95);
  assert.equal(totals.cgstPaise, 47);
  assert.equal(totals.sgstPaise, 48);
  assert.equal(totals.totalPaise, 1995);
});

test("POS totals use IGST when place of supply differs", () => {
  const totals = calculatePosTotals([allocation({ quantity: 1, unitPricePaise: 1000, gstPercent: 18 })], { type: "none" }, "36", "29");
  assert.equal(totals.igstPaise, 180);
  assert.equal(totals.cgstPaise, 0);
  assert.equal(totals.sgstPaise, 0);
});

test("regulated products require a prescription and unclassified products are blocked", () => {
  assert.equal(posProductRequiresPrescription({ prescriptionRequired: false, drugSchedule: "OTC" }), false);
  assert.equal(posProductRequiresPrescription({ prescriptionRequired: false, drugSchedule: "H1" }), true);
  assert.equal(posProductRequiresPrescription({ prescriptionRequired: true, drugSchedule: "G" }), true);
  assert.throws(() => assertPosProductsGoverned([{ productName: "Unknown", drugSchedule: "UNCLASSIFIED" }]), /classified/);
});

test("approved prescription coverage is aggregated by product and rejects excess supply", () => {
  const allocations = [
    allocation({ inventoryId: 1, quantity: 2, prescriptionRequired: true }),
    allocation({ inventoryId: 2, quantity: 3, prescriptionRequired: true }),
    allocation({ inventoryId: 3, productId: 8, productName: "OTC", quantity: 50 }),
  ];
  assert.doesNotThrow(() => assertPrescriptionCoverage(allocations, [{ productId: 7, quantityApproved: 5 }]));
  assert.throws(() => assertPrescriptionCoverage(allocations, [{ productId: 7, quantityApproved: 4 }]), /does not cover/);
});

test("offline prescription capture and review parsing enforce immutable medicine quantities", () => {
  const capture = parsePosPrescriptionCapture({
    documentId: 19,
    customerProfileId: 4,
    patientName: "Walk-in patient",
    patientAddress: "Hyderabad, Telangana",
    prescriberName: "Dr Example",
    prescriberAddress: "Example clinic, Hyderabad",
    prescribedOn: "2026-08-12",
    items: [{ productId: 7, medicineText: "Example tablet", quantityRequested: 2 }],
  });
  assert.equal(capture.items[0].quantityRequested, 2);
  assert.throws(() => parsePosPrescriptionCapture({ ...capture, items: [...capture.items, ...capture.items] }), /appear once/);
  assert.deepEqual(parsePosPrescriptionReview({
    decision: "approved", items: [{ productId: 7, quantityApproved: 2 }], notes: "",
  }).items, [{ productId: 7, quantityApproved: 2 }]);
  assert.throws(() => parsePosPrescriptionReview({ decision: "rejected", notes: "no", items: [] }), /clear review reason/);
  assert.throws(() => parsePosPrescriptionReview({ decision: "approved", notes: "", items: [] }), /Approve at least one/);
});

test("POS allocation consumes server-owned FEFO batches and respects reserved availability", () => {
  const batches = [
    { ...allocation({ inventoryId: 2, quantity: undefined, expiryDate: "2028-02-01" }), availableQuantity: 4 },
    { ...allocation({ inventoryId: 1, quantity: undefined, expiryDate: "2028-01-01" }), availableQuantity: 2 },
  ];
  delete batches[0].quantity;
  delete batches[1].quantity;
  const result = allocatePosProducts([{ productId: 7, quantity: 5 }], batches);
  assert.deepEqual(result.map(({ inventoryId, quantity }) => ({ inventoryId, quantity })), [
    { inventoryId: 1, quantity: 2 },
    { inventoryId: 2, quantity: 3 },
  ]);
  assert.throws(() => allocatePosProducts([{ productId: 7, quantity: 7 }], batches), /eligible FEFO stock/);
});

test("POS routes enforce tenant permissions, live identity and production transactional paths", () => {
  const catalog = readFileSync(new URL("../app/api/vendor/pos/catalog/route.ts", import.meta.url), "utf8");
  const customers = readFileSync(new URL("../app/api/vendor/pos/customers/route.ts", import.meta.url), "utf8");
  const sales = readFileSync(new URL("../app/api/vendor/pos/sales/route.ts", import.meta.url), "utf8");
  const captures = readFileSync(new URL("../app/api/vendor/pos/prescriptions/route.ts", import.meta.url), "utf8");
  const reviews = readFileSync(new URL("../app/api/vendor/pos/prescriptions/[id]/review/route.ts", import.meta.url), "utf8");
  assert.match(catalog, /requireVendorPermission\(request, "sale\.write"\)/);
  assert.match(catalog, /i\.vendor_id = \?/);
  assert.match(catalog, /i\.quantity - i\.reserved_quantity/);
  assert.match(customers, /FROM account_profiles/);
  assert.match(customers, /role = 'customer' AND status = 'active'/);
  assert.match(customers, /email_verified = 1 AND phone_verified = 1/);
  assert.doesNotMatch(customers, /FROM customers\b/);
  assert.match(sales, /completeOfflineSale/);
  assert.match(sales, /requireVendorPermission\(request, "sale\.write"\)/);
  assert.match(captures, /FROM account_profiles WHERE id = \? AND role = 'customer'/);
  assert.doesNotMatch(captures, /FROM customers\b/);
  assert.match(reviews, /requireVendorPermission\(request, "prescription\.review"\)/);
  assert.match(reviews, /pharmacist\.profile_id = \?/);
});
