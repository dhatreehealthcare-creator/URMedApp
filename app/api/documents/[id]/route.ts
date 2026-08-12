import { getD1 } from "../../../../db/d1";
import { getR2 } from "../../../../db/storage";
import { errorResponse, requireLocalProfile } from "../../../../lib/auth-server";

type DocumentRow = {
  id: number; ownerProfileId: number | null; vendorId: number | null; objectKey: string;
  originalFilename: string; mimeType: string; status: string;
};

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const id = Number((await context.params).id);
    if (!Number.isInteger(id) || id < 1) return Response.json({ error: "Document is invalid" }, { status: 400 });
    const row = await getD1().prepare(`
      SELECT id, owner_profile_id AS ownerProfileId, vendor_id AS vendorId, object_key AS objectKey,
        original_filename AS originalFilename, mime_type AS mimeType, status
      FROM stored_documents WHERE id = ? LIMIT 1
    `).bind(id).first<DocumentRow>();
    if (!row || row.status !== "active") return Response.json({ error: "Document not found" }, { status: 404 });
    const { profile } = await requireLocalProfile(request, ["customer", "vendor", "admin", "delivery"]);
    const allowed = row.ownerProfileId === profile.id || (row.vendorId && row.vendorId === profile.vendorId) || profile.role === "admin";
    if (!allowed) return Response.json({ error: "Document not found" }, { status: 404 });
    const object = await getR2().get(row.objectKey);
    if (!object) return Response.json({ error: "Document bytes are unavailable" }, { status: 404 });
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
