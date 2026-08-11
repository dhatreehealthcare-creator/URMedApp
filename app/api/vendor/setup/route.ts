import { getD1 } from "../../../../db/d1";
import { appendAuditEvent } from "../../../../lib/audit";
import { errorResponse, requireAuthUser } from "../../../../lib/auth-server";
import { encryptSensitiveText } from "../../../../lib/encryption";
import { requireVendorPermission, type VendorPermission } from "../../../../lib/vendor-access";
import { requireIsoDate } from "../../../../lib/date-controls";

const licenceForms = new Set(["20", "21", "20B", "21B", "20F", "21F"]);
const gstPattern = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const ifscPattern = /^[A-Z]{4}0[A-Z0-9]{6}$/;

function text(value: unknown, maximum: number) {
  return String(value ?? "").trim().slice(0, maximum);
}

function isoDate(value: unknown, label: string, required = true) {
  return requireIsoDate(value, label, !required);
}

async function verifiedVendorDocument(vendorId: number, documentId: unknown, purpose: string, required = true) {
  const id = Number(documentId);
  if (!Number.isInteger(id) || id < 1) {
    if (!required) return null;
    throw new Response(`Upload the ${purpose.replaceAll("_", " ")} document first`, { status: 400 });
  }
  const row = await getD1().prepare(`
    SELECT id FROM stored_documents
    WHERE id = ? AND vendor_id = ? AND purpose = ? AND status = 'active' AND malware_status = 'content_validated'
    LIMIT 1
  `).bind(id, vendorId, purpose).first<{ id: number }>();
  if (!row) throw new Response("The uploaded document could not be verified for this pharmacy", { status: 400 });
  return row.id;
}

async function loadSetup(vendorId: number) {
  const db = getD1();
  const vendor = await db.prepare(`
    SELECT v.id, v.business_name AS businessName, v.owner_name AS ownerName, v.phone, v.landline,
      v.email, v.gst_number AS gstNumber, v.address, v.latitude, v.longitude,
      v.home_delivery AS homeDelivery, v.approval_status AS approvalStatus,
      v.compliance_status AS complianceStatus, v.delivery_radius_km AS deliveryRadiusKm,
      p.phone_verified AS phoneVerified
    FROM vendors v LEFT JOIN account_profiles p ON p.id = v.profile_id WHERE v.id = ? LIMIT 1
  `).bind(vendorId).first();
  const bank = await db.prepare(`
    SELECT id, bank_name AS bankName, account_name AS accountName, account_last4 AS accountLast4,
      ifsc_code AS ifscCode, verification_status AS verificationStatus
    FROM vendor_bank_accounts WHERE vendor_id = ? AND active = 1 ORDER BY id DESC LIMIT 1
  `).bind(vendorId).first();
  const licences = await db.prepare(`
    SELECT l.id, l.licence_number AS licenceNumber, l.form_type AS formType,
      l.licence_category AS licenceCategory, l.issuing_authority AS issuingAuthority,
      l.issued_on AS issuedOn, l.valid_from AS validFrom, l.valid_until AS validUntil,
      l.document_id AS documentId, l.verification_status AS verificationStatus,
      d.original_filename AS documentName
    FROM vendor_licences l LEFT JOIN stored_documents d ON d.id = l.document_id
    WHERE l.vendor_id = ? ORDER BY l.valid_until DESC, l.id DESC LIMIT 20
  `).bind(vendorId).all();
  const pharmacists = await db.prepare(`
    SELECT p.id, p.full_name AS fullName, p.council_name AS councilName,
      p.registration_number AS registrationNumber, p.valid_from AS validFrom,
      p.valid_until AS validUntil, p.document_id AS documentId,
      p.verification_status AS verificationStatus, p.active,
      d.original_filename AS documentName
    FROM pharmacists p LEFT JOIN stored_documents d ON d.id = p.document_id
    WHERE p.vendor_id = ? ORDER BY p.active DESC, p.id DESC LIMIT 20
  `).bind(vendorId).all();
  return { vendor, bank, licences: licences.results, pharmacists: pharmacists.results };
}

export async function GET(request: Request) {
  try {
    const { vendorId } = await requireVendorPermission(request, "profile.manage");
    return Response.json(await loadSetup(vendorId), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const action = text(body.action, 40);
    const permission: VendorPermission = action === "bank" ? "accounts.write" : action === "profile" ? "profile.manage" : "licence.manage";
    const { profile, vendorId } = await requireVendorPermission(request, permission);
    const db = getD1();

    if (action === "profile") {
      const before = await db.prepare("SELECT * FROM vendors WHERE id = ? LIMIT 1").bind(vendorId).first();
      const businessName = text(body.businessName, 180);
      const ownerName = text(body.ownerName, 120);
      const phone = text(body.phone, 10).replace(/\D/g, "");
      const landline = text(body.landline, 10).replace(/\D/g, "");
      const gstNumber = text(body.gstNumber, 15).toUpperCase();
      const address = text(body.address, 500);
      const latitude = text(body.latitude, 24);
      const longitude = text(body.longitude, 24);
      const deliveryRadiusKm = Math.max(1, Math.min(Number(body.deliveryRadiusKm) || 5, 50));
      if (!businessName || !ownerName || !address) return Response.json({ error: "Business name, owner name and registered address are required" }, { status: 400 });
      if (!/^\d{10}$/.test(phone)) return Response.json({ error: "Phone must contain exactly 10 digits" }, { status: 400 });
      if (landline && !/^\d{10}$/.test(landline)) return Response.json({ error: "Landline must contain exactly 10 digits" }, { status: 400 });
      if (gstNumber && !gstPattern.test(gstNumber)) return Response.json({ error: "GSTIN format is invalid" }, { status: 400 });
      const authUser = await requireAuthUser(request);
      const confirmedPhone = String(authUser.phone ?? "").replace(/\D/g, "").slice(-10);
      if (!authUser.phone_confirmed_at || confirmedPhone !== phone) return Response.json({ error: "Verify this phone number with OTP before saving the pharmacy profile" }, { status: 400 });
      const lat = Number(latitude); const lon = Number(longitude);
      if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) return Response.json({ error: "Valid latitude and longitude are required" }, { status: 400 });
      const duplicate = await db.prepare(`
        SELECT id FROM account_profiles WHERE phone = ? AND id <> ?
        UNION SELECT profile_id AS id FROM vendors WHERE phone = ? AND id <> ? LIMIT 1
      `).bind(phone, profile.id, phone, vendorId).first();
      if (duplicate) return Response.json({ error: "This phone number is already registered" }, { status: 409 });
      await db.batch([
        db.prepare(`UPDATE vendors SET business_name = ?, owner_name = ?, phone = ?, landline = ?, gst_number = ?,
          address = ?, latitude = ?, longitude = ?, home_delivery = ?, delivery_radius_km = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
          .bind(businessName, ownerName, phone, landline, gstNumber, address, latitude, longitude, body.homeDelivery ? 1 : 0, deliveryRadiusKm, vendorId),
        db.prepare("UPDATE account_profiles SET name = ?, phone = ?, phone_verified = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(ownerName, phone, profile.id),
      ]);
      await appendAuditEvent({ vendorId, actorProfileId: profile.id, action: "vendor.profile.updated", entityType: "vendor", entityId: vendorId, before, after: { businessName, ownerName, phone, landline, gstNumber, address, latitude, longitude, homeDelivery: Boolean(body.homeDelivery), deliveryRadiusKm }, requestId: request.headers.get("cf-ray") ?? "" });
    } else if (action === "bank") {
      const bankName = text(body.bankName, 120);
      const accountName = text(body.accountName, 160);
      const accountNumber = text(body.accountNumber, 24).replace(/\s/g, "");
      const ifscCode = text(body.ifscCode, 11).toUpperCase();
      if (!bankName || !accountName || !/^\d{8,18}$/.test(accountNumber) || !ifscPattern.test(ifscCode)) return Response.json({ error: "Enter a valid bank, account name, 8–18 digit account number and IFSC" }, { status: 400 });
      const encrypted = await encryptSensitiveText(accountNumber);
      await db.batch([
        db.prepare("UPDATE vendor_bank_accounts SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE vendor_id = ? AND active = 1").bind(vendorId),
        db.prepare(`INSERT INTO vendor_bank_accounts (vendor_id, bank_name, account_name, account_number_encrypted,
          account_last4, ifsc_code, verification_status, active) VALUES (?, ?, ?, ?, ?, ?, 'pending', 1)`)
          .bind(vendorId, bankName, accountName, encrypted, accountNumber.slice(-4), ifscCode),
      ]);
      await appendAuditEvent({ vendorId, actorProfileId: profile.id, action: "vendor.bank.updated", entityType: "vendor_bank_account", entityId: vendorId, after: { bankName, accountName, accountLast4: accountNumber.slice(-4), ifscCode }, requestId: request.headers.get("cf-ray") ?? "" });
    } else if (action === "licence") {
      const licenceNumber = text(body.licenceNumber, 80).toUpperCase();
      const formType = text(body.formType, 8).toUpperCase();
      const issuingAuthority = text(body.issuingAuthority, 180);
      const validFrom = isoDate(body.validFrom, "Licence valid-from date")!;
      const validUntil = isoDate(body.validUntil, "Licence valid-until date")!;
      const issuedOn = isoDate(body.issuedOn, "Licence issue date", false);
      if (!licenceNumber || !licenceForms.has(formType) || !issuingAuthority) return Response.json({ error: "Licence number, approved form type and issuing authority are required" }, { status: 400 });
      if (validUntil < validFrom) return Response.json({ error: "Licence expiry must be after the valid-from date" }, { status: 400 });
      const documentId = await verifiedVendorDocument(vendorId, body.documentId, "drug_licence");
      await db.prepare(`
        INSERT INTO vendor_licences (vendor_id, licence_number, form_type, licence_category, issuing_authority,
          issued_on, valid_from, valid_until, document_id, verification_status)
        VALUES (?, ?, ?, 'retail', ?, ?, ?, ?, ?, 'pending')
        ON CONFLICT(vendor_id, licence_number) DO UPDATE SET form_type = excluded.form_type,
          issuing_authority = excluded.issuing_authority, issued_on = excluded.issued_on,
          valid_from = excluded.valid_from, valid_until = excluded.valid_until,
          document_id = excluded.document_id, verification_status = 'pending', suspended_at = NULL,
          updated_at = CURRENT_TIMESTAMP
      `).bind(vendorId, licenceNumber, formType, issuingAuthority, issuedOn, validFrom, validUntil, documentId).run();
      await db.prepare("UPDATE vendors SET licence_number = ?, compliance_status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(licenceNumber, vendorId).run();
      await appendAuditEvent({ vendorId, actorProfileId: profile.id, action: "vendor.licence.submitted", entityType: "vendor_licence", entityId: licenceNumber, after: { formType, issuingAuthority, issuedOn, validFrom, validUntil, documentId }, requestId: request.headers.get("cf-ray") ?? "" });
    } else if (action === "pharmacist") {
      const fullName = text(body.fullName, 140);
      const councilName = text(body.councilName, 180);
      const registrationNumber = text(body.registrationNumber, 80).toUpperCase();
      const validFrom = isoDate(body.validFrom, "Registration valid-from date", false);
      const validUntil = isoDate(body.validUntil, "Registration valid-until date", false);
      if (!fullName || !councilName || !registrationNumber) return Response.json({ error: "Pharmacist name, State Pharmacy Council and registration number are required" }, { status: 400 });
      if (validFrom && validUntil && validUntil < validFrom) return Response.json({ error: "Registration expiry must be after the valid-from date" }, { status: 400 });
      const documentId = await verifiedVendorDocument(vendorId, body.documentId, "pharmacist_registration");
      await db.prepare(`
        INSERT INTO pharmacists (vendor_id, profile_id, full_name, council_name, registration_number, valid_from,
          valid_until, document_id, verification_status, active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1)
        ON CONFLICT(vendor_id, registration_number) DO UPDATE SET full_name = excluded.full_name,
          profile_id = excluded.profile_id, council_name = excluded.council_name, valid_from = excluded.valid_from,
          valid_until = excluded.valid_until, document_id = excluded.document_id,
          verification_status = 'pending', active = 1
      `).bind(vendorId, profile.id, fullName, councilName, registrationNumber, validFrom, validUntil, documentId).run();
      await db.prepare("UPDATE vendors SET compliance_status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(vendorId).run();
      await appendAuditEvent({ vendorId, actorProfileId: profile.id, action: "vendor.pharmacist.submitted", entityType: "pharmacist", entityId: registrationNumber, after: { fullName, councilName, validFrom, validUntil, documentId }, requestId: request.headers.get("cf-ray") ?? "" });
    } else {
      return Response.json({ error: "Vendor setup action is invalid" }, { status: 400 });
    }
    return Response.json({ saved: true, ...(await loadSetup(vendorId)) });
  } catch (error) {
    return errorResponse(error);
  }
}
