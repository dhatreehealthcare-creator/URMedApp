export const PURCHASE_STATUS = {
  DRAFT: "draft",
  APPROVED: "approved",
  PARTIALLY_RECEIVED: "partially_received",
  RECEIVED: "received",
  CANCELLED: "cancelled",
} as const;

export type PurchaseStatus = typeof PURCHASE_STATUS[keyof typeof PURCHASE_STATUS];
export type StoredPurchaseStatus = PurchaseStatus | "posting" | "posted";

export const LEGACY_RECEIVED_PURCHASE_STATUS = "posted" as const;
export const RETURNABLE_PURCHASE_STATUSES = [
  PURCHASE_STATUS.PARTIALLY_RECEIVED,
  PURCHASE_STATUS.RECEIVED,
  LEGACY_RECEIVED_PURCHASE_STATUS,
] as const;

export function normalizePurchaseStatus(status: StoredPurchaseStatus): PurchaseStatus {
  if (status === LEGACY_RECEIVED_PURCHASE_STATUS) return PURCHASE_STATUS.RECEIVED;
  if (status === "posting") return PURCHASE_STATUS.DRAFT;
  return status;
}

export function purchaseStatusLabel(status: StoredPurchaseStatus): string {
  const normalized = normalizePurchaseStatus(status);
  const value = normalized.replaceAll("_", " ");
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function nextPurchaseStatuses(status: StoredPurchaseStatus): PurchaseStatus[] {
  const normalized = normalizePurchaseStatus(status);
  if (normalized === PURCHASE_STATUS.DRAFT) return [PURCHASE_STATUS.APPROVED, PURCHASE_STATUS.CANCELLED];
  if (normalized === PURCHASE_STATUS.APPROVED) return [PURCHASE_STATUS.PARTIALLY_RECEIVED, PURCHASE_STATUS.RECEIVED, PURCHASE_STATUS.CANCELLED];
  if (normalized === PURCHASE_STATUS.PARTIALLY_RECEIVED) return [PURCHASE_STATUS.PARTIALLY_RECEIVED, PURCHASE_STATUS.RECEIVED];
  return [];
}
