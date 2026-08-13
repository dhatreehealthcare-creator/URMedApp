import { getD1 } from "../db/d1.ts";
import { sha256Hex } from "./signatures.ts";

type AuditInput = {
  vendorId?: number | null;
  actorProfileId?: number | null;
  action: string;
  entityType: string;
  entityId: string | number;
  before?: unknown;
  after?: unknown;
  reason?: string;
  requestId?: string;
};

function stableJson(value: unknown): string {
  if (value === undefined || value === null) return "";
  return JSON.stringify(value, Object.keys(value as Record<string, unknown>).sort());
}

async function buildAuditEventStatement(
  input: AuditInput,
  database?: D1Database,
  options?: { whenPreviousStatementChanged?: boolean },
) {
  const db = database ?? getD1();
  const vendorId = input.vendorId ?? null;
  const previous = await db.prepare(`
    SELECT event_hash AS eventHash FROM audit_events
    WHERE (vendor_id = ? OR (vendor_id IS NULL AND ? IS NULL))
    ORDER BY id DESC LIMIT 1
  `).bind(vendorId, vendorId).first<{ eventHash: string }>();
  const createdAt = new Date().toISOString();
  const beforeJson = stableJson(input.before);
  const afterJson = stableJson(input.after);
  const previousHash = previous?.eventHash ?? "";
  const eventHash = await sha256Hex(JSON.stringify({
    vendorId,
    actorProfileId: input.actorProfileId ?? null,
    action: input.action,
    entityType: input.entityType,
    entityId: String(input.entityId),
    beforeJson,
    afterJson,
    reason: input.reason ?? "",
    requestId: input.requestId ?? "",
    previousHash,
    createdAt,
  }));
  const statement = db.prepare(`
    INSERT INTO audit_events (vendor_id, actor_profile_id, action, entity_type, entity_id,
      before_json, after_json, reason, request_id, previous_event_hash, event_hash, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    ${options?.whenPreviousStatementChanged ? "WHERE changes() = 1" : ""}
  `).bind(
    vendorId, input.actorProfileId ?? null, input.action, input.entityType, String(input.entityId),
    beforeJson, afterJson, input.reason ?? "", input.requestId ?? "", previousHash, eventHash, createdAt,
  );
  return { statement, eventHash };
}

export async function prepareAuditEventStatement(
  input: AuditInput,
  database?: D1Database,
  options?: { whenPreviousStatementChanged?: boolean },
) {
  return (await buildAuditEventStatement(input, database, options)).statement;
}

export async function appendAuditEvent(input: AuditInput, database?: D1Database) {
  const { statement, eventHash } = await buildAuditEventStatement(input, database);
  await statement.run();
  return eventHash;
}
