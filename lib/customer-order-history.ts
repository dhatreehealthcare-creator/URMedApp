export const customerOrderHistoryStatuses = [
  "all",
  "active",
  "awaiting_payment",
  "prescription_review",
  "completed",
  "cancelled",
] as const;
export const customerOrderHistoryPayments = ["all", "pending", "paid", "cod_due", "failed", "refund_pending", "refunded"] as const;
export const customerOrderHistoryDeliveries = ["all", "pickup", "pharmacy", "urmed"] as const;
export const customerOrderHistorySorts = ["newest", "oldest"] as const;

export type CustomerOrderHistoryStatus = typeof customerOrderHistoryStatuses[number];
export type CustomerOrderHistoryPayment = typeof customerOrderHistoryPayments[number];
export type CustomerOrderHistoryDelivery = typeof customerOrderHistoryDeliveries[number];
export type CustomerOrderHistorySort = typeof customerOrderHistorySorts[number];

export type CustomerReorderRequest = {
  orderId: number;
  inventoryId: number;
  productName: string;
  quantity: number;
  prescriptionRequired: boolean;
};

function oneOf<const Values extends readonly string[]>(
  value: string | null,
  values: Values,
  fallback: Values[number],
): Values[number] {
  return values.includes(value ?? "") ? value as Values[number] : fallback;
}

function boundedInteger(value: string | null, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value);
  return value && Number.isInteger(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

export function parseCustomerOrderHistoryQuery(input: URL | URLSearchParams) {
  const parameters = input instanceof URL ? input.searchParams : input;
  return {
    query: (parameters.get("q") ?? "").trim().replace(/\s+/g, " ").slice(0, 100),
    status: oneOf(parameters.get("status"), customerOrderHistoryStatuses, "all"),
    payment: oneOf(parameters.get("payment"), customerOrderHistoryPayments, "all"),
    delivery: oneOf(parameters.get("delivery"), customerOrderHistoryDeliveries, "all"),
    sort: oneOf(parameters.get("sort"), customerOrderHistorySorts, "newest"),
    page: boundedInteger(parameters.get("page"), 1, 1, 100_000),
    pageSize: boundedInteger(parameters.get("pageSize"), 10, 5, 30),
  };
}

export function escapeCustomerOrderSearch(value: string) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export function customerOrderStatusPredicate(status: CustomerOrderHistoryStatus) {
  if (status === "active") return "o.order_status NOT IN ('completed','cancelled')";
  if (status === "awaiting_payment") return "o.payment_status='pending' AND o.order_status<>'cancelled'";
  if (status === "prescription_review") return "o.prescription_status IN ('pending_review','clarification_required') AND o.order_status<>'cancelled'";
  if (status === "completed") return "o.order_status='completed'";
  if (status === "cancelled") return "o.order_status='cancelled'";
  return "1=1";
}

export function customerOrderSortExpression(sort: CustomerOrderHistorySort) {
  return sort === "oldest" ? "datetime(o.created_at) ASC,o.id ASC" : "datetime(o.created_at) DESC,o.id DESC";
}

export function canCustomerCancelOrder(input: {
  orderStatus: string;
  deliveryStatus: string;
  paymentStatus: string;
}) {
  return !["completed", "cancelled"].includes(input.orderStatus)
    && input.paymentStatus !== "paid"
    && ["awaiting_confirmation", "pharmacist_review"].includes(input.deliveryStatus);
}
