export type FefoBatch = {
  inventoryId: number;
  expiryDate: string;
  availableQuantity: number;
};

export type FefoAllocation<T extends FefoBatch> = T & { allocatedQuantity: number };

const GST_RATES = new Set([0, 5, 12, 18, 28]);

export function allocateFefo<T extends FefoBatch>(requestedQuantity: number, batches: T[]): FefoAllocation<T>[] {
  if (!Number.isInteger(requestedQuantity) || requestedQuantity < 1) throw new Error("Requested quantity is invalid");
  const eligible = batches
    .filter((batch) => Number.isInteger(batch.availableQuantity) && batch.availableQuantity > 0)
    .toSorted((left, right) => left.expiryDate.localeCompare(right.expiryDate) || left.inventoryId - right.inventoryId);
  const allocations: FefoAllocation<T>[] = [];
  let remaining = requestedQuantity;
  for (const batch of eligible) {
    if (!remaining) break;
    const allocatedQuantity = Math.min(remaining, batch.availableQuantity);
    allocations.push({ ...batch, allocatedQuantity });
    remaining -= allocatedQuantity;
  }
  if (remaining) throw new Error("Insufficient eligible stock");
  return allocations;
}

export function calculateGst(taxablePaise: number, gstPercent: number, sellerStateCode: string, placeOfSupplyStateCode: string) {
  if (!Number.isInteger(taxablePaise) || taxablePaise < 0) throw new Error("Taxable value is invalid");
  if (!GST_RATES.has(gstPercent)) throw new Error("GST rate is invalid");
  if (!/^\d{2}$/.test(placeOfSupplyStateCode)) throw new Error("Place of supply state code is invalid");
  if (gstPercent > 0 && !/^\d{2}$/.test(sellerStateCode)) throw new Error("Seller GST state code is unavailable");

  const taxPaise = Math.round(taxablePaise * gstPercent / 100);
  if (gstPercent > 0 && sellerStateCode !== placeOfSupplyStateCode) {
    return { taxPaise, cgstPaise: 0, sgstPaise: 0, igstPaise: taxPaise, taxMode: "interstate" as const };
  }
  const cgstPaise = Math.floor(taxPaise / 2);
  return { taxPaise, cgstPaise, sgstPaise: taxPaise - cgstPaise, igstPaise: 0, taxMode: "intrastate" as const };
}
