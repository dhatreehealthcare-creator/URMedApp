import { getD1 } from "../../../../db/d1";
import { requireAdminProfile } from "../../../../lib/admin-access";
import { appendAuditEvent } from "../../../../lib/audit";
import { errorResponse } from "../../../../lib/auth-server";
import {
  approveManufacturerRequest,
  listCanonicalManufacturers,
  listManufacturerRequests,
  loadManufacturerRequest,
  parseManufacturerGovernanceQuery,
} from "../../../../lib/manufacturer-governance";
import { cleanText } from "../../../../lib/product-master";

export async function GET(request: Request) {
  try {
    await requireAdminProfile(request);
    const filters = parseManufacturerGovernanceQuery(new URL(request.url));
    const db = getD1();
    const [manufacturers, requests] = await Promise.all([
      listCanonicalManufacturers(db, filters.query),
      listManufacturerRequests(db, filters, { role: "admin" }),
    ]);
    return Response.json({ manufacturers, ...requests }, { headers: { "Cache-Control": "private, no-store" } });
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
    if (!Number.isInteger(id) || id < 1 || !["approve", "reject"].includes(action)) {
      return Response.json({ error: "Choose a valid manufacturer governance action" }, { status: 400 });
    }
    if (reason.length < 5) return Response.json({ error: "Add a clear governance reason" }, { status: 400 });
    const db = getD1();
    const manufacturerRequest = await loadManufacturerRequest(db, id);
    if (!manufacturerRequest) return Response.json({ error: "Manufacturer request was not found" }, { status: 404 });
    if (manufacturerRequest.status !== "pending") return Response.json({ error: "Only a pending manufacturer request can be reviewed" }, { status: 409 });
    if (action === "approve") {
      const detail = await approveManufacturerRequest(db, manufacturerRequest, profile.id, reason, request.headers.get("cf-ray") ?? "");
      return Response.json({ saved: true, request: { id, status: "approved" }, manufacturer: detail }, { headers: { "Cache-Control": "no-store" } });
    }
    const results = await db.batch([
      db.prepare(`UPDATE manufacturer_change_requests SET status='rejected', reviewed_by_profile_id=?,
        review_reason=?, reviewed_at=CURRENT_TIMESTAMP, version=version+1, updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND status='pending' AND version=?`).bind(profile.id, reason, id, manufacturerRequest.version),
      db.prepare(`INSERT INTO manufacturer_governance_events (request_id, event_type, actor_profile_id, manufacturer_id, target_manufacturer_id, detail_json)
        SELECT id, 'rejected', ?, manufacturer_id, target_manufacturer_id, ? FROM manufacturer_change_requests
        WHERE id=? AND status='rejected' AND reviewed_by_profile_id=?`).bind(profile.id, JSON.stringify({ reason }), id, profile.id),
    ]);
    if (!results[0].meta.changes) return Response.json({ error: "The manufacturer request changed; refresh and retry" }, { status: 409 });
    await appendAuditEvent({ vendorId: manufacturerRequest.submittedVendorId, actorProfileId: profile.id, action: `admin.manufacturer.${manufacturerRequest.requestType}.rejected`, entityType: "manufacturer_change_request", entityId: id, before: manufacturerRequest, after: { status: "rejected" }, reason, requestId: request.headers.get("cf-ray") ?? "" }, db);
    return Response.json({ saved: true, request: { id, status: "rejected" } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
