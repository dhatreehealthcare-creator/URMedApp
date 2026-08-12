import { getD1 } from "../../../../db/d1";
import { errorResponse } from "../../../../lib/auth-server";
import { captureOnlineOrderPayment, InventoryReservationError } from "../../../../lib/inventory-reservations";
import { getRequiredRuntimeValue } from "../../../../lib/runtime-env";
import { constantTimeEqual, hmacHex, sha256Hex } from "../../../../lib/signatures";

type RazorpayWebhook = {
  event?: string;
  payload?: { payment?: { entity?: { id?: string; order_id?: string; status?: string } } };
};

export async function POST(request: Request) {
  try {
    const raw = await request.text();
    const received = request.headers.get("x-razorpay-signature") ?? "";
    const expected = await hmacHex(getRequiredRuntimeValue("RAZORPAY_WEBHOOK_SECRET"), raw);
    if (!constantTimeEqual(expected, received)) return Response.json({ error: "Invalid webhook signature" }, { status: 401 });
    const payload = JSON.parse(raw) as RazorpayWebhook;
    const eventType = payload.event ?? "unknown";
    const payment = payload.payload?.payment?.entity;
    const providerEventId = `${eventType}:${payment?.id ?? await sha256Hex(raw)}`;
    const db=getD1();
    const order = payment?.order_id ? await db.prepare("SELECT id FROM orders WHERE razorpay_order_id = ?").bind(payment.order_id).first<{ id: number }>() : null;
    const inserted=await db.prepare("INSERT OR IGNORE INTO payment_events (provider_event_id, order_id, event_type, payload_hash) VALUES (?, ?, ?, ?)")
      .bind(providerEventId, order?.id ?? null, eventType, await sha256Hex(raw)).run();
    if(!inserted.meta.changes)return Response.json({received:true,duplicate:true});
    if (order && (eventType === "payment.captured" || payment?.status === "captured")) {
      try {
        await captureOnlineOrderPayment({
          db,
          orderId: order.id,
          paymentId: payment?.id ?? "",
          note: "Online payment captured",
        });
      } catch (error) {
        await db.prepare("DELETE FROM payment_events WHERE provider_event_id=?").bind(providerEventId).run();
        if (error instanceof InventoryReservationError) return Response.json({ error: error.message }, { status: error.status });
        throw error;
      }
    }
    if (order && eventType === "payment.failed") {
      await db.prepare("UPDATE orders SET payment_status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND payment_status <> 'paid'").bind(order.id).run();
    }
    return Response.json({ received: true });
  } catch (error) {
    return errorResponse(error);
  }
}
