import { prepareAuditEventStatement } from "./audit.ts";

export class ComplianceReviewError extends Error {
  readonly status: number;

  constructor(message: string, status = 409) {
    super(message);
    this.name = "ComplianceReviewError";
    this.status = status;
  }
}

type ComplianceEntity = "licence" | "pharmacist";
type ComplianceDecision = "verified" | "rejected";

export async function reviewVendorCompliance(input: {
  db: D1Database;
  entity: ComplianceEntity;
  id: number;
  decision: ComplianceDecision;
  reason: string;
  actorProfileId: number;
  requestId?: string;
}) {
  const table = input.entity === "licence" ? "vendor_licences" : "pharmacists";
  const current = await input.db.prepare(`SELECT id,vendor_id AS vendorId,
    verification_status AS verificationStatus FROM ${table} WHERE id=? LIMIT 1`)
    .bind(input.id).first<{ id: number; vendorId: number; verificationStatus: string }>();
  if (!current) throw new ComplianceReviewError("Compliance record was not found", 404);
  if (current.verificationStatus !== "pending") {
    if (current.verificationStatus === input.decision) {
      return { vendorId: current.vendorId, duplicate: true as const };
    }
    throw new ComplianceReviewError("This compliance record was already reviewed. Refresh before making another decision.");
  }

  const audit = await prepareAuditEventStatement({
    vendorId: current.vendorId,
    actorProfileId: input.actorProfileId,
    action: `admin.${input.entity}.${input.decision}`,
    entityType: input.entity === "licence" ? "vendor_licence" : "pharmacist",
    entityId: input.id,
    before: { verificationStatus: current.verificationStatus },
    after: { decision: input.decision, reason: input.reason },
    requestId: input.requestId ?? "",
  }, input.db, { whenPreviousStatementChanged: true });

  const updateRecord = input.entity === "licence"
    ? input.db.prepare(`UPDATE vendor_licences SET verification_status=?,updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND vendor_id=? AND verification_status='pending'`)
      .bind(input.decision, input.id, current.vendorId)
    : input.db.prepare(`UPDATE pharmacists SET verification_status=?
        WHERE id=? AND vendor_id=? AND verification_status='pending'`)
      .bind(input.decision, input.id, current.vendorId);
  const results = await input.db.batch([
    updateRecord,
    audit,
    input.db.prepare(`UPDATE vendors SET
      compliance_status=CASE
        WHEN EXISTS(SELECT 1 FROM vendor_licences licence WHERE licence.vendor_id=vendors.id
          AND licence.verification_status='verified' AND licence.suspended_at IS NULL
          AND date(licence.valid_from)<=date('now') AND date(licence.valid_until)>=date('now'))
         AND EXISTS(SELECT 1 FROM pharmacists pharmacist WHERE pharmacist.vendor_id=vendors.id
          AND pharmacist.active=1 AND pharmacist.verification_status='verified'
          AND (pharmacist.valid_from IS NULL OR date(pharmacist.valid_from)<=date('now'))
          AND (pharmacist.valid_until IS NULL OR date(pharmacist.valid_until)>=date('now')))
        THEN 'verified' WHEN ?='rejected' THEN 'rejected' ELSE 'pending' END,
      approval_status=CASE
        WHEN EXISTS(SELECT 1 FROM vendor_licences licence WHERE licence.vendor_id=vendors.id
          AND licence.verification_status='verified' AND licence.suspended_at IS NULL
          AND date(licence.valid_from)<=date('now') AND date(licence.valid_until)>=date('now'))
         AND EXISTS(SELECT 1 FROM pharmacists pharmacist WHERE pharmacist.vendor_id=vendors.id
          AND pharmacist.active=1 AND pharmacist.verification_status='verified'
          AND (pharmacist.valid_from IS NULL OR date(pharmacist.valid_from)<=date('now'))
          AND (pharmacist.valid_until IS NULL OR date(pharmacist.valid_until)>=date('now')))
        THEN 'approved' WHEN ?='rejected' THEN 'rejected' ELSE 'testing' END,
      updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND changes()=1`)
      .bind(input.decision, input.decision, current.vendorId),
  ]);
  if (Number(results[0]?.meta.changes ?? 0) !== 1) {
    const raced = await input.db.prepare(`SELECT verification_status AS verificationStatus
      FROM ${table} WHERE id=? LIMIT 1`).bind(input.id).first<{ verificationStatus: string }>();
    if (raced?.verificationStatus === input.decision) return { vendorId: current.vendorId, duplicate: true as const };
    throw new ComplianceReviewError("This compliance record changed during review. Refresh before retrying.");
  }
  if (Number(results[1]?.meta.changes ?? 0) !== 1 || Number(results[2]?.meta.changes ?? 0) !== 1) {
    throw new Error("Compliance review evidence did not persist atomically");
  }
  return { vendorId: current.vendorId, duplicate: false as const };
}
