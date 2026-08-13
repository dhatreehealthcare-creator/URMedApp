import { getD1 } from "../../../../../../../db/d1";
import { prepareAuditEventStatement } from "../../../../../../../lib/audit";
import { errorResponse } from "../../../../../../../lib/auth-server";
import { OfflinePosError, parsePosPrescriptionReview } from "../../../../../../../lib/offline-pos";
import { requireVendorPermission } from "../../../../../../../lib/vendor-access";

function respond(error: unknown) {
  if (error instanceof OfflinePosError) return Response.json({ error: error.message }, { status: error.status });
  return errorResponse(error);
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { profile, vendorId } = await requireVendorPermission(request, "prescription.review");
    const captureId = Number((await context.params).id);
    if (!Number.isInteger(captureId) || captureId < 1) throw new OfflinePosError("Counter prescription is invalid");
    const review = parsePosPrescriptionReview(await request.json());
    const database = getD1();
    const pharmacist = await database.prepare(`SELECT pharmacist.id FROM pharmacists pharmacist
      JOIN account_profiles profile ON profile.id = pharmacist.profile_id
      WHERE pharmacist.vendor_id = ? AND pharmacist.profile_id = ? AND pharmacist.verification_status = 'verified'
        AND pharmacist.active = 1 AND (pharmacist.valid_until IS NULL OR date(pharmacist.valid_until) >= date('now'))
        AND profile.status = 'active' AND profile.email_verified = 1 AND profile.phone_verified = 1 LIMIT 1`)
      .bind(vendorId, profile.id).first<{ id: number }>();
    if (!pharmacist) throw new OfflinePosError("A currently verified pharmacist must perform this review", 403);
    const statements: D1PreparedStatement[] = [database.prepare(`INSERT INTO offline_prescription_reviews
      (offline_prescription_id,pharmacist_id,decision,notes)
      SELECT id,?,?,? FROM offline_prescriptions WHERE id = ? AND vendor_id = ? AND status = 'uploaded'`)
      .bind(pharmacist.id, review.decision, review.notes, captureId, vendorId)];
    for (const item of review.items) {
      statements.push(database.prepare(`INSERT INTO offline_prescription_review_items (review_id,product_id,quantity_approved)
        SELECT review.id,?,? FROM offline_prescription_reviews review
        JOIN offline_prescriptions capture ON capture.id = review.offline_prescription_id
        WHERE review.offline_prescription_id = ? AND capture.vendor_id = ?`)
        .bind(item.productId, item.quantityApproved, captureId, vendorId));
    }
    statements.push(database.prepare(`UPDATE offline_prescriptions SET status = ?, rejection_reason = ?, reviewed_at = CURRENT_TIMESTAMP
      WHERE id = ? AND vendor_id = ? AND status = 'uploaded'
        AND EXISTS (SELECT 1 FROM offline_prescription_reviews review
          WHERE review.offline_prescription_id = offline_prescriptions.id AND review.decision = ?)`)
      .bind(review.decision, review.decision === "approved" ? "" : review.notes, captureId, vendorId, review.decision));
    statements.push(await prepareAuditEventStatement({
      vendorId, actorProfileId: profile.id, action: `offline_prescription.${review.decision}`,
      entityType: "offline_prescription", entityId: captureId,
      after: { decision: review.decision, approvedItems: review.items }, reason: review.notes,
      requestId: request.headers.get("cf-ray") ?? "",
    }, database, { whenPreviousStatementChanged: true }));
    const results = await database.batch(statements);
    if (!results.at(-2)?.meta.changes) throw new OfflinePosError("The prescription was already reviewed or belongs to another pharmacy", 409);
    return Response.json({ prescription: { id: captureId, status: review.decision } }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return respond(error);
  }
}
