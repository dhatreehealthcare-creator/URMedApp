import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  canCustomerCancelOrder,
  customerOrderSortExpression,
  customerOrderStatusPredicate,
  escapeCustomerOrderSearch,
  parseCustomerOrderHistoryQuery,
} from "../lib/customer-order-history.ts";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("customer history query parsing is bounded and deterministic", () => {
  assert.deepEqual(parseCustomerOrderHistoryQuery(new URLSearchParams({
    q: "  Dolo   650  ", status: "completed", payment: "paid", delivery: "pickup",
    sort: "oldest", page: "9", pageSize: "500",
  })), {
    query: "Dolo 650", status: "completed", payment: "paid", delivery: "pickup",
    sort: "oldest", page: 9, pageSize: 30,
  });
  assert.equal(parseCustomerOrderHistoryQuery(new URLSearchParams({ status: "bad", page: "bad" })).status, "all");
  assert.equal(parseCustomerOrderHistoryQuery(new URLSearchParams({ status: "bad", page: "bad" })).page, 1);
  assert.equal(escapeCustomerOrderSearch("50%_\\"), "50\\%\\_\\\\");
  assert.match(customerOrderStatusPredicate("prescription_review"), /prescription_status/);
  assert.match(customerOrderSortExpression("oldest"), /ASC/);
});

test("customer cancellation is limited to unpaid pre-acceptance orders", () => {
  assert.equal(canCustomerCancelOrder({ orderStatus: "awaiting_payment", deliveryStatus: "awaiting_confirmation", paymentStatus: "pending" }), true);
  assert.equal(canCustomerCancelOrder({ orderStatus: "awaiting_prescription_review", deliveryStatus: "pharmacist_review", paymentStatus: "pending" }), true);
  assert.equal(canCustomerCancelOrder({ orderStatus: "placed", deliveryStatus: "awaiting_confirmation", paymentStatus: "paid" }), false);
  assert.equal(canCustomerCancelOrder({ orderStatus: "accepted", deliveryStatus: "confirmed", paymentStatus: "cod_due" }), false);
  assert.equal(canCustomerCancelOrder({ orderStatus: "completed", deliveryStatus: "delivered", paymentStatus: "paid" }), false);
});

test("customer list and detail APIs enforce verified customer ownership on every query", () => {
  const list = read("../app/api/customer/orders/route.ts");
  const detail = read("../app/api/customer/orders/[id]/route.ts");
  for (const source of [list, detail]) assert.match(source, /requireLocalProfile\(request, \["customer"\]\)/);
  assert.match(list, /o\.customer_profile_id=\?/);
  assert.match(list, /LIMIT \? OFFSET \?/);
  assert.match(detail, /o\.id=\? AND o\.customer_profile_id=\?/);
  assert.match(detail, /scoped_order\.customer_profile_id=\?/);
  assert.match(detail, /invoice: \{ id: order\.invoiceId, available: Boolean\(order\.invoiceId\), number: order\.invoiceNumber, downloadImplemented: true \}/);
  assert.doesNotMatch(detail, /v\.latitude|v\.longitude|vendor_public_locations|publicLatitude|publicLongitude/);
});

test("customer cancellation reuses controlled reservation and committed-stock release behavior", () => {
  const tracking = read("../app/api/orders/[id]/tracking/route.ts");
  assert.match(tracking, /requireLocalProfile\(request, \["customer", "vendor", "admin", "delivery"\]\)/);
  assert.match(tracking, /order\.customerProfileId !== profile\.id/);
  assert.match(tracking, /canCustomerCancelOrder\(order\) \? \["cancelled"\] : \[\]/);
  assert.match(tracking, /prepareOrderReservationReleaseStatements/);
  assert.match(tracking, /order_cancel_restore/);
  assert.match(tracking, /results\[eventIndex\]/);
});

test("history UI supports search, filters, detail, timeline, safe cancellation, and checkout handoff", () => {
  const history = read("../app/customer-order-history.tsx");
  const portal = read("../app/requirements-portal.tsx");
  const checkout = read("../app/live-marketplace.tsx");
  assert.match(history, /Search orders or medicines/);
  assert.match(history, /Page \{history\.pagination\.page\}/);
  assert.match(history, /Delivery timeline/);
  assert.match(history, /Cancel this unpaid order/);
  assert.match(history, /Reorder does not purchase automatically/);
  assert.match(history, /Immutable GST snapshot ready/);
  assert.match(history, /\/api\/customer\/invoices\/\$\{detail\.invoice\.id\}/);
  assert.match(history, /downloadInvoice\(endpoint\)/);
  assert.match(history, /printInvoice\(endpoint\)/);
  assert.match(portal, /<CustomerOrderHistory onReorder=/);
  assert.match(portal, /setCustomerSection\("orders"\)/);
  assert.match(checkout, /useState\(reorderRequest\?\.inventoryId \?\? 0\)/);
  assert.match(checkout, /const \[prescriptionByVendor, setPrescriptionByVendor\] = useState<Record<number, number>>\(\{\}\)/);
  const reorderContract = read("../lib/customer-order-history.ts").match(/export type CustomerReorderRequest = \{[\s\S]*?\n\};/)?.[0] ?? "";
  assert.doesNotMatch(reorderContract, /prescriptionId/);
  assert.match(checkout, /Review current price, stock, delivery, address/);
  assert.doesNotMatch(history, /authenticatedFetch\("\/api\/orders", \{ method: "POST"/);
});

test("packaged Worker covers customer history auth, tenant isolation, cancellation, and invoice status", () => {
  const integration = read("./integration/phase0-api.integration.test.mjs");
  assert.match(integration, /unauthenticated customer history/);
  assert.match(integration, /other customer isolated history/);
  assert.match(integration, /cross-customer history detail/);
  assert.match(integration, /customer order cancellation/);
  assert.match(integration, /customer cannot cancel paid order/);
  assert.match(integration, /downloadImplemented, true/);
  assert.match(integration, /customer GST invoice PDF/);
  assert.match(integration, /cross-customer GST invoice isolation/);
});
