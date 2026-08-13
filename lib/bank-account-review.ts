import { prepareAuditEventStatement } from "./audit.ts";

export class BankAccountReviewError extends Error {
  readonly status: number;

  constructor(message: string, status = 409) {
    super(message);
    this.name = "BankAccountReviewError";
    this.status = status;
  }
}

export async function reviewVendorBankAccount(input: {
  db: D1Database;
  id: number;
  decision: "verified" | "rejected";
  reason: string;
  actorProfileId: number;
  requestId?: string;
}) {
  const current = await input.db.prepare(`SELECT id,vendor_id AS vendorId,bank_name AS bankName,
    account_name AS accountName,account_last4 AS accountLast4,ifsc_code AS ifscCode,
    verification_status AS verificationStatus,active FROM vendor_bank_accounts WHERE id=? LIMIT 1`)
    .bind(input.id).first<{ id: number; vendorId: number; bankName: string; accountName: string;
      accountLast4: string; ifscCode: string; verificationStatus: string; active: number }>();
  if (!current || !current.active) throw new BankAccountReviewError("Active bank account was not found", 404);
  if (current.verificationStatus !== "pending") {
    if (current.verificationStatus === input.decision) return { vendorId: current.vendorId, duplicate: true as const };
    throw new BankAccountReviewError("This bank account was already reviewed. Refresh before making another decision.");
  }

  const audit = await prepareAuditEventStatement({
    vendorId: current.vendorId,
    actorProfileId: input.actorProfileId,
    action: `admin.vendor_bank_account.${input.decision}`,
    entityType: "vendor_bank_account",
    entityId: input.id,
    before: { verificationStatus: current.verificationStatus },
    after: {
      decision: input.decision,
      bankName: current.bankName,
      accountName: current.accountName,
      accountLast4: current.accountLast4,
      ifscCode: current.ifscCode,
    },
    reason: input.reason,
    requestId: input.requestId ?? "",
  }, input.db, { whenPreviousStatementChanged: true });

  const results = await input.db.batch([
    input.db.prepare(`UPDATE vendor_bank_accounts SET verification_status=?,updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND vendor_id=? AND active=1 AND verification_status='pending'`)
      .bind(input.decision, input.id, current.vendorId),
    audit,
  ]);
  if (Number(results[0]?.meta.changes ?? 0) !== 1) {
    const raced = await input.db.prepare(`SELECT verification_status AS verificationStatus,active
      FROM vendor_bank_accounts WHERE id=? LIMIT 1`).bind(input.id)
      .first<{ verificationStatus: string; active: number }>();
    if (raced?.active && raced.verificationStatus === input.decision) {
      return { vendorId: current.vendorId, duplicate: true as const };
    }
    throw new BankAccountReviewError("This bank account changed during review. Refresh before retrying.");
  }
  if (Number(results[1]?.meta.changes ?? 0) !== 1) throw new Error("Bank review evidence did not persist atomically");
  return { vendorId: current.vendorId, duplicate: false as const };
}
