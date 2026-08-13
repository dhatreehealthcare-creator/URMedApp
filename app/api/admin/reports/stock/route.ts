import { getD1 } from "../../../../../db/d1";
import { requireAdminProfile } from "../../../../../lib/admin-access";
import { errorResponse } from "../../../../../lib/auth-server";
import { AdminReportError, loadAdminStockReport, reportExportResponse, reportFormat } from "../../../../../lib/admin-reporting";

export async function GET(request: Request) {
  try {
    await requireAdminProfile(request);
    const url = new URL(request.url);
    const result = await loadAdminStockReport(getD1(), url);
    const format = reportFormat(url); if (format !== "json") {
      return reportExportResponse("urmed-stock-report.csv", "URMED STOCK REPORT", [
        "Medicine", "Manufacturer", "Medicines", "Stores", "Batches", "Physical quantity",
        "Reserved quantity", "Available quantity", "Quarantined quantity", "Expired quantity",
        "Low batches", "Stock cost paise", "Retail value paise", "Nearest expiry",
      ], result.rows.map((row) => [
        row.medicineName, row.manufacturerName, row.medicineCount, row.storeCount, row.batchCount,
        row.physicalQuantity, row.reservedQuantity, row.availableQuantity, row.quarantinedQuantity,
        row.expiredQuantity, row.lowBatchCount, row.stockCostPaise, row.retailValuePaise, row.nearestExpiry ?? "",
      ]), format);
    }
    return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof AdminReportError) return Response.json({ error: error.message }, { status: error.status, headers: { "Cache-Control": "no-store" } });
    return errorResponse(error);
  }
}
