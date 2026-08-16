import { getD1 } from "../../../db/d1";
import { appendAuditEvent } from "../../../lib/audit";
import { errorResponse, requireLocalProfile } from "../../../lib/auth-server";
import { effectiveRefillStatus, validateRefillDate } from "../../../lib/refill-engine";
import { releaseExpiredReservations } from "../../../lib/inventory-reservations";
import { effectivePriceFallbackSql } from "../../../lib/effective-pricing";
import { privateJson } from "../../../lib/http-response";

type RefillRow = {
  id: number; medicineName: string; originalQuantity: number; daysSupply: number; dueDate: string;
  reminderLeadDays: number; status: string; snoozedUntil: string | null; scheduleSource: string;
  sourceOrderNumber: string; vendorId: number; businessName: string; productId: number;
  prescriptionRequired: number; currentInventoryId: number | null; currentPricePaise: number | null;
  availableQuantity: number | null; currentExpiryDate: string | null; repeatOrderId: number | null;
};

export async function GET(request: Request) {
  try {
    const { profile } = await requireLocalProfile(request, ["customer"]);
    const db = getD1();
    await releaseExpiredReservations(db);
    const rows = await db.prepare(`
      SELECT r.id, r.medicine_name AS medicineName, r.original_quantity AS originalQuantity,
        r.days_supply AS daysSupply, r.due_date AS dueDate, r.reminder_lead_days AS reminderLeadDays,
        r.status, r.snoozed_until AS snoozedUntil, r.schedule_source AS scheduleSource,
        source.order_number AS sourceOrderNumber, r.vendor_id AS vendorId, v.business_name AS businessName,
        r.product_id AS productId, p.prescription_required AS prescriptionRequired,
        current.id AS currentInventoryId, ${effectivePriceFallbackSql("current", "sale_price_paise")} AS currentPricePaise,
        (current.quantity - current.reserved_quantity) AS availableQuantity,
        current.expiry_date AS currentExpiryDate, r.repeat_order_id AS repeatOrderId
      FROM refill_reminders r
      JOIN orders source ON source.id = r.source_order_id
      JOIN vendors v ON v.id = r.vendor_id
      JOIN products p ON p.id = r.product_id
      LEFT JOIN pharmacy_inventory current ON current.id = (
        SELECT i.id FROM pharmacy_inventory i
        WHERE i.vendor_id = r.vendor_id AND i.product_id = r.product_id AND i.active = 1
          AND i.quarantine_status = 'available' AND i.expiry_date IS NOT NULL
          AND date(i.expiry_date) >= date('now') AND (i.quantity - i.reserved_quantity) > 0
        ORDER BY date(i.expiry_date), i.id LIMIT 1
      )
      WHERE r.customer_profile_id = ?
      ORDER BY CASE r.status WHEN 'completed' THEN 2 WHEN 'cancelled' THEN 3 ELSE 1 END,
        date(COALESCE(r.snoozed_until, r.due_date)), r.id DESC
      LIMIT 100
    `).bind(profile.id).all<RefillRow>();
    return privateJson({ reminders: rows.results.map((row) => ({ ...row, effectiveStatus: effectiveRefillStatus(row) })) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const { profile } = await requireLocalProfile(request, ["customer"]);
    const body = await request.json() as Record<string, unknown>;
    const id = Number(body.id);
    const action = String(body.action ?? "");
    if (!Number.isInteger(id) || id < 1 || !["confirm", "snooze", "cancel"].includes(action)) {
      return privateJson({ error: "Refill reminder action is invalid" }, { status: 400 });
    }
    const db = getD1();
    const existing = await db.prepare(`SELECT id, vendor_id AS vendorId, status FROM refill_reminders
      WHERE id = ? AND customer_profile_id = ? LIMIT 1`).bind(id, profile.id).first<{ id: number; vendorId: number; status: string }>();
    if (!existing) return privateJson({ error: "Refill reminder not found" }, { status: 404 });
    if (["completed", "cancelled"].includes(existing.status)) return privateJson({ error: "This reminder is already closed" }, { status: 409 });

    if (action === "cancel") {
      await db.prepare(`UPDATE refill_reminders SET status = 'cancelled', snoozed_until = NULL,
        updated_at = CURRENT_TIMESTAMP WHERE id = ? AND customer_profile_id = ?`).bind(id, profile.id).run();
    } else if (action === "snooze") {
      const snoozedUntil = validateRefillDate(body.date);
      await db.prepare(`UPDATE refill_reminders SET status = 'snoozed', snoozed_until = ?,
        updated_at = CURRENT_TIMESTAMP WHERE id = ? AND customer_profile_id = ?`).bind(snoozedUntil, id, profile.id).run();
    } else {
      const dueDate = validateRefillDate(body.date);
      const daysSupply = Number(body.daysSupply);
      if (!Number.isInteger(daysSupply) || daysSupply < 1 || daysSupply > 365) return privateJson({ error: "Days supply must be between 1 and 365" }, { status: 400 });
      await db.prepare(`UPDATE refill_reminders SET status = 'active', due_date = ?, days_supply = ?,
        schedule_source = 'customer_confirmed', snoozed_until = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND customer_profile_id = ?`).bind(dueDate, daysSupply, id, profile.id).run();
    }
    await appendAuditEvent({ vendorId: existing.vendorId, actorProfileId: profile.id, action: `refill.${action}`, entityType: "refill_reminder", entityId: id, after: { date: body.date ?? null, daysSupply: body.daysSupply ?? null }, requestId: request.headers.get("cf-ray") ?? "" });
    return privateJson({ updated: true });
  } catch (error) {
    if (error instanceof Error && /reminder date|one year/i.test(error.message)) return privateJson({ error: error.message }, { status: 400 });
    return errorResponse(error);
  }
}
