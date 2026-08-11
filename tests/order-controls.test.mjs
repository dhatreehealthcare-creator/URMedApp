import assert from "node:assert/strict";
import test from "node:test";
import { allocateFefo, calculateGst } from "../lib/order-controls.ts";

test("FEFO consumes the earliest eligible batches and splits quantity", () => {
  const result = allocateFefo(7, [
    { inventoryId: 3, expiryDate: "2028-04-30", availableQuantity: 9 },
    { inventoryId: 1, expiryDate: "2027-12-31", availableQuantity: 5 },
    { inventoryId: 2, expiryDate: "2028-01-31", availableQuantity: 4 },
  ]);
  assert.deepEqual(result.map(({ inventoryId, allocatedQuantity }) => ({ inventoryId, allocatedQuantity })), [
    { inventoryId: 1, allocatedQuantity: 5 },
    { inventoryId: 2, allocatedQuantity: 2 },
  ]);
});

test("FEFO rejects an order that exceeds eligible stock", () => {
  assert.throws(() => allocateFefo(4, [{ inventoryId: 1, expiryDate: "2027-12-31", availableQuantity: 3 }]), /Insufficient/);
});

test("GST keeps the rounded line tax exact for intra-state supplies", () => {
  assert.deepEqual(calculateGst(999, 5, "36", "36"), {
    taxPaise: 50, cgstPaise: 25, sgstPaise: 25, igstPaise: 0, taxMode: "intrastate",
  });
});

test("GST uses IGST for inter-state supplies", () => {
  assert.deepEqual(calculateGst(1000, 18, "36", "29"), {
    taxPaise: 180, cgstPaise: 0, sgstPaise: 0, igstPaise: 180, taxMode: "interstate",
  });
});
