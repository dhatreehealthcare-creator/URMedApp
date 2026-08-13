import { appendAuditEvent } from "./audit.ts";
import { REMINDER_PROCESSING_CRON } from "./scheduled-job-config.ts";
import { prepareTransactionalEmailEnqueueStatement } from "./transactional-email-outbox.ts";

export { REMINDER_PROCESSING_CRON };
export const REMINDER_DEFAULT_TIME_ZONE = "Asia/Kolkata";

type DueRefill = {
  id: number;
  profileId: number;
  email: string;
  medicineName: string;
  dueDate: string;
  vendorId: number;
  inAppEnabled: number;
  emailEnabled: number;
  timeZone: string;
  localDate: string;
  localTime: string;
  lastNotifiedAt: string | null;
};

type DuePill = {
  id: number;
  profileId: number;
  email: string;
  medicineName: string;
  reminderTime: string;
  dosageInstructions: string;
  startDate: string;
  endDate: string | null;
  recurrenceRule: string;
  inAppEnabled: number;
  emailEnabled: number;
  timeZone: string;
  localDate: string;
  localTime: string;
  lastNotificationDate: string | null;
  lastEmailLocalDate: string | null;
};

export type ReminderProcessingWindow = {
  localDate: string;
  localTime: string;
  timeZone: string;
};

export type ReminderProcessingResult = {
  window: ReminderProcessingWindow;
  processed: { refills: number; pills: number; total: number };
  email: { queued: number; sent: number; unavailableOrFailed: number; notEnabled: number };
};

export type ProcessRemindersInput = {
  db: D1Database;
  now?: Date | number | string;
  actorProfileId?: number | null;
  requestId?: string;
  limit?: number;
  timeZone?: string;
  /** @deprecated Email delivery is now handled by the transactional outbox worker. */
  sendEmail?: (to: string, subject: string, html: string) => Promise<{ sent: boolean; reason?: string }>;
  appendAudit?: boolean;
};

const consentPredicate = `EXISTS (SELECT 1 FROM data_consents consent
  WHERE consent.profile_id=profile.id AND consent.purpose='health_reminders'
    AND consent.id=(SELECT MAX(latest.id) FROM data_consents latest
      WHERE latest.profile_id=profile.id AND latest.purpose='health_reminders')
    AND consent.consent_status='granted')`;

function asDate(value: Date | number | string | undefined) {
  const date = value === undefined ? new Date() : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Reminder processing time is invalid");
  return date;
}

function dateShift(value: string, days: number) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function safeProfileWindow(now: Date | number | string | undefined, timeZone: string) {
  try {
    return reminderProcessingWindow(now, timeZone);
  } catch {
    return reminderProcessingWindow(now, REMINDER_DEFAULT_TIME_ZONE);
  }
}

function recurrenceDue(row: Pick<DuePill, "recurrenceRule" | "startDate">, localDate: string) {
  if (row.recurrenceRule === "daily") return true;
  const weekday = new Date(`${localDate}T00:00:00.000Z`).getUTCDay();
  if (row.recurrenceRule === "weekdays") return weekday >= 1 && weekday <= 5;
  return row.recurrenceRule === "weekly"
    && weekday === new Date(`${row.startDate}T00:00:00.000Z`).getUTCDay();
}

async function dueReminderRows(input: Pick<ProcessRemindersInput, "db" | "now" | "timeZone" | "limit">) {
  const candidateLimit = Math.min(2000, Math.max(4, Math.trunc(input.limit ?? 100) * 4));
  const fallbackTimeZone = input.timeZone ?? REMINDER_DEFAULT_TIME_ZONE;
  const [refillCandidates, pillCandidates] = await Promise.all([
    input.db.prepare(`SELECT r.id,profile.id AS profileId,profile.email,r.medicine_name AS medicineName,
      COALESCE(r.snoozed_until,r.due_date) AS dueDate,r.vendor_id AS vendorId,r.reminder_lead_days AS reminderLeadDays,
      r.last_notified_at AS lastNotifiedAt,
      COALESCE(preference.in_app_enabled,0) AS inAppEnabled,
      CASE WHEN profile.email_verified=1 AND COALESCE(preference.email_enabled,0)=1 THEN 1 ELSE 0 END AS emailEnabled,
      COALESCE(preference.time_zone,?) AS timeZone
      FROM refill_reminders r JOIN account_profiles profile ON profile.id=r.customer_profile_id
      LEFT JOIN notification_preferences preference ON preference.profile_id=profile.id AND preference.category='reminder'
      WHERE profile.status='active' AND r.status IN ('active','snoozed') AND ${consentPredicate}
        AND (COALESCE(preference.in_app_enabled,0)=1
          OR (profile.email_verified=1 AND COALESCE(preference.email_enabled,0)=1))
      ORDER BY date(COALESCE(r.snoozed_until,r.due_date)),r.id LIMIT ?`)
      .bind(fallbackTimeZone, candidateLimit).all<Omit<DueRefill, "localDate" | "localTime"> & { reminderLeadDays: number }>(),
    input.db.prepare(`SELECT p.id,profile.id AS profileId,profile.email,p.medicine_name AS medicineName,
      p.reminder_time AS reminderTime,p.dosage_instructions AS dosageInstructions,
      p.start_date AS startDate,p.end_date AS endDate,p.recurrence_rule AS recurrenceRule,
      COALESCE(preference.in_app_enabled,0) AS inAppEnabled,
      CASE WHEN profile.email_verified=1 AND COALESCE(preference.email_enabled,0)=1 THEN 1 ELSE 0 END AS emailEnabled,
      COALESCE(preference.time_zone,?) AS timeZone,
      (SELECT MAX(date(n.created_at)) FROM notifications n WHERE n.profile_id=profile.id
        AND n.reference_type='pill_reminder' AND n.reference_id=p.id) AS lastNotificationDate,
      (SELECT MAX(substr(event.entity_id,-10)) FROM audit_events event
        WHERE event.actor_profile_id=profile.id AND event.action='reminder.email_sent'
          AND event.entity_type='pill_reminder' AND event.entity_id LIKE CAST(p.id AS TEXT)||':%') AS lastEmailLocalDate
      FROM pill_reminders p JOIN account_profiles profile ON profile.id=p.customer_profile_id
      LEFT JOIN notification_preferences preference ON preference.profile_id=profile.id AND preference.category='reminder'
      WHERE profile.status='active' AND p.active=1 AND ${consentPredicate}
        AND (COALESCE(preference.in_app_enabled,0)=1
          OR (profile.email_verified=1 AND COALESCE(preference.email_enabled,0)=1))
      ORDER BY p.reminder_time,p.id LIMIT ?`)
      .bind(fallbackTimeZone, candidateLimit).all<Omit<DuePill, "localDate" | "localTime">>(),
  ]);
  const refills: DueRefill[] = [];
  for (const row of refillCandidates.results) {
    const window = safeProfileWindow(input.now, row.timeZone);
    if (dateShift(row.dueDate, -Number(row.reminderLeadDays)) > window.localDate) continue;
    if (row.lastNotifiedAt && row.lastNotifiedAt.slice(0, 10) >= window.localDate) continue;
    refills.push({ ...row, localDate: window.localDate, localTime: window.localTime });
  }
  const pills: DuePill[] = [];
  for (const row of pillCandidates.results) {
    const window = safeProfileWindow(input.now, row.timeZone);
    if (row.startDate > window.localDate || (row.endDate && row.endDate < window.localDate)) continue;
    if (row.reminderTime > window.localTime || !recurrenceDue(row, window.localDate)) continue;
    if ((row.lastNotificationDate && row.lastNotificationDate >= window.localDate)
      || (row.lastEmailLocalDate && row.lastEmailLocalDate >= window.localDate)) continue;
    pills.push({ ...row, localDate: window.localDate, localTime: window.localTime });
  }
  const limit = Math.min(500, Math.max(1, Math.trunc(input.limit ?? 100)));
  return { refills: refills.slice(0, limit), pills: pills.slice(0, limit) };
}

export function reminderProcessingWindow(
  now?: Date | number | string,
  timeZone = REMINDER_DEFAULT_TIME_ZONE,
): ReminderProcessingWindow {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(asDate(now));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const localDate = `${value("year")}-${value("month")}-${value("day")}`;
  const localTime = `${value("hour")}:${value("minute")}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate) || !/^\d{2}:\d{2}$/.test(localTime)) {
    throw new Error("Reminder processing window could not be determined");
  }
  return { localDate, localTime, timeZone };
}

export async function getDueReminderCounts(input: Pick<ProcessRemindersInput, "db" | "now" | "timeZone">) {
  const window = reminderProcessingWindow(input.now, input.timeZone);
  const due = await dueReminderRows({ ...input, limit: 500 });
  return {
    window,
    status: {
      dueRefills: due.refills.length,
      duePills: due.pills.length,
    },
  };
}

export async function processDueReminders(input: ProcessRemindersInput): Promise<ReminderProcessingResult> {
  const window = reminderProcessingWindow(input.now, input.timeZone);
  const limit = Math.min(500, Math.max(1, Math.trunc(input.limit ?? 100)));
  const { refills, pills } = await dueReminderRows({ ...input, limit });
  let processedRefills = 0;
  let processedPills = 0;
  let emailsQueued = 0;
  let emailsSent = 0;
  let emailsUnavailableOrFailed = 0;
  let emailsNotEnabled = 0;
  for (const row of refills) {
    const statements: D1PreparedStatement[] = [
      input.db.prepare(`INSERT INTO notifications
        (profile_id,vendor_id,notification_type,severity,title,message,reference_type,reference_id,created_at)
        SELECT ?,?,'refill_due','info','Medicine refill reminder',?,'refill_reminder',?,?
        WHERE ?=1 AND EXISTS (SELECT 1 FROM refill_reminders WHERE id=?
          AND (last_notified_at IS NULL OR date(last_notified_at)<date(?)))`)
        .bind(row.profileId, row.vendorId,
          `${row.medicineName} is due for refill on ${row.dueDate}. Review current stock and prescription requirements before ordering.`,
          row.id, `${row.localDate}T${row.localTime}:00`, row.inAppEnabled, row.id, row.localDate),
      input.db.prepare(`UPDATE refill_reminders SET last_notified_at=?,updated_at=? WHERE id=?
        AND (last_notified_at IS NULL OR date(last_notified_at)<date(?))`)
        .bind(`${row.localDate}T${row.localTime}:00`, `${row.localDate}T${row.localTime}:00`, row.id, row.localDate),
    ];
    if (row.emailEnabled) {
      statements.push(prepareTransactionalEmailEnqueueStatement(input.db, {
        profileId: row.profileId,
        eventType: "refill_due",
        payload: { medicineName: row.medicineName, dueDate: row.dueDate },
        dedupeKey: `refill_due:${row.id}:${row.localDate}`,
        whenPreviousStatementChanged: true,
      }));
    }
    const results = await input.db.batch(statements);
    if (!Number(results[1]?.meta.changes ?? 0)) continue;
    processedRefills++;
    if (!row.emailEnabled) { emailsNotEnabled++; continue; }
    emailsQueued++;
  }
  for (const row of pills) {
    const statements: D1PreparedStatement[] = [];
    if (row.inAppEnabled) {
      statements.push(input.db.prepare(`INSERT INTO notifications
        (profile_id,notification_type,severity,title,message,reference_type,reference_id,created_at)
        SELECT ?,'pill_due','info','Medicine reminder',?,'pill_reminder',?,?
        WHERE NOT EXISTS (SELECT 1 FROM notifications WHERE profile_id=? AND reference_type='pill_reminder'
          AND reference_id=? AND date(created_at)=date(?))`)
        .bind(row.profileId, `${row.medicineName} at ${row.reminderTime}. ${row.dosageInstructions}`.trim(),
          row.id, `${row.localDate}T${row.localTime}:00`, row.profileId, row.id, row.localDate));
    }
    if (row.emailEnabled) {
      statements.push(prepareTransactionalEmailEnqueueStatement(input.db, {
        profileId: row.profileId,
        eventType: "pill_due",
        payload: { medicineName: row.medicineName, reminderTime: row.reminderTime, dosageInstructions: row.dosageInstructions },
        dedupeKey: `pill_due:${row.id}:${row.localDate}`,
        whenPreviousStatementChanged: true,
      }));
    }
    const results = statements.length ? await input.db.batch(statements) : [];
    if (!results.some((result) => Number(result?.meta.changes ?? 0) > 0)) continue;
    processedPills++;
    if (!row.emailEnabled) { emailsNotEnabled++; continue; }
    emailsQueued++;
  }
  const result: ReminderProcessingResult = {
    window,
    processed: {
      refills: processedRefills,
      pills: processedPills,
      total: processedRefills + processedPills,
    },
    email: { queued: emailsQueued, sent: emailsSent, unavailableOrFailed: emailsUnavailableOrFailed, notEnabled: emailsNotEnabled },
  };
  if (input.appendAudit !== false && result.processed.total > 0) {
    await appendAuditEvent({
      actorProfileId: input.actorProfileId ?? null,
      action: "reminders.processed",
      entityType: "notification_batch",
      entityId: `reminders:${window.localDate}T${window.localTime}`,
      after: result,
      requestId: input.requestId ?? "",
    }, input.db);
  }
  return result;
}
