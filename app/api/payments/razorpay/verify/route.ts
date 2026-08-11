import { getD1 } from "../../../../../db/d1";
import { errorResponse, requireLocalProfile } from "../../../../../lib/auth-server";
import { getRequiredRuntimeValue } from "../../../../../lib/runtime-env";
import { constantTimeEqual, hmacHex } from "../../../../../lib/signatures";

export async function POST(request: Request) {
  try {
    const { profile } = await requireLocalProfile(request, ["customer"]);
    const body = await request.json() as Record<string, unknown>;
    const razorpayOrderId = String(body.razorpay_order_id ?? "");
    const razorpayPaymentId = String(body.razorpay_payment_id ?? "");
    const receivedSignature = String(body.razorpay_signature ?? "");
    if (!razorpayOrderId || !razorpayPaymentId || !receivedSignature) return Response.json({ error: "Payment confirmation is incomplete" }, { status: 400 });
    const db = getD1();
    const order = await db.prepare(`SELECT id, prescription_status AS prescriptionStatus, order_status AS orderStatus,
      payment_status AS paymentStatus, razorpay_payment_id AS paymentId
      FROM orders WHERE razorpay_order_id = ? AND customer_profile_id = ? LIMIT 1`).bind(razorpayOrderId, profile.id)
      .first<{ id: number; prescriptionStatus: string; orderStatus: string; paymentStatus: string; paymentId: string }>();
    if (!order) return Response.json({ error: "Order not found" }, { status: 404 });
    if (order.orderStatus === "cancelled" || !["not_required", "approved"].includes(order.prescriptionStatus)) return Response.json({ error: "This order is not eligible for payment" }, { status: 409 });
    const expected = await hmacHex(getRequiredRuntimeValue("RAZORPAY_KEY_SECRET"), `${razorpayOrderId}|${razorpayPaymentId}`);
    if (!constantTimeEqual(expected, receivedSignature)) return Response.json({ error: "Payment signature verification failed" }, { status: 400 });
    if (order.paymentStatus === "paid") {
      if (order.paymentId && order.paymentId !== razorpayPaymentId) return Response.json({error:"A different payment is already recorded for this order"},{status:409});
      return Response.json({ verified: true, duplicate: true, orderId: order.id });
    }
    await db.batch([
      db.prepare(`UPDATE orders SET payment_status = 'paid',
        order_status = CASE WHEN order_status = 'awaiting_payment' THEN 'placed' ELSE order_status END,
        delivery_status = CASE WHEN order_status = 'awaiting_payment' THEN 'awaiting_confirmation' ELSE delivery_status END,
        razorpay_payment_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND payment_status <> 'paid'`).bind(razorpayPaymentId, order.id),
      db.prepare(`INSERT INTO delivery_events (order_id,status,actor_profile_id,note)
        SELECT ?,'payment_confirmed',?,'Online payment verified' WHERE NOT EXISTS
          (SELECT 1 FROM delivery_events WHERE order_id=? AND status='payment_confirmed')`).bind(order.id,profile.id,order.id),
    ]);
    return Response.json({ verified: true, orderId: order.id });
  } catch (error) {
    return errorResponse(error);
  }
}
