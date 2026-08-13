import { getD1 } from "../../../../db/d1";
import { requireAdminProfile } from "../../../../lib/admin-access";
import { errorResponse } from "../../../../lib/auth-server";

const headers = { "Cache-Control": "private, no-store" };

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
