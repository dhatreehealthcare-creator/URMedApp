import { getD1 } from "../../../../../db/d1";
import { appendAuditEvent } from "../../../../../lib/audit";
import { errorResponse, requireLocalProfile } from "../../../../../lib/auth-server";
import { prepareOrderReservationReleaseStatements } from "../../../../../lib/inventory-reservations";
import { nextDeliveryStatuses, orderStatusForDeliveryStatus, workflowStatusLabels, type DeliveryMethod, type WorkflowRole } from "../../../../../lib/order-workflow";
import { prepareTransactionalEmailEnqueueStatement } from "../../../../../lib/transactional-email-outbox";
import { canCustomerCancelOrder } from "../../../../../lib/customer-order-history";
import { requireVendorPermission } from "../../../../../lib/vendor-access";
import { prepareOnlineTaxInvoiceStatement } from "../../../../../lib/tax-invoice";
import {
  DeliveryLocationProofError,
  validateDeliveryLocationProof,
  type DeliveryLocationProof,
} from "../../../../../lib/delivery-location";
import { enforceRateLimit } from "../../../../../lib/abuse-controls";

const allowedStatuses = new Set(["confirmed", "packed", "ready_for_pickup", "picked_up", "out_for_delivery", "delivered", "cancelled"]);

type WorkflowOrder = {
  id: number; orderNumber: string; vendorId: number; branchId: number | null; customerProfileId: number;
  prescriptionStatus: string; paymentMethod: string; paymentStatus: string; deliveryMethod: DeliveryMethod;
  orderStatus: string; deliveryStatus: string;
};

function privateJson(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "private, no-store");
  return Response.json(body, { ...init, headers });
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const authenticated = await requireLocalProfile(request, ["customer", "vendor", "admin", "delivery"]);
    const { profile } = authenticated;
    const vendorAccess = profile.role === "vendor"
      ? await requireVendorPermission(request, "sale.write", authenticated)
      : null;
    const orderId = Number((await context.params).id);
    if (!Number.isInteger(orderId)) return privateJson({ error: "Order is invalid" }, { status: 400 });
    const order = await getD1().prepare("SELECT id, customer_profile_id AS customerProfileId, vendor_id AS vendorId, branch_id AS branchId, delivery_method AS deliveryMethod FROM orders WHERE id = ?")
      .bind(orderId).first<{ id: number; customerProfileId: number; vendorId: number; branchId: number | null; deliveryMethod: string }>();
    if (!order) return privateJson({ error: "Order not found" }, { status: 404 });
    const assigned = profile.role === "delivery" ? await getD1().prepare(`SELECT a.id FROM delivery_assignments a
      JOIN delivery_agents agent ON agent.id=a.agent_id WHERE a.order_id=? AND agent.profile_id=?
        AND a.status NOT IN ('cancelled') ORDER BY a.id DESC LIMIT 1`).bind(orderId,profile.id).first<{id:number}>() : null;
    const allowed = profile.role === "admin" || order.customerProfileId === profile.id
      || (profile.role === "vendor" && order.vendorId === vendorAccess?.vendorId && (vendorAccess.branchId === null || order.branchId === vendorAccess.branchId))
      || (profile.role === "delivery" && order.deliveryMethod === "urmed" && Boolean(assigned));
    if (!allowed) return privateJson({ error: "Order not found" }, { status: 404 });
    const events = await getD1().prepare(`SELECT e.status, e.note, e.latitude, e.longitude, e.created_at AS createdAt,
      COALESCE(actor.name, 'URMED system') AS actorName, COALESCE(actor.role, 'system') AS actorRole
      FROM delivery_events e LEFT JOIN account_profiles actor ON actor.id = e.actor_profile_id
      WHERE e.order_id = ? ORDER BY e.created_at, e.id`).bind(orderId).all();
    return privateJson({ events: events.results });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const authenticated = await requireLocalProfile(request, ["customer", "vendor", "admin", "delivery"]);
    const { profile } = authenticated;
    const limited = profile.role === "delivery"
      ? await enforceRateLimit(request, "gps", { profileId: profile.id })
      : null;
    if (limited) return limited;
    const vendorAccess = profile.role === "vendor"
      ? await requireVendorPermission(request, "sale.write", authenticated)
      : null;
    const orderId = Number((await context.params).id);
    const body = await request.json() as Record<string, unknown>;
    const status = String(body.status ?? "").trim();
    if (!Number.isInteger(orderId) || !allowedStatuses.has(status)) return privateJson({ error: "Tracking update is invalid" }, { status: 400 });
    const db = getD1();
    const order = await db.prepare(`SELECT o.id, o.order_number AS orderNumber, o.vendor_id AS vendorId,
      o.customer_profile_id AS customerProfileId, o.branch_id AS branchId,
      o.prescription_status AS prescriptionStatus, o.payment_method AS paymentMethod,
      o.payment_status AS paymentStatus, o.delivery_method AS deliveryMethod,
      o.order_status AS orderStatus, o.delivery_status AS deliveryStatus
      FROM orders o WHERE o.id = ?`)
      .bind(orderId).first<WorkflowOrder>();
    if (!order || (profile.role === "customer" && order.customerProfileId !== profile.id)
      || (profile.role === "vendor" && (order.vendorId !== vendorAccess?.vendorId || (vendorAccess.branchId !== null && order.branchId !== vendorAccess.branchId)))
      || (profile.role === "delivery" && order.deliveryMethod !== "urmed")) {
      return privateJson({ error: "Order not found" }, { status: 404 });
    }
    if (profile.role === "delivery") {
      const assignment = await db.prepare(`SELECT a.id FROM delivery_assignments a JOIN delivery_agents agent ON agent.id=a.agent_id
        WHERE a.order_id=? AND agent.profile_id=? AND a.status NOT IN ('cancelled') ORDER BY a.id DESC LIMIT 1`).bind(orderId,profile.id).first<{id:number}>();
      if(!assignment)return privateJson({error:"This delivery is not assigned to you"},{status:403});
    }
    if (order.orderStatus === "completed" || order.orderStatus === "cancelled") {
      if (order.deliveryStatus === status) return privateJson({ updated: false, unchanged: true });
      return privateJson({ error: "A completed or cancelled order cannot be changed" }, { status: 409 });
    }
    if (status === "cancelled" && order.paymentMethod === "online"
      && ["paid", "refund_pending"].includes(order.paymentStatus)) {
      return privateJson({ error: "Use the verified refund action to cancel a paid online order" }, { status: 409 });
    }
    if (status === "delivered" && order.paymentMethod === "cod" && order.paymentStatus !== "paid") {
      return privateJson({ error: "Record and verify COD collection evidence before marking this order delivered" }, { status: 409 });
    }
    if (status === "delivered" && order.paymentMethod === "cod") {
      const collection = await db.prepare("SELECT id FROM cod_collection_evidence WHERE order_id=? AND collection_status='collected' LIMIT 1").bind(orderId).first();
      if (!collection) return privateJson({ error: "Record and verify COD collection evidence before marking this order delivered" }, { status: 409 });
    }
    const permitted = profile.role === "customer"
      ? canCustomerCancelOrder(order) ? ["cancelled"] : []
      : nextDeliveryStatuses({
        role: profile.role as WorkflowRole, deliveryMethod: order.deliveryMethod, deliveryStatus: order.deliveryStatus,
        orderStatus: order.orderStatus, prescriptionStatus: order.prescriptionStatus,
        paymentMethod: order.paymentMethod, paymentStatus: order.paymentStatus,
      });
    if (!permitted.includes(status)) {
      return privateJson({ error: permitted.length
        ? `The next allowed action is: ${permitted.map((item) => workflowStatusLabels[item]).join(" or ")}`
        : "This account cannot advance the order from its current stage" }, { status: 409 });
    }

    const note = String(body.note ?? "").trim().slice(0, 300);
    if (status === "cancelled" && note.length < 5) return privateJson({ error: "Enter a clear cancellation reason" }, { status: 400 });
    let locationProof: DeliveryLocationProof | null = null;
    if (profile.role === "delivery" && ["picked_up", "out_for_delivery", "delivered"].includes(status)) {
      try {
        locationProof = validateDeliveryLocationProof(body);
      } catch (error) {
        if (error instanceof DeliveryLocationProofError) return privateJson({ error: error.message }, { status: 400 });
        throw error;
      }
      const claimed = await db.prepare(`UPDATE delivery_agents
        SET current_latitude=?,current_longitude=?,updated_at=?
        WHERE profile_id=? AND julianday(updated_at)<julianday(?)`)
        .bind(locationProof.latitude, locationProof.longitude, locationProof.capturedAt, profile.id, locationProof.capturedAt).run();
      if (!claimed.meta.changes) {
        return privateJson({ error: "This delivery location proof was already used. Capture a fresh position" }, { status: 409 });
      }
    }
    const latitude = locationProof?.latitude ?? "";
    const longitude = locationProof?.longitude ?? "";
    const eventNote = locationProof
      ? `${note || `Order ${workflowStatusLabels[status].toLowerCase()}`} · Browser GPS ${locationProof.capturedAt}, accuracy ${locationProof.accuracy}m`
      : note || `Order ${workflowStatusLabels[status].toLowerCase()}`;

    const statements = [];
    if (status === "cancelled") {
      statements.push(
        ...prepareOrderReservationReleaseStatements(db, { orderId, status: "released", reason: note }),
        db.prepare(`UPDATE pharmacy_inventory SET quantity = quantity + COALESCE((
          SELECT SUM(item.quantity) FROM order_items item WHERE item.order_id = ?
            AND item.inventory_id = pharmacy_inventory.id
        ), 0), updated_at = CURRENT_TIMESTAMP
        WHERE id IN (SELECT inventory_id FROM order_items WHERE order_id = ?)
          AND EXISTS (SELECT 1 FROM orders WHERE id = ? AND delivery_status = ?
            AND inventory_status='committed' AND order_status NOT IN ('completed', 'cancelled'))`)
          .bind(orderId, orderId, orderId, order.deliveryStatus),
        db.prepare(`INSERT INTO stock_ledger (vendor_id, inventory_id, movement_type, quantity_delta, balance_after,
          reference_type, reference_id, reason, actor_profile_id)
          SELECT i.vendor_id, i.id, 'order_cancel_restore', SUM(item.quantity), i.quantity, 'order', o.id, ?, ?
          FROM orders o JOIN order_items item ON item.order_id = o.id
          JOIN pharmacy_inventory i ON i.id = item.inventory_id
          WHERE o.id = ? AND o.delivery_status = ? AND o.inventory_status='committed'
            AND o.order_status NOT IN ('completed', 'cancelled')
          GROUP BY i.vendor_id, i.id, i.quantity, o.id`).bind(note, profile.id, orderId, order.deliveryStatus),
        db.prepare(`UPDATE orders SET inventory_status='released', updated_at=CURRENT_TIMESTAMP
          WHERE id=? AND delivery_status=? AND inventory_status='committed'
            AND order_status NOT IN ('completed','cancelled')`).bind(orderId, order.deliveryStatus),
      );
    }
    const eventIndex = statements.length;
    statements.push(
      db.prepare(`INSERT INTO delivery_events (order_id, status, actor_profile_id, note, latitude, longitude)
        SELECT id, ?, ?, ?, ?, ? FROM orders
        WHERE id = ? AND delivery_status = ? AND order_status NOT IN ('completed', 'cancelled')`)
        .bind(status, profile.id, eventNote, latitude, longitude, orderId, order.deliveryStatus),
      db.prepare(`UPDATE orders SET delivery_status = ?, order_status = ?,
        updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND delivery_status = ? AND order_status NOT IN ('completed', 'cancelled')`)
        .bind(status, orderStatusForDeliveryStatus(status), orderId, order.deliveryStatus),
    );
    if (profile.role === "delivery") {
      statements.push(db.prepare(`UPDATE delivery_assignments SET status=?,
        accepted_at=CASE WHEN ? IN ('picked_up','out_for_delivery','delivered') THEN COALESCE(accepted_at,CURRENT_TIMESTAMP) ELSE accepted_at END,
        picked_up_at=CASE WHEN ? IN ('picked_up','out_for_delivery','delivered') THEN COALESCE(picked_up_at,CURRENT_TIMESTAMP) ELSE picked_up_at END,
        delivered_at=CASE WHEN ?='delivered' THEN CURRENT_TIMESTAMP ELSE delivered_at END
        WHERE id=(SELECT a.id FROM delivery_assignments a JOIN delivery_agents agent ON agent.id=a.agent_id
          WHERE a.order_id=? AND agent.profile_id=? AND a.status NOT IN ('cancelled') ORDER BY a.id DESC LIMIT 1)`)
        .bind(status,status,status,status,orderId,profile.id));
    }
    if (status === "delivered") {
      statements.push(
        prepareOnlineTaxInvoiceStatement(db, orderId, profile.id),
        db.prepare(`UPDATE orders SET invoice_id=(SELECT id FROM tax_invoices WHERE source_type='online_order' AND source_id=orders.id ORDER BY id DESC LIMIT 1) WHERE id=? AND delivery_status='delivered'`).bind(orderId),
        db.prepare(`INSERT INTO ledger_entries (vendor_id,account_code,entry_date,description,debit_paise,credit_paise,reference_type,reference_id,created_by_profile_id)
          SELECT vendor_id,'CASH_BANK',date('now'),'Receipt for '||order_number,total_paise,0,'online_order',id,? FROM orders o
          WHERE id=? AND delivery_status='delivered' AND (payment_method<>'cod' OR EXISTS (SELECT 1 FROM cod_collection_evidence c WHERE c.order_id=o.id AND c.collection_status='collected')) AND NOT EXISTS (SELECT 1 FROM ledger_entries l WHERE l.reference_type='online_order' AND l.reference_id=o.id AND l.account_code='CASH_BANK')`).bind(profile.id,orderId),
        db.prepare(`INSERT INTO ledger_entries (vendor_id,account_code,entry_date,description,debit_paise,credit_paise,reference_type,reference_id,created_by_profile_id)
          SELECT vendor_id,'SALES',date('now'),'Sale for '||order_number,0,subtotal_paise,'online_order',id,? FROM orders o
          WHERE id=? AND delivery_status='delivered' AND NOT EXISTS (SELECT 1 FROM ledger_entries l WHERE l.reference_type='online_order' AND l.reference_id=o.id AND l.account_code='SALES')`).bind(profile.id,orderId),
        db.prepare(`INSERT INTO ledger_entries (vendor_id,account_code,entry_date,description,debit_paise,credit_paise,reference_type,reference_id,created_by_profile_id)
          SELECT vendor_id,'GST_PAYABLE',date('now'),'GST for '||order_number,0,tax_paise,'online_order',id,? FROM orders o
          WHERE id=? AND delivery_status='delivered' AND tax_paise>0 AND NOT EXISTS (SELECT 1 FROM ledger_entries l WHERE l.reference_type='online_order' AND l.reference_id=o.id AND l.account_code='GST_PAYABLE')`).bind(profile.id,orderId),
        db.prepare(`INSERT INTO ledger_entries (vendor_id,account_code,entry_date,description,debit_paise,credit_paise,reference_type,reference_id,created_by_profile_id)
          SELECT vendor_id,'DELIVERY_INCOME',date('now'),'Delivery income for '||order_number,0,delivery_fee_paise,'online_order',id,? FROM orders o
          WHERE id=? AND delivery_status='delivered' AND delivery_fee_paise>0 AND NOT EXISTS (SELECT 1 FROM ledger_entries l WHERE l.reference_type='online_order' AND l.reference_id=o.id AND l.account_code='DELIVERY_INCOME')`).bind(profile.id,orderId),
        db.prepare(`INSERT INTO statutory_register_entries (vendor_id,register_type,serial_number,transaction_date,
          patient_name,patient_address,prescriber_name,prescriber_address,product_id,batch_number,quantity_supplied,
          source_type,source_id,pharmacist_id,retention_until)
          SELECT o.vendor_id,CASE WHEN p.drug_schedule='H1' THEN 'H1' ELSE 'PRESCRIPTION' END,
            o.order_number||'-'||item.id,date('now'),rx.patient_name,rx.patient_address,rx.prescriber_name,
            rx.prescriber_address,item.product_id,item.batch_number,item.quantity,'online_order',o.id,review.pharmacist_id,
            CASE WHEN p.drug_schedule='H1' THEN date('now','+36 months') ELSE date('now','+24 months') END
          FROM orders o JOIN order_items item ON item.order_id=o.id JOIN products p ON p.id=item.product_id
          JOIN prescriptions rx ON rx.id=o.prescription_id
          JOIN prescription_reviews review ON review.id=(SELECT id FROM prescription_reviews r WHERE r.prescription_id=rx.id AND r.decision='approved' ORDER BY r.id DESC LIMIT 1)
          WHERE o.id=? AND o.delivery_status='delivered' AND (p.drug_schedule='H1' OR p.prescription_required=1)
          ON CONFLICT(vendor_id,register_type,serial_number) DO NOTHING`).bind(orderId),
        db.prepare(`INSERT OR IGNORE INTO refill_reminders (customer_profile_id, source_order_id, source_order_item_id,
          vendor_id, product_id, medicine_name, original_quantity, days_supply, due_date, reminder_lead_days,
          status, schedule_source)
          SELECT o.customer_profile_id, o.id, MIN(item.id), o.vendor_id, item.product_id, MIN(item.product_name),
            SUM(item.quantity), 30, date('now', '+30 day'), 3, 'active', 'estimated'
          FROM orders o JOIN order_items item ON item.order_id = o.id
          WHERE o.id = ? AND o.delivery_status = 'delivered'
          GROUP BY o.customer_profile_id, o.id, o.vendor_id, item.product_id`).bind(orderId),
        db.prepare(`INSERT INTO notifications (profile_id, vendor_id, notification_type, severity, title, message,
          reference_type, reference_id)
          SELECT customer_profile_id, vendor_id, 'refill_created', 'info', 'Estimated refill reminder created',
            'Review the estimated 30-day refill date before reordering.', 'order', id
          FROM orders WHERE id = ? AND delivery_status = 'delivered'`).bind(orderId),
      );
    }
    statements.push(prepareTransactionalEmailEnqueueStatement(db, {
      profileId: order.customerProfileId,
      eventType: "order_status_changed",
      payload: { orderNumber: order.orderNumber, status: workflowStatusLabels[status], refillCreated: status === "delivered" },
      dedupeKey: `order_status:${orderId}:${status}`,
    }));
    const results = await db.batch(statements);
    if (!results[eventIndex]?.meta.changes) return privateJson({ error: "The order changed. Refresh before taking the next action." }, { status: 409 });

    await appendAuditEvent({ vendorId: order.vendorId, actorProfileId: profile.id, action: `order.${status}`, entityType: "order", entityId: orderId, before: { orderStatus: order.orderStatus, deliveryStatus: order.deliveryStatus }, after: { orderStatus: orderStatusForDeliveryStatus(status), deliveryStatus: status, note, locationProof: locationProof ? { capturedAt: locationProof.capturedAt, accuracy: locationProof.accuracy } : undefined }, requestId: request.headers.get("cf-ray") ?? "" });
    return privateJson({ updated: true, status, label: workflowStatusLabels[status] });
  } catch (error) {
    return errorResponse(error);
  }
}
