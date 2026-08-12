export const PURCHASE_STATUS = {
  DRAFT: "draft",
  POSTING: "posting",
  RECEIVED: "received",
} as const;

export type PurchaseStatus = typeof PURCHASE_STATUS[keyof typeof PURCHASE_STATUS];
export type StoredPurchaseStatus = PurchaseStatus | "posted";

export const LEGACY_RECEIVED_PURCHASE_STATUS = "posted" as const;
export const RETURNABLE_PURCHASE_STATUSES = [
  PURCHASE_STATUS.RECEIVED,
  LEGACY_RECEIVED_PURCHASE_STATUS,
] as const;

export function normalizePurchaseStatus(status: StoredPurchaseStatus): PurchaseStatus {
  return status === LEGACY_RECEIVED_PURCHASE_STATUS ? PURCHASE_STATUS.RECEIVED : status;
}

export function purchaseStatusLabel(status: StoredPurchaseStatus): string {
  const normalized = normalizePurchaseStatus(status);
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}
