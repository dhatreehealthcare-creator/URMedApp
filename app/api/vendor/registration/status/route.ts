import { getD1 } from "../../../../../db/d1";
import { errorResponse } from "../../../../../lib/auth-server";
import { requireVendorOnboardingAccess } from "../../../../../lib/vendor-access";
import { getVendorRegistrationNextAction } from "../../../../../lib/vendor-registration-status";

type RegistrationSummary = {
  businessName: string;
  ownerName: string;
  email: string;
  phone: string;
  registrationStatus: string;
  registrationSubmittedAt: string | null;
  approvalStatus: string;
  complianceStatus: string;
  reviewNote: string;
  currentLicenceCount: number;
  verifiedLicenceCount: number;
  pharmacistCount: number;
  verifiedPharmacistCount: number;
};

export async function GET(request: Request) {
  try {
    const { profile, vendorId } = await requireVendorOnboardingAccess(request);
    const db = getD1();
    const registration = await db.prepare(`
      SELECT v.business_name AS businessName, v.owner_name AS ownerName, v.email, v.phone,
        v.registration_status AS registrationStatus, v.registration_submitted_at AS registrationSubmittedAt,
        v.approval_status AS approvalStatus, v.compliance_status AS complianceStatus,
        v.suspension_reason AS reviewNote,
        (SELECT COUNT(*) FROM vendor_licences l
          WHERE l.vendor_id = v.id AND l.valid_until >= date('now')) AS currentLicenceCount,
        (SELECT COUNT(*) FROM vendor_licences l
          WHERE l.vendor_id = v.id AND l.verification_status = 'verified' AND l.valid_until >= date('now')) AS verifiedLicenceCount,
        (SELECT COUNT(*) FROM pharmacists p WHERE p.vendor_id = v.id AND p.active = 1) AS pharmacistCount,
        (SELECT COUNT(*) FROM pharmacists p
          WHERE p.vendor_id = v.id AND p.active = 1 AND p.verification_status = 'verified'
            AND (p.valid_until IS NULL OR p.valid_until >= date('now'))) AS verifiedPharmacistCount
      FROM vendors v WHERE v.id = ? LIMIT 1
    `).bind(vendorId).first<RegistrationSummary>();
    if (!registration) return Response.json({ error: "Vendor registration was not found" }, { status: 404 });

    const [licences, pharmacists] = await Promise.all([
      db.prepare(`
        SELECT l.id, l.licence_number AS licenceNumber, l.form_type AS formType,
          l.valid_until AS validUntil, l.verification_status AS verificationStatus,
          d.original_filename AS documentName
        FROM vendor_licences l LEFT JOIN stored_documents d ON d.id = l.document_id
        WHERE l.vendor_id = ? ORDER BY l.valid_until DESC, l.id DESC LIMIT 20
      `).bind(vendorId).all(),
      db.prepare(`
        SELECT p.id, p.full_name AS fullName, p.council_name AS councilName,
          p.registration_number AS registrationNumber, p.valid_until AS validUntil,
          p.verification_status AS verificationStatus, p.active
        FROM pharmacists p WHERE p.vendor_id = ? ORDER BY p.active DESC, p.id DESC LIMIT 20
      `).bind(vendorId).all(),
    ]);
    const emailVerified = Boolean(profile.emailVerified);
    const phoneVerified = Boolean(profile.phoneVerified);
    const nextAction = getVendorRegistrationNextAction({
      emailVerified,
      phoneVerified,
      registrationStatus: registration.registrationStatus,
      approvalStatus: registration.approvalStatus,
      complianceStatus: registration.complianceStatus,
      currentLicenceCount: Number(registration.currentLicenceCount),
      verifiedLicenceCount: Number(registration.verifiedLicenceCount),
      pharmacistCount: Number(registration.pharmacistCount),
      verifiedPharmacistCount: Number(registration.verifiedPharmacistCount),
    });
    return Response.json({
      identity: {
        email: profile.email,
        phone: profile.phone,
        emailVerified,
        phoneVerified,
        verificationStatus: profile.identityVerificationStatus,
      },
      registration: { ...registration, nextAction },
      licences: licences.results,
      pharmacists: pharmacists.results,
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
