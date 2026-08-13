import { getD1 } from "../../../../db/d1.ts";
import { appendAuditEvent } from "../../../../lib/audit.ts";
import { errorResponse } from "../../../../lib/auth-server.ts";
import { captureOnlineOrderPayment, InventoryReservationError, prepareOrderReservationReleaseStatements } from "../../../../lib/inventory-reservations.ts";
import { PaymentLifecycleError, reconcileProviderRefund, type ProviderRefundStatus } from "../../../../lib/payment-lifecycle.ts";
import { getRequiredRuntimeValue } from "../../../../lib/runtime-env.ts";
import { constantTimeEqual, hmacHex, sha256Hex } from "../../../../lib/signatures.ts";
import {
  RAZORPAY_WEBHOOK_MAX_BYTES,
  readBoundedRequestText,
  RequestBodyTooLargeError,
} from "../../../../lib/bounded-request-body.ts";

type PaymentEntity = {
  id?: string;
  order_id?: string;
  amount?: number;
  currency?: string;
  status?: string;
  error_description?: string;
};

type RefundEntity = {
  id?: string;
  payment_id?: string;
  amount?: number;
  currency?: string;
  status?: string;
  notes?: { urmed_order_id?: string };
};

type RazorpayWebhook = {
  event?: string;
  payload?: {
    payment?: { entity?: PaymentEntity };
    refund?: { entity?: RefundEntity };
  };
};

function refundStatus(eventType: string, refund: RefundEntity): ProviderRefundStatus | null {
  if (eventType === "refund.processed") return "processed";
  if (eventType === "refund.failed") return "failed";
  if (eventType === "refund.created" && refund.status === "pending") return "pending";
  return null;
}

async function appendWebhookAudit(input: {
  db: D1Database;
  vendorId: number;
  action: string;
  entityType: string;
  entityId: string | number;
  after: unknown;
  reason?: string;
  requestId: string;
}) {
  const exists = await input.db.prepare(`SELECT id FROM audit_events
    WHERE action=? AND entity_type=? AND entity_id=? LIMIT 1`)
    .bind(input.action, input.entityType, String(input.entityId)).first<{ id: number }>();
  if (exists) return;
  await appendAuditEvent(input, input.db);
}

export async function POST(request: Request) {
  try {
    const raw = await readBoundedRequestText(request, RAZORPAY_WEBHOOK_MAX_BYTES);
    const received = request.headers.get("x-razorpay-signature") ?? "";
    const expected = await hmacHex(getRequiredRuntimeValue("RAZORPAY_WEBHOOK_SECRET"), raw);
    if (!constantTimeEqual(expected, received)) return Response.json({ error: "Invalid webhook signature" }, { status: 401 });
    const payload = JSON.parse(raw) as RazorpayWebhook;
    const eventType = payload.event ?? "unknown";
    const payment = payload.payload?.payment?.entity;
    const refund = payload.payload?.refund?.entity;
    const entityId = refund?.id ?? payment?.id;
    const providerEventId = `${eventType}:${entityId ?? await sha256Hex(raw)}`;
    const db = getD1();
    const order = payment?.order_id
      ? await db.prepare(`SELECT id,vendor_id AS vendorId,total_paise AS totalPaise,
          razorpay_order_id AS providerOrderId FROM orders WHERE razorpay_order_id=? LIMIT 1`)
        .bind(payment.order_id).first<{ id: number; vendorId: number; totalPaise: number; providerOrderId: string }>()
      : refund?.payment_id
        ? await db.prepare(`SELECT current_order.id,current_order.vendor_id AS vendorId,
            current_order.total_paise AS totalPaise,current_order.razorpay_order_id AS providerOrderId
            FROM payment_refunds refund JOIN orders current_order ON current_order.id=refund.order_id
            WHERE refund.provider_payment_id=? LIMIT 1`).bind(refund.payment_id)
          .first<{ id: number; vendorId: number; totalPaise: number; providerOrderId: string }>()
        : null;

    if (order && payment && (payment.amount !== order.totalPaise || payment.currency !== "INR"
      || payment.order_id !== order.providerOrderId)) {
      return Response.json({ error: "Webhook payment does not match the local order" }, { status: 409 });
    }
    if (order && refund && (refund.amount !== order.totalPaise || refund.currency !== "INR" || !refund.id || !refund.payment_id)) {
      return Response.json({ error: "Webhook refund does not match the local order" }, { status: 409 });
    }

    const inserted = await db.prepare("INSERT OR IGNORE INTO payment_events (provider_event_id, order_id, event_type, payload_hash) VALUES (?, ?, ?, ?)")
      .bind(providerEventId, order?.id ?? null, eventType, await sha256Hex(raw)).run();
    if (!inserted.meta.changes) return Response.json({ received: true, duplicate: true });

    try {
      if (order && payment && eventType === "payment.captured") {
        if (payment.status !== "captured") throw new PaymentLifecycleError("Captured-payment webhook has an invalid provider status", 409);
        const result = await captureOnlineOrderPayment({
          db,
          orderId: order.id,
          paymentId: payment.id ?? "",
          note: "Online payment captured",
        });
        await appendWebhookAudit({
          db,
          vendorId: order.vendorId,
          action: "payment.captured",
          entityType: "order",
          entityId: order.id,
          after: { providerPaymentId: payment.id, amountPaise: payment.amount, duplicate: result.duplicate },
          requestId: request.headers.get("cf-ray") ?? "",
        });
      }
      if (order && payment && eventType === "payment.failed") {
        await db.batch([
          ...prepareOrderReservationReleaseStatements(db, {
            orderId: order.id,
            status: "released",
            reason: "Online payment failed",
          }),
          db.prepare("UPDATE orders SET payment_status='failed',updated_at=CURRENT_TIMESTAMP WHERE id=? AND payment_status NOT IN ('paid','refunded','refund_pending')")
            .bind(order.id),
          db.prepare(`INSERT INTO delivery_events (order_id,status,note)
            SELECT ?,'payment_failed',? WHERE NOT EXISTS
              (SELECT 1 FROM delivery_events WHERE order_id=? AND status='payment_failed')`)
            .bind(order.id, String(payment.error_description ?? "Online payment failed").slice(0, 300), order.id),
        ]);
        await appendWebhookAudit({
          db,
          vendorId: order.vendorId,
          action: "payment.failed",
          entityType: "order",
          entityId: order.id,
          after: { providerPaymentId: payment.id, amountPaise: payment.amount },
          reason: payment.error_description ?? "Online payment failed",
          requestId: request.headers.get("cf-ray") ?? "",
        });
      }
      const normalizedRefundStatus = refund ? refundStatus(eventType, refund) : null;
      if (order && refund && normalizedRefundStatus) {
        const reconciled = await reconcileProviderRefund({
          db,
          providerPaymentId: refund.payment_id!,
          providerRefundId: refund.id!,
          amountPaise: refund.amount!,
          status: normalizedRefundStatus,
          failureReason: normalizedRefundStatus === "failed" ? "Razorpay reported that the refund failed" : "",
        });
        await appendWebhookAudit({
          db,
          vendorId: reconciled.vendorId,
          action: `payment.refund_${reconciled.status}`,
          entityType: "payment_refund",
          entityId: reconciled.refundId,
          after: { providerRefundId: refund.id, status: reconciled.status, amountPaise: refund.amount },
          requestId: request.headers.get("cf-ray") ?? "",
        });
      }
    } catch (error) {
      await db.prepare("DELETE FROM payment_events WHERE provider_event_id=?").bind(providerEventId).run();
      if (error instanceof InventoryReservationError || error instanceof PaymentLifecycleError) {
        return Response.json({ error: error.message }, { status: error.status });
      }
      throw error;
    }
    return Response.json({ received: true });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return Response.json({
        error: "Razorpay webhook payload exceeds the 256 KiB limit",
        code: "webhook_payload_too_large",
      }, { status: 413, headers: { "Cache-Control": "no-store" } });
    }
    return errorResponse(error);
  }
}
