import { getD1 } from "../../../../db/d1";
import { errorResponse } from "../../../../lib/auth-server";
import { requireVendorPermission } from "../../../../lib/vendor-access";
import { getAccountingStatements, getPartySubledger, statementCsv, statementPdf, statementXlsx, validateAccountingPeriod } from "../../../../lib/accounting-statements";

const headers = { "Cache-Control": "private, no-store" };

export async function GET(request: Request) {
  try {
    const { vendorId } = await requireVendorPermission(request, "accounts.write");
    const params = new URL(request.url).searchParams;
    const today = new Date().toISOString().slice(0, 10);
    const start = params.get("start") ?? `${today.slice(0, 4)}-01-01`;
    const end = params.get("end") ?? today;
    try { validateAccountingPeriod(start, end); } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Accounting period dates are invalid" }, { status: 400, headers }); }
    const statement = await getAccountingStatements(getD1(), { vendorId, start, end });
    const format = params.get("format");
    if (format === "csv") return new Response(statementCsv(statement), { headers: { ...headers, "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=urmed-accounting.csv" } });
    if (format === "xlsx") return new Response(await statementXlsx(statement) as unknown as BodyInit, { headers: { ...headers, "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": "attachment; filename=urmed-accounting.xlsx" } });
    if (format === "pdf") return new Response(await statementPdf(statement) as unknown as BodyInit, { headers: { ...headers, "Content-Type": "application/pdf", "Content-Disposition": "inline; filename=urmed-accounting.pdf" } });
    const partyType = params.get("partyType") as "supplier" | "customer" | null; const partyId = Number(params.get("partyId"));
    if (partyType && Number.isInteger(partyId) && partyId > 0) return Response.json({ statement, subledger: await getPartySubledger(getD1(), { vendorId, partyType, partyId, start, end }) }, { headers });
    return Response.json(statement, { headers });
  } catch (error) { return errorResponse(error); }
}
