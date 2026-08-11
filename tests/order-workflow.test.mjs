import assert from "node:assert/strict";
import test from "node:test";
import { nextDeliveryStatuses, orderStatusForDeliveryStatus } from "../lib/order-workflow.ts";

const base = {
  role: "vendor", deliveryMethod: "urmed", deliveryStatus: "awaiting_confirmation", orderStatus: "placed",
  prescriptionStatus: "not_required", paymentMethod: "cod", paymentStatus: "cod_due",
};

test("vendor follows received, accepted, packed and handover workflow", () => {
  assert.deepEqual(nextDeliveryStatuses(base), ["confirmed", "cancelled"]);
  assert.deepEqual(nextDeliveryStatuses({ ...base, deliveryStatus: "confirmed" }), ["packed", "cancelled"]);
  assert.deepEqual(nextDeliveryStatuses({ ...base, deliveryStatus: "packed" }), ["ready_for_pickup", "cancelled"]);
});

test("URMED delivery actions are restricted to delivery staff after handover", () => {
  assert.deepEqual(nextDeliveryStatuses({ ...base, deliveryStatus: "ready_for_pickup" }), ["cancelled"]);
  assert.deepEqual(nextDeliveryStatuses({ ...base, role: "delivery", deliveryStatus: "ready_for_pickup" }), ["assigned"]);
  assert.deepEqual(nextDeliveryStatuses({ ...base, role: "delivery", deliveryStatus: "assigned" }), ["picked_up"]);
  assert.deepEqual(nextDeliveryStatuses({ ...base, role: "delivery", deliveryStatus: "picked_up" }), ["out_for_delivery"]);
});

test("online payment and prescription gates block fulfilment", () => {
  assert.deepEqual(nextDeliveryStatuses({ ...base, paymentMethod: "online", paymentStatus: "pending" }), ["cancelled"]);
  assert.deepEqual(nextDeliveryStatuses({ ...base, prescriptionStatus: "pending_review" }), ["cancelled"]);
});

test("workflow prevents skipped and terminal transitions", () => {
  assert.ok(!nextDeliveryStatuses(base).includes("packed"));
  assert.deepEqual(nextDeliveryStatuses({ ...base, orderStatus: "completed", deliveryStatus: "delivered" }), []);
  assert.deepEqual(nextDeliveryStatuses({ ...base, deliveryStatus: "picked_up" }), []);
});

test("self delivery and pickup have method-specific paths", () => {
  assert.deepEqual(nextDeliveryStatuses({ ...base, deliveryMethod: "pharmacy", deliveryStatus: "packed" }), ["out_for_delivery", "cancelled"]);
  assert.deepEqual(nextDeliveryStatuses({ ...base, deliveryMethod: "pickup", deliveryStatus: "ready_for_pickup" }), ["delivered", "cancelled"]);
  assert.equal(orderStatusForDeliveryStatus("confirmed"), "accepted");
  assert.equal(orderStatusForDeliveryStatus("delivered"), "completed");
});
