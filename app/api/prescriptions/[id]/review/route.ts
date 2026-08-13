import { getD1 } from "../../../../../db/d1";
import { appendAuditEvent } from "../../../../../lib/audit";
import { errorResponse } from "../../../../../lib/auth-server";
import { prepareOrderReservationReleaseStatements } from "../../../../../lib/inventory-reservations";
import { prepareTransactionalEmailEnqueueStatement } from "../../../../../lib/transactional-email-outbox";
import { requireVendorPermission } from "../../../../../lib/vendor-access";

type MedicineInput = { medicineText?: unknown; dosageText?: unknown; durationText?: unknown; quantityApproved?: unknown };

function text(value: unknown, maximum: number) {
  return String(value ?? "").trim().slice(0, maximum);
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { profile, vendorId } = await requireVendorPermission(request, "prescription.review");
    const prescriptionId = Number((await context.params).id);
    const body = await request.json() as Record<string, unknown>;
    const decision = text(body.decision, 40);
    const notes = text(body.notes, 1000);
    if (!Number.isInteger(prescriptionId) || prescriptionId < 1 || !["approved", "rejected", "clarification_required"].includes(decision)) {
      return Response.json({ error: "Prescription review decision is invalid" }, { status: 400 });
    }
    if (decision !== "approved" && notes.length < 5) return Response.json({ error: "Add a clear reason for rejection or clarification" }, { status: 400 });
    const db = getD1();
    const pharmacist = await db.prepare(`SELECT id, full_name AS fullName FROM pharmacists
      WHERE vendor_id = ? AND profile_id = ? AND active = 1 AND verification_status = 'verified'
        AND (valid_until IS NULL OR valid_until >= date('now')) LIMIT 1`)
      .bind(vendorId, profile.id).first<{ id: number; fullName: string }>();
    if (!pharmacist) return Response.json({ error: "A currently verified pharmacist profile is required to review prescriptions" }, { status: 403 });
    const prescription = await db.prepare(`SELECT p.id, p.status, p.customer_profile_id AS customerProfileId,
      p.prescription_number AS prescriptionNumber
      FROM prescriptions p
      WHERE p.id = ? AND p.vendor_id = ? LIMIT 1`).bind(prescriptionId, vendorId)
      .first<{ id: number; status: string; customerProfileId: number; prescriptionNumber: string }>();
    if (!prescription) return Response.json({ error: "Prescription not found" }, { status: 404 });
    if (prescription.status !== "uploaded") return Response.json({ error: "Only a newly uploaded or resubmitted prescription can be reviewed" }, { status: 409 });

    const medicineInputs = Array.isArray(body.items) ? body.items.slice(0, 20) as MedicineInput[] : [];
    const medicines = medicineInputs.map((item) => ({
      medicineText: text(item.medicineText, 180), dosageText: text(item.dosageText, 120),
      durationText: text(item.durationText, 120), quantityApproved: item.quantityApproved === "" || item.quantityApproved == null ? null : Number(item.quantityApproved),
    })).filter((item) => item.medicineText);
    if (medicines.some((item) => item.quantityApproved !== null && (!Number.isInteger(item.quantityApproved) || item.quantityApproved < 0 || item.quantityApproved > 1000))) {
      return Response.json({ error: "Approved medicine quantity is invalid" }, { status: 400 });
    }

    const statements = [
      db.prepare("DELETE FROM prescription_items WHERE prescription_id = ?").bind(prescriptionId),
      db.prepare("INSERT INTO prescription_reviews (prescription_id, pharmacist_id, decision, notes) VALUES (?, ?, ?, ?)")
        .bind(prescriptionId, pharmacist.id, decision, notes),
      db.prepare(`UPDATE prescriptions SET status = ?, rejection_reason = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'uploaded'`)
        .bind(decision, decision === "approved" ? "" : notes, prescriptionId),
    ];
    for (const medicine of medicines) statements.push(db.prepare(`INSERT INTO prescription_items
      (prescription_id, medicine_text, dosage_text, duration_text, quantity_approved) VALUES (?, ?, ?, ?, ?)`)
      .bind(prescriptionId, medicine.medicineText, medicine.dosageText, medicine.durationText, medicine.quantityApproved));

    if (decision === "approved") {
      statements.push(
        db.prepare(`UPDATE orders SET prescription_status = 'approved',
          order_status = CASE WHEN payment_method = 'online' AND payment_status <> 'paid' THEN 'awaiting_payment' ELSE 'placed' END,
          delivery_status = 'awaiting_confirmation', updated_at = CURRENT_TIMESTAMP
          WHERE prescription_id = ? AND order_status <> 'cancelled'`).bind(prescriptionId),
        db.prepare(`INSERT INTO delivery_events (order_id, status, actor_profile_id, note)
          SELECT id, 'prescription_approved', ?, 'Prescription approved by verified pharmacist' FROM orders
          WHERE prescription_id = ? AND order_status <> 'cancelled'`).bind(profile.id, prescriptionId),
      );
    } else if (decision === "clarification_required") {
      statements.push(
        db.prepare(`UPDATE orders SET prescription_status = 'clarification_required', order_status = 'awaiting_prescription_review',
          delivery_status = 'pharmacist_review', updated_at = CURRENT_TIMESTAMP WHERE prescription_id = ? AND order_status <> 'cancelled'`).bind(prescriptionId),
        db.prepare(`INSERT INTO delivery_events (order_id, status, actor_profile_id, note)
          SELECT id, 'prescription_clarification', ?, ? FROM orders WHERE prescription_id = ? AND order_status <> 'cancelled'`)
          .bind(profile.id, notes, prescriptionId),
      );
    } else {
      const affectedOrders = await db.prepare(`SELECT id FROM orders WHERE prescription_id=? AND order_status<>'cancelled'`)
        .bind(prescriptionId).all<{id:number}>();
      for (const order of affectedOrders.results) statements.push(...prepareOrderReservationReleaseStatements(db, {
        orderId: order.id,
        status: "released",
        reason: "Prescription rejected",
      }));
      statements.push(
        db.prepare(`UPDATE pharmacy_inventory SET quantity = quantity + COALESCE((SELECT SUM(oi.quantity)
          FROM order_items oi JOIN orders o ON o.id = oi.order_id
          WHERE oi.inventory_id = pharmacy_inventory.id AND o.prescription_id = ?
            AND o.inventory_status='committed' AND o.order_status <> 'cancelled'), 0),
          updated_at = CURRENT_TIMESTAMP
          WHERE id IN (SELECT oi.inventory_id FROM order_items oi JOIN orders o ON o.id = oi.order_id
            WHERE o.prescription_id = ? AND o.inventory_status='committed' AND o.order_status <> 'cancelled')`).bind(prescriptionId, prescriptionId),
        db.prepare(`INSERT INTO stock_ledger (vendor_id, inventory_id, movement_type, quantity_delta, balance_after,
          reference_type, reference_id, reason, actor_profile_id)
          SELECT i.vendor_id, i.id, 'prescription_reject_restore', SUM(oi.quantity), i.quantity, 'order', o.id,
            'Stock restored after prescription rejection', ?
          FROM orders o JOIN order_items oi ON oi.order_id = o.id
          JOIN pharmacy_inventory i ON i.id = oi.inventory_id
          WHERE o.prescription_id = ? AND o.inventory_status='committed' AND o.order_status <> 'cancelled'
          GROUP BY i.vendor_id, i.id, i.quantity, o.id`).bind(profile.id, prescriptionId),
        db.prepare(`INSERT INTO delivery_events (order_id, status, actor_profile_id, note)
          SELECT id, 'prescription_rejected', ?, ? FROM orders WHERE prescription_id = ? AND order_status <> 'cancelled'`)
          .bind(profile.id, notes, prescriptionId),
        db.prepare(`UPDATE orders SET prescription_status = 'rejected', order_status = 'cancelled', delivery_status = 'cancelled',
          updated_at = CURRENT_TIMESTAMP WHERE prescription_id = ? AND order_status <> 'cancelled'`).bind(prescriptionId),
      );
    }
    statements.push(prepareTransactionalEmailEnqueueStatement(db, {
      profileId: prescription.customerProfileId,
      eventType: "prescription_reviewed",
      payload: { prescriptionNumber: prescription.prescriptionNumber,
        decision: decision as "approved" | "rejected" | "clarification_required" },
      dedupeKey: `prescription_reviewed:${prescriptionId}:${decision}`,
      whenPreviousStatementChanged: true,
    }));
    try {
      await db.batch(statements);
    } catch (error) {
      if (/prescription_already_reviewed/i.test(error instanceof Error ? error.message : "")) {
        return Response.json({ error: "This prescription was already reviewed. Refresh the queue." }, { status: 409 });
      }
      throw error;
    }
    await appendAuditEvent({ vendorId, actorProfileId: profile.id, action: `prescription.${decision}`, entityType: "prescription", entityId: prescriptionId, after: { decision, notes, medicines, pharmacistId: pharmacist.id }, requestId: request.headers.get("cf-ray") ?? "" });
    return Response.json({ reviewed: true, decision, pharmacist: pharmacist.fullName });
  } catch (error) {
    return errorResponse(error);
  }
}
