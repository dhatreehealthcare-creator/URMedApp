import { prepareAuditEventStatement } from "./audit.ts";
import { emailChannelEligibility, type NotificationCategory } from "./notification-preferences.ts";
import { sendTransactionalEmail, type TransactionalEmailSendResult } from "./resend.ts";
import { TRANSACTIONAL_EMAIL_OUTBOX_CRON } from "./scheduled-job-config.ts";

export { TRANSACTIONAL_EMAIL_OUTBOX_CRON };
export const EMAIL_OUTBOX_POLICY_VERSION = "URMED-EMAIL-OUTBOX-2026.1";

const eventCategory = {
  order_placed: "transactional",
  order_status_changed: "transactional",
  prescription_reviewed: "safety",
  refill_due: "reminder",
  pill_due: "reminder",
} as const satisfies Record<string, NotificationCategory>;

export type TransactionalEmailEventType = keyof typeof eventCategory;
export type TransactionalEmailPayload = {
  order_placed: { orderNumber: string; totalPaise: number; taxPaise: number };
  order_status_changed: { orderNumber: string; status: string; refillCreated: boolean };
  prescription_reviewed: { prescriptionNumber: string; decision: "approved" | "rejected" | "clarification_required" };
  refill_due: { medicineName: string; dueDate: string };
  pill_due: { medicineName: string; reminderTime: string; dosageInstructions: string };
};

type EnqueueInput<T extends TransactionalEmailEventType = TransactionalEmailEventType> = {
  profileId: number;
  eventType: T;
  payload: TransactionalEmailPayload[T];
  dedupeKey: string;
  now?: Date | number | string;
  maxAttempts?: number;
  whenPreviousStatementChanged?: boolean;
};

type OutboxRow = {
  id: number;
  profileId: number;
  recipientEmail: string;
  category: NotificationCategory;
  eventType: TransactionalEmailEventType;
  payloadJson: string;
  dedupeKey: string;
  status: string;
  attemptCount: number;
  maxAttempts: number;
};

type Sender = (
  to: string,
  subject: string,
  html: string,
  options: { idempotencyKey: string },
) => Promise<TransactionalEmailSendResult>;

export type EmailOutboxProcessingResult = {
  policyVersion: string;
  leaseOwner: string;
  recoveredLeases: number;
  claimed: number;
  sent: number;
  retryWaiting: number;
  deadLettered: number;
  cancelled: number;
  remainingDue: number;
};

export class TransactionalEmailOutboxError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "TransactionalEmailOutboxError";
    this.status = status;
  }
}

function asDate(value: Date | number | string | undefined) {
  const date = value === undefined ? new Date() : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TransactionalEmailOutboxError("Outbox processing time is invalid");
  return date;
}

function text(value: unknown, maximum: number, label: string) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > maximum) throw new TransactionalEmailOutboxError(`${label} is invalid`);
  return normalized;
}

function integer(value: unknown, maximum: number, label: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) throw new TransactionalEmailOutboxError(`${label} is invalid`);
  return parsed;
}

function canonicalPayload<T extends TransactionalEmailEventType>(eventType: T, value: TransactionalEmailPayload[T]) {
  const payload = value as Record<string, unknown>;
  if (eventType === "order_placed") return {
    orderNumber: text(payload.orderNumber, 80, "Order number"),
    totalPaise: integer(payload.totalPaise, 100_000_000, "Order total"),
    taxPaise: integer(payload.taxPaise, 100_000_000, "Order tax"),
  };
  if (eventType === "order_status_changed") return {
    orderNumber: text(payload.orderNumber, 80, "Order number"),
    status: text(payload.status, 60, "Order status"),
    refillCreated: payload.refillCreated === true,
  };
  if (eventType === "prescription_reviewed") {
    const decision = String(payload.decision ?? "");
    if (!["approved", "rejected", "clarification_required"].includes(decision)) {
      throw new TransactionalEmailOutboxError("Prescription decision is invalid");
    }
    return { prescriptionNumber: text(payload.prescriptionNumber, 80, "Prescription number"), decision };
  }
  if (eventType === "refill_due") return {
    medicineName: text(payload.medicineName, 180, "Medicine name"),
    dueDate: text(payload.dueDate, 10, "Refill date"),
  };
  return {
    medicineName: text(payload.medicineName, 180, "Medicine name"),
    reminderTime: text(payload.reminderTime, 5, "Reminder time"),
    dosageInstructions: String(payload.dosageInstructions ?? "").trim().slice(0, 240),
  };
}

function canonicalDedupeKey(value: unknown) {
  const key = String(value ?? "").trim();
  if (key.length < 3 || key.length > 200 || !/^[A-Za-z0-9:._-]+$/.test(key)) {
    throw new TransactionalEmailOutboxError("Email deduplication key is invalid");
  }
  return key;
}

export function prepareTransactionalEmailEnqueueStatement<T extends TransactionalEmailEventType>(
  db: D1Database,
  input: EnqueueInput<T>,
) {
  const profileId = Number(input.profileId);
  if (!Number.isInteger(profileId) || profileId < 1) throw new TransactionalEmailOutboxError("Email profile is invalid");
  const category = eventCategory[input.eventType];
  if (!category) throw new TransactionalEmailOutboxError("Email event type is invalid");
  const payloadJson = JSON.stringify(canonicalPayload(input.eventType, input.payload));
  if (payloadJson.length > 4000) throw new TransactionalEmailOutboxError("Email payload is too large");
  const dedupeKey = canonicalDedupeKey(input.dedupeKey);
  const maxAttempts = Math.min(12, Math.max(1, Math.trunc(input.maxAttempts ?? 5)));
  const now = asDate(input.now).toISOString();
  const consentPurpose = category === "reminder" ? "health_reminders" : null;
  return db.prepare(`INSERT OR IGNORE INTO transactional_email_outbox
    (profile_id,recipient_email,category,event_type,payload_json,dedupe_key,status,attempt_count,max_attempts,next_attempt_at)
    SELECT profile.id,lower(trim(profile.email)),?,?,?,?,'queued',0,?,?
    FROM account_profiles profile JOIN notification_preferences preference
      ON preference.profile_id=profile.id AND preference.category=?
    WHERE profile.id=? AND profile.status='active' AND profile.email_verified=1
      AND preference.email_enabled=1 AND trim(profile.email)<>''
      AND (? IS NULL OR EXISTS(SELECT 1 FROM data_consents consent
        WHERE consent.profile_id=profile.id AND consent.purpose=?
          AND consent.id=(SELECT MAX(latest.id) FROM data_consents latest
            WHERE latest.profile_id=profile.id AND latest.purpose=?)
          AND consent.consent_status='granted'))
      ${input.whenPreviousStatementChanged ? "AND changes()=1" : ""}`)
    .bind(category, input.eventType, payloadJson, dedupeKey, maxAttempts, now,
      category, profileId, consentPurpose, consentPurpose, consentPurpose);
}

export async function enqueueTransactionalEmail<T extends TransactionalEmailEventType>(
  db: D1Database,
  input: EnqueueInput<T>,
) {
  const result = await prepareTransactionalEmailEnqueueStatement(db, input).run();
  return { queued: Number(result.meta.changes ?? 0) === 1 };
}

function html(value: unknown) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function renderEmail(row: OutboxRow) {
  const payload = canonicalPayload(row.eventType, JSON.parse(row.payloadJson) as TransactionalEmailPayload[typeof row.eventType]);
  if (row.eventType === "order_placed") {
    const value = payload as TransactionalEmailPayload["order_placed"];
    return { subject: `URMED order ${value.orderNumber} received`, html: `<h2>Order ${html(value.orderNumber)}</h2><p>Your order for ₹${(value.totalPaise / 100).toFixed(2)} including GST of ₹${(value.taxPaise / 100).toFixed(2)} has been received.</p>` };
  }
  if (row.eventType === "order_status_changed") {
    const value = payload as TransactionalEmailPayload["order_status_changed"];
    return { subject: `URMED order ${value.orderNumber}: ${value.status}`, html: `<h2>${html(value.status)}</h2><p>Your order ${html(value.orderNumber)} is now ${html(value.status.toLowerCase())}.</p>${value.refillCreated ? "<p>Estimated 30-day refill reminders were created. Review each date in your URMED account before reordering.</p>" : ""}` };
  }
  if (row.eventType === "prescription_reviewed") {
    const value = payload as TransactionalEmailPayload["prescription_reviewed"];
    const subject = value.decision === "approved" ? "approved" : value.decision === "rejected" ? "rejected" : "needs clarification";
    return { subject: `URMED prescription ${value.prescriptionNumber} ${subject}`, html: `<h2>Prescription ${html(subject)}</h2><p>Open your protected URMED account to review the pharmacist's decision and any next steps.</p>` };
  }
  if (row.eventType === "refill_due") {
    const value = payload as TransactionalEmailPayload["refill_due"];
    return { subject: `URMED refill reminder: ${value.medicineName}`, html: `<h2>Refill reminder</h2><p>${html(value.medicineName)} is due for refill on ${html(value.dueDate)}.</p><p>Open URMED to review stock, current price and prescription requirements before ordering.</p>` };
  }
  const value = payload as TransactionalEmailPayload["pill_due"];
  return { subject: `URMED medicine reminder: ${value.medicineName}`, html: `<h2>Medicine reminder</h2><p>${html(value.medicineName)} at ${html(value.reminderTime)}.</p><p>${html(value.dosageInstructions)}</p>` };
}

export function emailRetryDelayMilliseconds(attemptCount: number, random = Math.random) {
  const base = Math.min(60 * 60 * 1000, 30_000 * (2 ** Math.max(0, attemptCount - 1)));
  const jitter = 0.75 + Math.min(1, Math.max(0, random())) * 0.5;
  return Math.round(base * jitter);
}

function safeErrorCode(value: unknown) {
  const code = String(value ?? "delivery_failed").trim().toLowerCase().replace(/[^a-z0-9._-]/g, "_").slice(0, 80);
  return code || "delivery_failed";
}

export function redactEmailFailureReason(value: unknown) {
  return String(value ?? "Email provider request failed")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/\b(bearer|token|secret|api[_ -]?key)\b\s*[:=]?\s*\S+/gi, "$1=[redacted]")
    .replace(/[\r\n\t]+/g, " ").trim().slice(0, 240) || "Email provider request failed";
}

async function transitionClaimed(db: D1Database, row: OutboxRow, leaseOwner: string, input: {
  status: "sent" | "retry_wait" | "dead_letter" | "cancelled";
  now: string;
  providerMessageId?: string;
  errorCode?: string;
  errorReason?: string;
  nextAttemptAt?: string;
}) {
  const result = await db.prepare(`UPDATE transactional_email_outbox SET status=?,lease_owner='',lease_expires_at=NULL,
    provider_message_id=?,last_error_code=?,last_error_reason=?,next_attempt_at=?,
    sent_at=CASE WHEN ?='sent' THEN ? ELSE NULL END,
    dead_lettered_at=CASE WHEN ?='dead_letter' THEN ? ELSE NULL END,
    cancelled_at=CASE WHEN ?='cancelled' THEN ? ELSE NULL END,updated_at=?
    WHERE id=? AND status='processing' AND lease_owner=? AND attempt_count=?`)
    .bind(input.status, input.providerMessageId ?? "", input.errorCode ?? "", input.errorReason ?? "",
      input.nextAttemptAt ?? input.now, input.status, input.now, input.status, input.now,
      input.status, input.now, input.now, row.id, leaseOwner, row.attemptCount).run();
  return Number(result.meta.changes ?? 0) === 1;
}

export async function processTransactionalEmailOutbox(input: {
  db: D1Database;
  now?: Date | number | string;
  leaseOwner: string;
  limit?: number;
  leaseMilliseconds?: number;
  random?: () => number;
  sender?: Sender;
}): Promise<EmailOutboxProcessingResult> {
  const { db } = input;
  const nowDate = asDate(input.now);
  const now = nowDate.toISOString();
  const leaseOwner = text(input.leaseOwner, 160, "Outbox lease owner");
  const limit = Math.min(50, Math.max(1, Math.trunc(input.limit ?? 25)));
  const leaseMilliseconds = Math.min(15 * 60_000, Math.max(30_000, Math.trunc(input.leaseMilliseconds ?? 120_000)));
  const leaseExpiresAt = new Date(nowDate.getTime() + leaseMilliseconds).toISOString();
  const sender = input.sender ?? sendTransactionalEmail;
  const random = input.random ?? Math.random;
  const recovered = await db.prepare(`UPDATE transactional_email_outbox SET status='retry_wait',lease_owner='',lease_expires_at=NULL,
    last_error_code='lease_expired',last_error_reason='Previous delivery lease expired before completion',next_attempt_at=?,updated_at=?
    WHERE status='processing' AND lease_expires_at<=?`).bind(now, now, now).run();
  const candidates = await db.prepare(`SELECT id FROM transactional_email_outbox
    WHERE status IN ('queued','retry_wait') AND next_attempt_at<=?
    ORDER BY next_attempt_at,id LIMIT ?`).bind(now, limit).all<{ id: number }>();
  const summary: EmailOutboxProcessingResult = {
    policyVersion: EMAIL_OUTBOX_POLICY_VERSION,
    leaseOwner,
    recoveredLeases: Number(recovered.meta.changes ?? 0),
    claimed: 0,
    sent: 0,
    retryWaiting: 0,
    deadLettered: 0,
    cancelled: 0,
    remainingDue: 0,
  };
  for (const candidate of candidates.results) {
    const claimed = await db.prepare(`UPDATE transactional_email_outbox SET status='processing',
      attempt_count=attempt_count+1,lease_owner=?,lease_expires_at=?,last_error_code='',last_error_reason='',updated_at=?
      WHERE id=? AND status IN ('queued','retry_wait') AND next_attempt_at<=? AND attempt_count<max_attempts`)
      .bind(leaseOwner, leaseExpiresAt, now, candidate.id, now).run();
    if (Number(claimed.meta.changes ?? 0) !== 1) continue;
    summary.claimed++;
    const row = await db.prepare(`SELECT id,profile_id AS profileId,recipient_email AS recipientEmail,
      category,event_type AS eventType,payload_json AS payloadJson,dedupe_key AS dedupeKey,status,
      attempt_count AS attemptCount,max_attempts AS maxAttempts FROM transactional_email_outbox
      WHERE id=? AND status='processing' AND lease_owner=? LIMIT 1`).bind(candidate.id, leaseOwner).first<OutboxRow>();
    if (!row) continue;
    const [eligibility, profile] = await Promise.all([
      emailChannelEligibility(db, row.profileId, row.category),
      db.prepare(`SELECT lower(trim(email)) AS email FROM account_profiles WHERE id=? AND status='active' LIMIT 1`)
        .bind(row.profileId).first<{ email: string }>(),
    ]);
    if (!eligibility.email || profile?.email !== row.recipientEmail) {
      if (await transitionClaimed(db, row, leaseOwner, { status: "cancelled", now,
        errorCode: "recipient_ineligible", errorReason: "Recipient or channel is no longer eligible" })) summary.cancelled++;
      continue;
    }
    let rendered: { subject: string; html: string };
    try {
      rendered = renderEmail(row);
    } catch {
      if (await transitionClaimed(db, row, leaseOwner, { status: "dead_letter", now,
        errorCode: "invalid_payload", errorReason: "Stored email template payload is invalid" })) summary.deadLettered++;
      continue;
    }
    let delivery: TransactionalEmailSendResult;
    try {
      delivery = await sender(row.recipientEmail, rendered.subject, rendered.html, { idempotencyKey: row.dedupeKey });
    } catch (error) {
      delivery = { sent: false, retryable: true, code: "sender_exception", reason: error instanceof Error ? error.message : "Email sender failed" };
    }
    if (delivery.sent && delivery.providerMessageId) {
      if (await transitionClaimed(db, row, leaseOwner, { status: "sent", now,
        providerMessageId: delivery.providerMessageId.slice(0, 200) })) summary.sent++;
      continue;
    }
    const errorCode = safeErrorCode(delivery.code);
    const errorReason = redactEmailFailureReason(delivery.reason);
    const terminal = delivery.retryable === false || row.attemptCount >= row.maxAttempts;
    if (terminal) {
      if (await transitionClaimed(db, row, leaseOwner, { status: "dead_letter", now, errorCode, errorReason })) summary.deadLettered++;
    } else {
      const nextAttemptAt = new Date(nowDate.getTime() + emailRetryDelayMilliseconds(row.attemptCount, random)).toISOString();
      if (await transitionClaimed(db, row, leaseOwner, { status: "retry_wait", now, nextAttemptAt, errorCode, errorReason })) summary.retryWaiting++;
    }
  }
  const remaining = await db.prepare(`SELECT COUNT(*) AS count FROM transactional_email_outbox
    WHERE status IN ('queued','retry_wait') AND next_attempt_at<=?`).bind(now).first<{ count: number }>();
  summary.remainingDue = Number(remaining?.count ?? 0);
  return summary;
}

export async function listTransactionalEmailOutbox(db: D1Database, status?: string) {
  const allowed = new Set(["queued", "processing", "sent", "retry_wait", "dead_letter", "cancelled"]);
  const filter = status && allowed.has(status) ? status : "";
  const [counts, rows] = await Promise.all([
    db.prepare(`SELECT status,COUNT(*) AS count FROM transactional_email_outbox GROUP BY status`).all<{ status: string; count: number }>(),
    db.prepare(`SELECT id,profile_id AS profileId,category,event_type AS eventType,status,attempt_count AS attemptCount,
      max_attempts AS maxAttempts,next_attempt_at AS nextAttemptAt,last_error_code AS lastErrorCode,
      last_error_reason AS lastErrorReason,provider_message_id AS providerMessageId,created_at AS createdAt,updated_at AS updatedAt,
      substr(recipient_email,1,1)||'***@'||substr(recipient_email,instr(recipient_email,'@')+1) AS recipient
      FROM transactional_email_outbox WHERE (?='' OR status=?) ORDER BY updated_at DESC,id DESC LIMIT 100`)
      .bind(filter, filter).all<Record<string, unknown>>(),
  ]);
  return { counts: Object.fromEntries(counts.results.map((row) => [row.status, Number(row.count)])), items: rows.results };
}

export async function retryDeadLetterEmail(input: {
  db: D1Database;
  id: number;
  actorProfileId: number;
  requestId?: string;
  now?: Date | number | string;
}) {
  const id = Number(input.id);
  if (!Number.isInteger(id) || id < 1) throw new TransactionalEmailOutboxError("Email outbox item is invalid");
  const current = await input.db.prepare(`SELECT status,attempt_count AS attemptCount,last_error_code AS lastErrorCode
    FROM transactional_email_outbox WHERE id=? LIMIT 1`).bind(id)
    .first<{ status: string; attemptCount: number; lastErrorCode: string }>();
  if (!current) throw new TransactionalEmailOutboxError("Email outbox item not found", 404);
  if (current.status !== "dead_letter") throw new TransactionalEmailOutboxError("Only a dead-letter email can be retried", 409);
  const now = asDate(input.now).toISOString();
  const update = input.db.prepare(`UPDATE transactional_email_outbox SET status='retry_wait',attempt_count=0,
    next_attempt_at=?,lease_owner='',lease_expires_at=NULL,provider_message_id='',last_error_code='',last_error_reason='',
    sent_at=NULL,dead_lettered_at=NULL,cancelled_at=NULL,updated_at=? WHERE id=? AND status='dead_letter'`)
    .bind(now, now, id);
  const audit = await prepareAuditEventStatement({
    actorProfileId: input.actorProfileId,
    action: "transactional_email.manual_retry",
    entityType: "transactional_email_outbox",
    entityId: id,
    before: current,
    after: { status: "retry_wait", attemptCount: 0, nextAttemptAt: now },
    requestId: input.requestId ?? "",
  }, input.db, { whenPreviousStatementChanged: true });
  const result = await input.db.batch([update, audit]);
  if (Number(result[0]?.meta.changes ?? 0) !== 1 || Number(result[1]?.meta.changes ?? 0) !== 1) {
    throw new TransactionalEmailOutboxError("Email outbox item changed. Refresh before retrying", 409);
  }
  return { retried: true as const };
}
