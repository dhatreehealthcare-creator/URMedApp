import { getD1 } from "../../../../../../db/d1";
import { errorResponse } from "../../../../../../lib/auth-server";
import { getPosReceipt } from "../../../../../../lib/offline-pos";
import { requireVendorPermission } from "../../../../../../lib/vendor-access";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { vendorId } = await requireVendorPermission(request, "sale.write");
    const id = Number((await context.params).id);
    if (!Number.isInteger(id) || id < 1) return Response.json({ error: "Counter sale is invalid" }, { status: 400 });
    const receipt = await getPosReceipt(getD1(), vendorId, id);
    if (!receipt) return Response.json({ error: "Counter sale not found" }, { status: 404 });
    return Response.json({ receipt }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
