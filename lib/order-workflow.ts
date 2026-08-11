export type WorkflowRole = "customer" | "vendor" | "admin" | "delivery";
export type DeliveryMethod = "pickup" | "pharmacy" | "urmed";

export type OrderWorkflowState = {
  role: WorkflowRole;
  deliveryMethod: DeliveryMethod;
  deliveryStatus: string;
  orderStatus: string;
  prescriptionStatus: string;
  paymentMethod: string;
  paymentStatus: string;
};

const vendorRoles = new Set<WorkflowRole>(["vendor", "admin"]);
const deliveryRoles = new Set<WorkflowRole>(["delivery", "admin"]);

export const workflowStatusLabels: Record<string, string> = {
  placed: "Order received",
  payment_confirmed: "Payment confirmed",
  prescription_approved: "Prescription approved",
  prescription_clarification: "Prescription clarification",
  prescription_rejected: "Prescription rejected",
  awaiting_confirmation: "Received",
  confirmed: "Accepted",
  pharmacist_review: "Pharmacist review",
  packed: "Packed",
  ready_for_pickup: "Ready for pickup",
  assigned: "Delivery assigned",
  picked_up: "Picked up",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  cancelled: "Cancelled",
};

export function nextDeliveryStatuses(state: OrderWorkflowState): string[] {
  if (["completed", "cancelled"].includes(state.orderStatus) || ["delivered", "cancelled"].includes(state.deliveryStatus)) return [];
  const canCancel = !["picked_up", "out_for_delivery"].includes(state.deliveryStatus) && vendorRoles.has(state.role);
  const cancellation = canCancel ? ["cancelled"] : [];
  if (!["not_required", "approved"].includes(state.prescriptionStatus)) return cancellation;
  if (state.paymentMethod === "online" && state.paymentStatus !== "paid") return cancellation;

  if (state.deliveryStatus === "awaiting_confirmation") return vendorRoles.has(state.role) ? ["confirmed", ...cancellation] : [];
  if (state.deliveryStatus === "confirmed") return vendorRoles.has(state.role) ? ["packed", ...cancellation] : [];
  if (state.deliveryStatus === "packed") {
    if (!vendorRoles.has(state.role)) return [];
    return [state.deliveryMethod === "pharmacy" ? "out_for_delivery" : "ready_for_pickup", ...cancellation];
  }
  if (state.deliveryStatus === "ready_for_pickup") {
    if (state.deliveryMethod === "pickup") return vendorRoles.has(state.role) ? ["delivered", ...cancellation] : [];
    if (state.deliveryMethod === "urmed") return deliveryRoles.has(state.role) ? ["assigned", ...cancellation] : cancellation;
    return [];
  }
  if (state.deliveryStatus === "assigned") return deliveryRoles.has(state.role) ? ["picked_up", ...cancellation] : cancellation;
  if (state.deliveryStatus === "picked_up") return deliveryRoles.has(state.role) ? ["out_for_delivery"] : [];
  if (state.deliveryStatus === "out_for_delivery") {
    if (state.deliveryMethod === "pharmacy") return vendorRoles.has(state.role) ? ["delivered"] : [];
    return deliveryRoles.has(state.role) ? ["delivered"] : [];
  }
  return [];
}

export function orderStatusForDeliveryStatus(status: string) {
  if (status === "delivered") return "completed";
  if (status === "cancelled") return "cancelled";
  if (status === "confirmed") return "accepted";
  return "processing";
}
