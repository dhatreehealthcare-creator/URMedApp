import { getD1 } from "../../../../db/d1";
import { appendAuditEvent } from "../../../../lib/audit";
import { errorResponse } from "../../../../lib/auth-server";
import {
  listCanonicalManufacturers,
  listManufacturerRequests,
  parseManufacturerGovernanceQuery,
  parseManufacturerProposal,
} from "../../../../lib/manufacturer-governance";
import { requireVendorPermission } from "../../../../lib/vendor-access";

export async function GET(request: Request) {
  try {
    const { vendorId } = await requireVendorPermission(request, "product.submit");
    const filters = parseManufacturerGovernanceQuery(new URL(request.url));
    const db = getD1();
    const [manufacturers, requests] = await Promise.all([
      listCanonicalManufacturers(db, filters.query),
      listManufacturerRequests(db, filters, { role: "vendor", vendorId }),
    ]);
    return Response.json({ manufacturers, ...requests }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const { profile, vendorId } = await requireVendorPermission(request, "product.submit");
    const proposal = parseManufacturerProposal(await request.json() as Record<string, unknown>);
    const db = getD1();
    let inserted: { id: number } | null;
    try {
      inserted = await db.prepare(`
        INSERT INTO manufacturer_change_requests (
          request_type, submitted_vendor_id, created_by_profile_id, manufacturer_id,
          target_manufacturer_id, proposed_name, normalized_proposed_name
        )
        SELECT ?, ?, ?, ?, ?, ?, ?
        WHERE
          (? = 'new' OR EXISTS (SELECT 1 FROM manufacturer_canonical_state
            WHERE manufacturer_id = ? AND status = 'active'))
          AND (? <> 'merge' OR EXISTS (SELECT 1 FROM manufacturer_canonical_state
            WHERE manufacturer_id = ? AND status = 'active'))
          AND (? <> 'rename' OR ? <> (SELECT normalized_name FROM manufacturers WHERE id = ?))
          AND (? = 'merge' OR (
            NOT EXISTS (SELECT 1 FROM manufacturers WHERE normalized_name = ?)
            AND NOT EXISTS (SELECT 1 FROM manufacturer_aliases WHERE normalized_alias = ?)
          ))
        RETURNING id
      `).bind(
        proposal.requestType, vendorId, profile.id, proposal.manufacturerId,
        proposal.targetManufacturerId, proposal.proposedName, proposal.normalizedProposedName,
        proposal.requestType, proposal.manufacturerId,
        proposal.requestType, proposal.targetManufacturerId,
        proposal.requestType, proposal.normalizedProposedName, proposal.manufacturerId,
        proposal.requestType, proposal.normalizedProposedName, proposal.normalizedProposedName,
      ).first<{ id: number }>();
    } catch (error) {
      if (error instanceof Error && /unique|constraint|manufacturer request/i.test(error.message)) {
        return Response.json({ error: "A conflicting manufacturer or pending governance request already exists" }, { status: 409 });
      }
      throw error;
    }
    if (!inserted) return Response.json({ error: "Choose active canonical manufacturers and a unique proposed name" }, { status: 409 });
    await appendAuditEvent({
      vendorId, actorProfileId: profile.id, action: `manufacturer.${proposal.requestType}.proposed`,
      entityType: "manufacturer_change_request", entityId: inserted.id,
      after: { ...proposal, status: "pending" }, requestId: request.headers.get("cf-ray") ?? "",
    }, db);
    return Response.json({ saved: true, request: { id: inserted.id, ...proposal, status: "pending" }, message: "Manufacturer change submitted for administrator governance review" }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const { profile, vendorId } = await requireVendorPermission(request, "product.submit");
    const id = Number(new URL(request.url).searchParams.get("id"));
    if (!Number.isInteger(id) || id < 1) return Response.json({ error: "Choose a valid manufacturer request" }, { status: 400 });
    const db = getD1();
    const results = await db.batch([
      db.prepare(`UPDATE manufacturer_change_requests SET status='withdrawn', reviewed_by_profile_id=?,
        review_reason='Withdrawn by submitting vendor', reviewed_at=CURRENT_TIMESTAMP,
        version=version+1, updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND submitted_vendor_id=? AND status='pending'`).bind(profile.id, id, vendorId),
      db.prepare(`INSERT INTO manufacturer_governance_events (request_id, event_type, actor_profile_id, detail_json)
        SELECT id, 'withdrawn', ?, '{"reason":"vendor withdrawal"}' FROM manufacturer_change_requests
        WHERE id=? AND submitted_vendor_id=? AND status='withdrawn' AND reviewed_by_profile_id=?`).bind(profile.id, id, vendorId, profile.id),
    ]);
    if (!results[0].meta.changes) return Response.json({ error: "Only your tenant's pending request can be withdrawn" }, { status: 404 });
    await appendAuditEvent({ vendorId, actorProfileId: profile.id, action: "manufacturer.request.withdrawn", entityType: "manufacturer_change_request", entityId: id, after: { status: "withdrawn" }, reason: "Withdrawn by submitting vendor", requestId: request.headers.get("cf-ray") ?? "" }, db);
    return Response.json({ saved: true, request: { id, status: "withdrawn" } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
