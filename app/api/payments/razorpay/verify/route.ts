import { getD1 } from "../../../../../db/d1";
import { errorResponse, requireLocalProfile } from "../../../../../lib/auth-server";
import { captureOnlineOrderPayment, InventoryReservationError } from "../../../../../lib/inventory-reservations";
import { fetchRazorpayPayment, RazorpayProviderError } from "../../../../../lib/razorpay";
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
    const order = await db.prepare(`SELECT id, total_paise AS totalPaise, prescription_status AS prescriptionStatus, order_status AS orderStatus,
      payment_status AS paymentStatus, razorpay_payment_id AS paymentId
      FROM orders WHERE razorpay_order_id = ? AND customer_profile_id = ? LIMIT 1`).bind(razorpayOrderId, profile.id)
      .first<{ id: number; totalPaise: number; prescriptionStatus: string; orderStatus: string; paymentStatus: string; paymentId: string }>();
    if (!order) return Response.json({ error: "Order not found" }, { status: 404 });
    if (order.orderStatus === "cancelled" || !["not_required", "approved"].includes(order.prescriptionStatus)) return Response.json({ error: "This order is not eligible for payment" }, { status: 409 });
    const expected = await hmacHex(getRequiredRuntimeValue("RAZORPAY_KEY_SECRET"), `${razorpayOrderId}|${razorpayPaymentId}`);
    if (!constantTimeEqual(expected, receivedSignature)) return Response.json({ error: "Payment signature verification failed" }, { status: 400 });
    try {
      const providerPayment = await fetchRazorpayPayment(razorpayPaymentId);
      if (providerPayment.order_id !== razorpayOrderId || providerPayment.amount !== order.totalPaise
        || providerPayment.currency !== "INR" || providerPayment.status !== "captured") {
        return Response.json({ error: "The captured payment does not match this order" }, { status: 409 });
      }
      const result = await captureOnlineOrderPayment({
        db,
        orderId: order.id,
        paymentId: razorpayPaymentId,
        actorProfileId: profile.id,
        note: "Online payment verified",
      });
      return Response.json({ verified: true, duplicate: result.duplicate, orderId: order.id });
    } catch (error) {
      if (error instanceof InventoryReservationError) return Response.json({ error: error.message }, { status: error.status });
      if (error instanceof RazorpayProviderError) return Response.json({ error: error.message }, { status: error.status });
      throw error;
    }
  } catch (error) {
    return errorResponse(error);
  }
}
