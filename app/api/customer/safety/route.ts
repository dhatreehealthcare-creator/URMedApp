import { getD1 } from "../../../../db/d1";
import { appendAuditEvent } from "../../../../lib/audit";
import { errorResponse, requireLocalProfile } from "../../../../lib/auth-server";
import { sha256 } from "../../../../lib/test-auth";
import { isStrictIsoDate } from "../../../../lib/date-controls";

const purposes = new Set(["order_fulfilment", "prescription_processing", "health_reminders", "marketing"]);
const privateResponseHeaders = { "Cache-Control": "private, no-store" };

function dateValue(value: unknown, optional = false) {
  const text = String(value ?? "").trim();
  if (optional && !text) return null;
  if (!isStrictIsoDate(text)) throw new Error("Enter a valid date");
  return text;
}

export async function GET(request: Request) {
  try {
    const { profile } = await requireLocalProfile(request, ["customer"]);
    const db = getD1();
    const [reminders, consents, notifications] = await Promise.all([
      db.prepare(`SELECT id, medicine_name AS medicineName, dosage_instructions AS dosageInstructions,
        reminder_time AS reminderTime, start_date AS startDate, end_date AS endDate,
        recurrence_rule AS recurrenceRule, active, created_at AS createdAt
        FROM pill_reminders WHERE customer_profile_id = ? ORDER BY active DESC, reminder_time, id DESC LIMIT 100`).bind(profile.id).all(),
      db.prepare(`SELECT purpose, policy_version AS policyVersion, consent_status AS consentStatus,
        granted_at AS grantedAt, withdrawn_at AS withdrawnAt, created_at AS createdAt
        FROM data_consents WHERE profile_id = ? AND id IN (
          SELECT MAX(id) FROM data_consents WHERE profile_id = ? GROUP BY purpose
        ) ORDER BY purpose`).bind(profile.id, profile.id).all(),
      db.prepare(`SELECT id,notification_type AS notificationType,severity,title,message,reference_type AS referenceType,
        reference_id AS referenceId,read_at AS readAt,created_at AS createdAt FROM notifications
        WHERE profile_id=? ORDER BY CASE WHEN read_at IS NULL THEN 0 ELSE 1 END,id DESC LIMIT 100`).bind(profile.id).all(),
    ]);
    return Response.json({ reminders: reminders.results, consents: consents.results, notifications: notifications.results, policyVersion: "URMED-DPDP-2026.1" }, { headers: privateResponseHeaders });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const { profile } = await requireLocalProfile(request, ["customer"]);
    const body = await request.json() as Record<string, unknown>;
    const action = String(body.action ?? "");
    const db = getD1();
    if (action === "create_reminder") {
      const medicineName = String(body.medicineName ?? "").trim().slice(0, 160);
      const dosage = String(body.dosageInstructions ?? "").trim().slice(0, 300);
      const reminderTime = String(body.reminderTime ?? "").trim();
      const startDate = dateValue(body.startDate)!;
      const endDate = dateValue(body.endDate, true);
      const recurrenceRule = String(body.recurrenceRule ?? "daily");
      if (!medicineName || !/^([01]\d|2[0-3]):[0-5]\d$/.test(reminderTime)) return Response.json({ error: "Medicine and a valid reminder time are required" }, { status: 400 });
      if (!new Set(["daily", "weekdays", "weekly"]).has(recurrenceRule)) return Response.json({ error: "Reminder recurrence is invalid" }, { status: 400 });
      if (endDate && endDate < startDate) return Response.json({ error: "End date cannot be before start date" }, { status: 400 });
      const result = await db.prepare(`INSERT INTO pill_reminders (customer_profile_id, medicine_name,
        dosage_instructions, reminder_time, start_date, end_date, recurrence_rule, active)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1)`).bind(profile.id, medicineName, dosage, reminderTime, startDate, endDate, recurrenceRule).run();
      await appendAuditEvent({ actorProfileId: profile.id, action: "pill_reminder.created", entityType: "pill_reminder", entityId: Number(result.meta.last_row_id), after: { medicineName, reminderTime, startDate, endDate, recurrenceRule }, requestId: request.headers.get("cf-ray") ?? "" });
      return Response.json({ created: true }, { status: 201, headers: privateResponseHeaders });
    }
    if (action === "toggle_reminder") {
      const id = Number(body.id); const active = body.active ? 1 : 0;
      const result = await db.prepare("UPDATE pill_reminders SET active = ? WHERE id = ? AND customer_profile_id = ?").bind(active, id, profile.id).run();
      if (!result.meta.changes) return Response.json({ error: "Reminder not found" }, { status: 404 });
      await appendAuditEvent({ actorProfileId: profile.id, action: active ? "pill_reminder.enabled" : "pill_reminder.disabled", entityType: "pill_reminder", entityId: id, after: { active: Boolean(active) }, requestId: request.headers.get("cf-ray") ?? "" });
      return Response.json({ updated: true }, { headers: privateResponseHeaders });
    }
    if (action === "consent") {
      const purpose = String(body.purpose ?? ""); const granted = Boolean(body.granted);
      if (!purposes.has(purpose)) return Response.json({ error: "Consent purpose is invalid" }, { status: 400 });
      const ipHash = await sha256(request.headers.get("cf-connecting-ip") ?? "unavailable");
      await db.prepare(`INSERT INTO data_consents (profile_id, purpose, policy_version, consent_status,
        captured_ip_hash, granted_at, withdrawn_at) VALUES (?, ?, 'URMED-DPDP-2026.1', ?, ?,
        CASE WHEN ? THEN CURRENT_TIMESTAMP END, CASE WHEN ? THEN NULL ELSE CURRENT_TIMESTAMP END)`)
        .bind(profile.id, purpose, granted ? "granted" : "withdrawn", ipHash, granted ? 1 : 0, granted ? 1 : 0).run();
      await appendAuditEvent({ actorProfileId: profile.id, action: granted ? "consent.granted" : "consent.withdrawn", entityType: "data_consent", entityId: purpose, after: { purpose, granted, policyVersion: "URMED-DPDP-2026.1" }, requestId: request.headers.get("cf-ray") ?? "" });
      return Response.json({ updated: true }, { headers: privateResponseHeaders });
    }
    if(action==="read_notification"){
      const id=Number(body.id);if(!Number.isInteger(id))return Response.json({error:"Notification is invalid"},{status:400});
      const result=await db.prepare(`UPDATE notifications SET read_at=COALESCE(read_at,CURRENT_TIMESTAMP) WHERE id=? AND profile_id=?`).bind(id,profile.id).run();
      if(!result.meta.changes)return Response.json({error:"Notification not found"},{status:404});
      return Response.json({updated:true}, { headers: privateResponseHeaders });
    }
    return Response.json({ error: "Safety action is invalid" }, { status: 400 });
  } catch (error) {
    if (error instanceof Error && /valid date/i.test(error.message)) return Response.json({ error: error.message }, { status: 400 });
    return errorResponse(error);
  }
}
