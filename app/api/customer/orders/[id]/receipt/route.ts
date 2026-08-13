import { getD1 } from "../../../../../../db/d1";
import { errorResponse, requireLocalProfile } from "../../../../../../lib/auth-server";

function escapeHtml(value: unknown) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  }[character]!));
}

function money(paise: number) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(paise / 100);
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { profile } = await requireLocalProfile(request, ["customer"]);
    const orderId = Number((await context.params).id);
    if (!Number.isInteger(orderId)) return Response.json({ error: "Order is invalid" }, { status: 400 });
    const order = await getD1().prepare(`SELECT current_order.order_number AS orderNumber,
      current_order.total_paise AS totalPaise,current_order.payment_status AS paymentStatus,
      current_order.razorpay_payment_id AS paymentId,current_order.created_at AS createdAt,
      current_order.customer_name AS customerName,vendor.business_name AS businessName,
      refund.provider_refund_id AS providerRefundId,refund.status AS refundStatus,
      refund.processed_at AS refundedAt
      FROM orders current_order JOIN vendors vendor ON vendor.id=current_order.vendor_id
      LEFT JOIN payment_refunds refund ON refund.order_id=current_order.id
      WHERE current_order.id=? AND current_order.customer_profile_id=?
        AND current_order.payment_method='online' AND current_order.razorpay_payment_id<>'' LIMIT 1`)
      .bind(orderId, profile.id).first<{
        orderNumber: string; totalPaise: number; paymentStatus: string; paymentId: string;
        createdAt: string; customerName: string; businessName: string;
        providerRefundId: string | null; refundStatus: string | null; refundedAt: string | null;
      }>();
    if (!order) return Response.json({ error: "Payment receipt not found" }, { status: 404 });
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Payment receipt ${escapeHtml(order.orderNumber)}</title>
      <style>body{font:15px system-ui;color:#17352d;margin:40px;max-width:720px}header{border-bottom:2px solid #16846b;padding-bottom:14px}h1{margin:0}.row{display:flex;justify-content:space-between;border-bottom:1px solid #dce8e4;padding:12px 0}.muted{color:#64766f}footer{margin-top:28px;font-size:12px;color:#64766f}</style></head><body>
      <header><h1>URMED payment receipt</h1><p class="muted">Payment evidence only · not a GST tax invoice</p></header>
      <div class="row"><span>Order</span><strong>${escapeHtml(order.orderNumber)}</strong></div>
      <div class="row"><span>Pharmacy</span><strong>${escapeHtml(order.businessName)}</strong></div>
      <div class="row"><span>Customer</span><strong>${escapeHtml(order.customerName)}</strong></div>
      <div class="row"><span>Captured amount</span><strong>${escapeHtml(money(order.totalPaise))}</strong></div>
      <div class="row"><span>Payment status</span><strong>${escapeHtml(order.paymentStatus.replaceAll("_", " "))}</strong></div>
      <div class="row"><span>Razorpay payment ID</span><strong>${escapeHtml(order.paymentId)}</strong></div>
      ${order.providerRefundId ? `<div class="row"><span>Razorpay refund ID</span><strong>${escapeHtml(order.providerRefundId)}</strong></div><div class="row"><span>Refund status</span><strong>${escapeHtml(order.refundStatus)}</strong></div>` : ""}
      <footer>Order created ${escapeHtml(new Date(order.createdAt).toISOString())}${order.refundedAt ? ` · Refund processed ${escapeHtml(new Date(order.refundedAt).toISOString())}` : ""}. This receipt is generated from URMED's reconciled payment record.</footer>
      </body></html>`;
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Disposition": `attachment; filename="URMED-payment-${order.orderNumber.replace(/[^A-Za-z0-9_-]/g, "")}.html"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
