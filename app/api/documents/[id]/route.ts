import { getD1 } from "../../../../db/d1";
import { getR2 } from "../../../../db/storage";
import { appendAuditEvent } from "../../../../lib/audit";
import { errorResponse, requireLocalProfile } from "../../../../lib/auth-server";
import { canDownloadStoredDocument } from "../../../../lib/document-access";

type DocumentRow = {
  id: number; ownerProfileId: number | null; vendorId: number | null; objectKey: string;
  purpose: string; originalFilename: string; mimeType: string; status: string;
};

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const id = Number((await context.params).id);
    if (!Number.isInteger(id) || id < 1) return Response.json({ error: "Document is invalid" }, { status: 400 });
    const db = getD1();
    const row = await db.prepare(`
      SELECT id, owner_profile_id AS ownerProfileId, vendor_id AS vendorId, object_key AS objectKey,
        purpose, original_filename AS originalFilename, mime_type AS mimeType, status
      FROM stored_documents WHERE id = ? LIMIT 1
    `).bind(id).first<DocumentRow>();
    if (!row || row.status !== "active") return Response.json({ error: "Document not found" }, { status: 404 });
    const { profile } = await requireLocalProfile(request, ["customer", "vendor", "admin", "delivery"], { allowIncompleteVendor: true });
    const allowed = await canDownloadStoredDocument({ request, profile, document: row, database: db });
    if (!allowed) return Response.json({ error: "Document not found" }, { status: 404 });
    const object = await getR2().get(row.objectKey);
    if (!object) return Response.json({ error: "Document bytes are unavailable" }, { status: 404 });
    await appendAuditEvent({
      vendorId: row.vendorId,
      actorProfileId: profile.id,
      action: "document.downloaded",
      entityType: "stored_document",
      entityId: row.id,
      after: { purpose: row.purpose, filename: row.originalFilename },
      requestId: request.headers.get("cf-ray") ?? "",
    }, db);
    return new Response(object.body, { headers: {
      "Content-Type": row.mimeType,
      "Content-Disposition": `inline; filename="${row.originalFilename.replaceAll('"', "")}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    } });
  } catch (error) {
    return errorResponse(error);
  }
}
