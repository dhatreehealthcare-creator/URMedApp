import assert from "node:assert/strict";
import test from "node:test";
import { nextRiderAction, validateSupplierReturn } from "../lib/operations-controls.ts";

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
