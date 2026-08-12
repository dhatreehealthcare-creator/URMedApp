import { getD1 } from "../../../../../db/d1";
import { appendAuditEvent } from "../../../../../lib/audit";
import { errorResponse, requireLocalProfile } from "../../../../../lib/auth-server";
import { nextDeliveryStatuses, orderStatusForDeliveryStatus, workflowStatusLabels, type DeliveryMethod, type WorkflowRole } from "../../../../../lib/order-workflow";
import { sendTransactionalEmail } from "../../../../../lib/resend";

const allowedStatuses = new Set(["confirmed", "packed", "ready_for_pickup", "picked_up", "out_for_delivery", "delivered", "cancelled"]);

type WorkflowOrder = {
  id: number; orderNumber: string; vendorId: number; customerProfileId: number; customerEmail: string;
  prescriptionStatus: string; paymentMethod: string; paymentStatus: string; deliveryMethod: DeliveryMethod;
  orderStatus: string; deliveryStatus: string;
};

function coordinate(value: unknown, minimum: number, maximum: number) {
  const text = String(value ?? "").trim().slice(0, 40);
  const number = Number(text);
  return text && Number.isFinite(number) && number >= minimum && number <= maximum ? text : "";
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { profile } = await requireLocalProfile(request, ["customer", "vendor", "admin", "delivery"]);
    const orderId = Number((await context.params).id);
    if (!Number.isInteger(orderId)) return Response.json({ error: "Order is invalid" }, { status: 400 });
    const order = await getD1().prepare("SELECT id, customer_profile_id AS customerProfileId, vendor_id AS vendorId, delivery_method AS deliveryMethod FROM orders WHERE id = ?")
      .bind(orderId).first<{ id: number; customerProfileId: number; vendorId: number; deliveryMethod: string }>();
    if (!order) return Response.json({ error: "Order not found" }, { status: 404 });
    const assigned = profile.role === "delivery" ? await getD1().prepare(`SELECT a.id FROM delivery_assignments a
      JOIN delivery_agents agent ON agent.id=a.agent_id WHERE a.order_id=? AND agent.profile_id=?
        AND a.status NOT IN ('cancelled') ORDER BY a.id DESC LIMIT 1`).bind(orderId,profile.id).first<{id:number}>() : null;
    const allowed = profile.role === "admin" || order.customerProfileId === profile.id
      || (profile.role === "vendor" && order.vendorId === profile.vendorId)
      || (profile.role === "delivery" && order.deliveryMethod === "urmed" && Boolean(assigned));
    if (!allowed) return Response.json({ error: "Order not found" }, { status: 404 });
    const events = await getD1().prepare(`SELECT e.status, e.note, e.latitude, e.longitude, e.created_at AS createdAt,
      COALESCE(actor.name, 'URMED system') AS actorName, COALESCE(actor.role, 'system') AS actorRole
      FROM delivery_events e LEFT JOIN account_profiles actor ON actor.id = e.actor_profile_id
      WHERE e.order_id = ? ORDER BY e.created_at, e.id`).bind(orderId).all();
    return Response.json({ events: events.results });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { profile } = await requireLocalProfile(request, ["vendor", "admin", "delivery"]);
    const orderId = Number((await context.params).id);
    const body = await request.json() as Record<string, unknown>;
    const status = String(body.status ?? "").trim();
    if (!Number.isInteger(orderId) || !allowedStatuses.has(status)) return Response.json({ error: "Tracking update is invalid" }, { status: 400 });
    const db = getD1();
    const order = await db.prepare(`SELECT o.id, o.order_number AS orderNumber, o.vendor_id AS vendorId,
      o.customer_profile_id AS customerProfileId, customer.email AS customerEmail,
      o.prescription_status AS prescriptionStatus, o.payment_method AS paymentMethod,
      o.payment_status AS paymentStatus, o.delivery_method AS deliveryMethod,
      o.order_status AS orderStatus, o.delivery_status AS deliveryStatus
      FROM orders o JOIN account_profiles customer ON customer.id = o.customer_profile_id WHERE o.id = ?`)
      .bind(orderId).first<WorkflowOrder>();
    if (!order || (profile.role === "vendor" && order.vendorId !== profile.vendorId)
      || (profile.role === "delivery" && order.deliveryMethod !== "urmed")) {
      return Response.json({ error: "Order not found" }, { status: 404 });
    }
    if (profile.role === "delivery") {
      const assignment = await db.prepare(`SELECT a.id FROM delivery_assignments a JOIN delivery_agents agent ON agent.id=a.agent_id
        WHERE a.order_id=? AND agent.profile_id=? AND a.status NOT IN ('cancelled') ORDER BY a.id DESC LIMIT 1`).bind(orderId,profile.id).first<{id:number}>();
      if(!assignment)return Response.json({error:"This delivery is not assigned to you"},{status:403});
    }
    if (order.orderStatus === "completed" || order.orderStatus === "cancelled") {
      if (order.deliveryStatus === status) return Response.json({ updated: false, unchanged: true });
      return Response.json({ error: "A completed or cancelled order cannot be changed" }, { status: 409 });
    }
    const permitted = nextDeliveryStatuses({
      role: profile.role as WorkflowRole, deliveryMethod: order.deliveryMethod, deliveryStatus: order.deliveryStatus,
      orderStatus: order.orderStatus, prescriptionStatus: order.prescriptionStatus,
      paymentMethod: order.paymentMethod, paymentStatus: order.paymentStatus,
    });
    if (!permitted.includes(status)) {
      return Response.json({ error: permitted.length
        ? `The next allowed action is: ${permitted.map((item) => workflowStatusLabels[item]).join(" or ")}`
        : "This account cannot advance the order from its current stage" }, { status: 409 });
    }

    const note = String(body.note ?? "").trim().slice(0, 300);
    if (status === "cancelled" && note.length < 5) return Response.json({ error: "Enter a clear cancellation reason" }, { status: 400 });
    const latitude = coordinate(body.latitude, -90, 90);
    const longitude = coordinate(body.longitude, -180, 180);
    if (profile.role === "delivery" && ["picked_up", "out_for_delivery", "delivered"].includes(status) && (!latitude || !longitude)) {
      return Response.json({ error: "Delivery latitude and longitude are required for this update" }, { status: 400 });
    }

    const statements = [];
    if (status === "cancelled") {
      statements.push(
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
      );
    }
    const eventIndex = statements.length;
    statements.push(
      db.prepare(`INSERT INTO delivery_events (order_id, status, actor_profile_id, note, latitude, longitude)
        SELECT id, ?, ?, ?, ?, ? FROM orders
        WHERE id = ? AND delivery_status = ? AND order_status NOT IN ('completed', 'cancelled')`)
        .bind(status, profile.id, note || `Order ${workflowStatusLabels[status].toLowerCase()}`, latitude, longitude, orderId, order.deliveryStatus),
      db.prepare(`UPDATE orders SET delivery_status = ?, order_status = ?,
        payment_status = CASE WHEN ? = 'delivered' AND payment_method = 'cod' THEN 'paid' ELSE payment_status END,
        updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND delivery_status = ? AND order_status NOT IN ('completed', 'cancelled')`)
        .bind(status, orderStatusForDeliveryStatus(status), status, orderId, order.deliveryStatus),
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
        db.prepare(`INSERT INTO tax_invoices (invoice_number, vendor_id, source_type, source_id, seller_gstin,
          buyer_gstin, place_of_supply_state_code, subtotal_paise, cgst_paise, sgst_paise, igst_paise, total_paise)
          SELECT 'GST-' || o.order_number, o.vendor_id, 'online_order', o.id, v.gst_number, '',
            o.place_of_supply_state_code, o.subtotal_paise, COALESCE(SUM(item.cgst_paise),0),
            COALESCE(SUM(item.sgst_paise),0), COALESCE(SUM(item.igst_paise),0), o.total_paise
          FROM orders o JOIN vendors v ON v.id=o.vendor_id JOIN order_items item ON item.order_id=o.id
          WHERE o.id=? AND o.delivery_status='delivered' AND NOT EXISTS (SELECT 1 FROM tax_invoices invoice WHERE invoice.source_type='online_order' AND invoice.source_id=o.id)
          GROUP BY o.id,o.order_number,o.vendor_id,v.gst_number,o.place_of_supply_state_code,o.subtotal_paise,o.total_paise`).bind(orderId),
        db.prepare(`UPDATE orders SET invoice_id=(SELECT id FROM tax_invoices WHERE source_type='online_order' AND source_id=orders.id ORDER BY id DESC LIMIT 1) WHERE id=? AND delivery_status='delivered'`).bind(orderId),
        db.prepare(`INSERT INTO ledger_entries (vendor_id,account_code,entry_date,description,debit_paise,credit_paise,reference_type,reference_id,created_by_profile_id)
          SELECT vendor_id,'CASH_BANK',date('now'),'Receipt for '||order_number,total_paise,0,'online_order',id,? FROM orders o
          WHERE id=? AND delivery_status='delivered' AND NOT EXISTS (SELECT 1 FROM ledger_entries l WHERE l.reference_type='online_order' AND l.reference_id=o.id AND l.account_code='CASH_BANK')`).bind(profile.id,orderId),
        db.prepare(`INSERT INTO ledger_entries (vendor_id,account_code,entry_date,description,debit_paise,credit_paise,reference_type,reference_id,created_by_profile_id)
          SELECT vendor_id,'SALES',date('now'),'Sale for '||order_number,0,subtotal_paise,'online_order',id,? FROM orders o
          WHERE id=? AND delivery_status='delivered' AND NOT EXISTS (SELECT 1 FROM ledger_entries l WHERE l.reference_type='online_order' AND l.reference_id=o.id AND l.account_code='SALES')`).bind(profile.id,orderId),
        db.prepare(`INSERT INTO ledger_entries (vendor_id,account_code,entry_date,description,debit_paise,credit_paise,reference_type,reference_id,created_by_profile_id)
          SELECT vendor_id,'GST_PAYABLE',date('now'),'GST for '||order_number,0,tax_paise,'online_order',id,? FROM orders o
          WHERE id=? AND delivery_status='delivered' AND tax_paise>0 AND NOT EXISTS (SELECT 1 FROM ledger_entries l WHERE l.reference_type='online_order' AND l.reference_id=o.id AND l.account_code='GST_PAYABLE')`).bind(profile.id,orderId),
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
    const results = await db.batch(statements);
    if (!results[eventIndex]?.meta.changes) return Response.json({ error: "The order changed. Refresh before taking the next action." }, { status: 409 });

    await appendAuditEvent({ vendorId: order.vendorId, actorProfileId: profile.id, action: `order.${status}`, entityType: "order", entityId: orderId, before: { orderStatus: order.orderStatus, deliveryStatus: order.deliveryStatus }, after: { orderStatus: orderStatusForDeliveryStatus(status), deliveryStatus: status, note, latitude, longitude }, requestId: request.headers.get("cf-ray") ?? "" });
    const refillMessage = status === "delivered" ? "<p>Estimated 30-day refill reminders were created for the delivered medicines. Review each date in your URMED account before reordering.</p>" : "";
    await sendTransactionalEmail(order.customerEmail, `URMED order ${order.orderNumber}: ${workflowStatusLabels[status]}`, `<h2>${workflowStatusLabels[status]}</h2><p>Your order ${order.orderNumber} is now ${workflowStatusLabels[status].toLowerCase()}.</p>${refillMessage}`);
    return Response.json({ updated: true, status, label: workflowStatusLabels[status] });
  } catch (error) {
    return errorResponse(error);
  }
}
