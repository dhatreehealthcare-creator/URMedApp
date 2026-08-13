import { getD1 } from "../../../../../db/d1";
import { errorResponse, requireLocalProfile } from "../../../../../lib/auth-server";
import { getCustomerTaxInvoice, taxInvoiceResponse } from "../../../../../lib/tax-invoice";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { profile } = await requireLocalProfile(request, ["customer"]);
    const invoiceId = Number((await context.params).id);
    if (!Number.isInteger(invoiceId) || invoiceId < 1) {
      return Response.json({ error: "Invoice is invalid" }, { status: 400, headers: { "Cache-Control": "private, no-store" } });
    }
    const invoice = await getCustomerTaxInvoice(getD1(), invoiceId, profile.id);
    if (!invoice) return Response.json({ error: "Invoice not found" }, { status: 404, headers: { "Cache-Control": "private, no-store" } });
    return taxInvoiceResponse(invoice, new URL(request.url).searchParams.get("format"));
  } catch (error) {
    return errorResponse(error);
  }
}
