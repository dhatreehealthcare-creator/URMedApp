import { getD1 } from "../../../../../db/d1";
import { errorResponse, requireLocalProfile } from "../../../../../lib/auth-server";
import { ensureOnlineReservationPayable, InventoryReservationError } from "../../../../../lib/inventory-reservations";
import { getRequiredRuntimeValue } from "../../../../../lib/runtime-env";

export async function POST(request: Request) {
  try {
    const { profile } = await requireLocalProfile(request, ["customer"]);
    const body = await request.json() as { orderId?: unknown };
    const orderId = Number(body.orderId);
    if (!Number.isInteger(orderId)) return Response.json({ error: "Order is invalid" }, { status: 400 });
    const db = getD1();
    const order = await db.prepare(`SELECT id, order_number AS orderNumber, total_paise AS totalPaise,
      payment_method AS paymentMethod, payment_status AS paymentStatus, razorpay_order_id AS razorpayOrderId,
      prescription_status AS prescriptionStatus, order_status AS orderStatus
      FROM orders WHERE id = ? AND customer_profile_id = ? LIMIT 1`).bind(orderId, profile.id)
      .first<{ id: number; orderNumber: string; totalPaise: number; paymentMethod: string; paymentStatus: string; razorpayOrderId: string; prescriptionStatus: string; orderStatus: string }>();
    if (!order) return Response.json({ error: "Order not found" }, { status: 404 });
    if (order.paymentMethod !== "online") return Response.json({ error: "This is a cash-on-delivery order" }, { status: 409 });
    if (order.orderStatus === "cancelled") return Response.json({ error: "A cancelled order cannot be paid" }, { status: 409 });
    if (!["not_required", "approved"].includes(order.prescriptionStatus)) return Response.json({ error: "Payment opens after pharmacist prescription approval" }, { status: 409 });
    try {
      await ensureOnlineReservationPayable(db, order.id);
    } catch (error) {
      if (error instanceof InventoryReservationError) return Response.json({ error: error.message }, { status: error.status });
      throw error;
    }
    const keyId = getRequiredRuntimeValue("RAZORPAY_KEY_ID");
    if (order.razorpayOrderId) return Response.json({ id: order.razorpayOrderId, amount: order.totalPaise, currency: "INR", keyId });
    const keySecret = getRequiredRuntimeValue("RAZORPAY_KEY_SECRET");
    const response = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${keyId}:${keySecret}`)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ amount: order.totalPaise, currency: "INR", receipt: order.orderNumber, notes: { urmed_order_id: String(order.id) } }),
    });
    const payload = await response.json() as { id?: string; amount?: number; currency?: string; receipt?: string; error?: { description?: string } };
    if (!response.ok || !payload.id) return Response.json({ error: payload.error?.description || "Razorpay could not create the payment" }, { status: 502 });
    if (payload.amount !== order.totalPaise || payload.currency !== "INR" || payload.receipt !== order.orderNumber) {
      return Response.json({ error: "Razorpay returned an inconsistent payment order" }, { status: 502 });
    }
    await db.prepare("UPDATE orders SET razorpay_order_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(payload.id, order.id).run();
    return Response.json({ id: payload.id, amount: order.totalPaise, currency: "INR", keyId });
  } catch (error) {
    return errorResponse(error);
  }
}
