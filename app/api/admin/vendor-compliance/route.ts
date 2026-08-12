import { getD1 } from "../../../../db/d1";
import { requireAdminProfile } from "../../../../lib/admin-access";
import { appendAuditEvent } from "../../../../lib/audit";
import { errorResponse } from "../../../../lib/auth-server";

async function listApplications() {
  const result = await getD1().prepare(`
    SELECT v.id AS vendorId, v.business_name AS businessName, v.owner_name AS ownerName,
      v.phone, v.email, v.address, v.approval_status AS approvalStatus,
      v.compliance_status AS complianceStatus, v.created_at AS registeredAt,
      (SELECT COUNT(*) FROM vendor_licences l WHERE l.vendor_id = v.id) AS licenceCount,
      (SELECT COUNT(*) FROM vendor_licences l WHERE l.vendor_id = v.id AND l.verification_status = 'verified' AND l.valid_until >= date('now')) AS validLicenceCount,
      (SELECT COUNT(*) FROM pharmacists p WHERE p.vendor_id = v.id AND p.active = 1) AS pharmacistCount,
      (SELECT COUNT(*) FROM pharmacists p WHERE p.vendor_id = v.id AND p.active = 1 AND p.verification_status = 'verified' AND (p.valid_until IS NULL OR p.valid_until >= date('now'))) AS validPharmacistCount
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
  return { applications: result.results, licences: licences.results, pharmacists: pharmacists.results };
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
    if (!["licence", "pharmacist"].includes(entity) || !["verified", "rejected"].includes(decision) || !Number.isInteger(id) || id < 1) {
      return Response.json({ error: "Choose a valid compliance record and decision" }, { status: 400 });
    }
    if (decision === "rejected" && reason.length < 5) return Response.json({ error: "Add a clear rejection reason" }, { status: 400 });
    const db = getD1();
    const table = entity === "licence" ? "vendor_licences" : "pharmacists";
    const record = await db.prepare(`SELECT id, vendor_id AS vendorId FROM ${table} WHERE id = ? LIMIT 1`).bind(id).first<{ id: number; vendorId: number }>();
    if (!record) return Response.json({ error: "Compliance record was not found" }, { status: 404 });
    await db.prepare(`UPDATE ${table} SET verification_status = ?${entity === "licence" ? ", updated_at = CURRENT_TIMESTAMP" : ""} WHERE id = ?`).bind(decision, id).run();
    const readiness = await db.prepare(`SELECT
      EXISTS(SELECT 1 FROM vendor_licences WHERE vendor_id = ? AND verification_status = 'verified' AND valid_until >= date('now')) AS licenceReady,
      EXISTS(SELECT 1 FROM pharmacists WHERE vendor_id = ? AND active = 1 AND verification_status = 'verified' AND (valid_until IS NULL OR valid_until >= date('now'))) AS pharmacistReady
    `).bind(record.vendorId, record.vendorId).first<{ licenceReady: number; pharmacistReady: number }>();
    const approved = Boolean(readiness?.licenceReady && readiness?.pharmacistReady);
    const complianceStatus = approved ? "verified" : decision === "rejected" ? "rejected" : "pending";
    const approvalStatus = approved ? "approved" : decision === "rejected" ? "rejected" : "testing";
    await db.prepare(`UPDATE vendors SET compliance_status = ?, approval_status = ?, suspension_reason = ?,
      suspended_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(complianceStatus, approvalStatus, decision === "rejected" ? reason : "", record.vendorId).run();
    await appendAuditEvent({ vendorId: record.vendorId, actorProfileId: profile.id, action: `admin.${entity}.${decision}`, entityType: entity === "licence" ? "vendor_licence" : "pharmacist", entityId: id, after: { decision, reason, complianceStatus, approvalStatus }, requestId: request.headers.get("cf-ray") ?? "" });
    return Response.json({ saved: true, ...(await listApplications()) });
  } catch (error) {
    return errorResponse(error);
  }
}
