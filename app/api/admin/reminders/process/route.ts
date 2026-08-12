import { getD1 } from "../../../../../db/d1";
import { requireAdminProfile } from "../../../../../lib/admin-access";
import { appendAuditEvent } from "../../../../../lib/audit";
import { errorResponse, type LocalProfile } from "../../../../../lib/auth-server";
import { sendTransactionalEmail } from "../../../../../lib/resend";

async function authorize(request: Request): Promise<LocalProfile | null> {
  const configuredSecret = process.env.REMINDER_JOB_SECRET ?? "";
  const suppliedSecret = request.headers.get("x-urmed-job-secret") ?? "";
  if (configuredSecret && suppliedSecret === configuredSecret) return null;
  return requireAdminProfile(request);
}

type DueRefill={id:number;profileId:number;email:string;medicineName:string;dueDate:string;vendorId:number};
type DuePill={id:number;profileId:number;email:string;medicineName:string;reminderTime:string;dosageInstructions:string};
const recurrenceDue=`(p.recurrence_rule='daily'
  OR (p.recurrence_rule='weekdays' AND CAST(strftime('%w','now') AS INTEGER) BETWEEN 1 AND 5)
  OR (p.recurrence_rule='weekly' AND strftime('%w',p.start_date)=strftime('%w','now')))`;
function html(value:string){return value.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;");}

export async function GET(request:Request){
  try{
    await authorize(request);const db=getD1();
    const status=await db.prepare(`SELECT
      (SELECT COUNT(*) FROM refill_reminders r WHERE r.status IN ('active','snoozed')
        AND date(COALESCE(r.snoozed_until,r.due_date),'-'||r.reminder_lead_days||' day')<=date('now')
        AND (r.last_notified_at IS NULL OR date(r.last_notified_at)<date('now'))) AS dueRefills,
      (SELECT COUNT(*) FROM pill_reminders p WHERE p.active=1 AND date(p.start_date)<=date('now')
        AND (p.end_date IS NULL OR date(p.end_date)>=date('now'))
        AND ${recurrenceDue}
        AND NOT EXISTS(SELECT 1 FROM notifications n WHERE n.reference_type='pill_reminder' AND n.reference_id=p.id AND date(n.created_at)=date('now'))) AS duePills`).first();
    return Response.json({status});
  }catch(error){return errorResponse(error);}
}

export async function POST(request:Request){
  try{
    const actor=await authorize(request);const db=getD1();
    const consent=`EXISTS (SELECT 1 FROM data_consents consent WHERE consent.profile_id=profile.id
      AND consent.purpose='health_reminders' AND consent.id=(SELECT MAX(latest.id) FROM data_consents latest
        WHERE latest.profile_id=profile.id AND latest.purpose='health_reminders') AND consent.consent_status='granted')`;
    const [refills,pills]=await Promise.all([
      db.prepare(`SELECT r.id,profile.id AS profileId,profile.email,r.medicine_name AS medicineName,
        COALESCE(r.snoozed_until,r.due_date) AS dueDate,r.vendor_id AS vendorId FROM refill_reminders r
        JOIN account_profiles profile ON profile.id=r.customer_profile_id
        WHERE r.status IN ('active','snoozed') AND date(COALESCE(r.snoozed_until,r.due_date),'-'||r.reminder_lead_days||' day')<=date('now')
          AND (r.last_notified_at IS NULL OR date(r.last_notified_at)<date('now')) AND ${consent}
        ORDER BY date(COALESCE(r.snoozed_until,r.due_date)),r.id LIMIT 100`).all<DueRefill>(),
      db.prepare(`SELECT p.id,profile.id AS profileId,profile.email,p.medicine_name AS medicineName,
        p.reminder_time AS reminderTime,p.dosage_instructions AS dosageInstructions FROM pill_reminders p
        JOIN account_profiles profile ON profile.id=p.customer_profile_id
        WHERE p.active=1 AND date(p.start_date)<=date('now') AND (p.end_date IS NULL OR date(p.end_date)>=date('now'))
          AND ${recurrenceDue} AND ${consent} AND NOT EXISTS(SELECT 1 FROM notifications n WHERE n.reference_type='pill_reminder'
            AND n.reference_id=p.id AND date(n.created_at)=date('now')) ORDER BY p.reminder_time,p.id LIMIT 100`).all<DuePill>(),
    ]);
    let processedRefills=0,processedPills=0;
    for(const row of refills.results){
      const results=await db.batch([
        db.prepare(`INSERT INTO notifications (profile_id,vendor_id,notification_type,severity,title,message,reference_type,reference_id)
          SELECT ?,?,'refill_due','info','Medicine refill reminder',?,'refill_reminder',? WHERE EXISTS
            (SELECT 1 FROM refill_reminders WHERE id=? AND (last_notified_at IS NULL OR date(last_notified_at)<date('now')))`)
          .bind(row.profileId,row.vendorId,`${row.medicineName} is due for refill on ${row.dueDate}. Review current stock and prescription requirements before ordering.`,row.id,row.id),
        db.prepare(`UPDATE refill_reminders SET last_notified_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND (last_notified_at IS NULL OR date(last_notified_at)<date('now'))`).bind(row.id),
      ]);
      if(!results[0]?.meta.changes)continue;
      processedRefills++;
      await sendTransactionalEmail(row.email,`URMED refill reminder: ${row.medicineName}`,`<h2>Refill reminder</h2><p>${html(row.medicineName)} is due for refill on ${html(row.dueDate)}.</p><p>Open URMED to review stock, current price and prescription requirements before ordering.</p>`);
    }
    for(const row of pills.results){
      const inserted=await db.prepare(`INSERT INTO notifications (profile_id,notification_type,severity,title,message,reference_type,reference_id)
        SELECT ?,'pill_due','info','Medicine reminder',?,'pill_reminder',? WHERE NOT EXISTS
          (SELECT 1 FROM notifications WHERE profile_id=? AND reference_type='pill_reminder' AND reference_id=? AND date(created_at)=date('now'))`)
        .bind(row.profileId,`${row.medicineName} at ${row.reminderTime}. ${row.dosageInstructions}`.trim(),row.id,row.profileId,row.id).run();
      if(!inserted.meta.changes)continue;
      processedPills++;
      await sendTransactionalEmail(row.email,`URMED medicine reminder: ${row.medicineName}`,`<h2>Medicine reminder</h2><p>${html(row.medicineName)} at ${html(row.reminderTime)}.</p><p>${html(row.dosageInstructions)}</p>`);
    }
    await appendAuditEvent({actorProfileId:actor?.id??null,action:"reminders.processed",entityType:"notification_batch",entityId:new Date().toISOString(),after:{refills:processedRefills,pills:processedPills},requestId:request.headers.get("cf-ray")??""});
    return Response.json({processed:{refills:processedRefills,pills:processedPills,total:processedRefills+processedPills}});
  }catch(error){return errorResponse(error);}
}
