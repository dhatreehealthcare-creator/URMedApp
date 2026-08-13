import { getD1 } from "../../../../db/d1";
import { errorResponse } from "../../../../lib/auth-server";
import { requireVendorPermission } from "../../../../lib/vendor-access";

export async function GET(request: Request) {
  try {
    const { vendorId } = await requireVendorPermission(request, "prescription.review");
    const rows = await getD1().prepare(`SELECT register_type AS registerType,
      serial_number AS serialNumber, transaction_date AS transactionDate,
      patient_name AS patientName, prescriber_name AS prescriberName,
      batch_number AS batchNumber, quantity_supplied AS quantitySupplied,
      retention_until AS retentionUntil
      FROM statutory_register_entries
      WHERE vendor_id=? ORDER BY transaction_date DESC, id DESC LIMIT 100`)
      .bind(vendorId).all();
    return Response.json({ registers: rows.results }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
