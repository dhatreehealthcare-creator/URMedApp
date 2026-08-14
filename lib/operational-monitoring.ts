import { sha256Hex } from "./signatures.ts";

export const OPERATIONAL_CATEGORIES = ["auth", "payment", "webhook", "scheduled_job", "email", "storage", "database", "backup", "security"] as const;
export const OPERATIONAL_SEVERITIES = ["info", "warning", "error", "critical"] as const;
export const OPERATIONAL_ALERT_STATUSES = ["open", "acknowledged", "resolved"] as const;
export type OperationalCategory = typeof OPERATIONAL_CATEGORIES[number];
export type OperationalSeverity = typeof OPERATIONAL_SEVERITIES[number];
export type OperationalAlertStatus = typeof OPERATIONAL_ALERT_STATUSES[number];

const sensitive = /pass(word)?|token|secret|authorization|cookie|credential|payload|prescription|address|latitude|longitude|coordinate|phone|email|access.?key|amount|currency/i;
export function sanitizeOperationalDetail(value: unknown, depth = 0): unknown {
  if (depth > 3 || value === null || value === undefined) return depth > 3 ? "[redacted]" : value;
  if (typeof value === "string") return value.length > 240 ? `${value.slice(0, 237)}...` : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeOperationalDetail(item, depth + 1));
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
      result[key] = sensitive.test(key) ? "[redacted]" : sanitizeOperationalDetail(item, depth + 1);
    }
    return result;
  }
  return "[redacted]";
}

function text(value: unknown, max: number) { return String(value ?? "").trim().slice(0, max); }
function integer(value: unknown, max: number) { const n = Number(value); return Number.isSafeInteger(n) && n >= 0 ? Math.min(n, max) : 0; }
function iso(value: unknown) { const date = value ? new Date(String(value)) : new Date(); return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString(); }

export type OperationalEventInput = {
  db: D1Database;
  eventKey: string;
  category: OperationalCategory;
  severity: OperationalSeverity;
  provider?: string;
  vendorId?: number | null;
  profileId?: number | null;
  referenceType?: string;
  referenceId?: string | number;
  errorCode?: string;
  attemptCount?: number;
  retryable?: boolean;
  requestId?: string;
  detail?: unknown;
  occurredAt?: string | Date | number;
};

export async function recordOperationalEvent(input: OperationalEventInput) {
  const occurredAt = iso(input.occurredAt);
  const eventKey = text(input.eventKey, 240);
  if (!eventKey) throw new Error("Operational event key is required");
  const detailJson = JSON.stringify(sanitizeOperationalDetail(input.detail ?? {}));
  const fingerprint = await sha256Hex(JSON.stringify([
    input.category, text(input.provider, 80), input.vendorId ?? null,
    text(input.errorCode, 100), text(input.referenceType, 80), text(input.referenceId, 160),
  ]));
  const inserted = await input.db.prepare(`
    INSERT INTO operational_events
      (event_key,category,severity,status,provider,vendor_id,profile_id,reference_type,reference_id,error_code,attempt_count,retryable,request_id,detail_json,occurred_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(event_key) DO NOTHING
    RETURNING id
  `).bind(
    eventKey, input.category, input.severity, "recorded", text(input.provider, 80), input.vendorId ?? null,
    input.profileId ?? null, text(input.referenceType, 80), text(input.referenceId, 160), text(input.errorCode, 100),
    integer(input.attemptCount, 10000), input.retryable ? 1 : 0, text(input.requestId, 160), detailJson, occurredAt,
  ).first<{ id: number }>();
  if (!inserted?.id) return { inserted: false, eventKey };
  await input.db.prepare(`
    INSERT INTO operational_alerts (fingerprint,category,severity,status,provider,vendor_id,occurrence_count,first_seen,last_seen,sample_event_id,last_error_code,version,resolution_reason)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(fingerprint) DO UPDATE SET
      severity=CASE WHEN excluded.severity='critical' OR (excluded.severity='error' AND operational_alerts.severity IN ('info','warning')) OR (excluded.severity='warning' AND operational_alerts.severity='info') THEN excluded.severity ELSE operational_alerts.severity END,
      status=CASE WHEN operational_alerts.status='resolved' THEN 'open' ELSE operational_alerts.status END,
      provider=excluded.provider, occurrence_count=MIN(10000, operational_alerts.occurrence_count+1), last_seen=excluded.last_seen,
      sample_event_id=COALESCE(operational_alerts.sample_event_id, excluded.sample_event_id), last_error_code=excluded.last_error_code,
      version=operational_alerts.version+1, resolved_at=CASE WHEN operational_alerts.status='resolved' THEN NULL ELSE operational_alerts.resolved_at END
  `).bind(
    fingerprint, input.category, input.severity, "open", text(input.provider, 80), input.vendorId ?? null,
    1, occurredAt, occurredAt, inserted.id, text(input.errorCode, 100), 1, "",
  ).run();
  return { inserted: true, eventKey, eventId: inserted.id, fingerprint };
}

export async function safeRecordOperationalEvent(input: OperationalEventInput) {
  try { return await recordOperationalEvent(input); } catch { return { inserted: false, eventKey: input.eventKey, monitoringUnavailable: true }; }
}

type Filters = { category?: string; severity?: string; status?: string; provider?: string; vendorId?: number; from?: string; to?: string; page?: number; pageSize?: number };
function filters(input: Filters) {
  const clauses: string[] = ["1=1"]; const params: unknown[] = [];
  const add = (sql: string, ...values: unknown[]) => { clauses.push(sql); params.push(...values); };
  if (input.category && OPERATIONAL_CATEGORIES.includes(input.category as OperationalCategory)) add("category=?", input.category);
  if (input.severity && OPERATIONAL_SEVERITIES.includes(input.severity as OperationalSeverity)) add("severity=?", input.severity);
  if (input.status && OPERATIONAL_ALERT_STATUSES.includes(input.status as OperationalAlertStatus)) add("status=?", input.status);
  if (input.provider) add("provider=?", text(input.provider, 80));
  if (input.vendorId !== undefined) add("vendor_id=?", input.vendorId);
  if (input.from) add("last_seen>=?", iso(input.from));
  if (input.to) add("last_seen<=?", iso(input.to));
  const page = Math.max(1, Math.floor(input.page ?? 1)); const pageSize = Math.min(100, Math.max(1, Math.floor(input.pageSize ?? 50)));
  return { where: clauses.join(" AND "), params, page, pageSize };
}

export async function listOperationalMonitoring(db: D1Database, input: Filters = {}) {
  const f = filters(input);
  const alertParams = [...f.params, f.pageSize, (f.page - 1) * f.pageSize];
  const alerts = await db.prepare(`SELECT id,fingerprint,category,severity,status,provider,vendor_id AS vendorId,occurrence_count AS occurrenceCount,first_seen AS firstSeen,last_seen AS lastSeen,last_error_code AS lastErrorCode,version,resolved_at AS resolvedAt,resolution_reason AS resolutionReason FROM operational_alerts WHERE ${f.where} ORDER BY last_seen DESC,id DESC LIMIT ? OFFSET ?`).bind(...alertParams).all();
  const eventWhere = f.where.replaceAll("last_seen", "occurred_at");
  const events = await db.prepare(`SELECT id,event_key AS eventKey,category,severity,status,provider,vendor_id AS vendorId,reference_type AS referenceType,reference_id AS referenceId,error_code AS errorCode,attempt_count AS attemptCount,retryable,request_id AS requestId,occurred_at AS occurredAt,created_at AS createdAt FROM operational_events WHERE ${eventWhere} ORDER BY occurred_at DESC,id DESC LIMIT ? OFFSET ?`).bind(...alertParams).all();
  const health = await getScheduledJobHealth(db);
  return { alerts: alerts.results, events: events.results, scheduledHealth: health, pagination: { page: f.page, pageSize: f.pageSize } };
}

export async function getScheduledJobHealth(db: D1Database) {
  const rows = await db.prepare(`SELECT reference_id AS cron,
      MAX(CASE WHEN error_code='job_completed' THEN occurred_at END) AS lastSuccess,
      MAX(CASE WHEN error_code<>'job_completed' THEN occurred_at END) AS lastFailure,
      MAX(occurred_at) AS lastSeen
    FROM operational_events WHERE category='scheduled_job' GROUP BY reference_id ORDER BY reference_id`).all<{ cron: string; lastSuccess: string | null; lastFailure: string | null; lastSeen: string | null }>();
  const now = Date.now();
  return rows.results.map((row) => ({ ...row, missed: !row.lastSuccess || now - new Date(row.lastSuccess).getTime() > 2 * 24 * 60 * 60 * 1000 }));
}

export async function updateOperationalAlert(input: { db: D1Database; id: number; action: "acknowledge" | "resolve" | "reopen"; version: number; reason?: string; actorProfileId: number; requestId?: string }) {
  const next = input.action === "resolve" ? "resolved" : input.action === "acknowledge" ? "acknowledged" : "open";
  const result = await input.db.prepare(`UPDATE operational_alerts SET status=?,resolved_at=?,resolution_reason=?,version=version+1 WHERE id=? AND version=?`).bind(next, next === "resolved" ? new Date().toISOString() : null, text(input.reason, 500), input.id, input.version).run();
  const changes = Number((result as { meta?: { changes?: number }; changes?: number }).meta?.changes ?? (result as { changes?: number }).changes ?? 0);
  if (changes !== 1) throw Object.assign(new Error("Monitoring alert changed; refresh and retry"), { code: "STALE_ALERT", status: 409 });
  return { id: input.id, status: next, version: input.version + 1 };
}

export async function recordScheduledJobEvent(input: { db: D1Database; cron: string; scheduledTime: number; ok: boolean; detail?: unknown; errorCode?: string; attemptCount?: number }) {
  return safeRecordOperationalEvent({ db: input.db, eventKey: `scheduled:${text(input.cron, 80)}:${input.scheduledTime}:${input.ok ? "success" : "failure"}`, category: "scheduled_job", severity: input.ok ? "info" : "critical", provider: "worker", referenceType: "cron", referenceId: input.cron, errorCode: input.errorCode ?? (input.ok ? "job_completed" : "job_failed"), retryable: !input.ok, attemptCount: input.attemptCount, detail: input.detail, occurredAt: input.scheduledTime });
}
