import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

const razorpaySecret = process.env.URMED_INTEGRATION_RAZORPAY_SECRET;
const webhookSecret = process.env.URMED_INTEGRATION_WEBHOOK_SECRET;
const inactiveToken = process.env.URMED_INTEGRATION_INACTIVE_TOKEN;
const integrationTestAuthSecret = process.env.URMED_INTEGRATION_TEST_AUTH_SECRET;
const migrationCount = Number(process.env.URMED_INTEGRATION_MIGRATION_COUNT);
const inspectPersistence = globalThis.__URMED_INTEGRATION_INSPECT__;
const triggerScheduled = globalThis.__URMED_INTEGRATION_SCHEDULED__;
const setTestClaims = globalThis.__URMED_INTEGRATION_SET_TEST_CLAIMS__;
const enableEmail = globalThis.__URMED_INTEGRATION_ENABLE_EMAIL__;
const inspectEmailOutbox = globalThis.__URMED_INTEGRATION_EMAIL_OUTBOX_INSPECT__;
const expireOrder = globalThis.__URMED_INTEGRATION_EXPIRE_ORDER__;
const orderEvidence = globalThis.__URMED_INTEGRATION_ORDER_EVIDENCE__;
const deliveryEvidence = globalThis.__URMED_INTEGRATION_DELIVERY_EVIDENCE__;
for (const [name, value] of Object.entries({
  baseUrl: process.env.URMED_INTEGRATION_BASE_URL,
  inspectPersistence,
  triggerScheduled,
  setTestClaims,
  enableEmail,
  inspectEmailOutbox,
  expireOrder,
  orderEvidence,
  deliveryEvidence,
  razorpaySecret,
  webhookSecret,
  inactiveToken,
  integrationTestAuthSecret,
  migrationCount,
})) {
  if (!value) throw new Error(`${name} is required; run this file through npm run test:integration`);
}

const context = {
  tokens: {},
  vendorId: 0,
  customerAddressId: 0,
  inventoryId: 0,
  invoiceOrderId: 0,
  invoiceId: 0,
  multiLineOrderId: 0,
  multiRxOrderId: 0,
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
  inventoryAdjustmentNumber: "",
  inventoryCountSessionNumber: "",
  firstReturnReleasedAt: "",
  abandonedReleasedAt: "",
  objectsBefore: 0,
  identityRaceWinners: [],
  manufacturerRequestId: 0,
  manufacturerId: 0,
  manufacturerTargetId: 0,
  manufacturerProductId: 0,
  manufacturerInventoryId: 0,
  offlineSaleId: 0,
  offlineRxSaleId: 0,
  offlinePrescriptionId: 0,
  offlinePrescriptionDocumentId: 0,
  vendorNotificationId: 0,
  vendorNotificationReplacementId: 0,
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
    headers: { "x-urmed-integration-key": integrationTestAuthSecret },
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

async function createOnlineOrder(quantity, inventoryId = context.inventoryId, prescriptionId, deliveryMethod = "pickup") {
  return expectStatus(api("/api/orders", {
    token: context.tokens.customer,
    json: {
      items: [{ inventoryId, quantity }],
      paymentMethod: "online",
      deliveryMethod,
      placeOfSupplyStateCode: "36",
      customerAddressId: context.customerAddressId,
      ...(prescriptionId ? { prescriptionId } : {}),
    },
  }), 201, "create online order");
}

async function captureOnlineOrder(orderResult, label) {
  const orderId = orderResult.payload.order.id;
  const providerOrder = await expectStatus(api("/api/payments/razorpay/order", {
    token: context.tokens.customer, json: { orderId },
  }), 200, `${label} provider order`);
  const providerOrderId = providerOrder.payload.id;
  const paymentId = `pay_p308_${orderId}_${orderResult.payload.order.totalPaise}`;
  const captureBody = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: {
    id: paymentId, order_id: providerOrderId, amount: orderResult.payload.order.totalPaise,
    currency: "INR", status: "captured",
  } } } });
  await expectStatus(api("/api/webhooks/razorpay", {
    body: captureBody,
    headers: { "content-type": "application/json", "x-razorpay-signature": signed(webhookSecret, captureBody) },
  }), 200, `${label} payment capture webhook`);
  return { providerOrderId, paymentId };
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

function assertPrivateReport(result, report) {
  assert.equal(result.payload?.report, report);
  assert.match(result.response.headers.get("cache-control") ?? "", /private.*no-store/i);
  assert.equal(result.response.headers.get("content-type")?.includes("application/json"), true);
}

function assertReportCsv(result, filename, header) {
  assert.equal(result.response.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.equal(result.response.headers.get("content-disposition"), `attachment; filename="${filename}"`);
  assert.match(result.response.headers.get("cache-control") ?? "", /private.*no-store/i);
  assert.equal(result.response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(result.text.split(/\r?\n/)[0], header);
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
    context.tokens.customerPhonePending = await login("customer-phone-pending@urmed.test");
    context.tokens.vendorInventoryStaff = await login("vendor-inventory-staff@urmed.test");
    context.tokens.vendorDeliveryCoordinator = await login("vendor-delivery-coordinator@urmed.test");
    context.tokens.vendorCounterStaff = await login("vendor-counter-staff@urmed.test");
    context.tokens.vendorExpiredPos = await login("vendor-expired-pos@urmed.test");
    context.tokens.delivery = await login("delivery@urmed.test");
    context.tokens.deliveryTwo = await login("delivery-two@urmed.test");

    const verificationReturnPage = await expectStatus(api("/vendor/verification-return?type=signup&token=must-not-render"), 200, "vendor verification return page");
    assert.match(verificationReturnPage.text, /Checking(?: the)? verification return/i);
    assert.doesNotMatch(verificationReturnPage.text, /must-not-render/);
    const verificationProblemPage = await expectStatus(api("/vendor/verification-return?error=access_denied&error_description=must-not-render"), 200, "vendor verification problem page");
    assert.match(verificationProblemPage.text, /Verification needs attention/);
    assert.doesNotMatch(verificationProblemPage.text, /must-not-render/);
    const registrationStatusPage = await expectStatus(api("/vendor/registration/status"), 200, "vendor registration status page");
    assert.match(registrationStatusPage.text, /Loading secured registration status/);
    await expectStatus(api("/api/vendor/registration/status"), 401, "unauthenticated registration status API");
    await expectStatus(api("/api/orders"), 401, "unauthenticated order list");
    await expectStatus(api("/api/admin/operations", { token: context.tokens.customer }), 403, "customer admin access");
    await expectStatus(api("/api/admin/operations", { token: context.tokens.vendor }), 403, "vendor admin access");
    await expectStatus(api("/api/admin/operations", { token: context.tokens.admin }), 200, "administrator access");
    await expectStatus(api("/api/auth/profile", { token: inactiveToken }), 401, "inactive session");
    await expectStatus(api("/api/auth/test-login", {
      headers: { "x-urmed-integration-key": integrationTestAuthSecret },
      json: { email: "inactive@urmed.test", password: "Urmed@Test2026!" },
    }), 401, "inactive account login");

    const recoveredLogin = await expectStatus(api("/api/auth/test-login", {
      headers: { "x-urmed-integration-key": integrationTestAuthSecret },
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
    await expectStatus(api("/api/vendor/operations", { token: context.tokens.vendor }), 200, "vendor operations");
    const vendorProfile = await expectStatus(api("/api/auth/profile", { token: context.tokens.vendor }), 200, "vendor tenant identity");
    context.vendorId = vendorProfile.payload.profile.vendorId;
    assert.ok(context.vendorId > 0);
    await enableEmail("customer@urmed.test");
  });

  await scenario("vendor notification inbox is private, tenant-scoped, versioned, audited, and re-alertable", async () => {
    await expectStatus(api("/api/vendor/notifications"), 401, "unauthenticated vendor notification inbox");
    await expectStatus(api("/api/vendor/notifications", { token: context.tokens.customer }), 403, "customer vendor notification inbox");
    await expectStatus(api("/api/vendor/notifications", { token: context.tokens.vendorDeliveryCoordinator }), 403, "delivery coordinator notification inbox");

    const initialScheduled = await triggerScheduled("30 0 * * *");
    if (initialScheduled.status !== 200) throw new Error(`scheduled vendor inventory alerts: ${initialScheduled.text}`);
    const deduplicatedScheduled = await triggerScheduled("30 0 * * *");
    if (deduplicatedScheduled.status !== 200) throw new Error(`repeated scheduled vendor inventory alerts: ${deduplicatedScheduled.text}`);

    const ownerInbox = await expectStatus(api("/api/vendor/notifications?includeResolved=true&limit=100", {
      token: context.tokens.vendor,
    }), 200, "vendor owner notification inbox");
    assert.match(ownerInbox.response.headers.get("cache-control") ?? "", /private.*no-store/i);
    assert.equal(ownerInbox.payload.canManage, true);
    const target = ownerInbox.payload.notifications.find((notification) =>
      notification.notificationType === "inventory_near_expiry"
        && notification.referenceType === "inventory_batch"
        && notification.referenceId === 900040);
    assert.ok(target, "the scheduled handler must create the primary vendor near-expiry alert");
    assert.equal(ownerInbox.payload.notifications.filter((notification) =>
      notification.notificationType === "inventory_near_expiry"
        && notification.referenceType === "inventory_batch"
        && notification.referenceId === 900040).length, 1, "scheduled retries must keep one active occurrence");
    assert.equal(ownerInbox.payload.notifications.some((notification) => notification.referenceId === 900041), false,
      "the primary vendor inbox must not expose the other vendor fixture");
    context.vendorNotificationId = target.id;

    const otherVendorInbox = await expectStatus(api("/api/vendor/notifications?includeResolved=true&limit=100", {
      token: context.tokens.vendorOperationalTwo,
    }), 200, "other vendor notification inbox");
    assert.ok(otherVendorInbox.payload.notifications.some((notification) => notification.referenceId === 900041));
    assert.equal(otherVendorInbox.payload.notifications.some((notification) => notification.referenceId === 900040), false);
    await expectStatus(api("/api/vendor/notifications", {
      token: context.tokens.vendorOperationalTwo,
      json: { id: target.id, version: target.version, action: "read" },
    }), 404, "cross-vendor notification transition");

    const counterInbox = await expectStatus(api("/api/vendor/notifications?limit=100", {
      token: context.tokens.vendorCounterStaff,
    }), 200, "read-only counter notification inbox");
    assert.equal(counterInbox.payload.canManage, false);
    assert.ok(counterInbox.payload.notifications.some((notification) => notification.id === target.id));
    const counterReadable = counterInbox.payload.notifications.find((notification) =>
      notification.notificationType === "inventory_zero_stock"
        && notification.message.includes("P503 Primary Vendor Alert Fixture"));
    assert.ok(counterReadable);
    const counterRead = await expectStatus(api("/api/vendor/notifications", {
      token: context.tokens.vendorCounterStaff,
      json: { id: counterReadable.id, version: counterReadable.version, action: "read" },
    }), 200, "counter staff can mark an inventory alert read");
    assert.equal(counterRead.payload.notification.lifecycleStatus, "read");
    await expectStatus(api("/api/vendor/notifications", {
      token: context.tokens.vendorCounterStaff,
      json: { id: target.id, version: target.version, action: "acknowledge" },
    }), 403, "counter staff cannot acknowledge inventory alert");
    const inventoryManagerInbox = await expectStatus(api("/api/vendor/notifications?limit=100", {
      token: context.tokens.vendorInventoryStaff,
    }), 200, "inventory manager notification inbox");
    assert.equal(inventoryManagerInbox.payload.canManage, true);

    const read = await expectStatus(api("/api/vendor/notifications", {
      token: context.tokens.vendor,
      json: { id: target.id, version: 0, action: "read" },
    }), 200, "read vendor inventory alert");
    assert.equal(read.payload.updated, true);
    assert.equal(read.payload.notification.lifecycleStatus, "read");
    assert.equal(read.payload.notification.version, 1);
    assert.ok(read.payload.notification.readAt);
    const repeatedRead = await expectStatus(api("/api/vendor/notifications", {
      token: context.tokens.vendor,
      json: { id: target.id, version: 0, action: "read" },
    }), 200, "idempotent read retry");
    assert.equal(repeatedRead.payload.updated, false);
    assert.equal(repeatedRead.payload.unchanged, true);
    assert.equal(repeatedRead.payload.notification.version, 1);

    const acknowledged = await expectStatus(api("/api/vendor/notifications", {
      token: context.tokens.vendorInventoryStaff,
      json: { id: target.id, version: 1, action: "acknowledge" },
    }), 200, "inventory manager acknowledges alert");
    assert.equal(acknowledged.payload.notification.lifecycleStatus, "acknowledged");
    assert.equal(acknowledged.payload.notification.version, 2);
    assert.ok(acknowledged.payload.notification.acknowledgedAt);

    const snoozedUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await expectStatus(api("/api/vendor/notifications", {
      token: context.tokens.vendor,
      json: { id: target.id, version: 1, action: "snooze", snoozedUntil },
    }), 409, "stale notification version is rejected");
    const snoozed = await expectStatus(api("/api/vendor/notifications", {
      token: context.tokens.vendorInventoryStaff,
      json: { id: target.id, version: 2, action: "snooze", snoozedUntil },
    }), 200, "snooze vendor inventory alert");
    assert.equal(snoozed.payload.notification.lifecycleStatus, "snoozed");
    assert.equal(snoozed.payload.notification.version, 3);
    assert.equal(snoozed.payload.notification.snoozedUntil, snoozedUntil);

    const resolved = await expectStatus(api("/api/vendor/notifications", {
      token: context.tokens.vendor,
      json: { id: target.id, version: 3, action: "resolve", reason: "P503 replacement stock ordered" },
    }), 200, "resolve vendor inventory alert");
    assert.equal(resolved.payload.notification.lifecycleStatus, "resolved");
    assert.equal(resolved.payload.notification.version, 4);
    assert.equal(resolved.payload.notification.resolutionReason, "P503 replacement stock ordered");
    const activeAfterResolution = await expectStatus(api("/api/vendor/notifications?limit=100", {
      token: context.tokens.vendor,
    }), 200, "active notification inbox after resolution");
    assert.equal(activeAfterResolution.payload.notifications.some((notification) => notification.id === target.id), false);

    const reAlertScheduled = await triggerScheduled("30 0 * * *");
    if (reAlertScheduled.status !== 200) throw new Error(`resolved-condition vendor re-alert: ${reAlertScheduled.text}`);
    const withResolved = await expectStatus(api("/api/vendor/notifications?includeResolved=true&limit=100", {
      token: context.tokens.vendor,
    }), 200, "resolved and re-alerted notification history");
    const occurrences = withResolved.payload.notifications.filter((notification) =>
      notification.notificationType === "inventory_near_expiry"
        && notification.referenceType === "inventory_batch"
        && notification.referenceId === 900040);
    assert.equal(occurrences.length, 2);
    assert.equal(occurrences.filter((notification) => notification.lifecycleStatus === "resolved").length, 1);
    const replacement = occurrences.find((notification) => notification.lifecycleStatus !== "resolved");
    assert.ok(replacement);
    assert.notEqual(replacement.id, target.id);
    context.vendorNotificationReplacementId = replacement.id;
    const repeatedReAlert = await triggerScheduled("30 0 * * *");
    if (repeatedReAlert.status !== 200) throw new Error(`repeated resolved-condition vendor re-alert: ${repeatedReAlert.text}`);
    const afterRepeatedReAlert = await expectStatus(api("/api/vendor/notifications?includeResolved=true&limit=100", {
      token: context.tokens.vendor,
    }), 200, "deduplicated replacement notification history");
    assert.equal(afterRepeatedReAlert.payload.notifications.filter((notification) =>
      notification.notificationType === "inventory_near_expiry"
        && notification.referenceType === "inventory_batch"
        && notification.referenceId === 900040).length, 2);
  });

  await scenario("saved customer addresses are verified, editable, defaulted, and tenant scoped", async () => {
    const initial = await expectStatus(api("/api/customer/addresses", { token: context.tokens.customer }), 200, "customer address book");
    assert.deepEqual(initial.payload.identity, {
      name: "URMED Test Customer",
      email: "customer@urmed.test",
      phone: "0000000001",
    });
    assert.equal(initial.payload.addresses.length, 1);
    assert.equal(initial.payload.addresses[0].id, 900010);
    assert.equal(initial.payload.addresses[0].isDefault, true);
    const otherCustomer = await expectStatus(api("/api/customer/addresses", { token: context.tokens.customerTwo }), 200, "other customer address book");
    assert.deepEqual(otherCustomer.payload.addresses.map((address) => address.id), [900011]);

    const created = await expectStatus(api("/api/customer/addresses", {
      token: context.tokens.customer,
      json: {
        action: "save",
        label: "P4 Work",
        address: "P4 customer work address",
        latitude: "17.432000",
        longitude: "78.407500",
        isDefault: false,
      },
    }), 201, "create owned customer address");
    const createdId = created.payload.selectedAddressId;
    assert.ok(createdId > 0);
    await expectStatus(api("/api/customer/addresses", {
      token: context.tokens.customerTwo,
      json: {
        action: "save",
        id: createdId,
        label: "Cross tenant edit",
        address: "Cross tenant address must not save",
        latitude: "17.432000",
        longitude: "78.407500",
      },
    }), 404, "cross-customer address edit");
    const edited = await expectStatus(api("/api/customer/addresses", {
      token: context.tokens.customer,
      json: {
        action: "save",
        id: createdId,
        label: "P4 Office",
        address: "P4 edited customer office address",
        latitude: "17.432100",
        longitude: "78.407600",
        isDefault: false,
      },
    }), 200, "edit owned customer address");
    assert.equal(edited.payload.addresses.find((address) => address.id === createdId).label, "P4 Office");
    const defaulted = await expectStatus(api("/api/customer/addresses", {
      token: context.tokens.customer,
      json: { action: "set_default", id: createdId },
    }), 200, "set customer default address");
    assert.equal(defaulted.payload.addresses.filter((address) => address.isDefault).length, 1);
    assert.equal(defaulted.payload.addresses.find((address) => address.isDefault).id, createdId);
    context.customerAddressId = createdId;

    await expectStatus(api("/api/orders", {
      token: context.tokens.customer,
      json: {
        items: [{ inventoryId: context.inventoryId, quantity: 1 }],
        customerAddressId: 900011,
        paymentMethod: "online",
        deliveryMethod: "pickup",
        placeOfSupplyStateCode: "36",
      },
    }), 404, "cross-customer checkout address");
    const phoneMismatch = await expectStatus(api("/api/orders", {
      token: context.tokens.customer,
      json: {
        items: [{ inventoryId: context.inventoryId, quantity: 1 }],
        customerAddressId: createdId,
        customerPhone: "9999999999",
        paymentMethod: "online",
        deliveryMethod: "pickup",
        placeOfSupplyStateCode: "36",
      },
    }), 409, "checkout phone cannot override verified profile");
    assert.match(phoneMismatch.payload.error, /re-verify.*mobile number/i);
  });

  await scenario("vendor order workflow requires sale.write without unauthorized side effects", async () => {
    const created = await expectStatus(api("/api/orders", {
      token: context.tokens.customer,
      json: {
        items: [{ inventoryId: context.inventoryId, quantity: 1 }],
        customerAddressId: context.customerAddressId,
        paymentMethod: "cod",
        deliveryMethod: "pickup",
        placeOfSupplyStateCode: "36",
      },
    }), 201, "create guarded staff-permission order");
    const orderId = created.payload.order.id;

    for (const [token, label] of [
      [context.tokens.vendorInventoryStaff, "inventory manager"],
      [context.tokens.vendorDeliveryCoordinator, "delivery coordinator"],
    ]) {
      const listDenied = await expectStatus(api("/api/orders", { token }), 403, `${label} generic order list denied`);
      assert.match(listDenied.response.headers.get("cache-control") ?? "", /no-store/i);
      const trackingDenied = await expectStatus(api(`/api/orders/${orderId}/tracking`, { token }), 403, `${label} tracking read denied`);
      assert.match(trackingDenied.response.headers.get("cache-control") ?? "", /no-store/i);
    }

    const counterList = await expectStatus(api("/api/orders", {
      token: context.tokens.vendorCounterStaff,
    }), 200, "counter staff sale.write order list");
    assert.equal(counterList.payload.orders.some((order) => order.id === orderId), true);
    assert.match(counterList.response.headers.get("cache-control") ?? "", /private.*no-store/i);
    const counterTracking = await expectStatus(api(`/api/orders/${orderId}/tracking`, {
      token: context.tokens.vendorCounterStaff,
    }), 200, "counter staff sale.write tracking read");
    assert.match(counterTracking.response.headers.get("cache-control") ?? "", /private.*no-store/i);
    const vendorNotifications = await expectStatus(api("/api/vendor/notifications?includeResolved=true&limit=100", { token: context.tokens.vendor }), 200, "vendor order notification inbox");
    assert.ok(vendorNotifications.payload.notifications.some((notification) => notification.notificationType === "vendor_order_new" && notification.referenceId === orderId));

    const before = await orderEvidence(orderId);
    for (const [token, label] of [
      [context.tokens.vendorInventoryStaff, "inventory manager"],
      [context.tokens.vendorDeliveryCoordinator, "delivery coordinator"],
    ]) {
      await expectStatus(api(`/api/orders/${orderId}/tracking`, {
        token,
        json: { status: "cancelled", note: `${label} must not mutate this order` },
      }), 403, `${label} tracking mutation denied`);
    }
    assert.deepEqual(await orderEvidence(orderId), before,
      "denied staff requests must not change order, inventory, stock/accounting ledgers, events, or audit evidence");

    await expectStatus(api(`/api/orders/${orderId}/tracking`, {
      token: context.tokens.vendorCounterStaff,
      json: { status: "cancelled", note: "Authorized counter cancellation fixture" },
    }), 200, "counter staff sale.write tracking mutation");
    const after = await orderEvidence(orderId);
    assert.equal(after.order.orderStatus, "cancelled");
    assert.equal(after.order.inventoryStatus, "released");
    assert.equal(after.inventory[0].quantity, before.inventory[0].quantity + 1);
    assert.equal(after.stockLedgerCount, before.stockLedgerCount + 1);
  });

  await scenario("delivery locations require fresh proof and expose only published operational coordinates", async () => {
    const initial = await expectStatus(api("/api/delivery", { token: context.tokens.delivery }), 200, "delivery workspace");
    assert.match(initial.response.headers.get("cache-control") ?? "", /private.*no-store/i);
    assert.doesNotMatch(initial.text, /Test location, Hyderabad, Telangana/);
    assert.doesNotMatch(initial.text, /17\.4318|78\.4073/);

    const missing = await expectStatus(api("/api/delivery", {
      token: context.tokens.delivery,
      json: { availabilityStatus: "online", latitude: "17.432200", longitude: "78.407700", accuracy: 10 },
    }), 400, "missing browser location timestamp");
    assert.match(missing.payload.error, /timestamp/i);
    await expectStatus(api("/api/delivery", {
      token: context.tokens.delivery,
      json: { availabilityStatus: "online", latitude: "17.432200", longitude: "78.407700", accuracy: 10, capturedAt: new Date(Date.now() - 60_000).toISOString() },
    }), 400, "stale browser location");
    await expectStatus(api("/api/delivery", {
      token: context.tokens.delivery,
      json: { availabilityStatus: "online", latitude: "17.432200", longitude: "78.407700", accuracy: 250, capturedAt: new Date().toISOString() },
    }), 400, "inaccurate browser location");

    const capturedAt = new Date().toISOString();
    const proof = { availabilityStatus: "online", latitude: "17.432200", longitude: "78.407700", accuracy: 12, capturedAt, source: "gps_watch" };
    await expectStatus(api("/api/delivery", { token: context.tokens.delivery, json: proof }), 200, "fresh browser location");
    const afterFresh = await deliveryEvidence();
    assert.equal(afterFresh.agent.availabilityStatus, "online");
    assert.equal(afterFresh.availabilityAuditCount, 1);
    assert.equal(afterFresh.locationPingAuditCount, 0);
    await expectStatus(api("/api/delivery", { token: context.tokens.delivery, json: proof }), 409, "replayed browser location");
    await expectStatus(api("/api/delivery", {
      token: context.tokens.delivery,
      json: { ...proof, latitude: "17.432210", capturedAt: new Date(Date.parse(capturedAt) + 1_000).toISOString() },
    }), 429, "throttled live location update");
    const afterRejectedUpdates = await deliveryEvidence();
    assert.deepEqual(afterRejectedUpdates, afterFresh, "rejected GPS updates must not change location state or amplify audit events");

    const order = await expectStatus(api("/api/orders", {
      token: context.tokens.customer,
      json: {
        items: [{ inventoryId: context.inventoryId, quantity: 1 }],
        customerAddressId: context.customerAddressId,
        paymentMethod: "cod",
        deliveryMethod: "urmed",
        placeOfSupplyStateCode: "36",
      },
    }), 201, "create assigned delivery privacy order");
    const orderId = order.payload.order.id;
    await expectStatus(api(`/api/orders/${orderId}/tracking`, {
      token: context.tokens.vendor,
      json: { status: "confirmed", note: "Delivery privacy order confirmed" },
    }), 200, "confirm delivery privacy order");
    await expectStatus(api(`/api/orders/${orderId}/tracking`, {
      token: context.tokens.vendor,
      json: { status: "packed", note: "Delivery privacy order packed" },
    }), 200, "pack delivery privacy order");
    await expectStatus(api(`/api/orders/${orderId}/tracking`, {
      token: context.tokens.vendor,
      json: { status: "ready_for_pickup", note: "Delivery privacy order ready" },
    }), 200, "ready delivery privacy order");
    const agents = await expectStatus(api("/api/admin/operations", { token: context.tokens.admin }), 200, "dispatch delivery agent list");
    const deliveryAgentId = agents.payload.deliveryAgents.find((agent) => agent.name === "URMED Test Rider")?.id;
    assert.ok(deliveryAgentId, "delivery agent fixture must be dispatchable");
    await expectStatus(api("/api/admin/operations", {
      token: context.tokens.admin,
      json: { action: "assign_delivery", orderId, agentId: deliveryAgentId },
    }), 200, "assign delivery privacy order");
    const assigned = await expectStatus(api("/api/delivery", { token: context.tokens.delivery }), 200, "assigned delivery workspace");
    const assignment = assigned.payload.assignments.find((row) => row.orderId === orderId);
    assert.ok(assignment);
    assert.equal(assignment.pickupAddress, "P009 explicitly public pickup point");
    assert.equal(assignment.pickupLatitude, "17.432100");
    assert.equal(assignment.pickupLongitude, "78.407600");
    assert.doesNotMatch(assigned.text, /Test location, Hyderabad, Telangana|17\.4318|78\.4073/);
    await expectStatus(api("/api/delivery", { token: context.tokens.deliveryTwo }), 200, "unassigned rider workspace");
    await expectStatus(api(`/api/orders/${orderId}/tracking`, { token: context.tokens.deliveryTwo }), 404, "unassigned rider tracking isolation");

    await expectStatus(api(`/api/orders/${orderId}/tracking`, {
      token: context.tokens.delivery,
      json: { status: "picked_up", latitude: "17.432100", longitude: "78.407600", accuracy: 8 },
    }), 400, "delivery transition missing proof timestamp");
    await expectStatus(api(`/api/orders/${orderId}/tracking`, {
      token: context.tokens.delivery,
      json: { status: "picked_up", latitude: "17.432100", longitude: "78.407600", accuracy: 8, capturedAt: new Date(Date.now() - 60_000).toISOString() },
    }), 400, "delivery transition stale proof");
    await expectStatus(api(`/api/orders/${orderId}/tracking`, {
      token: context.tokens.delivery,
      json: { status: "picked_up", latitude: "17.432100", longitude: "78.407600", accuracy: 250, capturedAt: new Date().toISOString() },
    }), 400, "delivery transition inaccurate proof");
    const pickedUpAt = new Date(Date.now() + 1_000).toISOString();
    const pickupProof = { status: "picked_up", latitude: "17.432100", longitude: "78.407600", accuracy: 8, capturedAt: pickedUpAt };
    await expectStatus(api(`/api/orders/${orderId}/tracking`, { token: context.tokens.delivery, json: pickupProof }), 200, "fresh pickup proof");
    await expectStatus(api(`/api/orders/${orderId}/tracking`, { token: context.tokens.delivery, json: { ...pickupProof, status: "out_for_delivery" } }), 409, "replayed transition proof");
    await expectStatus(api(`/api/orders/${orderId}/tracking`, { token: context.tokens.delivery, json: {
      ...pickupProof, status: "out_for_delivery", capturedAt: new Date(Date.parse(pickedUpAt) + 1_000).toISOString(),
    } }), 200, "fresh out-for-delivery proof");
    await expectStatus(api(`/api/orders/${orderId}/cod-collection`, {
      token: context.tokens.customer,
      json: { amountPaise: order.payload.order.totalPaise, tenderMode: "cash", receiptReference: "COD-CUSTOMER-BYPASS", idempotencyKey: "cod-customer-bypass-001" },
    }), 403, "customer cannot record COD collection");
    const collection = await expectStatus(api(`/api/orders/${orderId}/cod-collection`, {
      token: context.tokens.delivery,
      json: { amountPaise: order.payload.order.totalPaise, tenderMode: "cash", receiptReference: "COD-DELIVERY-900", idempotencyKey: "cod-delivery-900" },
    }), 200, "assigned rider records COD collection evidence");
    assert.equal(collection.payload.custodyStatus, "on_hand");
    assert.equal((await expectStatus(api(`/api/orders/${orderId}/cod-collection`, {
      token: context.tokens.delivery,
      json: { amountPaise: order.payload.order.totalPaise, tenderMode: "cash", receiptReference: "COD-DELIVERY-900", idempotencyKey: "cod-delivery-900" },
    }), 200, "replayed COD collection evidence")).payload.duplicate, true);
    await expectStatus(api(`/api/orders/${orderId}/tracking`, { token: context.tokens.delivery, json: {
      ...pickupProof, status: "delivered", capturedAt: new Date(Date.parse(pickedUpAt) + 2_000).toISOString(),
    } }), 200, "fresh delivered proof issues paid GST invoice");
    const codEvidence = await orderEvidence(orderId);
    assert.deepEqual({ tenderMode: codEvidence.codCollection.tenderMode, amountPaise: codEvidence.codCollection.amountPaise, custodyStatus: codEvidence.codCollection.custodyStatus }, { tenderMode: "cash", amountPaise: order.payload.order.totalPaise, custodyStatus: "on_hand" });

    context.invoiceOrderId = orderId;
    const deliveredDetail = await expectStatus(api(`/api/customer/orders/${orderId}`, { token: context.tokens.customer }), 200, "delivered customer invoice metadata");
    context.invoiceId = deliveredDetail.payload.order.invoice.id;
    assert.ok(context.invoiceId);
    assert.equal(deliveredDetail.payload.order.invoice.downloadImplemented, true);
    assert.match(deliveredDetail.payload.order.invoice.number, /^GST-/);

    const customerPdf = await expectStatus(api(`/api/customer/invoices/${context.invoiceId}?format=pdf`, { token: context.tokens.customer }), 200, "customer GST invoice PDF");
    const repeatedPdf = await expectStatus(api(`/api/customer/invoices/${context.invoiceId}?format=pdf`, { token: context.tokens.customer }), 200, "stable repeated GST invoice PDF");
    assert.equal(customerPdf.response.headers.get("content-type"), "application/pdf");
    assert.match(customerPdf.response.headers.get("cache-control") ?? "", /private.*no-store/i);
    assert.equal(customerPdf.response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(customerPdf.text.slice(0, 8), "%PDF-1.7");
    assert.deepEqual(customerPdf.bytes, repeatedPdf.bytes);
    const customerHtml = await expectStatus(api(`/api/customer/invoices/${context.invoiceId}?format=html`, { token: context.tokens.customer }), 200, "customer printable GST invoice");
    assert.match(customerHtml.text, /GST tax invoice/);
    assert.doesNotMatch(customerHtml.text, /latitude|longitude|17\.4318|78\.4073/i);
    assert.match(customerHtml.response.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    await expectStatus(api(`/api/customer/invoices/${context.invoiceId}`, { token: context.tokens.customerTwo }), 404, "cross-customer GST invoice isolation");
    await expectStatus(api(`/api/vendor/invoices/${context.invoiceId}`, { token: context.tokens.vendorOperationalTwo }), 404, "cross-vendor GST invoice isolation");
    await expectStatus(api(`/api/vendor/invoices/${context.invoiceId}`, { token: context.tokens.vendorInventoryStaff }), 403, "vendor staff without sale.write cannot download invoice");
    await expectStatus(api(`/api/vendor/invoices/${context.invoiceId}?format=html`, { token: context.tokens.vendor }), 200, "issuing vendor printable GST invoice");
  });

  await scenario("manufacturer proposals, concurrency, tenant isolation, rename aliases, and merge governance use real HTTP and D1", async () => {
    const initial = await expectStatus(api("/api/vendor/manufacturers?status=all&pageSize=50", { token: context.tokens.vendor }), 200, "vendor manufacturer master");
    assert.ok(initial.payload.manufacturers.length > 1, "recovered canonical manufacturers must be backfilled");
    const target = initial.payload.manufacturers[0];
    await expectStatus(api("/api/vendor/manufacturers", {
      token: context.tokens.customer,
      json: { requestType: "new", proposedName: "P205 Forbidden Manufacturer" },
    }), 403, "customer cannot propose manufacturer");

    const proposedName = "P205 Integration Manufacturer";
    const concurrent = await Promise.all([
      api("/api/vendor/manufacturers", { token: context.tokens.vendor, json: { requestType: "new", proposedName } }),
      api("/api/vendor/manufacturers", { token: context.tokens.vendor, json: { requestType: "new", proposedName } }),
    ]);
    assert.deepEqual(concurrent.map((result) => result.status).sort((a, b) => a - b), [201, 409]);
    const requestId = concurrent.find((result) => result.status === 201).payload.request.id;

    const otherTenant = await expectStatus(api("/api/vendor/manufacturers?status=pending&q=P205", { token: context.tokens.vendorOperationalTwo }), 200, "other vendor manufacturer queue");
    assert.equal(otherTenant.payload.requests.some((request) => request.id === requestId), false);
    await expectStatus(api(`/api/vendor/manufacturers?id=${requestId}`, { method: "DELETE", token: context.tokens.vendorOperationalTwo }), 404, "cross-vendor manufacturer withdrawal");
    await expectStatus(api("/api/admin/manufacturers", {
      method: "PATCH", token: context.tokens.vendor,
      json: { id: requestId, action: "approve", reason: "Wrong role attempt" },
    }), 403, "vendor cannot govern manufacturer");

    const approvals = await Promise.all([
      api("/api/admin/manufacturers", { method: "PATCH", token: context.tokens.admin, json: { id: requestId, action: "approve", reason: "Verified manufacturer identity" } }),
      api("/api/admin/manufacturers", { method: "PATCH", token: context.tokens.admin, json: { id: requestId, action: "approve", reason: "Repeated concurrent approval" } }),
    ]);
    assert.deepEqual(approvals.map((result) => result.status).sort((a, b) => a - b), [200, 409]);
    const createdManufacturerId = approvals.find((result) => result.status === 200).payload.manufacturer.manufacturerId;
    context.manufacturerRequestId = requestId;
    context.manufacturerId = createdManufacturerId;
    context.manufacturerTargetId = target.id;

    const productReferences = await expectStatus(api("/api/vendor/products?status=all&pageSize=5", { token: context.tokens.vendor }), 200, "manufacturer product references");
    const dosageFormId = productReferences.payload.dosageForms[0].id;
    const productSubmission = await expectStatus(api("/api/vendor/products", {
      token: context.tokens.vendor,
      json: {
        genericName: "P205 Test Compound", tradeName: "P205 Manufacturer Link Tablet",
        dosageFormId, manufacturerId: createdManufacturerId, strengthValue: "10", strengthUnit: "mg",
        packType: "strip", packSizeValue: "10", packSizeUnit: "tablet", dispensingUom: "tablet",
        prescriptionRequired: false, gstPercent: 5, hsnCode: "300490", drugSchedule: "OTC",
        productInformation: "Manufacturer governance linkage integration fixture", coldChainRequired: false,
      },
    }), 201, "submit product linked to governed manufacturer");
    context.manufacturerProductId = productSubmission.payload.product.id;
    await expectStatus(api("/api/admin/products", {
      method: "PATCH", token: context.tokens.admin,
      json: { id: context.manufacturerProductId, action: "approve", reason: "Verified structured integration product" },
    }), 200, "approve manufacturer-linked product");
    await expectStatus(api("/api/inventory", {
      token: context.tokens.vendor,
      json: { legacyId: productSubmission.payload.product.compatibilityId, batchNumber: "P205-MFG-LINK", expiryDate: isoDate(365), manufacturingDate: isoDate(-30), purchasePrice: "10", salePrice: "15", quantity: 5, gstPercent: 5, dosage: "10mg" },
    }), 201, "create manufacturer-linked inventory");
    const linkedInventory = await expectStatus(api("/api/inventory?scope=mine&q=P205%20Manufacturer%20Link", { token: context.tokens.vendor }), 200, "load manufacturer-linked inventory");
    context.manufacturerInventoryId = linkedInventory.payload.inventory.find((row) => row.batchNumber === "P205-MFG-LINK").id;

    const rename = await expectStatus(api("/api/vendor/manufacturers", {
      token: context.tokens.vendor,
      json: { requestType: "rename", manufacturerId: createdManufacturerId, proposedName: "P205 Renamed Manufacturer" },
    }), 201, "propose manufacturer rename");
    await expectStatus(api("/api/admin/manufacturers", {
      method: "PATCH", token: context.tokens.admin,
      json: { id: rename.payload.request.id, action: "approve", reason: "Confirmed legal-name change" },
    }), 200, "approve manufacturer rename");
    const oldAliasSearch = await expectStatus(api("/api/vendor/manufacturers?status=all&q=P205%20Integration", { token: context.tokens.vendor }), 200, "search old manufacturer alias");
    const renamed = oldAliasSearch.payload.manufacturers.find((manufacturer) => manufacturer.id === createdManufacturerId);
    assert.equal(renamed.name, "P205 Renamed Manufacturer");
    assert.match(renamed.aliases, /P205 Integration Manufacturer/);
    const renamedCatalog = await expectStatus(api("/api/catalog?q=P205%20Manufacturer%20Link"), 200, "catalog after manufacturer rename");
    assert.equal(renamedCatalog.payload.products.find((product) => product.name === "P205 Manufacturer Link Tablet").manufacturer, "P205 Renamed Manufacturer");
    const oldAliasInventory = await expectStatus(api("/api/inventory?q=P205%20Integration%20Manufacturer"), 200, "inventory search by old manufacturer alias");
    assert.ok(oldAliasInventory.payload.inventory.some((row) => row.id === context.manufacturerInventoryId));

    const merge = await expectStatus(api("/api/vendor/manufacturers", {
      token: context.tokens.vendor,
      json: { requestType: "merge", manufacturerId: createdManufacturerId, targetManufacturerId: target.id },
    }), 201, "propose manufacturer merge");
    await expectStatus(api("/api/admin/manufacturers", {
      method: "PATCH", token: context.tokens.admin,
      json: { id: merge.payload.request.id, action: "approve", reason: "Confirmed duplicate manufacturer" },
    }), 200, "approve manufacturer merge");
    const mergedAliasSearch = await expectStatus(api("/api/vendor/manufacturers?status=all&q=P205%20Renamed", { token: context.tokens.vendor }), 200, "search merged manufacturer alias");
    const canonicalTarget = mergedAliasSearch.payload.manufacturers.find((manufacturer) => manufacturer.id === target.id);
    assert.ok(canonicalTarget);
    assert.match(canonicalTarget.aliases, /P205 Renamed Manufacturer/);
    const mergedCatalog = await expectStatus(api("/api/catalog?q=P205%20Manufacturer%20Link"), 200, "catalog after manufacturer merge");
    assert.equal(mergedCatalog.payload.products.find((product) => product.name === "P205 Manufacturer Link Tablet").manufacturer, target.name);
    const mergedAliasInventory = await expectStatus(api("/api/inventory?q=P205%20Renamed%20Manufacturer"), 200, "inventory search by merged manufacturer alias");
    assert.ok(mergedAliasInventory.payload.inventory.some((row) => row.id === context.manufacturerInventoryId));
  });

  await scenario("public marketplace protects the vendor registered location", async () => {
    const mine = inventoryRow((await inventoryMine()).payload, context.inventoryId);
    const publicInventory = await expectStatus(api(`/api/inventory?q=${encodeURIComponent(mine.productName)}`), 200, "public inventory privacy");
    const publicStock = inventoryRow(publicInventory.payload, context.inventoryId);
    assert.ok(publicStock, "seeded stock must be discoverable without its private vendor location");
    for (const key of ["address", "latitude", "longitude", "vendorAddress", "vendorLatitude", "vendorLongitude", "pickupAddress", "pickupLatitude", "pickupLongitude", "deliveryRadiusKm"]) {
      assert.equal(Object.hasOwn(publicStock, key), false, `public inventory must not contain ${key}`);
    }
    assert.deepEqual(publicStock.publicLocation, {
      label: "P009 Customer Pickup",
      address: "P009 explicitly public pickup point",
      latitude: "17.432100",
      longitude: "78.407600",
      pickupEnabled: true,
      serviceEnabled: true,
      serviceRadiusKm: 10,
    });
    for (const inventoryId of [900020, 900021, 900022, 900023]) {
      assert.equal(inventoryRow(publicInventory.payload, inventoryId), undefined, `non-operational inventory ${inventoryId} must not be public`);
      await expectStatus(api("/api/orders", {
        token: context.tokens.customer,
        json: {
          items: [{ inventoryId, quantity: 1 }],
          paymentMethod: "online",
          deliveryMethod: "pickup",
          placeOfSupplyStateCode: "36",
          customerAddressId: context.customerAddressId,
        },
      }), 409, `non-operational vendor inventory ${inventoryId} checkout`);
    }

    const catalog = await expectStatus(api(`/api/catalog?q=${encodeURIComponent(mine.productName)}`), 200, "public catalog privacy");
    assert.ok(catalog.payload.products.length > 0);
    for (const product of catalog.payload.products) {
      for (const key of ["address", "latitude", "longitude", "vendorAddress", "vendorLatitude", "vendorLongitude", "pickupAddress", "pickupLatitude", "pickupLongitude"]) {
        assert.equal(Object.hasOwn(product, key), false, `public catalog must not contain ${key}`);
      }
    }
    assert.ok(catalog.payload.products.some((product) => product.publicLocation?.address === "P009 explicitly public pickup point"));

    await expectStatus(api("/api/vendor/public-location", { token: context.tokens.customer }), 403, "customer cannot manage vendor public location");
    const ownerLocation = await expectStatus(api("/api/vendor/public-location", { token: context.tokens.vendor }), 200, "vendor owner public location");
    assert.equal(ownerLocation.payload.publicLocation.publicationStatus, "published");
    const publicLocationUpdate = {
      label: "P009 Published Customer Entrance",
      address: "P009 public entrance, Integration Road",
      latitude: "17.431900",
      longitude: "78.407400",
      pickupEnabled: true,
      serviceEnabled: true,
      serviceRadiusKm: 10,
    };
    await expectStatus(api("/api/vendor/public-location", {
      token: context.tokens.vendor,
      json: { action: "publish", ...publicLocationUpdate },
    }), 400, "publication requires explicit consent");
    await expectStatus(api("/api/vendor/public-location", {
      token: context.tokens.vendorTwo,
      json: { action: "publish", ...publicLocationUpdate, publicationConsent: true },
    }), 403, "incomplete vendor cannot publish a customer location");
    await expectStatus(api("/api/vendor/public-location", {
      token: context.tokens.vendor,
      json: { action: "unpublish" },
    }), 200, "vendor unpublishes customer location");
    const hiddenInventory = await expectStatus(api(`/api/inventory?q=${encodeURIComponent(mine.productName)}`), 200, "unpublished public location");
    assert.equal(inventoryRow(hiddenInventory.payload, context.inventoryId).publicLocation, null);
    const unpublishedDelivery = await expectStatus(api("/api/orders", {
      token: context.tokens.customer,
      json: {
        items: [{ inventoryId: context.inventoryId, quantity: 1 }],
        paymentMethod: "online",
        deliveryMethod: "urmed",
        placeOfSupplyStateCode: "36",
        customerAddressId: context.customerAddressId,
      },
    }), 409, "delivery without a published service point");
    assert.match(unpublishedDelivery.payload.error, /publishes a customer service point/i);
    await expectStatus(api("/api/vendor/public-location", {
      token: context.tokens.vendor,
      json: { action: "publish", ...publicLocationUpdate, publicationConsent: true },
    }), 200, "vendor explicitly republishes customer location");
    const republishedInventory = await expectStatus(api(`/api/inventory?q=${encodeURIComponent(mine.productName)}`), 200, "republished public location");
    assert.equal(inventoryRow(republishedInventory.payload, context.inventoryId).publicLocation.address, publicLocationUpdate.address);

    const outsideAddress = await expectStatus(api("/api/customer/addresses", {
      token: context.tokens.customer,
      json: {
        action: "save",
        label: "Outside service area",
        address: "Outside serviceability probe",
        latitude: "0",
        longitude: "0",
        isDefault: false,
      },
    }), 201, "save outside-service address");
    const outside = await expectStatus(api("/api/orders", {
      token: context.tokens.customer,
      json: {
        items: [{ inventoryId: context.inventoryId, quantity: 1 }],
        paymentMethod: "online",
        deliveryMethod: "urmed",
        placeOfSupplyStateCode: "36",
        customerAddressId: outsideAddress.payload.selectedAddressId,
      },
    }), 409, "private serviceability rejection");
    assert.equal(outside.payload.error, "This delivery address is outside the pharmacy service area. Choose pickup or another pharmacy.");
    assert.doesNotMatch(outside.text, /\d+(?:\.\d+)?\s*km/i);
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
    assert.equal((await expectStatus(api("/api/vendor/registration/status", { token: emailPending }), 200, "email pending registration status")).payload.registration.nextAction, "verify_email");
    assert.equal((await expectStatus(api("/api/vendor/registration/status", { token: phonePending }), 200, "phone pending registration status")).payload.registration.nextAction, "verify_phone");
    assert.equal((await expectStatus(api("/api/vendor/registration/status", { token: bothPending }), 200, "both pending registration status")).payload.registration.nextAction, "verify_email");
    assert.equal((await expectStatus(api("/api/vendor/registration/status", { token: context.tokens.vendorTwo }), 200, "draft registration status")).payload.registration.nextAction, "complete_registration");
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

  await scenario("interrupted customer verification resumes from provider-backed state", async () => {
    const interrupted = await expectStatus(api("/api/auth/profile", { token: context.tokens.customerPhonePending }), 200, "interrupted customer onboarding");
    assert.equal(interrupted.payload.profile.identityVerificationStatus, "phone_pending");
    assert.deepEqual(interrupted.payload.onboarding, {
      status: "phone_pending",
      nextAction: "verify_phone",
      verificationComplete: false,
      resumable: true,
    });
    await expectStatus(api("/api/orders", { token: context.tokens.customerPhonePending }), 403, "interrupted customer operations");

    const resumed = await expectStatus(api("/api/auth/profile", { token: context.tokens.customerPhonePending }), 200, "resumed customer onboarding");
    assert.deepEqual(resumed.payload.onboarding, interrupted.payload.onboarding);
    await setTestClaims("customer-phone-pending@urmed.test", { emailConfirmed: true, phoneConfirmed: true });

    const completed = await expectStatus(api("/api/auth/profile", { token: context.tokens.customerPhonePending }), 200, "completed customer verification sync");
    assert.equal(completed.payload.profile.identityVerificationStatus, "verified");
    assert.deepEqual(completed.payload.onboarding, {
      status: "operational",
      nextAction: "open_workspace",
      verificationComplete: true,
      resumable: true,
    });
    const repeated = await expectStatus(api("/api/auth/profile", { token: context.tokens.customerPhonePending }), 200, "idempotent customer verification sync");
    assert.deepEqual(repeated.payload.profile, completed.payload.profile);
    assert.deepEqual(repeated.payload.onboarding, completed.payload.onboarding);
    await expectStatus(api("/api/orders", { token: context.tokens.customerPhonePending }), 200, "verified customer operations");
  });

  await scenario("vendor registration draft survives interruption without trusting contact fields", async () => {
    const before = await expectStatus(api("/api/vendor/setup", { token: context.tokens.vendorTwo }), 200, "initial vendor draft");
    const originalPhone = before.payload.vendor.phone;
    const originalEmail = before.payload.vendor.email;
    const firstDraft = await expectStatus(api("/api/vendor/setup", {
      token: context.tokens.vendorTwo,
      json: {
        action: "registration_draft",
        businessName: "P110 Resumable Pharmacy",
        ownerName: "P110 Resumable Owner",
        landline: "0401234567",
        gstNumber: "",
        homeDelivery: false,
        deliveryRadiusKm: 5,
        phone: "9999999999",
        email: "spoofed@example.test",
      },
    }), 200, "save first vendor draft step");
    assert.equal(firstDraft.payload.vendor.phone, originalPhone);
    assert.equal(firstDraft.payload.vendor.email, originalEmail);
    assert.equal(firstDraft.payload.registrationDraft.businessName, "P110 Resumable Pharmacy");
    assert.equal(firstDraft.payload.registrationDraft.phone, undefined);
    assert.equal(firstDraft.payload.registrationDraft.email, undefined);

    const resumed = await expectStatus(api("/api/vendor/setup", { token: context.tokens.vendorTwo }), 200, "reload vendor draft after interruption");
    assert.equal(resumed.payload.registrationDraft.businessName, "P110 Resumable Pharmacy");
    assert.equal(resumed.payload.registrationDraft.ownerName, "P110 Resumable Owner");
    assert.ok(resumed.payload.registrationDraft.savedAt);
    await expectStatus(api("/api/vendor/setup", {
      token: context.tokens.customer,
      json: { action: "registration_draft", businessName: "Cross role", ownerName: "Customer" },
    }), 403, "customer cannot persist vendor draft");

    const secondDraft = await expectStatus(api("/api/vendor/setup", {
      token: context.tokens.vendorTwo,
      json: {
        action: "registration_draft",
        businessName: "P110 Resumable Pharmacy",
        ownerName: "P110 Resumable Owner",
        landline: "0401234567",
        gstNumber: "",
        address: "P110 private draft location",
        latitude: "17.431800",
        longitude: "78.407300",
        homeDelivery: true,
        deliveryRadiusKm: 9,
        licenceNumber: "P110-DRAFT-LICENCE",
      },
    }), 200, "save later vendor draft step");
    assert.equal(secondDraft.payload.registrationDraft.address, "P110 private draft location");
    assert.equal(secondDraft.payload.registrationDraft.latitude, "17.431800");
    assert.equal(secondDraft.payload.registrationDraft.longitude, "78.407300");
    assert.equal(secondDraft.payload.registrationDraft.licenceNumber, "P110-DRAFT-LICENCE");
    const isolated = await expectStatus(api("/api/vendor/setup", { token: context.tokens.vendorOperationalTwo }), 200, "other vendor setup remains isolated");
    assert.notEqual(isolated.payload.vendor.businessName, secondDraft.payload.vendor.businessName);
  });

  await scenario("normalized email and phone claims are race-safe without account enumeration", async () => {
    const createVendor = (token, suffix) => api("/api/auth/profile", {
      token,
      json: {
        role: "vendor",
        name: `P103 ${suffix} Owner`,
        businessName: `P103 ${suffix} Pharmacy`,
        email: `spoofed-${suffix}@example.test`,
        phone: "9999999999",
      },
    });
    const assertRace = async (tokens, field) => {
      const results = await Promise.all(tokens.map((token, index) => createVendor(token, `${field}-${index + 1}`)));
      assert.deepEqual(results.map((result) => result.status).sort((left, right) => left - right), [200, 409]);
      const winnerIndex = results.findIndex((result) => result.status === 200);
      const winner = results[winnerIndex];
      const conflict = results.find((result) => result.status === 409);
      assert.equal(conflict.payload.code, "identity_conflict");
      assert.deepEqual(conflict.payload.fields, [field]);
      assert.doesNotMatch(conflict.text, /integration:p103|P103 .* Owner|auth_user_id/i);
      assert.equal(winner.payload.profile.email, winner.payload.profile.email.toLowerCase());
      assert.equal(winner.payload.profile.vendorAccessStatus, "registration_draft");
      context.identityRaceWinners.push(winner.payload.profile.authUserId);

      await expectStatus(createVendor(tokens[winnerIndex], `${field}-winner-retry`), 200, `${field} winner idempotent retry`);
      const loserIndex = winnerIndex === 0 ? 1 : 0;
      const repeatedConflict = await expectStatus(createVendor(tokens[loserIndex], `${field}-loser-retry`), 409, `${field} loser conflict retry`);
      assert.equal(repeatedConflict.payload.code, "identity_conflict");
      assert.deepEqual(repeatedConflict.payload.fields, [field]);
    };

    await assertRace(["p103-email-race-a", "p103-email-race-b"], "email");
    await assertRace(["p103-phone-race-a", "p103-phone-race-b"], "phone");
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
    const statusBeforePharmacist = await expectStatus(api("/api/vendor/registration/status", { token: context.tokens.vendorTwo }), 200, "submitted vendor registration status");
    assert.equal(statusBeforePharmacist.payload.identity.emailVerified, true);
    assert.equal(statusBeforePharmacist.payload.identity.phoneVerified, true);
    assert.equal(statusBeforePharmacist.payload.registration.nextAction, "add_pharmacist");
    assert.equal(statusBeforePharmacist.payload.registration.registrationStatus, "submitted");
    assert.equal(statusBeforePharmacist.payload.registration.currentLicenceCount, 1);
    assert.equal(statusBeforePharmacist.payload.registration.verifiedLicenceCount, 0);
    assert.equal(statusBeforePharmacist.payload.registration.address, undefined);
    assert.equal(statusBeforePharmacist.payload.registration.latitude, undefined);
    assert.equal(statusBeforePharmacist.payload.registration.longitude, undefined);
    await expectStatus(api("/api/vendor/registration/status", { token: context.tokens.customer }), 403, "customer registration status access");
    const otherVendorStatus = await expectStatus(api("/api/vendor/registration/status", { token: context.tokens.vendorOperationalTwo }), 200, "other vendor own registration status");
    assert.equal(otherVendorStatus.payload.registration.businessName, "P009 Other Operational Pharmacy");
    assert.notEqual(otherVendorStatus.payload.registration.businessName, registration.businessName);

    const pharmacistForm = new FormData();
    pharmacistForm.set("purpose", "pharmacist_registration");
    pharmacistForm.set("file", new File([png], "p1-vendor-pharmacist.png", { type: "image/png" }));
    const pharmacistUpload = await expectStatus(api("/api/documents", { token: context.tokens.vendorTwo, body: pharmacistForm }), 201, "pending vendor pharmacist upload");
    await expectStatus(api("/api/vendor/setup", {
      token: context.tokens.vendorTwo,
      json: {
        action: "pharmacist",
        fullName: "P104 Integration Pharmacist",
        councilName: "Telangana State Pharmacy Council",
        registrationNumber: "P104-PHARMACIST",
        validFrom: isoDate(-30),
        validUntil: isoDate(730),
        documentId: pharmacistUpload.payload.document.id,
      },
    }), 200, "pending vendor pharmacist submission");
    const statusAfterPharmacist = await expectStatus(api("/api/vendor/registration/status", { token: context.tokens.vendorTwo }), 200, "review status after pharmacist submission");
    assert.equal(statusAfterPharmacist.payload.registration.nextAction, "awaiting_review");
    assert.equal(statusAfterPharmacist.payload.registration.pharmacistCount, 1);
    assert.equal(statusAfterPharmacist.payload.registration.verifiedPharmacistCount, 0);
    const downloaded = await expectStatus(api(`/api/documents/${context.vendorRegistrationDocumentId}`, { token: context.tokens.vendorTwo }), 200, "download submitted vendor licence");
    assert.deepEqual(Buffer.from(downloaded.bytes), png);
  });

  await scenario("received purchases are tenant-scoped and supplier returns reject invalid reuse", async () => {
    await expectStatus(api("/api/vendor/suppliers"), 401, "unauthenticated supplier directory");
    await expectStatus(api("/api/vendor/suppliers", { token: context.tokens.customer }), 403, "customer supplier directory");
    await expectStatus(api("/api/vendor/suppliers/900009", { token: context.tokens.vendorOperationalTwo }), 404, "cross-vendor supplier detail");
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
    const supplierDirectory = await expectStatus(api(`/api/vendor/suppliers?q=${encodeURIComponent("P009 Integration Supplier")}&status=active&sort=payable_high&page=1&pageSize=5`, {
      token: context.tokens.vendor,
    }), 200, "tenant supplier directory");
    assert.equal(supplierDirectory.payload.pagination.total, 1);
    assert.equal(supplierDirectory.payload.suppliers[0].id, 900009);
    assert.equal(supplierDirectory.payload.suppliers[0].purchaseCount, 1);
    assert.equal(supplierDirectory.payload.suppliers[0].grossPurchasePaise, 5_250);
    assert.equal(supplierDirectory.payload.suppliers[0].payablePaise, 5_250);
    const otherSupplierDirectory = await expectStatus(api(`/api/vendor/suppliers?q=${encodeURIComponent("P009 Integration Supplier")}`, {
      token: context.tokens.vendorOperationalTwo,
    }), 200, "other vendor isolated supplier directory");
    assert.equal(otherSupplierDirectory.payload.pagination.total, 0);
    assert.deepEqual(otherSupplierDirectory.payload.suppliers, []);
    const supplierDetail = await expectStatus(api("/api/vendor/suppliers/900009?page=1&pageSize=5", {
      token: context.tokens.vendor,
    }), 200, "tenant supplier detail");
    assert.equal(supplierDetail.payload.summary.grossPurchasePaise, 5_250);
    assert.equal(supplierDetail.payload.summary.payablePaise, 5_250);
    assert.equal(supplierDetail.payload.purchases[0].purchaseNumber, purchase.payload.purchaseNumber);
    assert.equal(supplierDetail.payload.purchases[0].unitCount, 5);
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
    const supplierAfterReturns = await expectStatus(api("/api/vendor/suppliers/900009", {
      token: context.tokens.vendor,
    }), 200, "supplier balance after completed returns");
    assert.equal(supplierAfterReturns.payload.summary.returnCount, 2);
    assert.equal(supplierAfterReturns.payload.summary.returnPaise, 5_000);
    assert.equal(supplierAfterReturns.payload.summary.payablePaise, 250);
    assert.equal(supplierAfterReturns.payload.ledger.some((entry) => entry.accountCode === "ACCOUNTS_PAYABLE"), true);
    assert.equal(supplierAfterReturns.payload.ledger.some((entry) => entry.accountCode === "SUPPLIER_PAYABLE"), true);
  });

  await scenario("pricing governance is tenant-scoped, effective-dated, conversion-governed, and MRP-enforced", async () => {
    await expectStatus(api("/api/vendor/pricing?inventoryId=900060", { token: context.tokens.customer }), 403, "customer pricing access denied");
    const initial = await expectStatus(api("/api/vendor/pricing?inventoryId=900060", { token: context.tokens.vendor }), 200, "initial price history");
    assert.ok(Array.isArray(initial.payload.prices));
    const price = await expectStatus(api("/api/vendor/pricing", { token: context.tokens.vendor, json: {
      action: "price", inventoryId: 900060, purchasePricePaise: 750, salePricePaise: 1100, mrpPaise: 1400,
      gstPercent: 5, effectiveFrom: isoDate(), reason: "P209 approved repricing",
    } }), 201, "effective price update");
    assert.equal(price.payload.appliedNow, true);
    await expectStatus(api("/api/vendor/pricing", { token: context.tokens.vendor, json: {
      action: "price", inventoryId: 900060, salePricePaise: 1500, mrpPaise: 1400, gstPercent: 5,
      effectiveFrom: isoDate(), reason: "P209 invalid MRP override",
    } }), 400, "sale price above MRP rejected");
    const conversion = await expectStatus(api("/api/vendor/pricing", { token: context.tokens.vendor, json: {
      action: "conversion", productId: 900060, presentationUom: "strip", baseUom: "tablet", baseUnitsPerPresentation: 10,
      effectiveFrom: isoDate(),
    } }), 201, "pack conversion proposal");
    assert.equal(conversion.payload.governanceStatus, "pending");
    const barcode = await expectStatus(api("/api/vendor/pricing", { token: context.tokens.vendor, json: {
      action: "barcode", productId: 900060, code: "4006381333931", symbology: "GTIN-13",
    } }), 201, "barcode proposal");
    const approvedConversion = await expectStatus(api("/api/admin/pricing", { method: "PATCH", token: context.tokens.admin, json: {
      action: "conversion_approve", id: conversion.payload.conversionId, reason: "P209 governed strip conversion",
    } }), 200, "admin conversion approval");
    assert.equal(approvedConversion.payload.governanceStatus, "approved");
    const approvedBarcode = await expectStatus(api("/api/admin/pricing", { method: "PATCH", token: context.tokens.admin, json: {
      action: "barcode_approve", id: barcode.payload.barcodeId, reason: "P209 verified GTIN",
    } }), 200, "admin barcode approval");
    assert.equal(approvedBarcode.payload.status, "approved");
    const final = await expectStatus(api("/api/vendor/pricing?inventoryId=900060", { token: context.tokens.vendor }), 200, "final pricing governance state");
    assert.equal(final.payload.prices[0].salePricePaise, 1100);
    assert.equal(final.payload.conversions[0].baseUnitsPerPresentation, 10);
    assert.equal(final.payload.barcodes[0].code, "4006381333931");
    await expectStatus(api("/api/vendor/pricing", { token: context.tokens.vendorOperationalTwo, json: {
      action: "price", inventoryId: 900060, salePricePaise: 1050, mrpPaise: 1300, gstPercent: 5,
      effectiveFrom: isoDate(), reason: "Cross tenant pricing attempt",
    } }), 404, "cross-vendor pricing denied");
  });

  await scenario("accounting statements are governed, balanced, tenant-scoped, and private", async () => {
    await expectStatus(api("/api/admin/accounting?start=2026-01-01&end=2026-12-31", { token: context.tokens.customer }), 403, "customer accounting denied");
    const admin = await expectStatus(api("/api/admin/accounting?start=2026-01-01&end=2026-12-31", { token: context.tokens.admin }), 200, "admin accounting statements");
    assert.ok(Array.isArray(admin.payload.accounts));
    assert.equal(typeof admin.payload.trialBalance.balanced, "boolean");
    assert.equal(admin.response.headers.get("cache-control"), "private, no-store");
    for (const [format, contentType] of [["csv", "text/csv"], ["xlsx", "spreadsheetml.sheet"], ["pdf", "application/pdf"]]) {
      const exported = await expectStatus(api(`/api/admin/accounting?start=2026-01-01&end=2026-12-31&format=${format}`, { token: context.tokens.admin }), 200, `admin accounting ${format} export`);
      assert.match(exported.response.headers.get("content-type") ?? "", new RegExp(contentType));
      assert.equal(exported.response.headers.get("cache-control"), "private, no-store");
    }
    const reconciliation = await expectStatus(api("/api/admin/accounting", { method: "POST", token: context.tokens.admin, json: {
      action: "reconcile", accountCode: "SALES", periodStart: "2026-01-01", periodEnd: "2026-12-31", statementPaise: 0, note: "Local integration statement check",
    } }), 200, "accounting reconciliation review");
    assert.equal(typeof reconciliation.payload.variancePaise, "number");
    const vendor = await expectStatus(api("/api/vendor/accounting?start=2026-01-01&end=2026-12-31", { token: context.tokens.vendor }), 200, "vendor accounting statements");
    assert.equal(vendor.payload.period.vendorId, context.vendorId);
    assert.equal(typeof vendor.payload.trialBalance.balanced, "boolean");
    await expectStatus(api("/api/vendor/accounting?start=2026-12-31&end=2026-01-01", { token: context.tokens.vendor }), 400, "reversed accounting period rejected");
  });

  await scenario("inventory adjustments and cycle counts are guarded, tenant-scoped, and idempotent", async () => {
    await expectStatus(api("/api/vendor/inventory-reconciliation"), 401, "unauthenticated inventory reconciliation");
    await expectStatus(api("/api/vendor/inventory-reconciliation", { token: context.tokens.customer }), 403, "customer inventory reconciliation");
    const before = await expectStatus(api("/api/vendor/inventory-reconciliation", { token: context.tokens.vendor }), 200, "vendor inventory reconciliation");
    const countedBatch = before.payload.inventory.find((row) => row.id === 900012);
    assert.ok(countedBatch, "vendor-owned OTC batch must be available to count");
    assert.equal(countedBatch.quantity, 50);
    assert.equal(before.payload.canAdjust, true);
    assert.ok(before.payload.reasons.some((reason) => reason.code === "found_stock"));

    const adjustmentRequest = {
      action: "adjust",
      idempotencyKey: "p208-integration-manual-900012",
      inventoryId: 900012,
      expectedQuantity: 50,
      quantityDelta: 2,
      reasonCode: "found_stock",
      notes: "Integration shelf recount found two units",
    };
    const adjusted = await expectStatus(api("/api/vendor/inventory-reconciliation", {
      token: context.tokens.vendor,
      json: adjustmentRequest,
    }), 201, "authorized manual inventory adjustment");
    context.inventoryAdjustmentNumber = adjusted.payload.adjustmentNumber;
    assert.equal(adjusted.payload.duplicate, false);
    assert.equal(adjusted.payload.balanceAfter, 52);
    const duplicateAdjustment = await expectStatus(api("/api/vendor/inventory-reconciliation", {
      token: context.tokens.vendor,
      json: adjustmentRequest,
    }), 200, "idempotent manual inventory adjustment");
    assert.equal(duplicateAdjustment.payload.duplicate, true);
    assert.equal(duplicateAdjustment.payload.adjustmentNumber, context.inventoryAdjustmentNumber);

    await expectStatus(api("/api/vendor/inventory-reconciliation", {
      token: context.tokens.vendorOperationalTwo,
      json: { ...adjustmentRequest, idempotencyKey: "p208-cross-tenant-900012", expectedQuantity: 52 },
    }), 404, "cross-vendor inventory adjustment");
    await expectStatus(api("/api/vendor/inventory-reconciliation", {
      token: context.tokens.customer,
      json: { ...adjustmentRequest, idempotencyKey: "p208-wrong-role-900012", expectedQuantity: 52 },
    }), 403, "wrong-role inventory adjustment");

    const countRequest = {
      action: "count",
      idempotencyKey: "p208-integration-count-900012",
      scopeLabel: "Integration OTC shelf",
      notes: "Witnessed packaged-worker count",
      lines: [{ inventoryId: 900012, expectedQuantity: 52, countedQuantity: 51 }],
    };
    const counted = await expectStatus(api("/api/vendor/inventory-reconciliation", {
      token: context.tokens.vendor,
      json: countRequest,
    }), 201, "authorized inventory cycle count");
    context.inventoryCountSessionNumber = counted.payload.sessionNumber;
    assert.equal(counted.payload.duplicate, false);
    assert.equal(counted.payload.varianceLineCount, 1);
    assert.equal(counted.payload.netVarianceQuantity, -1);
    const duplicateCount = await expectStatus(api("/api/vendor/inventory-reconciliation", {
      token: context.tokens.vendor,
      json: countRequest,
    }), 200, "idempotent inventory cycle count");
    assert.equal(duplicateCount.payload.duplicate, true);
    assert.equal(duplicateCount.payload.sessionNumber, context.inventoryCountSessionNumber);

    const held = await createOnlineOrder(2, 900012);
    const reservationFloor = await expectStatus(api("/api/vendor/inventory-reconciliation", {
      token: context.tokens.vendor,
      json: {
        action: "adjust", idempotencyKey: "p208-reservation-floor-900012",
        inventoryId: 900012, expectedQuantity: 51, quantityDelta: -50,
        reasonCode: "damage", notes: "Attempt below customer reservation",
      },
    }), 409, "reservation floor inventory adjustment");
    assert.match(reservationFloor.payload.error, /below 2 reserved units/i);
    await expectStatus(api(`/api/orders/${held.payload.order.id}/tracking`, {
      token: context.tokens.customer,
      json: { status: "cancelled", note: "Release P2-08 reservation test" },
    }), 200, "release inventory reconciliation reservation");
    const after = await expectStatus(api("/api/vendor/inventory-reconciliation", { token: context.tokens.vendor }), 200, "reconciled inventory after count");
    assert.equal(after.payload.inventory.find((row) => row.id === 900012).quantity, 51);
    assert.equal(after.payload.inventory.find((row) => row.id === 900012).reservedQuantity, 0);
  });

  await scenario("online reservations commit or release exactly once across terminal paths", async () => {
    const initial = inventoryRow((await inventoryMine()).payload, context.inventoryId);
    const multiLine = await expectStatus(api("/api/orders", {
      token: context.tokens.customer,
      json: {
        items: [
          { inventoryId: context.inventoryId, quantity: 1 },
          { inventoryId: 900012, quantity: 2 },
        ],
        paymentMethod: "online", deliveryMethod: "pickup", placeOfSupplyStateCode: "36",
        customerAddressId: context.customerAddressId,
      },
    }), 201, "multi-line pharmacy order");
    context.multiLineOrderId = multiLine.payload.order.id;
    const multiLineDetail = await expectStatus(api(`/api/customer/orders/${context.multiLineOrderId}`, {
      token: context.tokens.customer,
    }), 200, "merged multi-line pharmacy order detail");
    assert.equal(multiLineDetail.payload.order.items.length, 2);
    assert.equal(multiLineDetail.payload.order.items.reduce((sum, item) => sum + item.quantity, 0), 3);
    await expectStatus(api(`/api/orders/${context.multiLineOrderId}/tracking`, {
      token: context.tokens.customer,
      json: { status: "cancelled", note: "Release multi-line cart fixture" },
    }), 200, "release multi-line pharmacy order");
    await expectStatus(api("/api/orders", {
      token: context.tokens.customer,
      json: {
        items: [
          { inventoryId: context.inventoryId, quantity: 1 },
          { inventoryId: 900011, quantity: 1 },
        ],
        paymentMethod: "online", deliveryMethod: "pickup", placeOfSupplyStateCode: "36",
        customerAddressId: context.customerAddressId,
      },
    }), 400, "mixed pharmacy cart rejected");

    const successful = await createOnlineOrder(2);
    context.successfulOrderId = successful.payload.order.id;
    const reserved = inventoryRow((await inventoryMine()).payload, context.inventoryId);
    assert.equal(reserved.quantity, initial.quantity);
    assert.equal(reserved.reservedQuantity, initial.reservedQuantity + 2);
    const providerOrder = await expectStatus(api("/api/payments/razorpay/order", {
      token: context.tokens.customer, json: { orderId: context.successfulOrderId },
    }), 200, "create Razorpay payment order through local provider");
    const successfulProviderOrderId = providerOrder.payload.id;
    assert.equal(successfulProviderOrderId, `order_local_${context.successfulOrderId}`);
    assert.equal(providerOrder.payload.amount, successful.payload.order.totalPaise);
    const successfulPaymentId = `pay_p009_refundretry_${context.successfulOrderId}_${successful.payload.order.totalPaise}`;
    const verification = {
      razorpay_order_id: successfulProviderOrderId,
      razorpay_payment_id: successfulPaymentId,
      razorpay_signature: signed(razorpaySecret, `${successfulProviderOrderId}|${successfulPaymentId}`),
    };
    const captureWebhookBody = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: {
      id: successfulPaymentId, order_id: successfulProviderOrderId, amount: successful.payload.order.totalPaise,
      currency: "INR", status: "captured",
    } } } });
    const captureWebhookHeaders = { "content-type": "application/json", "x-razorpay-signature": signed(webhookSecret, captureWebhookBody) };
    const captureRace = await Promise.all([
      api("/api/payments/razorpay/verify", { token: context.tokens.customer, json: verification }),
      api("/api/webhooks/razorpay", { body: captureWebhookBody, headers: captureWebhookHeaders }),
    ]);
    assert.deepEqual(captureRace.map((result) => result.status), [200, 200], "checkout and signed webhook race is idempotent");
    assert.equal((await expectStatus(api("/api/payments/razorpay/verify", { token: context.tokens.customer, json: verification }), 200, "duplicate payment verification")).payload.duplicate, true);
    assert.equal((await expectStatus(api("/api/webhooks/razorpay", { body: captureWebhookBody, headers: captureWebhookHeaders }), 200, "duplicate captured webhook")).payload.duplicate, true);
    const committed = inventoryRow((await inventoryMine()).payload, context.inventoryId);
    assert.equal(committed.quantity, initial.quantity - 2);
    assert.equal(committed.reservedQuantity, initial.reservedQuantity);

    await expectStatus(api("/api/customer/orders"), 401, "unauthenticated customer history");
    await expectStatus(api("/api/customer/orders", { token: context.tokens.vendor }), 403, "vendor customer history");
    const customerHistory = await expectStatus(api(`/api/customer/orders?q=${encodeURIComponent(successful.payload.order.orderNumber)}&status=active&payment=paid&delivery=pickup&sort=newest&page=1&pageSize=5`, {
      token: context.tokens.customer,
    }), 200, "customer history search and filters");
    assert.equal(customerHistory.payload.pagination.total, 1);
    assert.equal(customerHistory.payload.orders[0].id, context.successfulOrderId);
    assert.equal(customerHistory.payload.orders[0].canCancel, false);
    assert.equal(customerHistory.payload.orders[0].invoiceAvailable, false);
    const otherCustomerHistory = await expectStatus(api(`/api/customer/orders?q=${encodeURIComponent(successful.payload.order.orderNumber)}`, {
      token: context.tokens.customerTwo,
    }), 200, "other customer isolated history");
    assert.equal(otherCustomerHistory.payload.pagination.total, 0);
    const customerDetail = await expectStatus(api(`/api/customer/orders/${context.successfulOrderId}`, {
      token: context.tokens.customer,
    }), 200, "customer order detail and timeline");
    assert.equal(customerDetail.payload.order.id, context.successfulOrderId);
    assert.equal(customerDetail.payload.order.items.length, 1);
    assert.equal(customerDetail.payload.order.items[0].reorderInventoryId, context.inventoryId);
    assert.equal(customerDetail.payload.order.trackingEvents.some((event) => event.status === "payment_confirmed"), true);
    assert.deepEqual(customerDetail.payload.order.invoice, { id: null, available: false, number: null, downloadImplemented: true });
    await expectStatus(api(`/api/customer/orders/${context.successfulOrderId}`, { token: context.tokens.customerTwo }), 404, "cross-customer history detail");

    await expectStatus(api("/api/vendor/orders"), 401, "unauthenticated vendor order queue");
    await expectStatus(api("/api/vendor/orders", { token: context.tokens.customer }), 403, "customer vendor order queue");
    const vendorQueue = await expectStatus(api(`/api/vendor/orders?q=${encodeURIComponent(successful.payload.order.orderNumber)}&status=action_required&payment=paid&delivery=pickup&page=1&pageSize=5`, {
      token: context.tokens.vendor,
    }), 200, "tenant vendor order queue");
    assert.equal(vendorQueue.payload.pagination.total, 1);
    assert.equal(vendorQueue.payload.orders[0].id, context.successfulOrderId);
    assert.equal(vendorQueue.payload.orders[0].nextStatuses.includes("confirmed"), true);
    const otherVendorQueue = await expectStatus(api(`/api/vendor/orders?q=${encodeURIComponent(successful.payload.order.orderNumber)}`, {
      token: context.tokens.vendorOperationalTwo,
    }), 200, "other vendor isolated order queue");
    assert.equal(otherVendorQueue.payload.pagination.total, 0);
    assert.deepEqual(otherVendorQueue.payload.orders, []);
    const vendorOrderDetail = await expectStatus(api(`/api/vendor/orders/${context.successfulOrderId}`, {
      token: context.tokens.vendor,
    }), 200, "tenant vendor order detail");
    assert.equal(vendorOrderDetail.payload.order.id, context.successfulOrderId);
    assert.equal(vendorOrderDetail.payload.order.items.length, 1);
    assert.equal(vendorOrderDetail.payload.order.customerName, "URMED Test Customer");
    assert.equal(vendorOrderDetail.payload.order.trackingEvents.length > 0, true);
    await expectStatus(api(`/api/vendor/orders/${context.successfulOrderId}`, {
      token: context.tokens.vendorOperationalTwo,
    }), 404, "cross-vendor order detail");
    await expectStatus(api(`/api/vendor/orders/${context.successfulOrderId}`, {
      token: context.tokens.customer,
    }), 403, "customer vendor order detail");

    await scenario("pickup and pharmacy self-delivery fulfilment reach finality and finalized online returns are isolated", async () => {
      const pickupOrder = await createOnlineOrder(1, 900050, undefined, "pickup");
      const pickupOrderId = pickupOrder.payload.order.id;
      await captureOnlineOrder(pickupOrder, "P308 pickup");
      await expectStatus(api(`/api/orders/${pickupOrderId}/tracking`, { token: context.tokens.vendor, json: { status: "confirmed", note: "P308 pickup accepted" } }), 200, "P308 pickup confirmed");
      await expectStatus(api(`/api/orders/${pickupOrderId}/tracking`, { token: context.tokens.vendor, json: { status: "packed", note: "P308 pickup packed" } }), 200, "P308 pickup packed");
      await expectStatus(api(`/api/orders/${pickupOrderId}/tracking`, { token: context.tokens.vendor, json: { status: "ready_for_pickup", note: "P308 pickup ready" } }), 200, "P308 pickup ready");
      await expectStatus(api(`/api/orders/${pickupOrderId}/tracking`, { token: context.tokens.vendor, json: { status: "delivered", note: "P308 customer collected" } }), 200, "P308 pickup completed");
      const pickupEvidence = await orderEvidence(pickupOrderId);
      assert.equal(pickupEvidence.order.orderStatus, "completed");
      assert.equal(pickupEvidence.order.deliveryStatus, "delivered");
      assert.equal(pickupEvidence.order.inventoryStatus, "committed");
      const pickupDetail = await expectStatus(api(`/api/customer/orders/${pickupOrderId}`, { token: context.tokens.customer }), 200, "P308 pickup invoice metadata");
      assert.ok(pickupDetail.payload.order.invoice.id);

      const onlineReturn = {
        action: "return", sourceType: "online", sourceId: pickupOrderId, inventoryId: 900050,
        quantity: 1, condition: "sealed", reason: "P308 pickup customer return", idempotencyKey: `p308-online-return-${pickupOrderId}`,
        refundMethod: "credit",
      };
      const returned = await expectStatus(api("/api/vendor/operations", { token: context.tokens.vendor, json: onlineReturn }), 201, "P308 online sealed return");
      assert.equal(returned.payload.disposition, "restocked");
      assert.match(returned.payload.creditNoteNumber, /^CN-/);
      const duplicateReturn = await expectStatus(api("/api/vendor/operations", { token: context.tokens.vendor, json: onlineReturn }), 200, "P308 online return replay");
      assert.equal(duplicateReturn.payload.duplicate, true);
      await expectStatus(api("/api/vendor/operations", { token: context.tokens.vendor, json: { ...onlineReturn, idempotencyKey: `p308-online-return-excess-${pickupOrderId}`, quantity: 2 } }), 409, "P308 online excess return");
      await expectStatus(api("/api/vendor/operations", { token: context.tokens.vendorOperationalTwo, json: onlineReturn }), 404, "P308 online cross-vendor return");
      await expectStatus(api(`/api/orders/${pickupOrderId}/tracking`, { token: context.tokens.vendor, json: { status: "cancelled", note: "Cannot cancel finalized returned order" } }), 409, "P308 returned order cannot be cancelled");
      const returnedEvidence = await orderEvidence(pickupOrderId);
      assert.equal(returnedEvidence.order.orderStatus, "completed");
      assert.equal(returnedEvidence.inventory.find((row) => row.id === 900050).quantity, 20);

      const selfDeliveryOrder = await createOnlineOrder(1, 900050, undefined, "pharmacy");
      const selfDeliveryOrderId = selfDeliveryOrder.payload.order.id;
      await captureOnlineOrder(selfDeliveryOrder, "P308 pharmacy self-delivery");
      await expectStatus(api(`/api/orders/${selfDeliveryOrderId}/tracking`, { token: context.tokens.vendor, json: { status: "confirmed", note: "P308 self-delivery accepted" } }), 200, "P308 self-delivery confirmed");
      await expectStatus(api(`/api/orders/${selfDeliveryOrderId}/tracking`, { token: context.tokens.vendor, json: { status: "packed", note: "P308 self-delivery packed" } }), 200, "P308 self-delivery packed");
      await expectStatus(api(`/api/orders/${selfDeliveryOrderId}/tracking`, { token: context.tokens.vendor, json: { status: "out_for_delivery", note: "P308 pharmacy rider dispatched" } }), 200, "P308 self-delivery dispatched");
      await expectStatus(api(`/api/orders/${selfDeliveryOrderId}/tracking`, { token: context.tokens.vendor, json: { status: "delivered", note: "P308 pharmacy delivery completed" } }), 200, "P308 self-delivery completed");
      const selfDeliveryEvidence = await orderEvidence(selfDeliveryOrderId);
      assert.equal(selfDeliveryEvidence.order.orderStatus, "completed");
      assert.equal(selfDeliveryEvidence.order.deliveryStatus, "delivered");
      const selfDeliveryDetail = await expectStatus(api(`/api/customer/orders/${selfDeliveryOrderId}`, { token: context.tokens.customer }), 200, "P308 self-delivery invoice metadata");
      assert.ok(selfDeliveryDetail.payload.order.invoice.id);
      assert.equal(selfDeliveryEvidence.inventory.find((row) => row.id === 900050).quantity, 19);
    });

    const failed = await createOnlineOrder(3);
    context.failedOrderId = failed.payload.order.id;
    const failedProviderOrderId = (await expectStatus(api("/api/payments/razorpay/order", {
      token: context.tokens.customer, json: { orderId: context.failedOrderId },
    }), 200, "create payment order before failed webhook")).payload.id;
    const webhookBody = JSON.stringify({ event: "payment.failed", payload: { payment: { entity: {
      id: "pay_p009_failed", order_id: failedProviderOrderId, amount: failed.payload.order.totalPaise,
      currency: "INR", status: "failed", error_description: "Local bank declined the payment",
    } } } });
    const webhookHeaders = { "content-type": "application/json", "x-razorpay-signature": signed(webhookSecret, webhookBody) };
    await expectStatus(api("/api/webhooks/razorpay", { body: webhookBody, headers: webhookHeaders }), 200, "failed payment webhook");
    assert.equal((await expectStatus(api("/api/webhooks/razorpay", { body: webhookBody, headers: webhookHeaders }), 200, "duplicate failed webhook")).payload.duplicate, true);
    assert.equal(inventoryRow((await inventoryMine()).payload, context.inventoryId).reservedQuantity, 0);

    const cancelled = await createOnlineOrder(4);
    context.cancelledOrderId = cancelled.payload.order.id;
    await expectStatus(api(`/api/orders/${context.cancelledOrderId}/tracking`, {
      token: context.tokens.customer,
      json: { status: "cancelled", note: "Customer requested cancellation" },
    }), 200, "customer order cancellation");
    assert.equal((await expectStatus(api(`/api/orders/${context.cancelledOrderId}/tracking`, {
      token: context.tokens.customer,
      json: { status: "cancelled", note: "Customer requested cancellation" },
    }), 200, "repeated customer cancellation")).payload.unchanged, true);
    assert.equal(inventoryRow((await inventoryMine()).payload, context.inventoryId).reservedQuantity, 0);
    const cancelledDetail = await expectStatus(api(`/api/customer/orders/${context.cancelledOrderId}`, { token: context.tokens.customer }), 200, "cancelled customer order detail");
    assert.equal(cancelledDetail.payload.order.orderStatus, "cancelled");
    assert.equal(cancelledDetail.payload.order.canCancel, false);
    await expectStatus(api(`/api/orders/${context.successfulOrderId}/tracking`, {
      token: context.tokens.customer,
      json: { status: "cancelled", note: "Paid order should not cancel" },
    }), 409, "customer cannot cancel paid order");
    await expectStatus(api(`/api/orders/${context.successfulOrderId}/tracking`, { token: context.tokens.vendorOperationalTwo }), 404, "cross-vendor order access");
    await expectStatus(api(`/api/orders/${context.successfulOrderId}/tracking`, { token: context.tokens.customerTwo }), 404, "cross-customer order access");

    await expectStatus(api("/api/payments/razorpay/refund", {
      token: context.tokens.customerTwo,
      json: { orderId: context.successfulOrderId, reason: "Wrong customer refund attempt" },
    }), 404, "cross-customer refund isolation");
    await expectStatus(api("/api/payments/razorpay/refund", {
      token: context.tokens.vendorOperationalTwo,
      json: { orderId: context.successfulOrderId, reason: "Wrong pharmacy refund attempt" },
    }), 404, "cross-vendor refund isolation");
    await expectStatus(api("/api/payments/razorpay/refund", {
      token: context.tokens.customer,
      json: { orderId: context.successfulOrderId, reason: "Customer cancelled before pharmacy acceptance" },
    }), 502, "deterministic Razorpay refund failure");
    const failedRefundDetail = await expectStatus(api(`/api/customer/orders/${context.successfulOrderId}`, {
      token: context.tokens.customer,
    }), 200, "failed refund remains visible");
    assert.equal(failedRefundDetail.payload.order.orderStatus, "cancelled");
    assert.equal(failedRefundDetail.payload.order.refund.status, "failed");
    assert.equal(failedRefundDetail.payload.order.canRefund, false);
    assert.equal(inventoryRow((await inventoryMine()).payload, context.inventoryId).quantity, initial.quantity);

    const refundId = `rfnd_p009_${context.successfulOrderId}`;
    const refundEntity = {
      id: refundId, payment_id: successfulPaymentId, amount: successful.payload.order.totalPaise,
      currency: "INR", status: "pending", notes: { urmed_order_id: String(context.successfulOrderId) },
    };
    const originalPaymentEntity = {
      id: successfulPaymentId, order_id: successfulProviderOrderId, amount: successful.payload.order.totalPaise,
      currency: "INR", status: "captured",
    };
    const outOfOrderCreatedBody = JSON.stringify({ event: "refund.created", payload: {
      payment: { entity: originalPaymentEntity }, refund: { entity: refundEntity },
    } });
    const outOfOrderCreatedHeaders = { "content-type": "application/json", "x-razorpay-signature": signed(webhookSecret, outOfOrderCreatedBody) };
    await expectStatus(api("/api/webhooks/razorpay", { body: outOfOrderCreatedBody, headers: outOfOrderCreatedHeaders }), 200, "refund.created after local failure");
    assert.equal((await expectStatus(api(`/api/customer/orders/${context.successfulOrderId}`, {
      token: context.tokens.customer,
    }), 200, "created-after-failed persisted state")).payload.order.refund.status, "failed");

    const refundRetry = await expectStatus(api("/api/payments/razorpay/refund", {
      token: context.tokens.customer,
      json: { orderId: context.successfulOrderId, reason: "Customer cancelled before pharmacy acceptance" },
    }), 202, "retry failed refund with identical idempotency body");
    assert.equal(refundRetry.payload.refund.status, "pending");
    assert.equal(refundRetry.payload.refund.providerRefundId, refundId);

    const processedBody = JSON.stringify({ event: "refund.processed", payload: {
      payment: { entity: originalPaymentEntity }, refund: { entity: { ...refundEntity, status: "processed" } },
    } });
    const processedHeaders = { "content-type": "application/json", "x-razorpay-signature": signed(webhookSecret, processedBody) };
    await expectStatus(api("/api/webhooks/razorpay", { body: processedBody, headers: processedHeaders }), 200, "signed refund processed webhook");
    assert.equal((await expectStatus(api("/api/webhooks/razorpay", { body: processedBody, headers: processedHeaders }), 200, "replayed refund processed webhook")).payload.duplicate, true);
    const lateFailedBody = JSON.stringify({ event: "refund.failed", payload: {
      payment: { entity: originalPaymentEntity }, refund: { entity: { ...refundEntity, status: "failed" } },
    } });
    await expectStatus(api("/api/webhooks/razorpay", {
      body: lateFailedBody,
      headers: { "content-type": "application/json", "x-razorpay-signature": signed(webhookSecret, lateFailedBody) },
    }), 200, "late failed webhook cannot reverse processed refund");
    const processedRefundDetail = await expectStatus(api(`/api/customer/orders/${context.successfulOrderId}`, {
      token: context.tokens.customer,
    }), 200, "processed refund detail");
    assert.equal(processedRefundDetail.payload.order.paymentStatus, "refunded");
    assert.equal(processedRefundDetail.payload.order.refund.status, "processed");
    assert.equal(processedRefundDetail.payload.order.paymentReceiptAvailable, true);
    const duplicateRefunds = await Promise.all([
      api("/api/payments/razorpay/refund", { token: context.tokens.customer, json: { orderId: context.successfulOrderId, reason: "Customer cancelled before pharmacy acceptance" } }),
      api("/api/payments/razorpay/refund", { token: context.tokens.customer, json: { orderId: context.successfulOrderId, reason: "Customer cancelled before pharmacy acceptance" } }),
    ]);
    assert.deepEqual(duplicateRefunds.map((result) => result.status), [200, 200], "concurrent processed refund requests remain idempotent");
    const receipt = await expectStatus(api(`/api/customer/orders/${context.successfulOrderId}/receipt`, {
      token: context.tokens.customer,
    }), 200, "customer payment receipt");
    assert.match(receipt.text, /Payment evidence only/);
    assert.match(receipt.text, new RegExp(successfulPaymentId));
    await expectStatus(api(`/api/customer/orders/${context.successfulOrderId}/receipt`, {
      token: context.tokens.customerTwo,
    }), 404, "cross-customer payment receipt isolation");

    const multipleRx = await expectStatus(api("/api/orders", {
      token: context.tokens.customer,
      json: {
        items: [
          { inventoryId: 900009, quantity: 1 },
          { inventoryId: 900010, quantity: 2 },
        ],
        prescriptionId: 900009,
        paymentMethod: "online", deliveryMethod: "pickup", placeOfSupplyStateCode: "36",
        customerAddressId: context.customerAddressId,
      },
    }), 201, "multiple Rx lines use one owned pharmacy prescription");
    context.multiRxOrderId = multipleRx.payload.order.id;
    const multipleRxDetail = await expectStatus(api(`/api/customer/orders/${context.multiRxOrderId}`, {
      token: context.tokens.customer,
    }), 200, "multiple Rx line detail");
    assert.equal(multipleRxDetail.payload.order.items.length, 2);
    assert.equal(multipleRxDetail.payload.order.prescriptionId, 900009);
    await expectStatus(api("/api/orders", {
      token: context.tokens.customer,
      json: {
        items: [{ inventoryId: 900009, quantity: 1 }], prescriptionId: 900009,
        paymentMethod: "online", deliveryMethod: "pickup", placeOfSupplyStateCode: "36",
        customerAddressId: context.customerAddressId,
      },
    }), 409, "used prescription cannot be reused");

    const prescriptionRacePayload = {
      items: [{ inventoryId: 900010, quantity: 1 }], prescriptionId: 900010,
      paymentMethod: "online", deliveryMethod: "pickup", placeOfSupplyStateCode: "36",
      customerAddressId: context.customerAddressId,
    };
    const prescriptionRace = await Promise.all([
      api("/api/orders", { token: context.tokens.customer, json: prescriptionRacePayload }),
      api("/api/orders", { token: context.tokens.customer, json: prescriptionRacePayload }),
    ]);
    assert.deepEqual(prescriptionRace.map((result) => result.status).sort(), [201, 409], "concurrent prescription reuse is rejected atomically");
    const raceWinner = prescriptionRace.find((result) => result.status === 201);
    await expectStatus(api(`/api/orders/${raceWinner.payload.order.id}/tracking`, {
      token: context.tokens.customer,
      json: { status: "cancelled", note: "Release prescription race fixture" },
    }), 200, "release prescription race winner");

    context.rejectedOrderId = context.multiRxOrderId;
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

  await scenario("transactional email outbox is atomic, scheduled, idempotent, and admin-visible", async () => {
    const queued = await expectStatus(api("/api/admin/email-outbox?status=queued", { token: context.tokens.admin }), 200, "admin queued email outbox");
    assert.match(queued.response.headers.get("cache-control") ?? "", /private.*no-store/i);
    assert.ok(queued.payload.items.some((item) => item.eventType === "order_placed"));
    assert.equal(queued.payload.items.some((item) => /@/.test(item.recipient) && !/\*\*\*/.test(item.recipient)), false);
    await expectStatus(api("/api/admin/email-outbox", { token: context.tokens.customer }), 403, "customer email outbox access");
    const firstRun = await triggerScheduled("7,17,27,37,47,57 * * * *");
    assert.equal(firstRun.status, 200, firstRun.text);
    const repeatedRun = await triggerScheduled("7,17,27,37,47,57 * * * *");
    assert.equal(repeatedRun.status, 200, repeatedRun.text);
    const evidence = await inspectEmailOutbox();
    assert.equal(evidence.deleteGuard, true);
    assert.ok(evidence.rows.some((row) => ["retry_wait", "sent", "dead_letter"].includes(row.status)));
    const after = await expectStatus(api("/api/admin/email-outbox", { token: context.tokens.admin }), 200, "admin email outbox after scheduled processing");
    assert.equal(after.payload.items.length, queued.payload.items.length);
  });

  await scenario("expired reservations cannot pay and scheduled recovery is idempotent without traffic", async () => {
    const expired = await createOnlineOrder(6);
    context.expiredOrderId = expired.payload.order.id;
    await expireOrder(context.expiredOrderId);
    await expectStatus(api("/api/payments/razorpay/order", {
      token: context.tokens.customer, json: { orderId: context.expiredOrderId },
    }), 409, "expired reservation cannot create payment order");
    await expectStatus(api("/api/payments/razorpay/order", {
      token: context.tokens.customer, json: { orderId: context.expiredOrderId },
    }), 409, "repeated expired payment-order attempt");
    assert.equal(inventoryRow((await inventoryMine()).payload, context.inventoryId).reservedQuantity, 0);

    const abandoned = await createOnlineOrder(6);
    context.abandonedOrderId = abandoned.payload.order.id;
    await expireOrder(context.abandonedOrderId);
    await expectStatus(api("/api/catalog?q=dolo"), 200, "side-effect-free public catalogue read");
    await expectStatus(api("/api/inventory"), 200, "side-effect-free public inventory read");
    const beforeScheduledRecovery = await orderEvidence(context.abandonedOrderId);
    assert.equal(beforeScheduledRecovery.order.inventoryStatus, "reserved");
    assert.ok(beforeScheduledRecovery.inventory.some((row) => row.reservedQuantity > 0));
    const scheduled = await triggerScheduled();
    if (scheduled.status !== 200) throw new Error(`scheduled reservation recovery: ${scheduled.text}`);
    const repeatedScheduled = await triggerScheduled();
    if (repeatedScheduled.status !== 200) throw new Error(`repeated scheduled recovery: ${repeatedScheduled.text}`);
    assert.equal(inventoryRow((await inventoryMine()).payload, context.inventoryId).reservedQuantity, 0);
  });

  await scenario("offline POS is FEFO, idempotent, tenant-scoped, prescription-gated, and atomically evidenced", async () => {
    await expectStatus(api("/api/vendor/pos/catalog"), 401, "unauthenticated counter catalog");
    await expectStatus(api("/api/vendor/pos/catalog", { token: context.tokens.customer }), 403, "customer counter catalog");
    await expectStatus(api("/api/vendor/statutory-register", { token: context.tokens.vendorCounterStaff }), 403, "counter statutory register privacy");
    await expectStatus(api("/api/vendor/statutory-register", { token: context.tokens.vendorInventoryStaff }), 403, "inventory manager statutory register privacy");

    const catalog = await expectStatus(api("/api/vendor/pos/catalog?q=P304&pageSize=20", { token: context.tokens.vendor }), 200, "tenant counter catalog");
    const otc = catalog.payload.products.find((product) => product.productName === "P304 Counter OTC Fixture");
    const secondOtc = catalog.payload.products.find((product) => product.productName === "P304 Counter Second OTC");
    const rx = catalog.payload.products.find((product) => product.productName === "P304 Counter Rx Fixture");
    assert.ok(otc && secondOtc && rx, "counter fixtures must be discoverable");
    assert.equal(otc.availableQuantity, 38, "reserved stock is excluded from POS availability");

    const liveCustomer = await expectStatus(api("/api/vendor/pos/customers?q=customer%40urmed.test", { token: context.tokens.vendor }), 200, "exact live POS customer");
    assert.equal(liveCustomer.payload.customer.email, "customer@urmed.test");
    const recovered = await expectStatus(api("/api/vendor/pos/customers?q=recovered-only%40urmed.test", { token: context.tokens.vendor }), 200, "recovered archive is not live POS identity");
    assert.equal(recovered.payload.customer, null);

    const otcRequest = {
      idempotencyKey: "p304:offline:multi:001",
      customerProfileId: liveCustomer.payload.customer.id,
      customerName: "Browser supplied name is ignored",
      customerPhone: "9999999999",
      buyerGstin: "",
      placeOfSupplyStateCode: "36",
      paymentMode: "cash",
      discountType: "fixed",
      discountValue: 1,
      items: [{ productId: otc.productId, quantity: 19 }, { productId: secondOtc.productId, quantity: 2 }],
    };
    await expectStatus(api("/api/vendor/pos/sales", { token: context.tokens.vendorInventoryStaff, json: otcRequest }), 403, "inventory staff cannot post counter sale");
    await expectStatus(api("/api/vendor/pos/sales", { token: context.tokens.vendorOperationalTwo, json: otcRequest }), 409, "other tenant cannot sell pharmacy stock");
    await expectStatus(api("/api/vendor/pos/sales", { token: context.tokens.vendorExpiredPos, json: otcRequest }), 409, "expired-licence vendor counter sale");
    const completed = await expectStatus(api("/api/vendor/pos/sales", { token: context.tokens.vendor, json: otcRequest }), 201, "atomic multi-line counter sale");
    context.offlineSaleId = completed.payload.receipt.id;
    assert.equal(completed.payload.replayed, false);
    assert.equal(completed.payload.receipt.customerName, "URMED Test Customer");
    assert.deepEqual(completed.payload.receipt.lines.map((line) => [line.batchNumber, line.quantity]), [
      ["P304-OTC-EARLY", 18], ["P304-OTC-LATE", 1], ["P304-OTC-SECOND", 2],
    ]);
    const counterPdf = await expectStatus(api(`/api/vendor/invoices/${completed.payload.receipt.invoiceId}?format=pdf`, { token: context.tokens.vendor }), 200, "counter GST invoice PDF");
    assert.equal(counterPdf.text.slice(0, 8), "%PDF-1.7");
    await expectStatus(api(`/api/customer/invoices/${completed.payload.receipt.invoiceId}`, { token: context.tokens.customer }), 200, "linked live customer counter invoice");
    await expectStatus(api(`/api/customer/invoices/${completed.payload.receipt.invoiceId}`, { token: context.tokens.customerTwo }), 404, "counter invoice customer isolation");
    const replayed = await expectStatus(api("/api/vendor/pos/sales", { token: context.tokens.vendor, json: otcRequest }), 200, "idempotent counter replay");
    assert.equal(replayed.payload.replayed, true);
    assert.equal(replayed.payload.receipt.id, context.offlineSaleId);
    await expectStatus(api("/api/vendor/pos/sales", {
      token: context.tokens.vendor,
      json: { ...otcRequest, items: [{ productId: otc.productId, quantity: 1 }] },
    }), 409, "counter idempotency fingerprint conflict");
    await expectStatus(api(`/api/vendor/pos/sales/${context.offlineSaleId}`, { token: context.tokens.vendorOperationalTwo }), 404, "cross-tenant counter receipt");

    const offlineReturn = {
      action: "return", sourceType: "offline", sourceId: context.offlineSaleId, inventoryId: 900033,
      quantity: 1, condition: "sealed", reason: "P306 sealed customer return", idempotencyKey: "p306-offline-return-001",
      refundMethod: "credit",
    };
    const offlineReturnResult = await expectStatus(api("/api/vendor/operations", { token: context.tokens.vendor, json: offlineReturn }), 201, "completed offline sale return and credit note");
    assert.match(offlineReturnResult.payload.creditNoteNumber, /^CN-/);
    assert.equal(offlineReturnResult.payload.disposition, "restocked");
    const offlineReturnReplay = await expectStatus(api("/api/vendor/operations", { token: context.tokens.vendor, json: offlineReturn }), 200, "idempotent offline return replay");
    assert.equal(offlineReturnReplay.payload.duplicate, true);
    await expectStatus(api("/api/vendor/operations", { token: context.tokens.vendor, json: { ...offlineReturn, idempotencyKey: "p306-offline-return-002", quantity: 2 } }), 409, "excess offline return rejected");
    await expectStatus(api("/api/vendor/operations", { token: context.tokens.vendorOperationalTwo, json: offlineReturn }), 404, "cross-tenant return denied");

    const failedAuditUpload = new FormData();
    failedAuditUpload.set("purpose", "offline_prescription");
    failedAuditUpload.set("file", new File([png], "p304-audit-failure.png", { type: "image/png" }));
    const failedAuditDocument = await expectStatus(api("/api/documents", { token: context.tokens.vendor, body: failedAuditUpload }), 201, "offline prescription upload for rollback");
    const captureBody = {
      customerProfileId: liveCustomer.payload.customer.id,
      patientName: "URMED Test Customer",
      patientAddress: "P304 Patient Address",
      prescriberName: "P304 Test Doctor",
      prescriberAddress: "P304 Test Clinic",
      prescribedOn: isoDate(),
      serialNumber: "P304-RX-001",
      items: [{ productId: rx.productId, medicineText: rx.productName, quantityRequested: 2 }],
    };
    await expectStatus(api("/api/vendor/pos/prescriptions", {
      token: context.tokens.vendor,
      headers: { "cf-ray": "p304-fail-audit" },
      json: { ...captureBody, documentId: failedAuditDocument.payload.document.id, patientName: "P304 Audit Rollback" },
    }), 500, "capture audit failure rolls back domain mutation");

    const rxUpload = new FormData();
    rxUpload.set("purpose", "offline_prescription");
    rxUpload.set("file", new File([png], "p304-counter-prescription.png", { type: "image/png" }));
    const uploaded = await expectStatus(api("/api/documents", { token: context.tokens.vendor, body: rxUpload }), 201, "counter prescription R2 upload");
    context.offlinePrescriptionDocumentId = uploaded.payload.document.id;
    const captured = await expectStatus(api("/api/vendor/pos/prescriptions", {
      token: context.tokens.vendor,
      json: { ...captureBody, documentId: context.offlinePrescriptionDocumentId },
    }), 201, "counter prescription capture");
    context.offlinePrescriptionId = captured.payload.prescription.id;
    const ownerDownload = await expectStatus(api(`/api/documents/${context.offlinePrescriptionDocumentId}`, { token: context.tokens.vendor }), 200, "capturing owner downloads counter prescription");
    assert.deepEqual(Buffer.from(ownerDownload.bytes), png);
    await expectStatus(api(`/api/documents/${context.offlinePrescriptionDocumentId}`, { token: context.tokens.vendorCounterStaff }), 403, "counter cannot browse another actor prescription");
    await expectStatus(api(`/api/documents/${context.offlinePrescriptionDocumentId}`, { token: context.tokens.vendorOperationalTwo }), 404, "other pharmacy counter prescription bytes");
    const counterQueue = await expectStatus(api("/api/vendor/pos/prescriptions", { token: context.tokens.vendorCounterStaff }), 200, "counter-owned prescription queue");
    assert.equal(counterQueue.payload.prescriptions.some((capture) => capture.id === context.offlinePrescriptionId), false);
    await expectStatus(api(`/api/vendor/pos/prescriptions/${context.offlinePrescriptionId}/review`, {
      token: context.tokens.vendorCounterStaff, json: { decision: "approved", notes: "", items: [{ productId: rx.productId, quantityApproved: 2 }] },
    }), 403, "counter cannot review prescription");
    await expectStatus(api(`/api/vendor/pos/prescriptions/${context.offlinePrescriptionId}/review`, {
      token: context.tokens.vendor,
      headers: { "cf-ray": "p304-fail-audit" },
      json: { decision: "approved", notes: "", items: [{ productId: rx.productId, quantityApproved: 2 }] },
    }), 500, "review audit failure rolls back approval");
    const afterFailedReview = await expectStatus(api("/api/vendor/pos/prescriptions", { token: context.tokens.vendor }), 200, "review rollback state");
    assert.equal(afterFailedReview.payload.prescriptions.find((capture) => capture.id === context.offlinePrescriptionId).status, "uploaded");
    await expectStatus(api(`/api/vendor/pos/prescriptions/${context.offlinePrescriptionId}/review`, {
      token: context.tokens.vendor,
      json: { decision: "approved", notes: "", items: [{ productId: rx.productId, quantityApproved: 2 }] },
    }), 200, "verified pharmacist approval");

    const rxSale = {
      idempotencyKey: "p304:offline:rx:001",
      customerProfileId: liveCustomer.payload.customer.id,
      customerName: liveCustomer.payload.customer.name,
      customerPhone: liveCustomer.payload.customer.phone,
      buyerGstin: "",
      placeOfSupplyStateCode: "29",
      paymentMode: "card",
      discountType: "percent",
      discountValue: 5,
      prescriptionCaptureId: context.offlinePrescriptionId,
      items: [{ productId: rx.productId, quantity: 3 }],
    };
    await expectStatus(api("/api/vendor/pos/sales", { token: context.tokens.vendor, json: rxSale }), 409, "prescription quantity coverage");
    const rxCompleted = await expectStatus(api("/api/vendor/pos/sales", {
      token: context.tokens.vendor, json: { ...rxSale, items: [{ productId: rx.productId, quantity: 2 }] },
    }), 201, "approved prescription counter sale");
    context.offlineRxSaleId = rxCompleted.payload.receipt.id;
    assert.equal(rxCompleted.payload.receipt.igstPaise > 0, true);
    assert.equal(rxCompleted.payload.receipt.cgstPaise, 0);
    await expectStatus(api("/api/vendor/pos/sales", {
      token: context.tokens.vendor,
      json: { ...rxSale, idempotencyKey: "p304:offline:rx:reuse", items: [{ productId: rx.productId, quantity: 1 }] },
    }), 409, "one-time counter prescription use");
  });

  await scenario("admin operational reports enforce authorization, bounded filters, store scope, stable totals, CSV, and delivery privacy", async () => {
    const reports = ["stock", "sales", "expenses", "home-delivery"];
    const deniedRoles = [
      [context.tokens.customer, "customer"],
      [context.tokens.vendor, "vendor"],
      [context.tokens.delivery, "delivery"],
    ];
    for (const report of reports) {
      await expectStatus(api(`/api/admin/reports/${report}?page=1&pageSize=5`), 401, `unauthenticated ${report} report`);
      for (const [token, role] of deniedRoles) {
        await expectStatus(api(`/api/admin/reports/${report}?page=1&pageSize=5`, { token }), 403, `${role} ${report} report`);
      }
      const allowed = await expectStatus(api(`/api/admin/reports/${report}?page=1&pageSize=5`, {
        token: context.tokens.admin,
      }), 200, `administrator ${report} report`);
      assertPrivateReport(allowed, report === "home-delivery" ? "home_delivery" : report);
      assert.equal(allowed.payload.pagination.page, 1);
      assert.equal(allowed.payload.pagination.pageSize, 5);
      assert.ok(allowed.payload.rows.length <= 5);
    }

    await expectStatus(api("/api/admin/reports/stock?sort=DROP%20TABLE", { token: context.tokens.admin }), 400, "stock sort allowlist");
    await expectStatus(api("/api/admin/reports/stock?pageSize=101", { token: context.tokens.admin }), 400, "stock bounded page size");
    await expectStatus(api("/api/admin/reports/sales?channel=retail", { token: context.tokens.admin }), 400, "sales channel allowlist");
    await expectStatus(api("/api/admin/reports/expenses?payment=crypto", { token: context.tokens.admin }), 400, "expense payment allowlist");
    await expectStatus(api("/api/admin/reports/home-delivery?status=private", { token: context.tokens.admin }), 400, "delivery status allowlist");
    await expectStatus(api("/api/admin/reports/home-delivery?minDistanceKm=10&maxDistanceKm=1", {
      token: context.tokens.admin,
    }), 400, "delivery distance bounds");

    const [primaryProfile, otherProfile] = await Promise.all([
      expectStatus(api("/api/auth/profile", { token: context.tokens.vendor }), 200, "primary vendor report scope"),
      expectStatus(api("/api/auth/profile", { token: context.tokens.vendorOperationalTwo }), 200, "other vendor report scope"),
    ]);
    const primaryVendorId = primaryProfile.payload.profile.vendorId;
    const otherVendorId = otherProfile.payload.profile.vendorId;
    assert.ok(primaryVendorId && otherVendorId && primaryVendorId !== otherVendorId);
    assert.equal(primaryVendorId, context.vendorId);
    const dateFrom = isoDate(-1);
    const dateTo = isoDate(1);

    const stockQuery = `vendorId=${primaryVendorId}&groupBy=medicine&stockState=zero&q=${encodeURIComponent("P503 Primary Vendor Alert Fixture")}&page=1&pageSize=5&sort=medicine&direction=asc`;
    const stock = await expectStatus(api(`/api/admin/reports/stock?${stockQuery}`, {
      token: context.tokens.admin,
    }), 200, "primary store zero-stock report");
    assertPrivateReport(stock, "stock");
    assert.deepEqual(stock.payload.pagination, { page: 1, pageSize: 5, total: 1, totalPages: 1 });
    assert.equal(stock.payload.rows.length, 1);
    assert.equal(stock.payload.rows[0].medicineName, "P503 Primary Vendor Alert Fixture");
    assert.deepEqual({
      physicalQuantity: stock.payload.rows[0].physicalQuantity,
      reservedQuantity: stock.payload.rows[0].reservedQuantity,
      availableQuantity: stock.payload.rows[0].availableQuantity,
      storeCount: stock.payload.rows[0].storeCount,
    }, { physicalQuantity: 0, reservedQuantity: 0, availableQuantity: 0, storeCount: 1 });
    const repeatedStock = await expectStatus(api(`/api/admin/reports/stock?${stockQuery}`, {
      token: context.tokens.admin,
    }), 200, "stable primary stock totals");
    assert.deepEqual(repeatedStock.payload.summary, stock.payload.summary);
    const crossStoreStock = await expectStatus(api(`/api/admin/reports/stock?vendorId=${otherVendorId}&groupBy=medicine&stockState=zero&q=${encodeURIComponent("P503 Primary Vendor Alert Fixture")}&page=1&pageSize=5`, {
      token: context.tokens.admin,
    }), 200, "stock report other-store scope");
    assert.equal(crossStoreStock.payload.pagination.total, 0);

    const salesQuery = `dateFrom=${dateFrom}&dateTo=${dateTo}&vendorId=${primaryVendorId}&groupBy=medicine&channel=offline&q=${encodeURIComponent("P304 Counter OTC Fixture")}&page=1&pageSize=5&sort=medicine&direction=asc`;
    const sales = await expectStatus(api(`/api/admin/reports/sales?${salesQuery}`, {
      token: context.tokens.admin,
    }), 200, "primary store offline medicine sales report");
    assertPrivateReport(sales, "sales");
    assert.equal(sales.payload.recognition, "completed_sales_and_completed_returns");
    assert.deepEqual(sales.payload.pagination, { page: 1, pageSize: 5, total: 1, totalPages: 1 });
    assert.equal(sales.payload.rows[0].medicineName, "P304 Counter OTC Fixture");
    assert.equal(sales.payload.summary.transactions, 1);
    assert.equal(sales.payload.summary.soldQuantity, 19);
    assert.equal(sales.payload.summary.returnTransactions, 0);
    assert.equal(sales.payload.summary.returnedQuantity, 0);
    assert.equal(sales.payload.summary.netSalesPaise, sales.payload.summary.grossSalesPaise);
    const repeatedSales = await expectStatus(api(`/api/admin/reports/sales?${salesQuery}`, {
      token: context.tokens.admin,
    }), 200, "stable primary sales totals");
    assert.deepEqual(repeatedSales.payload.summary, sales.payload.summary);
    const crossStoreSales = await expectStatus(api(`/api/admin/reports/sales?dateFrom=${dateFrom}&dateTo=${dateTo}&vendorId=${otherVendorId}&groupBy=medicine&channel=offline&q=${encodeURIComponent("P304 Counter OTC Fixture")}&page=1&pageSize=5`, {
      token: context.tokens.admin,
    }), 200, "sales report other-store scope");
    assert.equal(crossStoreSales.payload.pagination.total, 0);

    const expenseQuery = `dateFrom=${dateFrom}&dateTo=${dateTo}&vendorId=${primaryVendorId}&scope=store&groupBy=entry&q=P611&page=1&pageSize=5&sort=date&direction=asc`;
    const expenses = await expectStatus(api(`/api/admin/reports/expenses?${expenseQuery}`, {
      token: context.tokens.admin,
    }), 200, "primary store expense report");
    assertPrivateReport(expenses, "expenses");
    assert.deepEqual(expenses.payload.pagination, { page: 1, pageSize: 5, total: 1, totalPages: 1 });
    assert.equal(expenses.payload.rows[0].businessName, "URMED Test Pharmacy");
    assert.equal(expenses.payload.summary.entryCount, 1);
    assert.equal(expenses.payload.summary.amountPaise, 12345);
    const repeatedExpenses = await expectStatus(api(`/api/admin/reports/expenses?${expenseQuery}`, {
      token: context.tokens.admin,
    }), 200, "stable primary expense totals");
    assert.deepEqual(repeatedExpenses.payload.summary, expenses.payload.summary);
    const otherExpenses = await expectStatus(api(`/api/admin/reports/expenses?dateFrom=${dateFrom}&dateTo=${dateTo}&vendorId=${otherVendorId}&scope=store&groupBy=entry&q=P611&page=1&pageSize=5`, {
      token: context.tokens.admin,
    }), 200, "other-store expense scope");
    assert.equal(otherExpenses.payload.summary.entryCount, 1);
    assert.equal(otherExpenses.payload.summary.amountPaise, 23456);
    assert.equal(otherExpenses.payload.rows[0].businessName, "P009 Other Operational Pharmacy");
    const platformExpenses = await expectStatus(api(`/api/admin/reports/expenses?dateFrom=${dateFrom}&dateTo=${dateTo}&scope=platform&groupBy=entry&q=P611&page=1&pageSize=5`, {
      token: context.tokens.admin,
    }), 200, "platform expense scope");
    assert.equal(platformExpenses.payload.summary.entryCount, 1);
    assert.equal(platformExpenses.payload.summary.amountPaise, 34567);
    assert.equal(platformExpenses.payload.rows[0].businessName, "Platform / unallocated");

    const deliveryQuery = `dateFrom=${dateFrom}&dateTo=${dateTo}&vendorId=${primaryVendorId}&method=urmed&status=delivered&cod=paid&page=1&pageSize=5&sort=date&direction=asc&slaTargetMinutes=120`;
    const delivery = await expectStatus(api(`/api/admin/reports/home-delivery?${deliveryQuery}`, {
      token: context.tokens.admin,
    }), 200, "delivered URMED report");
    assertPrivateReport(delivery, "home_delivery");
    assert.deepEqual(delivery.payload.pagination, { page: 1, pageSize: 5, total: 1, totalPages: 1 });
    assert.equal(delivery.payload.rows[0].orderId, context.invoiceOrderId);
    assert.equal(delivery.payload.rows[0].paymentMethod, "cod");
    assert.equal(delivery.payload.rows[0].paymentStatus, "paid");
    for (const privateKey of [
      "customerName", "customerPhone", "deliveryAddress", "latitude", "longitude",
      "originLatitude", "originLongitude", "destinationLatitude", "destinationLongitude",
    ]) assert.equal(Object.hasOwn(delivery.payload.rows[0], privateKey), false, `delivery report must omit ${privateKey}`);
    for (const privateValue of [
      "URMED Test Customer", "0000000001", "P4 edited customer office address",
      "17.4318", "78.4073", "17.4321", "78.4076",
    ]) assert.equal(delivery.text.includes(privateValue), false, `delivery report must not expose ${privateValue}`);
    const repeatedDelivery = await expectStatus(api(`/api/admin/reports/home-delivery?${deliveryQuery}`, {
      token: context.tokens.admin,
    }), 200, "stable delivery totals");
    assert.deepEqual(repeatedDelivery.payload.summary, delivery.payload.summary);
    const crossStoreDelivery = await expectStatus(api(`/api/admin/reports/home-delivery?dateFrom=${dateFrom}&dateTo=${dateTo}&vendorId=${otherVendorId}&method=urmed&status=delivered&page=1&pageSize=5`, {
      token: context.tokens.admin,
    }), 200, "delivery report other-store scope");
    assert.equal(crossStoreDelivery.payload.pagination.total, 0);

    const stockCsv = await expectStatus(api(`/api/admin/reports/stock?${stockQuery}&format=csv`, {
      token: context.tokens.admin,
    }), 200, "stock CSV report");
    assertReportCsv(stockCsv, "urmed-stock-report.csv", "Medicine,Manufacturer,Medicines,Stores,Batches,Physical quantity,Reserved quantity,Available quantity,Quarantined quantity,Expired quantity,Low batches,Stock cost paise,Retail value paise,Nearest expiry");
    const salesCsv = await expectStatus(api(`/api/admin/reports/sales?${salesQuery}&format=csv`, {
      token: context.tokens.admin,
    }), 200, "sales CSV report");
    assertReportCsv(salesCsv, "urmed-sales-report.csv", "Date,Channel,Medicine,Manufacturer,Sale transactions,Return transactions,Sold quantity,Returned quantity,Gross sales paise,Returns paise,Net sales paise");
    const expensesCsv = await expectStatus(api(`/api/admin/reports/expenses?${expenseQuery}&format=csv`, {
      token: context.tokens.admin,
    }), 200, "expense CSV report");
    assertReportCsv(expensesCsv, "urmed-expense-report.csv", "Label,Date,Expense head,Store,Purpose,Payment mode,Entries,Amount paise");
    const deliveryCsv = await expectStatus(api(`/api/admin/reports/home-delivery?${deliveryQuery}&format=csv`, {
      token: context.tokens.admin,
    }), 200, "home-delivery CSV report");
    assertReportCsv(deliveryCsv, "urmed-home-delivery-report.csv", "Order,Store,Method,Status,Rider,Assignment status,Payment method,Payment status,Delivery fee paise,Order total paise,Created at,Assigned at,Picked up at,Delivered at,Estimated straight-line distance km,Elapsed minutes,SLA status");
    for (const privateValue of ["URMED Test Customer", "0000000001", "17.4318", "78.4073", "17.4321", "78.4076"]) {
      assert.equal(deliveryCsv.text.includes(privateValue), false, `delivery CSV must not expose ${privateValue}`);
    }
    for (const report of ["stock", "sales", "expenses", "home-delivery"]) {
      const query = report === "stock" ? stockQuery : report === "sales" ? salesQuery : report === "expenses" ? expenseQuery : deliveryQuery;
      for (const format of ["xlsx", "pdf"]) {
        const exported = await expectStatus(api(`/api/admin/reports/${report}?${query}&format=${format}`, { token: context.tokens.admin }), 200, `${report} ${format} report`);
        assert.match(String(exported.response.headers.get("content-type") ?? ""), format === "xlsx" ? /spreadsheetml/ : /application\/pdf/);
        assert.equal(exported.response.headers.get("cache-control"), "private, no-store");
        assert.ok(exported.bytes?.length > 100, `${report} ${format} export must contain bytes`);
      }
    }
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
    await expectStatus(api(`/api/documents/${context.documentId}`, { token: context.tokens.vendor }), 404, "pharmacy cannot read an unlinked customer upload");
    await expectStatus(api(`/api/documents/${context.documentId}`, { token: context.tokens.vendorOperationalTwo }), 404, "other vendor document access");
    for (const [vendorId, label] of [
      [900020, "expired licence"],
      [900021, "noncompliant"],
      [900022, "testing"],
      [900023, "draft"],
    ]) {
      await expectStatus(api("/api/prescriptions", {
        token: context.tokens.customer,
        json: {
          documentId: context.documentId,
          vendorId,
          patientName: "P009 Security Patient",
          patientAddress: "P009 Security Address",
          prescriberName: "P009 Security Doctor",
          prescribedOn: new Date().toISOString().slice(0, 10),
        },
      }), 409, `${label} vendor prescription submission`);
    }
    await expectStatus(api("/api/prescriptions", {
      token: context.tokens.customer,
      json: {
        documentId: context.documentId,
        vendorId: context.vendorId,
        patientName: "P009 Document Access Patient",
        patientAddress: "P009 Document Access Address",
        prescriberName: "P009 Document Access Doctor",
        prescriberAddress: "P009 Document Access Clinic",
        prescribedOn: new Date().toISOString().slice(0, 10),
        serialNumber: "P009-DOCUMENT-ACCESS",
      },
    }), 201, "link uploaded prescription to selected pharmacy");
    const pharmacistDownload = await expectStatus(api(`/api/documents/${context.documentId}`, {
      token: context.tokens.vendor,
    }), 200, "pharmacy owner with prescription review access downloads linked prescription");
    assert.deepEqual(Buffer.from(pharmacistDownload.bytes), png);
    await expectStatus(api(`/api/documents/${context.documentId}`, {
      token: context.tokens.vendorCounterStaff,
    }), 403, "counter staff cannot download linked prescription bytes");
    await expectStatus(api(`/api/documents/${context.documentId}`, {
      token: context.tokens.vendorOperationalTwo,
    }), 404, "other pharmacy cannot download linked prescription bytes");
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
    assert.equal(evidence.identityRaceProfileCount, 2);
    assert.equal(evidence.identityRaceVendorCount, 2);
    assert.deepEqual(evidence.identityRaceAuthUsers.sort(), context.identityRaceWinners.sort());
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
    assert.equal(evidence.vendorDraftAuditCount, 2);
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
    assert.deepEqual({ ...evidence.inventoryAdjustment }, {
      id: evidence.inventoryAdjustment.id,
      quantityBefore: 50,
      quantityDelta: 2,
      balanceAfter: 52,
      reasonCode: "found_stock",
      sourceType: "manual",
    });
    assert.deepEqual({ ...evidence.inventoryCount }, {
      id: evidence.inventoryCount.id,
      lineCount: 1,
      varianceLineCount: 1,
      netVarianceQuantity: -1,
      countedQuantity: 51,
      varianceQuantity: -1,
    });
    assert.deepEqual(evidence.inventoryReconciliationMovements.map((row) => ({ ...row })), [
      { movementType: "inventory_adjustment", quantityDelta: 2, balanceAfter: 52 },
      { movementType: "cycle_count_adjustment", quantityDelta: -1, balanceAfter: 51 },
    ]);
    assert.deepEqual(evidence.inventoryReconciliationAuditActions, ["inventory.adjustment.completed", "inventory.count.completed"]);
    assert.deepEqual({ ...evidence.inventoryEvidenceImmutability }, {
      adjustmentUpdateGuard: 1,
      adjustmentDeleteGuard: 1,
      countSessionUpdateGuard: 1,
      countSessionDeleteGuard: 1,
      countLineUpdateGuard: 1,
      countLineDeleteGuard: 1,
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
    assert.deepEqual({ ...evidence.paymentRefund }, {
      id: evidence.paymentRefund.id,
      status: "processed",
      providerPaymentId: `pay_p009_refundretry_${context.successfulOrderId}_${evidence.paymentRefund.amountPaise}`,
      providerRefundId: `rfnd_p009_${context.successfulOrderId}`,
      amountPaise: evidence.paymentRefund.amountPaise,
      salesReturnId: evidence.paymentRefund.salesReturnId,
    });
    assert.deepEqual({ ...evidence.refundGuards }, { mismatchedInsert: true, invalidTransition: true, deleteForbidden: true });
    assert.equal(evidence.refundSalesReturn.status, "completed");
    assert.match(evidence.refundSalesReturn.creditNoteNumber, /^CN-/);
    assert.equal(evidence.refundSalesReturn.refundPaise, evidence.paymentRefund.amountPaise);
    assert.deepEqual({ ...evidence.refundItemSummary }, { lineCount: 1, quantity: 2, amountPaise: evidence.paymentRefund.amountPaise });
    assert.deepEqual(evidence.refundLedgerAccounts.map((row) => ({ ...row })), [
      { accountCode: "CUSTOMER_REFUNDS", debitPaise: 0, creditPaise: evidence.paymentRefund.amountPaise },
      { accountCode: "SALES_RETURNS", debitPaise: evidence.paymentRefund.amountPaise, creditPaise: 0 },
    ]);
    assert.deepEqual(evidence.refundStockMovements.map((row) => ({ ...row })), [
      { movementType: "payment_refund_restore", quantityDelta: 2 },
    ]);
    assert.deepEqual(evidence.refundDeliveryEvents, ["refund_requested", "refund_failed", "refund_retry", "refund_processed"]);
    assert.equal(evidence.refundAuditActions.filter((action) => action === "payment.refund_requested").length, 1);
    assert.equal(evidence.refundAuditActions.filter((action) => action === "payment.refund_failed").length, 1);
    assert.equal(evidence.refundAuditActions.filter((action) => action === "payment.refund_retried").length, 1);
    assert.equal(evidence.refundAuditActions.filter((action) => action === "payment.refund_processed").length, 1);
    assert.equal(evidence.refundNotificationCount, 1);
    assert.equal(evidence.refundTriggerCount, 3);
    assert.deepEqual({ ...evidence.vendorNotificationLifecycle }, {
      lifecycleStatus: "resolved",
      version: 4,
      readAt: evidence.vendorNotificationLifecycle.readAt,
      acknowledgedAt: evidence.vendorNotificationLifecycle.acknowledgedAt,
      snoozedUntil: null,
      resolvedAt: evidence.vendorNotificationLifecycle.resolvedAt,
      resolutionReason: "P503 replacement stock ordered",
    });
    assert.ok(evidence.vendorNotificationLifecycle.readAt);
    assert.ok(evidence.vendorNotificationLifecycle.acknowledgedAt);
    assert.ok(evidence.vendorNotificationLifecycle.resolvedAt);
    assert.deepEqual({ ...evidence.vendorNotificationReplacement }, {
      totalCount: 2,
      resolvedCount: 1,
      activeCount: 1,
      activeId: context.vendorNotificationReplacementId,
    });
    assert.deepEqual(evidence.vendorNotificationAuditActions, [
      "notification.read",
      "notification.acknowledge",
      "notification.snooze",
      "notification.resolve",
    ]);
    assert.equal(evidence.manufacturerMigrationAudit.sourceRows, evidence.manufacturerMigrationAudit.importedRows);
    assert.equal(evidence.manufacturerMigrationAudit.rejectedRows, 0);
    assert.deepEqual({ ...evidence.manufacturerState }, { status: "merged", mergedIntoManufacturerId: context.manufacturerTargetId });
    assert.equal(evidence.manufacturerProduct.manufacturerId, context.manufacturerTargetId);
    assert.ok(evidence.manufacturerAliases.some((alias) => alias.aliasName === "P205 Integration Manufacturer"));
    assert.ok(evidence.manufacturerAliases.some((alias) => alias.aliasName === "P205 Renamed Manufacturer"));
    assert.deepEqual(evidence.manufacturerRequests.map((request) => request.status), ["approved", "approved", "approved"]);
    assert.equal(evidence.manufacturerEventCount, 3);
    assert.ok(evidence.manufacturerAuditCount >= 6);
    assert.deepEqual({ ...evidence.manufacturerGuards }, { directInsert: true, cyclicState: true, aliasDelete: true, eventUpdate: true });
    assert.deepEqual({ ...evidence.onlineInvoice }, {
      id: context.invoiceId,
      invoiceNumber: evidence.onlineInvoice.invoiceNumber,
      sourceNumber: evidence.onlineInvoice.sourceNumber,
      sourceType: "online_order",
      snapshotVersion: 1,
      grossPaise: evidence.onlineInvoice.grossPaise,
      discountPaise: evidence.onlineInvoice.discountPaise,
      subtotalPaise: evidence.onlineInvoice.subtotalPaise,
      cgstPaise: evidence.onlineInvoice.cgstPaise,
      sgstPaise: evidence.onlineInvoice.sgstPaise,
      igstPaise: evidence.onlineInvoice.igstPaise,
      deliveryFeePaise: evidence.onlineInvoice.deliveryFeePaise,
      totalPaise: evidence.onlineInvoice.totalPaise,
      lineCount: 1,
      lineTaxablePaise: evidence.onlineInvoice.subtotalPaise,
      lineTotalPaise: evidence.onlineInvoice.totalPaise - evidence.onlineInvoice.deliveryFeePaise,
    });
    assert.match(evidence.onlineInvoice.invoiceNumber, /^GST-/);
    assert.deepEqual({ ...evidence.invoiceGuards }, { updateHeader: true, deleteHeader: true, updateLine: true, deleteLine: true, forgedLine: true });
    assert.equal(evidence.offlineSale.id, context.offlineSaleId);
    assert.match(evidence.offlineSale.saleNumber, /^POS-/);
    assert.match(evidence.offlineSale.invoiceNumber, /^GST-POS-/);
    assert.equal(evidence.offlineSale.invoiceLineCount, 3);
    assert.equal(evidence.offlineSale.invoiceLineTotalPaise, evidence.offlineSale.totalPaise);
    assert.equal(evidence.offlineSale.grossPaise - evidence.offlineSale.discountPaise, evidence.offlineSale.subtotalPaise);
    assert.equal(evidence.offlineSale.subtotalPaise + evidence.offlineSale.taxPaise, evidence.offlineSale.totalPaise);
    assert.deepEqual(evidence.offlineSaleItems.map((row) => ({ batchNumber: row.batchNumber, quantity: row.quantity })), [
      { batchNumber: "P304-OTC-EARLY", quantity: 18 },
      { batchNumber: "P304-OTC-LATE", quantity: 1 },
      { batchNumber: "P304-OTC-SECOND", quantity: 2 },
    ]);
    assert.deepEqual(evidence.offlineSaleStock.map((row) => ({ ...row })), [
      { id: 900030, quantity: 2, reservedQuantity: 2 },
      { id: 900031, quantity: 19, reservedQuantity: 0 },
      { id: 900033, quantity: 9, reservedQuantity: 0 },
    ]);
    assert.deepEqual(evidence.offlineSaleMovements.map((row) => ({ ...row })), [
      { inventoryId: 900030, quantityDelta: -18, balanceAfter: 2 },
      { inventoryId: 900031, quantityDelta: -1, balanceAfter: 19 },
      { inventoryId: 900033, quantityDelta: -2, balanceAfter: 8 },
    ]);
    assert.equal(evidence.offlineSaleLedger.reduce((sum, row) => sum + row.debitPaise, 0), evidence.offlineSale.totalPaise);
    assert.equal(evidence.offlineSaleLedger.reduce((sum, row) => sum + row.creditPaise, 0), evidence.offlineSale.totalPaise);
    assert.equal(evidence.offlineSaleEventCount, 1);
    assert.equal(evidence.offlineRxSale.offlinePrescriptionId, context.offlinePrescriptionId);
    assert.equal(evidence.offlineRxSale.igstPaise > 0, true);
    assert.equal(evidence.offlineRxSale.cgstPaise, 0);
    assert.equal(evidence.offlineRxSale.sgstPaise, 0);
    assert.deepEqual({ ...evidence.offlineRxInventory }, { quantity: 8, reservedQuantity: 0 });
    assert.deepEqual({ ...evidence.offlineRxEvidence }, {
      statutoryCount: 1,
      eventCount: 1,
      prescriptionAuditCount: 2,
      failedCaptureCount: 0,
      expiredVendorSaleCount: 0,
    });
    assert.deepEqual({ ...evidence.offlinePrescriptionDocument }, {
      vendorId: context.vendorId,
      purpose: "offline_prescription",
      sizeBytes: png.byteLength,
      status: "active",
    });
    assert.equal(evidence.inventory.quantity, 99, "the delivery-proof COD fixture commits one physical unit");
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
