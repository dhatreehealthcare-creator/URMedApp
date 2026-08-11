import { getD1 } from "../../../../db/d1";
import { errorResponse } from "../../../../lib/auth-server";
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
      await db.batch([
        db.prepare(`UPDATE orders SET payment_status='paid',razorpay_payment_id=?,
          order_status=CASE WHEN order_status='awaiting_payment' THEN 'placed' ELSE order_status END,
          delivery_status=CASE WHEN order_status='awaiting_payment' THEN 'awaiting_confirmation' ELSE delivery_status END,
          updated_at=CURRENT_TIMESTAMP WHERE id=? AND order_status<>'cancelled'`).bind(payment?.id??"",order.id),
        db.prepare(`INSERT INTO delivery_events (order_id,status,note) SELECT ?,'payment_confirmed','Online payment captured'
          WHERE NOT EXISTS(SELECT 1 FROM delivery_events WHERE order_id=? AND status='payment_confirmed')`).bind(order.id,order.id),
      ]);
    }
    if (order && eventType === "payment.failed") {
      await db.prepare("UPDATE orders SET payment_status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND payment_status <> 'paid'").bind(order.id).run();
    }
    return Response.json({ received: true });
  } catch (error) {
    return errorResponse(error);
  }
}
