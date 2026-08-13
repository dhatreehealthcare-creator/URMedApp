import { getD1 } from "../../../../db/d1";
import { requireAdminProfile } from "../../../../lib/admin-access";
import { appendAuditEvent } from "../../../../lib/audit";
import { errorResponse } from "../../../../lib/auth-server";
import { cleanText } from "../../../../lib/product-master";
import { listAdminAlternateQueue, loadCompatibleAlternatePair, parseAlternateQuery } from "../../../../lib/product-alternates";

export async function GET(request: Request) {
  try {
    await requireAdminProfile(request);
    return Response.json(await listAdminAlternateQueue(getD1(), parseAlternateQuery(new URL(request.url))), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const profile = await requireAdminProfile(request);
    const body = await request.json() as Record<string, unknown>;
    const id = Number(body.id);
    const action = cleanText(body.action, 20);
    const reason = cleanText(body.reason, 500);
    if (!Number.isInteger(id) || id < 1 || !["approve", "reject", "deactivate"].includes(action)) {
      return Response.json({ error: "Choose a valid alternate governance action" }, { status: 400 });
    }
    if (["reject", "deactivate"].includes(action) && reason.length < 5) {
      return Response.json({ error: "Add a clear clinical-governance reason" }, { status: 400 });
    }
    const db = getD1();
    const before = await db.prepare(`
      SELECT id, product_id AS productId, alternate_product_id AS alternateProductId,
        submitted_vendor_id AS submittedVendorId, governance_status AS governanceStatus
      FROM product_alternates WHERE id = ? LIMIT 1
    `).bind(id).first<{ id: number; productId: number; alternateProductId: number; submittedVendorId: number | null; governanceStatus: string }>();
    if (!before) return Response.json({ error: "Alternate proposal was not found" }, { status: 404 });
    if (action === "approve") await loadCompatibleAlternatePair(db, before.productId, before.alternateProductId);
    const expected = action === "deactivate" ? "approved" : "pending";
    const nextStatus = action === "deactivate" ? "inactive" : action === "approve" ? "approved" : "rejected";
    const reviewReason = action === "approve" ? "Approved after D-09 clinical compatibility review" : reason;
    const result = await db.prepare(`
      UPDATE product_alternates SET governance_status = ?, reviewed_by_profile_id = ?,
        review_reason = ?, reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND governance_status = ?
    `).bind(nextStatus, profile.id, reviewReason, id, expected).run();
    if (!result.meta.changes) {
      const actionLabel = action === "approve" ? "approved" : action === "reject" ? "rejected" : "deactivated";
      return Response.json({ error: `Only a ${expected} alternate can be ${actionLabel}` }, { status: 409 });
    }
    await appendAuditEvent({ vendorId: before.submittedVendorId, actorProfileId: profile.id, action: `admin.product_alternate.${action}`, entityType: "product_alternate", entityId: id, before, after: { governanceStatus: nextStatus }, reason: reviewReason, requestId: request.headers.get("cf-ray") ?? "" }, db);
    return Response.json({ saved: true, alternate: { id, governanceStatus: nextStatus }, automaticSubstitution: false }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
