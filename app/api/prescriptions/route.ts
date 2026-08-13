import { getD1 } from "../../../db/d1";
import { appendAuditEvent } from "../../../lib/audit";
import { errorResponse, requireLocalProfile } from "../../../lib/auth-server";
import { requireVendorPermission } from "../../../lib/vendor-access";
import { requireIsoDate } from "../../../lib/date-controls";
import { currentOperationalVendorPredicate } from "../../../lib/operational-vendor";

function text(value: unknown, maximum: number) {
  return String(value ?? "").trim().slice(0, maximum);
}

function date(value: unknown) {
  const result = requireIsoDate(value, "Prescription date", true);
  if (!result) return null;
  if (result > new Date().toISOString().slice(0, 10)) throw new Response("Prescription date cannot be in the future", { status: 400 });
  return result;
}

function prescriptionNumber() {
  return `RX-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
}

async function listForCustomer(profileId: number) {
  const result = await getD1().prepare(`
    SELECT p.id, p.prescription_number AS prescriptionNumber, p.vendor_id AS vendorId,
      v.business_name AS businessName, p.document_id AS documentId,
      d.original_filename AS documentName, p.patient_name AS patientName,
      p.patient_address AS patientAddress, p.prescriber_name AS prescriberName,
      p.prescriber_address AS prescriberAddress, p.prescribed_on AS prescribedOn,
      p.serial_number AS serialNumber, p.status, p.rejection_reason AS rejectionReason,
      p.created_at AS createdAt, p.reviewed_at AS reviewedAt,
      (SELECT notes FROM prescription_reviews r WHERE r.prescription_id = p.id ORDER BY r.id DESC LIMIT 1) AS reviewNotes,
      (SELECT group_concat(o.order_number, ', ') FROM orders o WHERE o.prescription_id = p.id) AS orderNumbers
    FROM prescriptions p
    LEFT JOIN vendors v ON v.id = p.vendor_id
    JOIN stored_documents d ON d.id = p.document_id
    WHERE p.customer_profile_id = ? ORDER BY p.created_at DESC LIMIT 100
  `).bind(profileId).all();
  return result.results;
}

async function listForVendor(vendorId: number) {
  const result = await getD1().prepare(`
    SELECT p.id, p.prescription_number AS prescriptionNumber, p.vendor_id AS vendorId,
      v.business_name AS businessName, p.document_id AS documentId,
      d.original_filename AS documentName, p.patient_name AS patientName,
      p.patient_address AS patientAddress, p.prescriber_name AS prescriberName,
      p.prescriber_address AS prescriberAddress, p.prescribed_on AS prescribedOn,
      p.serial_number AS serialNumber, p.status, p.rejection_reason AS rejectionReason,
      p.created_at AS createdAt, p.reviewed_at AS reviewedAt,
      c.name AS customerName, c.phone AS customerPhone,
      (SELECT notes FROM prescription_reviews r WHERE r.prescription_id = p.id ORDER BY r.id DESC LIMIT 1) AS reviewNotes,
      (SELECT group_concat(o.order_number, ', ') FROM orders o WHERE o.prescription_id = p.id) AS orderNumbers
    FROM prescriptions p
    JOIN vendors v ON v.id = p.vendor_id
    JOIN account_profiles c ON c.id = p.customer_profile_id
    JOIN stored_documents d ON d.id = p.document_id
    WHERE p.vendor_id = ? ORDER BY CASE p.status WHEN 'uploaded' THEN 0 WHEN 'clarification_required' THEN 1 ELSE 2 END, p.created_at DESC LIMIT 100
  `).bind(vendorId).all();
  return result.results;
}

export async function GET(request: Request) {
  try {
    const { profile } = await requireLocalProfile(request, ["customer", "vendor"]);
    if (profile.role === "vendor") {
      const { vendorId } = await requireVendorPermission(request, "prescription.review");
      return Response.json({ prescriptions: await listForVendor(vendorId) }, { headers: { "Cache-Control": "private, no-store" } });
    }
    return Response.json({ prescriptions: await listForCustomer(profile.id) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const { profile } = await requireLocalProfile(request, ["customer"]);
    const body = await request.json() as Record<string, unknown>;
    const documentId = Number(body.documentId);
    const vendorId = Number(body.vendorId);
    const replacePrescriptionId = Number(body.replacePrescriptionId || 0);
    const patientName = text(body.patientName || profile.name, 140);
    const patientAddress = text(body.patientAddress, 500);
    const prescriberName = text(body.prescriberName, 140);
    const prescriberAddress = text(body.prescriberAddress, 500);
    const prescribedOn = date(body.prescribedOn);
    const serialNumber = text(body.serialNumber, 80);
    if (!Number.isInteger(documentId) || documentId < 1 || !Number.isInteger(vendorId) || vendorId < 1) return Response.json({ error: "Choose a pharmacy and upload the prescription document first" }, { status: 400 });
    if (!patientName || !patientAddress || !prescriberName || !prescribedOn) return Response.json({ error: "Patient name, address, prescriber and prescription date are required" }, { status: 400 });
    const db = getD1();
    const operationalVendor = currentOperationalVendorPredicate("v");
    const vendor = await db.prepare(`SELECT v.id FROM vendors v WHERE v.id = ? AND ${operationalVendor} LIMIT 1`).bind(vendorId).first();
    if (!vendor) return Response.json({ error: "The selected pharmacy cannot receive prescriptions" }, { status: 409 });
    const document = await db.prepare(`SELECT id FROM stored_documents WHERE id = ? AND owner_profile_id = ?
      AND purpose = 'prescription' AND status = 'active' AND malware_status = 'content_validated' LIMIT 1`).bind(documentId, profile.id).first();
    if (!document) return Response.json({ error: "The uploaded prescription document could not be verified" }, { status: 400 });

    let prescriptionId: number;
    let number: string;
    if (replacePrescriptionId) {
      const existing = await db.prepare(`SELECT id, prescription_number AS prescriptionNumber, vendor_id AS vendorId
        FROM prescriptions WHERE id = ? AND customer_profile_id = ? AND status = 'clarification_required' LIMIT 1`)
        .bind(replacePrescriptionId, profile.id).first<{ id: number; prescriptionNumber: string; vendorId: number }>();
      if (!existing || existing.vendorId !== vendorId) return Response.json({ error: "Only a prescription awaiting clarification can be replaced" }, { status: 409 });
      prescriptionId = existing.id; number = existing.prescriptionNumber;
      const replacement = await db.batch([
        db.prepare(`UPDATE prescriptions SET document_id = ?, patient_name = ?, patient_address = ?, prescriber_name = ?,
          prescriber_address = ?, prescribed_on = ?, serial_number = ?, status = 'uploaded', rejection_reason = '', reviewed_at = NULL
          WHERE id = ? AND EXISTS (SELECT 1 FROM vendors v WHERE v.id = prescriptions.vendor_id AND ${operationalVendor})`)
          .bind(documentId, patientName, patientAddress, prescriberName, prescriberAddress, prescribedOn, serialNumber, prescriptionId),
        db.prepare(`UPDATE stored_documents SET vendor_id = ? WHERE id = ?
          AND EXISTS (SELECT 1 FROM prescriptions refreshed WHERE refreshed.id = ? AND refreshed.document_id = ? AND refreshed.status = 'uploaded')`)
          .bind(vendorId, documentId, prescriptionId, documentId),
        db.prepare(`UPDATE orders SET prescription_status = 'pending_review', order_status = 'awaiting_prescription_review',
          delivery_status = 'pharmacist_review', updated_at = CURRENT_TIMESTAMP
          WHERE prescription_id = ? AND order_status <> 'cancelled'
            AND EXISTS (SELECT 1 FROM prescriptions refreshed WHERE refreshed.id = ? AND refreshed.document_id = ? AND refreshed.status = 'uploaded')`)
          .bind(prescriptionId, prescriptionId, documentId),
      ]);
      if (!replacement[0]?.meta.changes) return Response.json({ error: "The selected pharmacy cannot receive prescriptions" }, { status: 409 });
      await appendAuditEvent({ vendorId, actorProfileId: profile.id, action: "prescription.resubmitted", entityType: "prescription", entityId: prescriptionId, after: { documentId, patientName, prescriberName, prescribedOn }, requestId: request.headers.get("cf-ray") ?? "" });
    } else {
      number = prescriptionNumber();
      const inserted = await db.prepare(`INSERT INTO prescriptions (prescription_number, customer_profile_id, vendor_id,
        document_id, patient_name, patient_address, prescriber_name, prescriber_address, prescribed_on, serial_number, status)
        SELECT ?, ?, v.id, ?, ?, ?, ?, ?, ?, ?, 'uploaded' FROM vendors v
        WHERE v.id = ? AND ${operationalVendor}`)
        .bind(number, profile.id, documentId, patientName, patientAddress, prescriberName, prescriberAddress, prescribedOn, serialNumber, vendorId).run();
      if (!inserted.meta.changes) return Response.json({ error: "The selected pharmacy cannot receive prescriptions" }, { status: 409 });
      prescriptionId = Number(inserted.meta.last_row_id);
      await db.prepare("UPDATE stored_documents SET vendor_id = ? WHERE id = ?").bind(vendorId, documentId).run();
      await appendAuditEvent({ vendorId, actorProfileId: profile.id, action: "prescription.uploaded", entityType: "prescription", entityId: prescriptionId, after: { number, documentId, patientName, prescriberName, prescribedOn }, requestId: request.headers.get("cf-ray") ?? "" });
    }
    return Response.json({ prescription: { id: prescriptionId, prescriptionNumber: number, status: "uploaded" }, prescriptions: await listForCustomer(profile.id) }, { status: replacePrescriptionId ? 200 : 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
