import { getD1 } from "../../../../../db/d1";
import { requireAdminProfile } from "../../../../../lib/admin-access";
import { errorResponse } from "../../../../../lib/auth-server";
import { AdminReportError, csvResponse, loadAdminExpenseReport, wantsCsv } from "../../../../../lib/admin-reporting";

export async function GET(request: Request) {
  try {
    await requireAdminProfile(request);
    const url = new URL(request.url);
    const result = await loadAdminExpenseReport(getD1(), url);
    if (wantsCsv(url)) {
      return csvResponse("urmed-expense-report.csv", [
        "Label", "Date", "Expense head", "Store", "Purpose", "Payment mode", "Entries", "Amount paise",
      ], result.rows.map((row) => [
        row.label, row.expenseDate, row.expenseHead, row.businessName, row.purpose,
        row.paymentMode, row.entryCount, row.amountPaise,
      ]));
    }
    return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof AdminReportError) return Response.json({ error: error.message }, { status: error.status, headers: { "Cache-Control": "no-store" } });
    return errorResponse(error);
  }
}
