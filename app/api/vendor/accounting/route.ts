import { getD1 } from "../../../../db/d1";
import { errorResponse } from "../../../../lib/auth-server";
import { requireVendorPermission } from "../../../../lib/vendor-access";
import { getAccountingStatements, validateAccountingPeriod } from "../../../../lib/accounting-statements";

const headers = { "Cache-Control": "private, no-store" };

export async function GET(request: Request) {
  try {
    const { vendorId } = await requireVendorPermission(request, "accounts.write");
    const params = new URL(request.url).searchParams;
    const today = new Date().toISOString().slice(0, 10);
    const start = params.get("start") ?? `${today.slice(0, 4)}-01-01`;
    const end = params.get("end") ?? today;
    try { validateAccountingPeriod(start, end); } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Accounting period dates are invalid" }, { status: 400, headers }); }
    return Response.json(await getAccountingStatements(getD1(), { vendorId, start, end }), { headers });
  } catch (error) { return errorResponse(error); }
}
