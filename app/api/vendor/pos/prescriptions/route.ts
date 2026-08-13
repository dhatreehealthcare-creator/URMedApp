import { getD1 } from "../../../../../db/d1";
import { prepareAuditEventStatement } from "../../../../../lib/audit";
import { errorResponse } from "../../../../../lib/auth-server";
import { OfflinePosError, parsePosPrescriptionCapture } from "../../../../../lib/offline-pos";
import { requireVendorPermission } from "../../../../../lib/vendor-access";

type CaptureRow = {
  id: number; captureNumber: string; customerProfileId: number | null; documentId: number;
  documentName: string; patientName: string; prescriberName: string; prescribedOn: string;
  status: string; rejectionReason: string; createdAt: string; itemsJson: string;
};

function captureNumber() {
  return `OPRX-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${crypto.randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
}

function respond(error: unknown) {
  if (error instanceof OfflinePosError) return Response.json({ error: error.message }, { status: error.status });
  return errorResponse(error);
}

async function listCaptures(vendorId: number, capturedByProfileId: number | null) {
  const rows = await getD1().prepare(`SELECT capture.id, capture.capture_number AS captureNumber,
    capture.customer_profile_id AS customerProfileId, capture.document_id AS documentId,
    document.original_filename AS documentName, capture.patient_name AS patientName,
    capture.prescriber_name AS prescriberName, capture.prescribed_on AS prescribedOn,
    capture.status, capture.rejection_reason AS rejectionReason, capture.created_at AS createdAt,
    COALESCE((SELECT json_group_array(json_object('productId', item.product_id, 'medicineText', item.medicine_text,
      'quantityRequested', item.quantity_requested)) FROM offline_prescription_items item
      WHERE item.offline_prescription_id = capture.id), '[]') AS itemsJson
    FROM offline_prescriptions capture JOIN stored_documents document ON document.id = capture.document_id
    WHERE capture.vendor_id = ? AND (? IS NULL OR capture.captured_by_profile_id = ?)
    ORDER BY CASE capture.status WHEN 'uploaded' THEN 0 ELSE 1 END,
      capture.created_at DESC, capture.id DESC LIMIT 100`).bind(vendorId, capturedByProfileId, capturedByProfileId).all<CaptureRow>();
  return rows.results.map(({ itemsJson, ...capture }) => ({
    ...capture,
    items: JSON.parse(itemsJson) as Array<{ productId: number; medicineText: string; quantityRequested: number }>,
  }));
}

export async function GET(request: Request) {
  try {
    const { profile, vendorId } = await requireVendorPermission(request, "sale.write");
    let canReview = true;
    try {
      await requireVendorPermission(request, "prescription.review", { profile });
    } catch (error) {
      if (error instanceof Response && error.status === 403) canReview = false;
      else throw error;
    }
    return Response.json({ prescriptions: await listCaptures(vendorId, canReview ? null : profile.id) }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return respond(error);
  }
}

export async function POST(request: Request) {
  try {
    const { profile, vendorId } = await requireVendorPermission(request, "sale.write");
    const draft = parsePosPrescriptionCapture(await request.json());
    const database = getD1();
    if (draft.customerProfileId) {
      const customer = await database.prepare(`SELECT id FROM account_profiles WHERE id = ? AND role = 'customer'
        AND status = 'active' AND email_verified = 1 AND phone_verified = 1 LIMIT 1`)
        .bind(draft.customerProfileId).first();
      if (!customer) throw new OfflinePosError("The selected verified live customer is unavailable", 409);
    }
    const number = captureNumber();
    const statements: D1PreparedStatement[] = [database.prepare(`INSERT INTO offline_prescriptions
      (capture_number,vendor_id,customer_profile_id,document_id,patient_name,patient_address,prescriber_name,
        prescriber_address,prescribed_on,serial_number,status,captured_by_profile_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,'uploaded',?)`).bind(number, vendorId, draft.customerProfileId, draft.documentId,
      draft.patientName, draft.patientAddress, draft.prescriberName, draft.prescriberAddress, draft.prescribedOn,
      draft.serialNumber, profile.id)];
    for (const item of draft.items) {
      statements.push(database.prepare(`INSERT INTO offline_prescription_items
        (offline_prescription_id,product_id,medicine_text,quantity_requested)
        SELECT id,?,?,? FROM offline_prescriptions WHERE capture_number = ? AND vendor_id = ?`)
        .bind(item.productId, item.medicineText, item.quantityRequested, number, vendorId));
    }
    statements.push(await prepareAuditEventStatement({
      vendorId, actorProfileId: profile.id, action: "offline_prescription.captured", entityType: "offline_prescription",
      entityId: number, after: { captureNumber: number, documentId: draft.documentId, productCount: draft.items.length },
      requestId: request.headers.get("cf-ray") ?? "",
    }, database));
    await database.batch(statements);
    const saved = await database.prepare("SELECT id FROM offline_prescriptions WHERE capture_number = ? AND vendor_id = ? LIMIT 1")
      .bind(number, vendorId).first<{ id: number }>();
    if (!saved) throw new OfflinePosError("The counter prescription could not be captured", 409);
    return Response.json({ prescription: { id: saved.id, captureNumber: number, status: "uploaded" }, prescriptions: await listCaptures(vendorId, profile.id) }, {
      status: 201, headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return respond(error);
  }
}
