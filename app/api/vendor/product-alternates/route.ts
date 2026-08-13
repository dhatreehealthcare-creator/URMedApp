import { getD1 } from "../../../../db/d1";
import { appendAuditEvent } from "../../../../lib/audit";
import { errorResponse } from "../../../../lib/auth-server";
import {
  canonicalProductPair,
  listVendorAlternateCandidates,
  loadCompatibleAlternatePair,
  parseAlternateQuery,
  requireAlternateSubmissionAccess,
} from "../../../../lib/product-alternates";

export async function GET(request: Request) {
  try {
    const { vendorId } = await requireAlternateSubmissionAccess(request);
    return Response.json(
      await listVendorAlternateCandidates(getD1(), vendorId, parseAlternateQuery(new URL(request.url))),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const { profile, vendorId } = await requireAlternateSubmissionAccess(request);
    const body = await request.json() as Record<string, unknown>;
    const pair = canonicalProductPair(body.productId, body.alternateProductId);
    const db = getD1();
    const compatible = await loadCompatibleAlternatePair(db, pair.productId, pair.alternateProductId);
    const before = await db.prepare(`
      SELECT id, submitted_vendor_id AS submittedVendorId, governance_status AS governanceStatus
      FROM product_alternates WHERE product_id = ? AND alternate_product_id = ? LIMIT 1
    `).bind(pair.productId, pair.alternateProductId).first<{
      id: number; submittedVendorId: number | null; governanceStatus: string;
    }>();
    let id: number;
    let action = "product_alternate.proposed";
    if (!before) {
      const inserted = await db.prepare(`
        INSERT INTO product_alternates (
          product_id, alternate_product_id, submitted_vendor_id, created_by_profile_id,
          governance_status, review_reason
        ) VALUES (?, ?, ?, ?, 'pending', '') RETURNING id
      `).bind(pair.productId, pair.alternateProductId, vendorId, profile.id).first<{ id: number }>();
      if (!inserted) return Response.json({ error: "Alternate proposal could not be created" }, { status: 409 });
      id = inserted.id;
    } else {
      if (!["rejected", "inactive", "withdrawn"].includes(before.governanceStatus)) {
        return Response.json({ error: before.governanceStatus === "approved" ? "This governed alternate is already approved" : "This alternate proposal is already awaiting review" }, { status: 409 });
      }
      const result = await db.prepare(`
        UPDATE product_alternates SET submitted_vendor_id = ?, created_by_profile_id = ?,
          governance_status = 'pending', reviewed_by_profile_id = NULL, review_reason = '',
          reviewed_at = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND governance_status IN ('rejected', 'inactive', 'withdrawn')
      `).bind(vendorId, profile.id, before.id).run();
      if (!result.meta.changes) return Response.json({ error: "The proposal changed; refresh and retry" }, { status: 409 });
      id = before.id;
      action = "product_alternate.resubmitted";
    }
    await appendAuditEvent({
      vendorId, actorProfileId: profile.id, action, entityType: "product_alternate", entityId: id,
      before, after: { ...pair, governanceStatus: "pending", compatibility: compatible },
      requestId: request.headers.get("cf-ray") ?? "",
    }, db);
    return Response.json({ saved: true, alternate: { id, ...pair, governanceStatus: "pending" }, message: "Alternate proposed for administrator review; no automatic substitution is enabled." }, { status: before ? 200 : 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const { profile, vendorId } = await requireAlternateSubmissionAccess(request);
    const id = Number(new URL(request.url).searchParams.get("id"));
    if (!Number.isInteger(id) || id < 1) return Response.json({ error: "Choose a valid proposal" }, { status: 400 });
    const db = getD1();
    const before = await db.prepare(`
      SELECT id, product_id AS productId, alternate_product_id AS alternateProductId,
        submitted_vendor_id AS submittedVendorId, governance_status AS governanceStatus
      FROM product_alternates
      WHERE id = ? AND submitted_vendor_id = ? AND governance_status = 'pending'
      LIMIT 1
    `).bind(id, vendorId).first<Record<string, unknown>>();
    if (!before) return Response.json({ error: "Only your tenant's pending proposal can be withdrawn" }, { status: 404 });
    const reason = "Withdrawn by submitting vendor";
    const result = await db.prepare(`
      UPDATE product_alternates SET governance_status = 'withdrawn', reviewed_by_profile_id = ?,
        review_reason = ?, reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND submitted_vendor_id = ? AND governance_status = 'pending'
    `).bind(profile.id, reason, id, vendorId).run();
    if (!result.meta.changes) return Response.json({ error: "The proposal changed; refresh and retry" }, { status: 409 });
    await appendAuditEvent({ vendorId, actorProfileId: profile.id, action: "product_alternate.withdrawn", entityType: "product_alternate", entityId: id, before, after: { governanceStatus: "withdrawn" }, reason, requestId: request.headers.get("cf-ray") ?? "" }, db);
    return Response.json({ saved: true, alternate: { id, governanceStatus: "withdrawn" } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
