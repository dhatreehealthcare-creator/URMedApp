import { getD1 } from "../../../../../db/d1";
import { appendAuditEvent } from "../../../../../lib/audit";
import { errorResponse, requireLocalProfile } from "../../../../../lib/auth-server";
import {
  beginFullOrderRefund,
  PaymentLifecycleError,
  reconcileProviderRefund,
  type RefundActorRole,
} from "../../../../../lib/payment-lifecycle";
import { createRazorpayRefund, RazorpayProviderError } from "../../../../../lib/razorpay";
import { requireVendorPermission } from "../../../../../lib/vendor-access";
import { enforceRateLimit } from "../../../../../lib/abuse-controls";
import { safeRecordOperationalEvent } from "../../../../../lib/operational-monitoring";
import { privateJson } from "../../../../../lib/http-response";

export async function POST(request: Request) {
  try {
    const { profile } = await requireLocalProfile(request, ["customer", "vendor", "admin"]);
    const limited = await enforceRateLimit(request, "payment", { profileId: profile.id });
    if (limited) return limited;
    const body = await request.json() as Record<string, unknown>;
    const orderId = Number(body.orderId);
    const reason = String(body.reason ?? "").trim();
    if (!Number.isInteger(orderId)) return privateJson({ error: "Order is invalid" }, { status: 400 });

    const db = getD1();
    const order = await db.prepare(`SELECT id,vendor_id AS vendorId,customer_profile_id AS customerProfileId
      FROM orders WHERE id=? LIMIT 1`).bind(orderId)
      .first<{ id: number; vendorId: number; customerProfileId: number }>();
    const permitted = order && (profile.role === "admin" || order.customerProfileId === profile.id
      || (profile.role === "vendor" && order.vendorId === profile.vendorId));
    if (!permitted) return privateJson({ error: "Order not found" }, { status: 404 });
    if (profile.role === "vendor") await requireVendorPermission(request, "sale.write");

    const refund = await beginFullOrderRefund({
      db,
      orderId,
      actorProfileId: profile.id,
      actorRole: profile.role as RefundActorRole,
      reason,
    });
    if (!refund.duplicate || refund.retry) {
      await appendAuditEvent({
        vendorId: refund.vendorId,
        actorProfileId: profile.id,
        action: refund.retry ? "payment.refund_retried" : "payment.refund_requested",
        entityType: "payment_refund",
        entityId: refund.id,
        after: { orderId, amountPaise: refund.amountPaise, status: "pending" },
        reason,
        requestId: request.headers.get("cf-ray") ?? "",
      }, db);
    }
    if (refund.status === "processed") {
      return privateJson({ refund: { id: refund.id, status: refund.status, amountPaise: refund.amountPaise }, duplicate: true });
    }

    try {
      const providerRefund = await createRazorpayRefund({
        paymentId: refund.providerPaymentId,
        amountPaise: refund.amountPaise,
        receipt: refund.refundReceipt,
        orderId,
        reason: refund.reason,
      });
      const reconciled = await reconcileProviderRefund({
        db,
        providerPaymentId: providerRefund.payment_id,
        providerRefundId: providerRefund.id,
        amountPaise: providerRefund.amount,
        status: providerRefund.status,
        failureReason: providerRefund.status === "failed" ? "Razorpay reported that the refund failed" : "",
        actorProfileId: profile.id,
      });
      if (reconciled.changed) {
        await appendAuditEvent({
          vendorId: reconciled.vendorId,
          actorProfileId: profile.id,
          action: `payment.refund_${reconciled.status}`,
          entityType: "payment_refund",
          entityId: reconciled.refundId,
          after: { providerRefundId: providerRefund.id, status: reconciled.status, amountPaise: refund.amountPaise },
          reason,
          requestId: request.headers.get("cf-ray") ?? "",
        }, db);
      }
      return privateJson({
        refund: { id: refund.id, providerRefundId: providerRefund.id, status: reconciled.status, amountPaise: refund.amountPaise },
        duplicate: refund.duplicate && !reconciled.changed,
      }, { status: reconciled.status === "pending" ? 202 : 200 });
    } catch (error) {
      if (!(error instanceof RazorpayProviderError)) throw error;
      await safeRecordOperationalEvent({ db, eventKey: `payment-refund:provider-failure:${refund.id}:${Date.now()}`, category: "payment", severity: "error", provider: "razorpay", vendorId: refund.vendorId, profileId: profile.id, referenceType: "payment_refund", referenceId: refund.id, errorCode: "provider_refund_failed", retryable: true, detail: { providerStatus: error.status } });
      const reconciled = await reconcileProviderRefund({
        db,
        providerPaymentId: refund.providerPaymentId,
        providerRefundId: "",
        amountPaise: refund.amountPaise,
        status: "failed",
        failureReason: error.message,
        actorProfileId: profile.id,
      });
      await appendAuditEvent({
        vendorId: reconciled.vendorId,
        actorProfileId: profile.id,
        action: "payment.refund_failed",
        entityType: "payment_refund",
        entityId: reconciled.refundId,
        after: { status: "failed" },
        reason: error.message,
        requestId: request.headers.get("cf-ray") ?? "",
      }, db);
      return privateJson({ error: error.message, refund: { id: refund.id, status: "failed", amountPaise: refund.amountPaise } }, { status: error.status });
    }
  } catch (error) {
    if (error instanceof PaymentLifecycleError) return privateJson({ error: error.message }, { status: error.status });
    return errorResponse(error);
  }
}
