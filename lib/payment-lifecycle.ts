export type RefundActorRole = "customer" | "vendor" | "admin";
export type ProviderRefundStatus = "pending" | "processed" | "failed";

export type RefundRecord = {
  id: number;
  orderId: number;
  orderNumber: string;
  vendorId: number;
  customerProfileId: number;
  salesReturnId: number | null;
  providerPaymentId: string;
  providerRefundId: string | null;
  refundReceipt: string;
  amountPaise: number;
  status: ProviderRefundStatus;
  reason: string;
  failureReason: string;
};

type RefundableOrder = {
  id: number;
  orderNumber: string;
  vendorId: number;
  customerProfileId: number;
  totalPaise: number;
  paymentMethod: string;
  paymentStatus: string;
  inventoryStatus: string;
  orderStatus: string;
  deliveryStatus: string;
  providerPaymentId: string;
};

const CUSTOMER_REFUNDABLE_DELIVERY_STATUSES = new Set(["awaiting_confirmation"]);
const OPERATOR_REFUNDABLE_DELIVERY_STATUSES = new Set([
  "awaiting_confirmation", "confirmed", "packed", "ready_for_pickup", "assigned",
]);

export class PaymentLifecycleError extends Error {
  readonly status: number;

  constructor(message: string, status = 409) {
    super(message);
    this.name = "PaymentLifecycleError";
    this.status = status;
  }
}

export function canRequestFullRefund(order: Pick<RefundableOrder,
  "paymentMethod" | "paymentStatus" | "inventoryStatus" | "orderStatus" | "deliveryStatus" | "providerPaymentId">,
actorRole: RefundActorRole) {
  if (order.paymentMethod !== "online" || order.paymentStatus !== "paid" || !order.providerPaymentId
    || order.inventoryStatus !== "committed" || ["completed", "cancelled"].includes(order.orderStatus)) return false;
  return (actorRole === "customer" ? CUSTOMER_REFUNDABLE_DELIVERY_STATUSES : OPERATOR_REFUNDABLE_DELIVERY_STATUSES)
    .has(order.deliveryStatus);
}

async function loadRefund(db: D1Database, orderId: number) {
  return db.prepare(`SELECT refund.id,refund.order_id AS orderId,current_order.order_number AS orderNumber,
    refund.vendor_id AS vendorId,refund.customer_profile_id AS customerProfileId,
    refund.sales_return_id AS salesReturnId,refund.provider_payment_id AS providerPaymentId,
    refund.provider_refund_id AS providerRefundId,refund.refund_receipt AS refundReceipt,
    refund.amount_paise AS amountPaise,refund.status,refund.reason,refund.failure_reason AS failureReason
    FROM payment_refunds refund JOIN orders current_order ON current_order.id=refund.order_id
    WHERE refund.order_id=? LIMIT 1`).bind(orderId).first<RefundRecord>();
}

async function loadOrder(db: D1Database, orderId: number) {
  return db.prepare(`SELECT id,order_number AS orderNumber,vendor_id AS vendorId,
    customer_profile_id AS customerProfileId,total_paise AS totalPaise,payment_method AS paymentMethod,
    payment_status AS paymentStatus,inventory_status AS inventoryStatus,order_status AS orderStatus,
    delivery_status AS deliveryStatus,razorpay_payment_id AS providerPaymentId
    FROM orders WHERE id=? LIMIT 1`).bind(orderId).first<RefundableOrder>();
}

function identifier(prefix: string, orderNumber: string) {
  return `${prefix}-${orderNumber.replace(/[^A-Za-z0-9_-]/g, "").slice(-48)}`;
}

export async function beginFullOrderRefund(input: {
  db: D1Database;
  orderId: number;
  actorProfileId: number;
  actorRole: RefundActorRole;
  reason: string;
}) {
  const { db } = input;
  const reason = input.reason.trim().slice(0, 300);
  if (reason.length < 5) throw new PaymentLifecycleError("Enter a clear refund reason", 400);

  const existing = await loadRefund(db, input.orderId);
  if (existing) {
    if (existing.status === "failed") {
      await db.batch([
        db.prepare(`UPDATE payment_refunds SET status='pending',failure_reason='',failed_at=NULL,updated_at=CURRENT_TIMESTAMP
          WHERE id=? AND status='failed'`).bind(existing.id),
        db.prepare("UPDATE sales_returns SET status='pending' WHERE id=? AND status='failed'").bind(existing.salesReturnId),
        db.prepare(`UPDATE orders SET payment_status='refund_pending',updated_at=CURRENT_TIMESTAMP
          WHERE id=? AND order_status='cancelled' AND payment_status='paid'`).bind(existing.orderId),
        db.prepare(`INSERT INTO delivery_events (order_id,status,actor_profile_id,note)
          SELECT ?,'refund_retry',?,'Refund retry requested' WHERE NOT EXISTS
            (SELECT 1 FROM delivery_events WHERE order_id=? AND status='refund_retry')`)
          .bind(existing.orderId, input.actorProfileId, existing.orderId),
      ]);
      return { ...(await loadRefund(db, input.orderId))!, duplicate: false, retry: true };
    }
    return { ...existing, duplicate: true, retry: false };
  }

  const order = await loadOrder(db, input.orderId);
  if (!order) throw new PaymentLifecycleError("Order not found", 404);
  if (!canRequestFullRefund(order, input.actorRole)) {
    throw new PaymentLifecycleError(input.actorRole === "customer"
      ? "A paid order can be refunded only before the pharmacy accepts it"
      : "This order is too far through fulfilment to refund safely");
  }

  const refundReceipt = identifier("URMED-RF", order.orderNumber);
  const returnNumber = identifier("RET", order.orderNumber);
  const creditNoteNumber = identifier("CN", order.orderNumber);
  const allowedStatuses = input.actorRole === "customer"
    ? "'awaiting_confirmation'"
    : "'awaiting_confirmation','confirmed','packed','ready_for_pickup','assigned'";

  try {
    await db.batch([
      db.prepare(`INSERT INTO payment_refunds (order_id,vendor_id,customer_profile_id,provider_payment_id,
        refund_receipt,amount_paise,status,reason,requested_by_profile_id)
        SELECT id,vendor_id,customer_profile_id,razorpay_payment_id,?,?, 'pending',?,?
        FROM orders WHERE id=? AND payment_method='online' AND payment_status='paid'
          AND inventory_status='committed' AND razorpay_payment_id<>''
          AND order_status NOT IN ('completed','cancelled') AND delivery_status IN (${allowedStatuses})`)
        .bind(refundReceipt, order.totalPaise, reason, input.actorProfileId, order.id),
      db.prepare(`INSERT INTO sales_returns (return_number,vendor_id,source_type,source_id,reason,
        credit_note_number,refund_paise,status,created_by_profile_id)
        SELECT ?,refund.vendor_id,'online',refund.order_id,?, ?,refund.amount_paise,'pending',?
        FROM payment_refunds refund WHERE refund.order_id=? AND refund.sales_return_id IS NULL`)
        .bind(returnNumber, reason, creditNoteNumber, input.actorProfileId, order.id),
      db.prepare(`UPDATE payment_refunds SET sales_return_id=(SELECT id FROM sales_returns WHERE return_number=?),
        updated_at=CURRENT_TIMESTAMP WHERE order_id=? AND sales_return_id IS NULL`)
        .bind(returnNumber, order.id),
      db.prepare(`INSERT INTO sales_return_items (sales_return_id,inventory_id,quantity,condition,disposition,amount_paise)
        SELECT refund.sales_return_id,item.inventory_id,SUM(item.quantity),'unopened','restocked',SUM(item.line_total_paise)
        FROM payment_refunds refund JOIN orders current_order ON current_order.id=refund.order_id
        JOIN order_items item ON item.order_id=current_order.id
        WHERE refund.order_id=? AND current_order.inventory_status='committed'
        GROUP BY refund.sales_return_id,item.inventory_id`).bind(order.id),
      db.prepare(`UPDATE pharmacy_inventory SET quantity=quantity+COALESCE((
        SELECT SUM(item.quantity) FROM order_items item WHERE item.order_id=?
          AND item.inventory_id=pharmacy_inventory.id),0),updated_at=CURRENT_TIMESTAMP
        WHERE id IN (SELECT inventory_id FROM order_items WHERE order_id=?)
          AND EXISTS (SELECT 1 FROM orders current_order JOIN payment_refunds refund ON refund.order_id=current_order.id
            WHERE current_order.id=? AND current_order.inventory_status='committed' AND refund.status='pending')`)
        .bind(order.id, order.id, order.id),
      db.prepare(`INSERT INTO stock_ledger (vendor_id,inventory_id,movement_type,quantity_delta,balance_after,
        reference_type,reference_id,reason,actor_profile_id)
        SELECT inventory.vendor_id,inventory.id,'payment_refund_restore',SUM(item.quantity),inventory.quantity,
          'payment_refund',refund.id,?,?
        FROM payment_refunds refund JOIN orders current_order ON current_order.id=refund.order_id
        JOIN order_items item ON item.order_id=current_order.id
        JOIN pharmacy_inventory inventory ON inventory.id=item.inventory_id
        WHERE refund.order_id=? AND current_order.inventory_status='committed'
          AND NOT EXISTS (SELECT 1 FROM stock_ledger existing WHERE existing.reference_type='payment_refund'
            AND existing.reference_id=refund.id AND existing.inventory_id=inventory.id)
        GROUP BY inventory.vendor_id,inventory.id,inventory.quantity,refund.id`)
        .bind(reason, input.actorProfileId, order.id),
      db.prepare(`INSERT INTO delivery_events (order_id,status,actor_profile_id,note)
        SELECT ?,'refund_requested',?,? WHERE EXISTS
          (SELECT 1 FROM payment_refunds WHERE order_id=? AND status='pending')`)
        .bind(order.id, input.actorProfileId, reason, order.id),
      db.prepare(`UPDATE orders SET order_status='cancelled',delivery_status='cancelled',
        payment_status='refund_pending',inventory_status='released',updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND payment_status='paid' AND inventory_status='committed'
          AND order_status NOT IN ('completed','cancelled') AND delivery_status IN (${allowedStatuses})`)
        .bind(order.id),
    ]);
  } catch (error) {
    const raced = await loadRefund(db, order.id);
    if (raced) return { ...raced, duplicate: true, retry: false };
    throw error;
  }

  const created = await loadRefund(db, order.id);
  if (!created) throw new PaymentLifecycleError("The order changed before the refund could start");
  return { ...created, duplicate: false, retry: false };
}

export async function reconcileProviderRefund(input: {
  db: D1Database;
  providerPaymentId: string;
  providerRefundId: string;
  amountPaise: number;
  status: ProviderRefundStatus;
  failureReason?: string;
  actorProfileId?: number | null;
}) {
  const local = await input.db.prepare(`SELECT id,order_id AS orderId,vendor_id AS vendorId,
    customer_profile_id AS customerProfileId,sales_return_id AS salesReturnId,
    provider_payment_id AS providerPaymentId,provider_refund_id AS providerRefundId,
    amount_paise AS amountPaise,status FROM payment_refunds
    WHERE provider_refund_id=? OR (provider_payment_id=? AND amount_paise=?) ORDER BY id LIMIT 1`)
    .bind(input.providerRefundId, input.providerPaymentId, input.amountPaise)
    .first<Pick<RefundRecord, "id" | "orderId" | "vendorId" | "customerProfileId" | "salesReturnId" | "providerPaymentId" | "providerRefundId" | "amountPaise" | "status">>();
  if (!local) throw new PaymentLifecycleError("Refund record not found", 404);
  if (local.providerPaymentId !== input.providerPaymentId || local.amountPaise !== input.amountPaise
    || (local.providerRefundId && local.providerRefundId !== input.providerRefundId)) {
    throw new PaymentLifecycleError("Provider refund does not match the local order", 409);
  }
  if (local.status === "processed") return { refundId: local.id, orderId: local.orderId, vendorId: local.vendorId, changed: false, status: local.status };

  const failureReason = String(input.failureReason ?? "").trim().slice(0, 300);
  if (input.status === "processed") {
    const results = await input.db.batch([
      input.db.prepare(`UPDATE payment_refunds SET provider_refund_id=?,status='processed',failure_reason='',
        processed_at=COALESCE(processed_at,CURRENT_TIMESTAMP),failed_at=NULL,updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND status<>'processed'`).bind(input.providerRefundId, local.id),
      input.db.prepare("UPDATE sales_returns SET status='completed' WHERE id=? AND status<>'completed'").bind(local.salesReturnId),
      input.db.prepare(`UPDATE orders SET payment_status='refunded',updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND payment_status IN ('paid','refund_pending')`).bind(local.orderId),
      input.db.prepare(`INSERT INTO ledger_entries (vendor_id,account_code,entry_date,description,debit_paise,
        credit_paise,reference_type,reference_id,created_by_profile_id)
        SELECT vendor_id,'SALES_RETURNS',date('now'),'Refund completed',amount_paise,0,'payment_refund',id,?
        FROM payment_refunds refund WHERE id=? AND status='processed' AND NOT EXISTS
          (SELECT 1 FROM ledger_entries entry WHERE entry.reference_type='payment_refund'
            AND entry.reference_id=refund.id AND entry.account_code='SALES_RETURNS')`)
        .bind(input.actorProfileId ?? null, local.id),
      input.db.prepare(`INSERT INTO ledger_entries (vendor_id,account_code,entry_date,description,debit_paise,
        credit_paise,reference_type,reference_id,created_by_profile_id)
        SELECT vendor_id,'CUSTOMER_REFUNDS',date('now'),'Refund completed',0,amount_paise,'payment_refund',id,?
        FROM payment_refunds refund WHERE id=? AND status='processed' AND NOT EXISTS
          (SELECT 1 FROM ledger_entries entry WHERE entry.reference_type='payment_refund'
            AND entry.reference_id=refund.id AND entry.account_code='CUSTOMER_REFUNDS')`)
        .bind(input.actorProfileId ?? null, local.id),
      input.db.prepare(`INSERT INTO delivery_events (order_id,status,actor_profile_id,note)
        SELECT ?,'refund_processed',?,'Payment refund processed' WHERE NOT EXISTS
          (SELECT 1 FROM delivery_events WHERE order_id=? AND status='refund_processed')`)
        .bind(local.orderId, input.actorProfileId ?? null, local.orderId),
      input.db.prepare(`INSERT INTO notifications (profile_id,vendor_id,notification_type,severity,title,message,
        reference_type,reference_id)
        SELECT customer_profile_id,vendor_id,'refund_processed','info','Refund processed',
          'Your payment refund has been processed by Razorpay.','payment_refund',id
        FROM payment_refunds refund WHERE id=? AND NOT EXISTS
          (SELECT 1 FROM notifications notification WHERE notification.reference_type='payment_refund'
            AND notification.reference_id=refund.id AND notification.notification_type='refund_processed')`).bind(local.id),
    ]);
    return { refundId: local.id, orderId: local.orderId, vendorId: local.vendorId, changed: Boolean(results[0]?.meta.changes), status: "processed" as const };
  }

  if (input.status === "failed") {
    const results = await input.db.batch([
      input.db.prepare(`UPDATE payment_refunds SET provider_refund_id=COALESCE(provider_refund_id,?),status='failed',
        failure_reason=?,failed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status<>'processed'`)
        .bind(input.providerRefundId || null, failureReason || "Razorpay refund failed", local.id),
      input.db.prepare("UPDATE sales_returns SET status='failed' WHERE id=? AND status<>'completed'").bind(local.salesReturnId),
      input.db.prepare(`UPDATE orders SET payment_status='paid',updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND payment_status='refund_pending'`).bind(local.orderId),
      input.db.prepare(`INSERT INTO delivery_events (order_id,status,actor_profile_id,note)
        SELECT ?,'refund_failed',?,? WHERE NOT EXISTS
          (SELECT 1 FROM delivery_events WHERE order_id=? AND status='refund_failed')`)
        .bind(local.orderId, input.actorProfileId ?? null, failureReason || "Razorpay refund failed", local.orderId),
    ]);
    return { refundId: local.id, orderId: local.orderId, vendorId: local.vendorId, changed: Boolean(results[0]?.meta.changes), status: "failed" as const };
  }

  const result = await input.db.prepare(`UPDATE payment_refunds SET provider_refund_id=?,status='pending',
    failure_reason='',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending' AND (provider_refund_id IS NULL OR provider_refund_id=?)`)
    .bind(input.providerRefundId, local.id, input.providerRefundId).run();
  if (result.meta.changes) {
    return { refundId: local.id, orderId: local.orderId, vendorId: local.vendorId, changed: true, status: "pending" as const };
  }
  const persisted = await input.db.prepare("SELECT status FROM payment_refunds WHERE id=?")
    .bind(local.id).first<{ status: ProviderRefundStatus }>();
  return { refundId: local.id, orderId: local.orderId, vendorId: local.vendorId, changed: false, status: persisted?.status ?? local.status };
}
