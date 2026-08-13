import { prepareAuditEventStatement } from "./audit.ts";

export const ORDER_NOTIFICATION_TYPES = {
  newOrder: "vendor_order_new",
  overdue: "vendor_order_sla_overdue",
} as const;

function validDate(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Processing date is invalid");
  return date.toISOString();
}

export async function generateVendorOrderSlaNotifications(input: { db: D1Database; now?: string; limit?: number }) {
  const now = validDate(input.now ?? new Date().toISOString());
  const limit = Math.max(1, Math.min(500, Math.trunc(input.limit ?? 200)));
  const result = await input.db.prepare(`INSERT INTO notifications
      (profile_id,vendor_id,notification_type,severity,title,message,reference_type,reference_id,created_at)
    SELECT NULL,o.vendor_id,?, 'warning','Order SLA overdue',
      'Order '||o.order_number||' has exceeded the response target for '||o.delivery_status||'.',
      'order',o.id,?
    FROM orders o
    WHERE o.order_status NOT IN ('completed','cancelled')
      AND o.delivery_status IN ('awaiting_confirmation','confirmed','packed','ready_for_pickup')
      AND datetime(o.created_at, '+' || CASE o.delivery_status
        WHEN 'awaiting_confirmation' THEN 30 WHEN 'confirmed' THEN 60
        WHEN 'packed' THEN 30 WHEN 'ready_for_pickup' THEN 30 ELSE 30 END || ' minutes') < datetime(?)
      AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.vendor_id=o.vendor_id
        AND n.notification_type=? AND n.reference_type='order' AND n.reference_id=o.id
        AND n.lifecycle_status<>'resolved')
    ORDER BY o.created_at LIMIT ?`).bind(ORDER_NOTIFICATION_TYPES.overdue, now, now, ORDER_NOTIFICATION_TYPES.overdue, limit).run();
  return { processingAt: now, generated: Number(result.meta.changes ?? 0) };
}

export function prepareVendorNewOrderNotificationStatement(db: D1Database, input: { orderNumber: string; orderId: number; vendorId: number; now?: string }) {
  return db.prepare(`INSERT INTO notifications
      (profile_id,vendor_id,notification_type,severity,title,message,reference_type,reference_id,created_at)
    SELECT NULL,o.vendor_id,?,?, ?,?,'order',o.id,?
    FROM orders o WHERE o.order_number=? AND NOT EXISTS
      (SELECT 1 FROM notifications WHERE vendor_id=o.vendor_id AND notification_type=? AND reference_type='order' AND reference_id=o.id)`)
    .bind(ORDER_NOTIFICATION_TYPES.newOrder, "info", "New customer order", `Order ${input.orderNumber} is awaiting pharmacy confirmation.`, input.now ?? new Date().toISOString(), input.orderNumber, ORDER_NOTIFICATION_TYPES.newOrder);
}

export async function appendVendorNotificationAudit(db: D1Database, input: { vendorId: number; actorProfileId: number; action: string; notificationId: number }) {
  const statement = await prepareAuditEventStatement({ vendorId: input.vendorId, actorProfileId: input.actorProfileId, action: input.action, entityType: "vendor_notification", entityId: input.notificationId }, db, { whenPreviousStatementChanged: true });
  await statement.run();
}
