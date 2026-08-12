import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

const razorpaySecret = process.env.URMED_INTEGRATION_RAZORPAY_SECRET;
const webhookSecret = process.env.URMED_INTEGRATION_WEBHOOK_SECRET;
const inactiveToken = process.env.URMED_INTEGRATION_INACTIVE_TOKEN;
const migrationCount = Number(process.env.URMED_INTEGRATION_MIGRATION_COUNT);
const inspectPersistence = globalThis.__URMED_INTEGRATION_INSPECT__;
const triggerScheduled = globalThis.__URMED_INTEGRATION_SCHEDULED__;
for (const [name, value] of Object.entries({
  baseUrl: process.env.URMED_INTEGRATION_BASE_URL,
  inspectPersistence,
  triggerScheduled,
  razorpaySecret,
  webhookSecret,
  inactiveToken,
  migrationCount,
})) {
  if (!value) throw new Error(`${name} is required; run this file through npm run test:integration`);
}

const context = {
  tokens: {},
  vendorId: 0,
  inventoryId: 0,
  legacyId: 0,
  purchaseItemId: 0,
  successfulOrderId: 0,
  failedOrderId: 0,
  cancelledOrderId: 0,
  rejectedOrderId: 0,
  expiredOrderId: 0,
  abandonedOrderId: 0,
  documentId: 0,
  supplierReturnNumber: "",
  firstReturnReleasedAt: "",
  abandonedReleasedAt: "",
  objectsBefore: 0,
};

async function api(pathname, options = {}) {
  const headers = new Headers(options.headers ?? {});
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  let body = options.body;
  if (options.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(options.json);
  }
  const method = options.method ?? (body ? "POST" : "GET");
  let response;
  try {
    response = await fetch(`${process.env.URMED_INTEGRATION_BASE_URL}${pathname}`, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new Error(`${method} ${pathname} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  const payload = response.headers.get("content-type")?.includes("application/json") && text ? JSON.parse(text) : null;
  return { response, status: response.status, payload, text, bytes };
}

async function expectStatus(resultPromise, status, label) {
  const result = await resultPromise;
  assert.equal(result.status, status, `${label}: ${result.text}`);
  return result;
}

async function login(email) {
  const result = await expectStatus(api("/api/auth/test-login", {
    json: { email, password: "Urmed@Test2026!" },
  }), 200, `login ${email}`);
  assert.equal(typeof result.payload?.token, "string");
  return result.payload.token;
}

function isoDate(offsetDays = 0) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function signed(secret, value) {
  return createHmac("sha256", secret).update(value).digest("hex");
}

async function createOnlineOrder(quantity, inventoryId = context.inventoryId, prescriptionId) {
  return expectStatus(api("/api/orders", {
    token: context.tokens.customer,
    json: {
      items: [{ inventoryId, quantity }],
      paymentMethod: "online",
      deliveryMethod: "pickup",
      placeOfSupplyStateCode: "36",
      customerName: "URMED Integration Customer",
      customerPhone: "9000000001",
      deliveryAddress: "P009 integration pickup",
      latitude: "17.4318",
      longitude: "78.4073",
      ...(prescriptionId ? { prescriptionId } : {}),
    },
  }), 201, "create online order");
}

async function inventoryMine(token = context.tokens.vendor) {
  return expectStatus(api("/api/inventory?scope=mine", { token }), 200, "vendor inventory");
}

function inventoryRow(payload, id) {
  return payload.inventory.find((row) => row.id === id);
}

async function scenario(name, callback) {
  const started = Date.now();
  try {
    await callback();
    console.log(`[integration] ✓ ${name} (${Date.now() - started}ms)`);
  } catch (error) {
    throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

export async function runPhase0IntegrationSuite() {
  await scenario("test identities enforce role, status, archive, and admin boundaries", async () => {
    context.tokens.customer = await login("customer@urmed.test");
    context.tokens.vendor = await login("vendor@urmed.test");
    context.tokens.admin = await login("admin@urmed.test");
    context.tokens.customerTwo = await login("customer-two@urmed.test");
    context.tokens.vendorTwo = await login("vendor-two@urmed.test");
    context.tokens.vendorOperationalTwo = await login("vendor-operational-two@urmed.test");

    await expectStatus(api("/api/orders"), 401, "unauthenticated order list");
    await expectStatus(api("/api/admin/operations", { token: context.tokens.customer }), 403, "customer admin access");
    await expectStatus(api("/api/admin/operations", { token: context.tokens.vendor }), 403, "vendor admin access");
    await expectStatus(api("/api/admin/operations", { token: context.tokens.admin }), 200, "administrator access");
    await expectStatus(api("/api/auth/profile", { token: inactiveToken }), 401, "inactive session");
    await expectStatus(api("/api/auth/test-login", {
      json: { email: "inactive@urmed.test", password: "Urmed@Test2026!" },
    }), 401, "inactive account login");

    const recoveredLogin = await expectStatus(api("/api/auth/test-login", {
      json: { email: "recovered-only@urmed.test", password: "Urmed@Test2026!" },
    }), 401, "recovered archive login");
    assert.match(recoveredLogin.payload.error, /incorrect/i);
    await expectStatus(api("/api/auth/profile", {
      method: "POST",
      token: "urmed_test_recovered_archive_has_no_session",
      json: { role: "customer", name: "Recovered" },
    }), 401, "recovered archive profile creation");
    const recovery = await expectStatus(api("/api/admin/recovery", { token: context.tokens.admin }), 200, "admin recovery archive");
    assert.ok(recovery.payload.customers.some((customer) => customer.email === "recovered-only@urmed.test"));
    assert.equal(recovery.payload.security.recoveredRecordsCanAuthenticate, false);
    await expectStatus(api("/api/admin/recovery", { token: context.tokens.customer }), 403, "customer recovery archive access");

    const inventory = await inventoryMine();
    const stock = inventory.payload.inventory.find((row) => row.batchNumber === "TEST-URMED-001");
    assert.ok(stock, "seeded vendor stock must be visible");
    context.inventoryId = stock.id;
    context.legacyId = stock.legacyId;
    const vendorOperations = await expectStatus(api("/api/vendor/operations", { token: context.tokens.vendor }), 200, "vendor operations");
    context.vendorId = vendorOperations.payload.inventory.find((row) => row.id === context.inventoryId)?.vendorId ?? 1;
  });

  await scenario("provider claims gate vendor onboarding and synchronize idempotently", async () => {
    const emailPending = await login("vendor-email-pending@urmed.test");
    const phonePending = await login("vendor-phone-pending@urmed.test");
    const bothPending = await login("vendor-both-pending@urmed.test");
    const emailPendingProfile = await expectStatus(api("/api/auth/profile", { token: emailPending }), 200, "email pending profile");
    assert.equal(emailPendingProfile.payload.profile.identityVerificationStatus, "email_pending");
    assert.equal(emailPendingProfile.payload.profile.vendorAccessStatus, "email_pending");
    const phonePendingProfile = await expectStatus(api("/api/auth/profile", { token: phonePending }), 200, "phone pending profile");
    assert.equal(phonePendingProfile.payload.profile.identityVerificationStatus, "phone_pending");
    assert.equal(phonePendingProfile.payload.profile.vendorAccessStatus, "phone_pending");
    const bothPendingProfile = await expectStatus(api("/api/auth/profile", { token: bothPending }), 200, "both pending profile");
    assert.equal(bothPendingProfile.payload.profile.identityVerificationStatus, "email_and_phone_pending");
    await expectStatus(api("/api/vendor/operations", { token: emailPending }), 403, "unverified email operations");
    await expectStatus(api("/api/vendor/operations", { token: phonePending }), 403, "unverified phone operations");
    await expectStatus(api("/api/vendor/operations", { token: context.tokens.vendorTwo }), 403, "draft vendor operations");

    for (const [token, label] of [[emailPending, "email"], [phonePending, "phone"], [bothPending, "both"]]) {
      const setup = await expectStatus(api("/api/vendor/setup", { token }), 200, `${label} pending onboarding`);
      await expectStatus(api("/api/vendor/setup", {
        token,
        json: {
          action: "registration",
          businessName: "Verification Gate Pharmacy",
          ownerName: "Verification Gate Owner",
          phone: setup.payload.vendor.phone,
          address: "Private verification gate address",
          latitude: "17.4318",
          longitude: "78.4073",
          licenceNumber: "P102-GATE",
          formType: "20B",
          issuingAuthority: "Drugs Control Administration",
          validFrom: isoDate(-1),
          validUntil: isoDate(365),
          documentId: 900009,
          emailVerified: true,
          phoneVerified: true,
        },
      }), 400, `${label} pending registration rejection`);
    }

    const firstSync = await expectStatus(api("/api/auth/profile", { token: context.tokens.vendorTwo }), 200, "first verified state sync");
    const secondSync = await expectStatus(api("/api/auth/profile", { token: context.tokens.vendorTwo }), 200, "second verified state sync");
    assert.deepEqual(firstSync.payload.profile, secondSync.payload.profile);
    assert.equal(secondSync.payload.profile.identityVerificationStatus, "verified");
    assert.equal(secondSync.payload.profile.vendorAccessStatus, "registration_draft");
  });

  await scenario("vendor registration submits business, private location, and licence as one review package", async () => {
    const setupBefore = await expectStatus(api("/api/vendor/setup", { token: context.tokens.vendorTwo }), 200, "load vendor registration");
    const licence = new FormData();
    licence.set("purpose", "drug_licence");
    licence.set("file", new File([png], "p1-vendor-licence.png", { type: "image/png" }));
    const uploaded = await expectStatus(api("/api/documents", { token: context.tokens.vendorTwo, body: licence }), 201, "upload vendor licence");
    context.vendorRegistrationDocumentId = uploaded.payload.document.id;
    const registration = {
      action: "registration",
      businessName: "P1 Integration Pharmacy",
      ownerName: "P1 Integration Owner",
      phone: setupBefore.payload.vendor.phone,
      landline: "",
      gstNumber: "",
      address: "P1 private legal location",
      latitude: "17.431800",
      longitude: "78.407300",
      homeDelivery: true,
      deliveryRadiusKm: 8,
      licenceNumber: "DL-P1-INTEGRATION",
      formType: "20B",
      issuingAuthority: "P1 Drugs Control Administration",
      issuedOn: isoDate(-30),
      validFrom: isoDate(-30),
      validUntil: isoDate(730),
      documentId: context.vendorRegistrationDocumentId,
    };
    await expectStatus(api("/api/vendor/setup", {
      token: context.tokens.vendorTwo,
      json: { ...registration, latitude: "91" },
    }), 400, "invalid private vendor location");
    await expectStatus(api("/api/vendor/setup", {
      token: context.tokens.vendorTwo,
      json: { ...registration, phone: "9999999999" },
    }), 400, "mismatched provider-confirmed phone");
    const saved = await expectStatus(api("/api/vendor/setup", { token: context.tokens.vendorTwo, json: registration }), 200, "submit vendor registration");
    assert.equal(saved.payload.saved, true);
    assert.equal(saved.payload.vendor.businessName, registration.businessName);
    assert.equal(saved.payload.vendor.address, registration.address);
    assert.equal(saved.payload.vendor.latitude, registration.latitude);
    assert.equal(saved.payload.vendor.longitude, registration.longitude);
    assert.equal(saved.payload.vendor.homeDelivery, 1);
    assert.equal(saved.payload.vendor.registrationStatus, "submitted");
    assert.ok(saved.payload.licences.some((row) => row.licenceNumber === registration.licenceNumber && row.verificationStatus === "pending"));
    const pendingReview = await expectStatus(api("/api/auth/profile", { token: context.tokens.vendorTwo }), 200, "submitted vendor review state");
    assert.equal(pendingReview.payload.profile.vendorAccessStatus, "review_pending");
    await expectStatus(api("/api/vendor/operations", { token: context.tokens.vendorTwo }), 403, "pending-review vendor operations");
    const downloaded = await expectStatus(api(`/api/documents/${context.vendorRegistrationDocumentId}`, { token: context.tokens.vendorTwo }), 200, "download submitted vendor licence");
    assert.deepEqual(Buffer.from(downloaded.bytes), png);
  });

  await scenario("received purchases are tenant-scoped and supplier returns reject invalid reuse", async () => {
    const purchase = await expectStatus(api("/api/purchases", {
      token: context.tokens.vendor,
      json: {
        supplierId: 900009,
        invoiceNumber: "P009-INVOICE-001",
        invoiceDate: isoDate(),
        items: [{
          legacyId: context.legacyId,
          batchNumber: "P009-PURCHASE-BATCH",
          expiryDate: isoDate(720),
          manufacturingDate: isoDate(-180),
          dosage: "Integration stock",
          quantity: 5,
          freeQuantity: 0,
          purchasePrice: "10.00",
          salePrice: "12.00",
          mrp: "15.00",
          gstPercent: 5,
        }],
      },
    }), 201, "purchase receiving");
    assert.ok(purchase.payload.purchaseNumber);
    const operations = await expectStatus(api("/api/vendor/operations", { token: context.tokens.vendor }), 200, "return selector");
    const returnable = operations.payload.returnablePurchases.find((row) => row.batchNumber === "P009-PURCHASE-BATCH");
    assert.ok(returnable, "received purchase must appear in supplier-return selector");
    assert.equal(returnable.purchasedQuantity, 5);
    context.purchaseItemId = returnable.purchaseOrderItemId;

    await expectStatus(api("/api/vendor/operations", {
      token: context.tokens.vendorOperationalTwo,
      json: { action: "supplier_return", purchaseOrderItemId: context.purchaseItemId, quantity: 1, reason: "Cross tenant return attempt" },
    }), 404, "cross-vendor supplier return");
    await expectStatus(api("/api/vendor/operations", {
      token: context.tokens.vendor,
      json: { action: "supplier_return", purchaseOrderItemId: context.purchaseItemId, quantity: 6, reason: "Excess quantity attempt" },
    }), 409, "excess supplier return");
    const completed = await expectStatus(api("/api/vendor/operations", {
      token: context.tokens.vendor,
      json: { action: "supplier_return", purchaseOrderItemId: context.purchaseItemId, quantity: 2, reason: "Damaged supplier packaging" },
    }), 201, "supplier return completion");
    context.supplierReturnNumber = completed.payload.returnNumber;
    assert.ok(completed.payload.debitNoteNumber);
    await expectStatus(api("/api/vendor/operations", {
      token: context.tokens.vendor,
      json: { action: "supplier_return", purchaseOrderItemId: context.purchaseItemId, quantity: 4, reason: "Return more than remainder" },
    }), 409, "return above remaining quantity");
    await expectStatus(api("/api/vendor/operations", {
      token: context.tokens.vendor,
      json: { action: "supplier_return", purchaseOrderItemId: context.purchaseItemId, quantity: 3, reason: "Return final received units" },
    }), 201, "return final quantity");
    await expectStatus(api("/api/vendor/operations", {
      token: context.tokens.vendor,
      json: { action: "supplier_return", purchaseOrderItemId: context.purchaseItemId, quantity: 1, reason: "Attempt double return" },
    }), 409, "double supplier return");
  });

  await scenario("online reservations commit or release exactly once across terminal paths", async () => {
    const initial = inventoryRow((await inventoryMine()).payload, context.inventoryId);
    const successful = await createOnlineOrder(2);
    context.successfulOrderId = successful.payload.order.id;
    const reserved = inventoryRow((await inventoryMine()).payload, context.inventoryId);
    assert.equal(reserved.quantity, initial.quantity);
    assert.equal(reserved.reservedQuantity, initial.reservedQuantity + 2);
    const successfulProviderOrderId = `order_p009_${context.successfulOrderId}`;
    const successfulPaymentId = "pay_p009_success";
    const verification = {
      razorpay_order_id: successfulProviderOrderId,
      razorpay_payment_id: successfulPaymentId,
      razorpay_signature: signed(razorpaySecret, `${successfulProviderOrderId}|${successfulPaymentId}`),
    };
    assert.equal((await expectStatus(api("/api/payments/razorpay/verify", { token: context.tokens.customer, json: verification }), 200, "payment verification")).payload.duplicate, false);
    assert.equal((await expectStatus(api("/api/payments/razorpay/verify", { token: context.tokens.customer, json: verification }), 200, "duplicate payment verification")).payload.duplicate, true);
    const committed = inventoryRow((await inventoryMine()).payload, context.inventoryId);
    assert.equal(committed.quantity, initial.quantity - 2);
    assert.equal(committed.reservedQuantity, initial.reservedQuantity);

    const failed = await createOnlineOrder(3);
    context.failedOrderId = failed.payload.order.id;
    const failedProviderOrderId = `order_p009_${context.failedOrderId}`;
    const webhookBody = JSON.stringify({ event: "payment.failed", payload: { payment: { entity: { id: "pay_p009_failed", order_id: failedProviderOrderId, status: "failed" } } } });
    const webhookHeaders = { "content-type": "application/json", "x-razorpay-signature": signed(webhookSecret, webhookBody) };
    await expectStatus(api("/api/webhooks/razorpay", { body: webhookBody, headers: webhookHeaders }), 200, "failed payment webhook");
    assert.equal((await expectStatus(api("/api/webhooks/razorpay", { body: webhookBody, headers: webhookHeaders }), 200, "duplicate failed webhook")).payload.duplicate, true);
    assert.equal(inventoryRow((await inventoryMine()).payload, context.inventoryId).reservedQuantity, 0);

    const cancelled = await createOnlineOrder(4);
    context.cancelledOrderId = cancelled.payload.order.id;
    await expectStatus(api(`/api/orders/${context.cancelledOrderId}/tracking`, {
      token: context.tokens.vendor,
      json: { status: "cancelled", note: "Customer requested cancellation" },
    }), 200, "order cancellation");
    assert.equal((await expectStatus(api(`/api/orders/${context.cancelledOrderId}/tracking`, {
      token: context.tokens.vendor,
      json: { status: "cancelled", note: "Customer requested cancellation" },
    }), 200, "repeated cancellation")).payload.unchanged, true);
    assert.equal(inventoryRow((await inventoryMine()).payload, context.inventoryId).reservedQuantity, 0);
    await expectStatus(api(`/api/orders/${context.successfulOrderId}/tracking`, { token: context.tokens.vendorOperationalTwo }), 404, "cross-vendor order access");
    await expectStatus(api(`/api/orders/${context.successfulOrderId}/tracking`, { token: context.tokens.customerTwo }), 404, "cross-customer order access");

    const rejected = await createOnlineOrder(2, 900009, 900009);
    context.rejectedOrderId = rejected.payload.order.id;
    await expectStatus(api("/api/prescriptions/900009/review", {
      token: context.tokens.vendor,
      json: { decision: "rejected", notes: "Prescription details cannot be verified" },
    }), 200, "prescription rejection");
    await expectStatus(api("/api/prescriptions/900009/review", {
      token: context.tokens.vendor,
      json: { decision: "rejected", notes: "Prescription details cannot be verified" },
    }), 409, "repeated prescription rejection");
    assert.equal(inventoryRow((await inventoryMine()).payload, 900009).reservedQuantity, 0);
  });

  await scenario("expired reservations cannot pay and scheduled recovery is idempotent without traffic", async () => {
    const expired = await createOnlineOrder(6);
    context.expiredOrderId = expired.payload.order.id;
    const expiredProviderOrderId = `order_p009_${context.expiredOrderId}`;
    const expiredPaymentId = "pay_p009_expired";
    const expiredVerification = {
      razorpay_order_id: expiredProviderOrderId,
      razorpay_payment_id: expiredPaymentId,
      razorpay_signature: signed(razorpaySecret, `${expiredProviderOrderId}|${expiredPaymentId}`),
    };
    await expectStatus(api("/api/payments/razorpay/verify", { token: context.tokens.customer, json: expiredVerification }), 409, "expired reservation payment");
    await expectStatus(api("/api/payments/razorpay/verify", { token: context.tokens.customer, json: expiredVerification }), 409, "repeated expired payment");
    assert.equal(inventoryRow((await inventoryMine()).payload, context.inventoryId).reservedQuantity, 0);

    const abandoned = await createOnlineOrder(6);
    context.abandonedOrderId = abandoned.payload.order.id;
    const scheduled = await triggerScheduled();
    if (scheduled.status !== 200) throw new Error(`scheduled reservation recovery: ${scheduled.text}`);
    const repeatedScheduled = await triggerScheduled();
    if (repeatedScheduled.status !== 200) throw new Error(`repeated scheduled recovery: ${repeatedScheduled.text}`);
    assert.equal(inventoryRow((await inventoryMine()).payload, context.inventoryId).reservedQuantity, 0);
  });

  await scenario("R2 uploads enforce validation, ownership, and metadata failure cleanup", async () => {
    context.objectsBefore = await globalThis.__URMED_INTEGRATION_R2_COUNT__();
    const form = new FormData();
    form.set("purpose", "prescription");
    form.set("file", new File([png], "p009-prescription.png", { type: "image/png" }));
    const uploaded = await expectStatus(api("/api/documents", { token: context.tokens.customer, body: form }), 201, "valid R2 upload");
    context.documentId = uploaded.payload.document.id;
    const downloaded = await expectStatus(api(`/api/documents/${context.documentId}`, { token: context.tokens.customer }), 200, "owner R2 download");
    assert.deepEqual(Buffer.from(downloaded.bytes), png);
    await expectStatus(api(`/api/documents/${context.documentId}`, { token: context.tokens.customerTwo }), 404, "other customer document access");
    await expectStatus(api(`/api/documents/${context.documentId}`, { token: context.tokens.vendorOperationalTwo }), 404, "other vendor document access");
    for (const [filename, mime, bytes] of [
      ["bad-extension.txt", "text/plain", png],
      ["mime-mismatch.png", "image/jpeg", png],
      ["invalid-signature.png", "image/png", Buffer.from("not a png")],
    ]) {
      const invalid = new FormData();
      invalid.set("purpose", "prescription");
      invalid.set("file", new File([bytes], filename, { type: mime }));
      await expectStatus(api("/api/documents", { token: context.tokens.customer, body: invalid }), 400, filename);
    }
    const failing = new FormData();
    failing.set("purpose", "prescription");
    failing.set("file", new File([png], "metadata-failure.png", { type: "image/png" }));
    await expectStatus(api("/api/documents", { token: context.tokens.customer, body: failing }), 500, "metadata persistence failure");
  });

  await scenario("post-run D1 and R2 inspection proves transactional side effects", async () => {
    const evidence = await inspectPersistence(context);
    assert.equal(evidence.migrationCount, migrationCount);
    assert.equal(evidence.recoveredProfileCount, 0);
    assert.equal(evidence.recoveredTestAccountCount, 0);
    assert.deepEqual({ ...evidence.vendorRegistration }, {
      id: 2,
      businessName: "P1 Integration Pharmacy",
      address: "P1 private legal location",
      latitude: "17.431800",
      longitude: "78.407300",
      approvalStatus: "pending",
      complianceStatus: "pending",
      licenceNumber: "DL-P1-INTEGRATION",
      licenceStatus: "pending",
    });
    assert.equal(evidence.vendorRegistrationAuditCount, 1);
    assert.equal(evidence.returnedInventoryQuantity, 0);
    assert.equal(evidence.supplierReturn.debitNoteNumber.startsWith("DN-"), true);
    assert.equal(evidence.supplierReturn.totalPaise, 2_000);
    assert.deepEqual(evidence.supplierReturnLedgerAccounts, ["PURCHASE_RETURNS", "SUPPLIER_PAYABLE"]);
    assert.deepEqual(evidence.supplierReturnMovements.map((row) => ({ ...row })), [
      { movementType: "supplier_return", quantityDelta: -2, balanceAfter: 3 },
    ]);
    assert.equal(evidence.supplierReturnAuditCount, 1);
    assert.deepEqual({ ...evidence.purchaseReturnSummary }, {
      returnCount: 2,
      returnedQuantity: 5,
      stockMovementCount: 2,
      ledgerEntryCount: 4,
      auditEventCount: 2,
    });
    assert.deepEqual(evidence.reservations, {
      [context.successfulOrderId]: "committed",
      [context.failedOrderId]: "released",
      [context.cancelledOrderId]: "released",
      [context.rejectedOrderId]: "released",
      [context.expiredOrderId]: "expired",
      [context.abandonedOrderId]: "expired",
    });
    assert.equal(evidence.onlineSaleLedgerCount, 1);
    assert.equal(evidence.inventory.quantity, 98);
    assert.equal(evidence.inventory.reservedQuantity, 0);
    assert.equal(evidence.rxInventory.reservedQuantity, 0);
    assert.equal(evidence.recoveryTotals.ordersReleased, 1);
    assert.equal(evidence.recoveryTotals.reservationsReleased, 2);
    assert.equal(evidence.document.sizeBytes, png.byteLength);
    assert.equal(evidence.document.mimeType, "image/png");
    assert.equal(evidence.document.sha256, "431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460");
    assert.equal(evidence.document.status, "active");
    assert.equal(evidence.documentMetadataFailures, 0);
    assert.equal(evidence.r2PayloadCount, context.objectsBefore + 1);
  });
}
