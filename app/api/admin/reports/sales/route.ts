import { getD1 } from "../../../../../db/d1";
import { requireAdminProfile } from "../../../../../lib/admin-access";
import { errorResponse } from "../../../../../lib/auth-server";
import { AdminReportError, loadAdminSalesReport, reportExportResponse, reportFormat } from "../../../../../lib/admin-reporting";

export async function GET(request: Request) {
  try {
    await requireAdminProfile(request);
    const url = new URL(request.url);
    const result = await loadAdminSalesReport(getD1(), url);
    const format = reportFormat(url); if (format !== "json") {
      return reportExportResponse("urmed-sales-report.csv", "URMED SALES REPORT", [
        "Date", "Channel", "Medicine", "Manufacturer", "Sale transactions", "Return transactions",
        "Sold quantity", "Returned quantity", "Gross sales paise", "Returns paise", "Net sales paise",
      ], result.rows.map((row) => [
        row.activityDate, row.channel, row.medicineName, row.manufacturerName, row.transactions,
        row.returnTransactions, row.soldQuantity, row.returnedQuantity, row.grossSalesPaise,
        row.returnedPaise, row.netSalesPaise,
      ]), format);
    }
    return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof AdminReportError) return Response.json({ error: error.message }, { status: error.status, headers: { "Cache-Control": "no-store" } });
    return errorResponse(error);
  }
}
