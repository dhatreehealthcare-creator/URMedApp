export type PurchaseBatchIdentity = {
  expiryDate: string | null;
  manufacturingDate: string | null;
};

function normalizedDate(value: string | null | undefined) {
  return (value ?? "").trim();
}

export function hasConflictingPurchaseBatch(
  existing: PurchaseBatchIdentity,
  incoming: PurchaseBatchIdentity,
) {
  const existingManufacturingDate = normalizedDate(existing.manufacturingDate);
  const incomingManufacturingDate = normalizedDate(incoming.manufacturingDate);
  return normalizedDate(existing.expiryDate) !== normalizedDate(incoming.expiryDate)
    || Boolean(existingManufacturingDate && incomingManufacturingDate
      && existingManufacturingDate !== incomingManufacturingDate);
}

export function isDuplicateSupplierInvoiceError(error: unknown) {
  const detail = error instanceof Error ? error.message : String(error ?? "");
  return /purchase_orders_vendor_invoice_uidx/i.test(detail)
    || /UNIQUE constraint failed:\s*purchase_orders\.vendor_id\s*,\s*purchase_orders\.supplier_id\s*,\s*purchase_orders\.invoice_number/i.test(detail);
}

export function calculatePurchaseLineAmounts(
  purchasePricePaise: number,
  quantity: number,
  gstPercent: number,
) {
  const taxablePaise = purchasePricePaise * quantity;
  const taxPaise = Math.round(taxablePaise * gstPercent / 100);
  return { taxablePaise, taxPaise, lineTotalPaise: taxablePaise + taxPaise };
}
