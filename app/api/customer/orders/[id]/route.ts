import { getD1 } from "../../../../../db/d1";
import { errorResponse, requireLocalProfile } from "../../../../../lib/auth-server";
import { canCustomerCancelOrder } from "../../../../../lib/customer-order-history";
import { canRequestFullRefund } from "../../../../../lib/payment-lifecycle";

type CustomerOrderDetailRow = {
  id: number; orderNumber: string; businessName: string; subtotalPaise: number; taxPaise: number;
  deliveryFeePaise: number; totalPaise: number; paymentMethod: string; paymentStatus: string;
  deliveryMethod: string; orderStatus: string; deliveryStatus: string; prescriptionId: number | null;
  prescriptionStatus: string; inventoryStatus: string; reservationExpiresAt: string | null;
  placeOfSupplyStateCode: string; deliveryAddress: string; invoiceId: number | null;
  invoiceNumber: string | null; providerPaymentId: string; createdAt: string; updatedAt: string;
};

type CustomerOrderItemRow = {
  id: number; productId: number; productName: string; batchNumber: string; quantity: number;
  unitPricePaise: number; gstPercent: number; taxablePaise: number; cgstPaise: number;
  sgstPaise: number; igstPaise: number; lineTotalPaise: number; prescriptionRequired: number;
  reorderInventoryId: number | null; reorderAvailableQuantity: number | null;
};

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { profile } = await requireLocalProfile(request, ["customer"]);
    const orderId = Number((await context.params).id);
    if (!Number.isInteger(orderId) || orderId < 1) return Response.json({ error: "Order is invalid" }, { status: 400 });
    const db = getD1();
    const order = await db.prepare(`SELECT o.id,o.order_number AS orderNumber,v.business_name AS businessName,
      o.subtotal_paise AS subtotalPaise,o.tax_paise AS taxPaise,o.delivery_fee_paise AS deliveryFeePaise,
      o.total_paise AS totalPaise,o.payment_method AS paymentMethod,o.payment_status AS paymentStatus,
      o.delivery_method AS deliveryMethod,o.order_status AS orderStatus,o.delivery_status AS deliveryStatus,
      o.prescription_id AS prescriptionId,o.prescription_status AS prescriptionStatus,
      o.inventory_status AS inventoryStatus,o.reservation_expires_at AS reservationExpiresAt,
      o.place_of_supply_state_code AS placeOfSupplyStateCode,o.delivery_address AS deliveryAddress,
      o.invoice_id AS invoiceId,invoice.invoice_number AS invoiceNumber,
      o.razorpay_payment_id AS providerPaymentId,o.created_at AS createdAt,o.updated_at AS updatedAt
      FROM orders o JOIN vendors v ON v.id=o.vendor_id
      LEFT JOIN tax_invoices invoice ON invoice.id=o.invoice_id
      WHERE o.id=? AND o.customer_profile_id=? AND o.order_type='online' LIMIT 1`)
      .bind(orderId, profile.id).first<CustomerOrderDetailRow>();
    if (!order) return Response.json({ error: "Order not found" }, { status: 404 });
    const [items, events, refund] = await Promise.all([
      db.prepare(`SELECT item.id,item.product_id AS productId,item.product_name AS productName,
        item.batch_number AS batchNumber,item.quantity,item.unit_price_paise AS unitPricePaise,
        item.gst_percent AS gstPercent,item.taxable_paise AS taxablePaise,item.cgst_paise AS cgstPaise,
        item.sgst_paise AS sgstPaise,item.igst_paise AS igstPaise,item.line_total_paise AS lineTotalPaise,
        product.prescription_required AS prescriptionRequired,
        (SELECT current.id FROM pharmacy_inventory current
          WHERE current.vendor_id=scoped_order.vendor_id AND current.branch_id=scoped_order.branch_id AND current.product_id=item.product_id
            AND current.active=1 AND current.quarantine_status='available'
            AND current.expiry_date IS NOT NULL AND date(current.expiry_date)>=date('now')
            AND current.cold_chain_status IN ('not_applicable','within_range')
            AND (current.quantity-current.reserved_quantity)>0
          ORDER BY date(current.expiry_date),current.id LIMIT 1) AS reorderInventoryId,
        (SELECT current.quantity-current.reserved_quantity FROM pharmacy_inventory current
          WHERE current.vendor_id=scoped_order.vendor_id AND current.branch_id=scoped_order.branch_id AND current.product_id=item.product_id
            AND current.active=1 AND current.quarantine_status='available'
            AND current.expiry_date IS NOT NULL AND date(current.expiry_date)>=date('now')
            AND current.cold_chain_status IN ('not_applicable','within_range')
            AND (current.quantity-current.reserved_quantity)>0
          ORDER BY date(current.expiry_date),current.id LIMIT 1) AS reorderAvailableQuantity
        FROM order_items item JOIN orders scoped_order ON scoped_order.id=item.order_id
        JOIN products product ON product.id=item.product_id
        WHERE item.order_id=? AND scoped_order.customer_profile_id=? ORDER BY item.id`)
        .bind(orderId, profile.id).all<CustomerOrderItemRow>(),
      db.prepare(`SELECT event.id,event.status,event.note,event.created_at AS createdAt,
        COALESCE(actor.name,'URMED system') AS actorName,COALESCE(actor.role,'system') AS actorRole
        FROM delivery_events event JOIN orders scoped_order ON scoped_order.id=event.order_id
        LEFT JOIN account_profiles actor ON actor.id=event.actor_profile_id
        WHERE event.order_id=? AND scoped_order.customer_profile_id=?
        ORDER BY datetime(event.created_at),event.id`).bind(orderId, profile.id).all(),
      db.prepare(`SELECT refund.id,refund.provider_refund_id AS providerRefundId,
        refund.amount_paise AS amountPaise,refund.status,refund.reason,
        refund.failure_reason AS failureReason,refund.refund_receipt AS refundReceipt,
        return_record.credit_note_number AS creditNoteNumber,
        refund.initiated_at AS initiatedAt,refund.processed_at AS processedAt
        FROM payment_refunds refund LEFT JOIN sales_returns return_record ON return_record.id=refund.sales_return_id
        WHERE refund.order_id=? AND refund.customer_profile_id=? LIMIT 1`)
        .bind(orderId, profile.id).first(),
    ]);
    return Response.json({
      order: {
        ...order,
        canCancel: canCustomerCancelOrder(order),
        canRefund: canRequestFullRefund(order, "customer"),
        paymentReceiptAvailable: order.paymentMethod === "online" && Boolean(order.providerPaymentId),
        refund,
        invoice: { id: order.invoiceId, available: Boolean(order.invoiceId), number: order.invoiceNumber, downloadImplemented: true },
        items: items.results.map((item) => ({ ...item, prescriptionRequired: Boolean(item.prescriptionRequired) })),
        trackingEvents: events.results,
      },
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
