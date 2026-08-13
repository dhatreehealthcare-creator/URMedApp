import { getD1 } from "../../../../db/d1";
import { requireAdminProfile } from "../../../../lib/admin-access";
import { errorResponse } from "../../../../lib/auth-server";

const headers = { "Cache-Control": "private, no-store" };

export async function GET(request: Request) {
  try {
    await requireAdminProfile(request);
    const db = getD1(); const params = new URL(request.url).searchParams; const inventoryId = Number(params.get("inventoryId") ?? 0);
    if (!Number.isInteger(inventoryId) || inventoryId < 1) return Response.json({ error: "Choose a valid inventory batch" }, { status: 400, headers });
    const inventory = await db.prepare("SELECT product_id AS productId FROM pharmacy_inventory WHERE id=?").bind(inventoryId).first<{ productId: number }>();
    if (!inventory) return Response.json({ error: "Inventory batch was not found" }, { status: 404, headers });
    const [prices, barcodes] = await db.batch([
      db.prepare("SELECT id,inventory_id AS inventoryId,sale_price_paise AS salePricePaise,mrp_paise AS mrpPaise,effective_from AS effectiveFrom,reason FROM inventory_price_history WHERE product_id=? ORDER BY effective_from DESC,id DESC").bind(inventory.productId),
      db.prepare("SELECT id,product_id AS productId,code,symbology,status,review_reason AS reviewReason FROM product_barcodes WHERE product_id=? ORDER BY id DESC").bind(inventory.productId),
    ]);
    return Response.json({ productId: inventory.productId, prices: prices.results, barcodes: barcodes.results }, { headers });
  } catch (error) { return errorResponse(error); }
}

export async function PATCH(request: Request) {
  try {
    const profile = await requireAdminProfile(request);
    const body = await request.json() as Record<string, unknown>; const action = String(body.action ?? ""); const id = Number(body.id); const db = getD1();
    if (!Number.isInteger(id) || id < 1 || !["conversion_approve", "barcode_approve", "reject", "deactivate"].includes(action)) return Response.json({ error: "Pricing governance action is invalid" }, { status: 400, headers });
    if (action.startsWith("conversion")) {
      const status = action === "conversion_approve" ? "approved" : action === "deactivate" ? "inactive" : "rejected";
      const result = await db.prepare("UPDATE product_pack_conversions SET governance_status=?,reviewed_by_profile_id=?,review_reason=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND governance_status IN ('pending','rejected')").bind(status,profile.id,String(body.reason ?? "").trim().slice(0,500),id).run();
      if (!result.meta.changes) return Response.json({ error: "Conversion was not found or already finalized" }, { status: 409, headers });
      return Response.json({ saved: true, governanceStatus: status }, { headers });
    }
    const status = action === "barcode_approve" ? "approved" : action === "deactivate" ? "inactive" : "rejected";
    const result = await db.prepare("UPDATE product_barcodes SET status=?,reviewed_by_profile_id=?,review_reason=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('pending','rejected')").bind(status,profile.id,String(body.reason ?? "").trim().slice(0,500),id).run();
    if (!result.meta.changes) return Response.json({ error: "Barcode was not found or already finalized" }, { status: 409, headers });
    return Response.json({ saved: true, status }, { headers });
  } catch (error) { return errorResponse(error); }
}
