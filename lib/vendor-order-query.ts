export const vendorOrderQueueStatuses = [
  "all",
  "action_required",
  "awaiting_confirmation",
  "prescription_review",
  "in_progress",
  "completed",
  "cancelled",
] as const;

export const vendorOrderPaymentStatuses = ["all", "pending", "paid", "cod_due", "failed", "refunded"] as const;
export const vendorOrderDeliveryMethods = ["all", "pickup", "pharmacy", "urmed"] as const;
export const vendorOrderSorts = ["newest", "oldest", "amount_high", "amount_low"] as const;

export type VendorOrderQueueStatus = typeof vendorOrderQueueStatuses[number];
export type VendorOrderPaymentStatus = typeof vendorOrderPaymentStatuses[number];
export type VendorOrderDeliveryMethod = typeof vendorOrderDeliveryMethods[number];
export type VendorOrderSort = typeof vendorOrderSorts[number];

export type VendorOrderQueueQuery = {
  query: string;
  status: VendorOrderQueueStatus;
  payment: VendorOrderPaymentStatus;
  delivery: VendorOrderDeliveryMethod;
  sort: VendorOrderSort;
  page: number;
  pageSize: number;
};

function oneOf<const Values extends readonly string[]>(
  value: string | null,
  values: Values,
  fallback: Values[number],
): Values[number] {
  return values.includes(value ?? "") ? value as Values[number] : fallback;
}

function boundedInteger(value: string | null, fallback: number, minimum: number, maximum: number) {
  if (value === null || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

export function parseVendorOrderQueueQuery(input: URL | URLSearchParams): VendorOrderQueueQuery {
  const parameters = input instanceof URL ? input.searchParams : input;
  return {
    query: (parameters.get("q") ?? "").trim().replace(/\s+/g, " ").slice(0, 100),
    status: oneOf(parameters.get("status"), vendorOrderQueueStatuses, "all"),
    payment: oneOf(parameters.get("payment"), vendorOrderPaymentStatuses, "all"),
    delivery: oneOf(parameters.get("delivery"), vendorOrderDeliveryMethods, "all"),
    sort: oneOf(parameters.get("sort"), vendorOrderSorts, "newest"),
    page: boundedInteger(parameters.get("page"), 1, 1, 100_000),
    pageSize: boundedInteger(parameters.get("pageSize"), 20, 5, 50),
  };
}

export function escapeSqlLike(value: string) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export function vendorOrderStatusPredicate(status: VendorOrderQueueStatus) {
  if (status === "action_required") {
    return `(
      o.prescription_status = 'pending_review'
      OR (
        o.prescription_status IN ('not_required', 'approved')
        AND (o.payment_method = 'cod' OR o.payment_status = 'paid')
        AND (
          o.delivery_status IN ('awaiting_confirmation', 'confirmed', 'packed')
          OR (o.delivery_method = 'pickup' AND o.delivery_status = 'ready_for_pickup')
          OR (o.delivery_method = 'pharmacy' AND o.delivery_status = 'out_for_delivery')
        )
      )
    )`;
  }
  if (status === "awaiting_confirmation") return "o.delivery_status = 'awaiting_confirmation'";
  if (status === "prescription_review") return "o.prescription_status IN ('pending_review', 'clarification_required')";
  if (status === "in_progress") {
    return `o.order_status NOT IN ('completed', 'cancelled')
      AND o.delivery_status NOT IN ('awaiting_confirmation', 'pharmacist_review')`;
  }
  if (status === "completed") return "o.order_status = 'completed'";
  if (status === "cancelled") return "o.order_status = 'cancelled'";
  return "1 = 1";
}

export function vendorOrderSortExpression(sort: VendorOrderSort) {
  if (sort === "oldest") return "datetime(o.created_at) ASC, o.id ASC";
  if (sort === "amount_high") return "o.total_paise DESC, datetime(o.created_at) DESC, o.id DESC";
  if (sort === "amount_low") return "o.total_paise ASC, datetime(o.created_at) DESC, o.id DESC";
  return "datetime(o.created_at) DESC, o.id DESC";
}
