import { getD1 } from "../../../../../db/d1";
import { requireAdminProfile } from "../../../../../lib/admin-access";
import { errorResponse } from "../../../../../lib/auth-server";
import { AdminReportError, loadAdminDeliveryReport, reportExportResponse, reportFormat } from "../../../../../lib/admin-reporting";

export async function GET(request: Request) {
  try {
    await requireAdminProfile(request);
    const url = new URL(request.url);
    const result = await loadAdminDeliveryReport(getD1(), url);
    const format = reportFormat(url); if (format !== "json") {
      return reportExportResponse("urmed-home-delivery-report.csv", "URMED HOME DELIVERY REPORT", [
        "Order", "Store", "Method", "Status", "Rider", "Assignment status", "Payment method",
        "Payment status", "Delivery fee paise", "Order total paise", "Created at", "Assigned at",
        "Picked up at", "Delivered at", "Estimated straight-line distance km", "Elapsed minutes", "SLA status",
      ], result.rows.map((row) => [
        row.orderNumber, row.businessName, row.deliveryMethod, row.deliveryStatus, row.riderName,
        row.assignmentStatus, row.paymentMethod, row.paymentStatus, row.deliveryFeePaise, row.orderTotalPaise,
        row.createdAt, row.assignedAt ?? "", row.pickedUpAt ?? "", row.deliveredAt ?? "",
        row.estimatedDistanceKm ?? "", row.elapsedMinutes, row.slaStatus,
      ]), format);
    }
    return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof AdminReportError) return Response.json({ error: error.message }, { status: error.status, headers: { "Cache-Control": "no-store" } });
    return errorResponse(error);
  }
}
