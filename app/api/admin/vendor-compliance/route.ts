import { getD1 } from "../../../../db/d1";
import { requireAdminProfile } from "../../../../lib/admin-access";
import { errorResponse } from "../../../../lib/auth-server";
import { ComplianceReviewError, reviewVendorCompliance } from "../../../../lib/vendor-compliance-review";
import { BankAccountReviewError, reviewVendorBankAccount } from "../../../../lib/bank-account-review";

async function listApplications() {
  const result = await getD1().prepare(`
    SELECT v.id AS vendorId, v.business_name AS businessName, v.owner_name AS ownerName,
      v.phone, v.email, v.address, v.approval_status AS approvalStatus,
      v.compliance_status AS complianceStatus, v.created_at AS registeredAt,
      (SELECT COUNT(*) FROM vendor_licences l WHERE l.vendor_id = v.id) AS licenceCount,
      (SELECT COUNT(*) FROM vendor_licences l WHERE l.vendor_id = v.id AND l.verification_status = 'verified'
        AND l.suspended_at IS NULL AND date(l.valid_from) <= date('now') AND date(l.valid_until) >= date('now')) AS validLicenceCount,
      (SELECT COUNT(*) FROM pharmacists p WHERE p.vendor_id = v.id AND p.active = 1) AS pharmacistCount,
      (SELECT COUNT(*) FROM pharmacists p WHERE p.vendor_id = v.id AND p.active = 1 AND p.verification_status = 'verified'
        AND (p.valid_from IS NULL OR date(p.valid_from) <= date('now'))
        AND (p.valid_until IS NULL OR date(p.valid_until) >= date('now'))) AS validPharmacistCount
    FROM vendors v ORDER BY CASE v.compliance_status WHEN 'pending' THEN 0 WHEN 'rejected' THEN 1 ELSE 2 END, v.created_at DESC LIMIT 100
  `).all();
  const licences = await getD1().prepare(`
    SELECT l.id, l.vendor_id AS vendorId, l.licence_number AS licenceNumber, l.form_type AS formType,
      l.issuing_authority AS issuingAuthority, l.valid_from AS validFrom, l.valid_until AS validUntil,
      l.verification_status AS verificationStatus, l.document_id AS documentId,
      d.original_filename AS documentName
    FROM vendor_licences l LEFT JOIN stored_documents d ON d.id = l.document_id
    WHERE l.verification_status IN ('pending', 'verified', 'rejected') ORDER BY l.created_at DESC LIMIT 200
  `).all();
  const pharmacists = await getD1().prepare(`
    SELECT p.id, p.vendor_id AS vendorId, p.full_name AS fullName, p.council_name AS councilName,
      p.registration_number AS registrationNumber, p.valid_from AS validFrom, p.valid_until AS validUntil,
      p.verification_status AS verificationStatus, p.document_id AS documentId,
      d.original_filename AS documentName
    FROM pharmacists p LEFT JOIN stored_documents d ON d.id = p.document_id
    WHERE p.active = 1 AND p.verification_status IN ('pending', 'verified', 'rejected') ORDER BY p.created_at DESC LIMIT 200
  `).all();
  const bankAccounts = await getD1().prepare(`
    SELECT bank.id,bank.vendor_id AS vendorId,vendor.business_name AS businessName,
      bank.bank_name AS bankName,bank.account_name AS accountName,bank.account_last4 AS accountLast4,
      bank.ifsc_code AS ifscCode,bank.verification_status AS verificationStatus,bank.created_at AS submittedAt
    FROM vendor_bank_accounts bank JOIN vendors vendor ON vendor.id=bank.vendor_id
    WHERE bank.active=1 AND bank.verification_status IN ('pending','verified','rejected')
    ORDER BY CASE bank.verification_status WHEN 'pending' THEN 0 WHEN 'rejected' THEN 1 ELSE 2 END,
      bank.created_at DESC LIMIT 200
  `).all();
  return { applications: result.results, licences: licences.results, pharmacists: pharmacists.results, bankAccounts: bankAccounts.results };
}

export async function GET(request: Request) {
  try {
    await requireAdminProfile(request);
    return Response.json(await listApplications(), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const profile = await requireAdminProfile(request);
    const body = await request.json() as Record<string, unknown>;
    const entity = String(body.entity ?? "");
    const decision = String(body.decision ?? "");
    const id = Number(body.id);
    const reason = String(body.reason ?? "").trim().slice(0, 500);
    if (!["licence", "pharmacist", "bank_account"].includes(entity) || !["verified", "rejected"].includes(decision) || !Number.isInteger(id) || id < 1) {
      return Response.json({ error: "Choose a valid compliance record and decision" }, { status: 400 });
    }
    if (decision === "rejected" && reason.length < 5) return Response.json({ error: "Add a clear rejection reason" }, { status: 400 });
    const db = getD1();
    const reviewed = entity === "bank_account"
      ? await reviewVendorBankAccount({ db, id, decision: decision as "verified" | "rejected", reason,
        actorProfileId: profile.id, requestId: request.headers.get("cf-ray") ?? "" })
      : await reviewVendorCompliance({ db, entity: entity as "licence" | "pharmacist", id,
        decision: decision as "verified" | "rejected", reason, actorProfileId: profile.id,
        requestId: request.headers.get("cf-ray") ?? "" });
    return Response.json({ saved: true, duplicate: reviewed.duplicate, ...(await listApplications()) });
  } catch (error) {
    if (error instanceof ComplianceReviewError || error instanceof BankAccountReviewError) return Response.json({ error: error.message }, { status: error.status });
    return errorResponse(error);
  }
}
