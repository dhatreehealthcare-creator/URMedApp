import assert from "node:assert/strict";
import test from "node:test";
import { nextRiderAction, validateSupplierReturn } from "../lib/operations-controls.ts";
import {
  DELIVERY_LOCATION_MIN_UPDATE_INTERVAL_MS,
  deliveryTimestampMs,
  validateDeliveryLocationProof,
} from "../lib/delivery-location.ts";

test("supplier return is limited by current stock and unreturned purchase quantity",()=>{
  assert.deepEqual(validateSupplierReturn({quantity:3,currentQuantity:8,purchasedQuantity:10,returnedQuantity:2}),{remainingPurchased:8,remainingAfter:5});
  assert.throws(()=>validateSupplierReturn({quantity:9,currentQuantity:8,purchasedQuantity:10,returnedQuantity:0}),/current batch stock/);
  assert.throws(()=>validateSupplierReturn({quantity:4,currentQuantity:10,purchasedQuantity:5,returnedQuantity:2}),/unreturned purchased stock/);
});

test("delivery agent actions cannot skip the assignment workflow",()=>{
  assert.equal(nextRiderAction("assigned"),"picked_up");
  assert.equal(nextRiderAction("picked_up"),"out_for_delivery");
  assert.equal(nextRiderAction("out_for_delivery"),"delivered");
  assert.equal(nextRiderAction("delivered"),"");
});

test("delivery proof requires fresh accurate browser geolocation",()=>{
  const now=Date.parse("2026-08-13T10:00:00.000Z");
  assert.deepEqual(validateDeliveryLocationProof({
    latitude:"17.4321",longitude:"78.4076",accuracy:12.34,capturedAt:"2026-08-13T09:59:50.000Z",
  },now),{
    latitude:"17.432100",longitude:"78.407600",accuracy:12.3,
    capturedAt:"2026-08-13T09:59:50.000Z",capturedAtMs:now-10_000,
  });
  assert.throws(()=>validateDeliveryLocationProof({latitude:"",longitude:"78.4",accuracy:10,capturedAt:new Date(now).toISOString()},now),/latitude/i);
  assert.throws(()=>validateDeliveryLocationProof({latitude:"17.4",longitude:"78.4",accuracy:10},now),/timestamp/i);
  assert.throws(()=>validateDeliveryLocationProof({latitude:"17.4",longitude:"78.4",accuracy:10,capturedAt:"2026-08-13T09:59:00.000Z"},now),/stale/i);
  assert.throws(()=>validateDeliveryLocationProof({latitude:"17.4",longitude:"78.4",accuracy:101,capturedAt:new Date(now).toISOString()},now),/100 metres/i);
  assert.equal(deliveryTimestampMs("2026-08-13 10:00:00"),now);
  assert.equal(DELIVERY_LOCATION_MIN_UPDATE_INTERVAL_MS,15_000);
});
