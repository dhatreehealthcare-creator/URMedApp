import { getD1 } from "../../../db/d1";
import { getR2 } from "../../../db/storage";
import { appendAuditEvent } from "../../../lib/audit";
import { errorResponse, requireLocalProfile } from "../../../lib/auth-server";
import { DocumentUploadQuotaError, documentUploadQuotaResponse, reserveDocumentUpload } from "../../../lib/document-upload-quota";
import { requireVendorOnboardingAccess, requireVendorPermission } from "../../../lib/vendor-access";

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const allowedPurposes = new Set(["drug_licence", "pharmacist_registration", "prescription", "offline_prescription"]);
const mimeByExtension: Record<string, string[]> = {
  jpg: ["image/jpeg"], jpeg: ["image/jpeg"], png: ["image/png"], pdf: ["application/pdf"],
  doc: ["application/msword", "application/octet-stream"],
  docx: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/zip", "application/octet-stream"],
};

function matchesSignature(extension: string, bytes: Uint8Array) {
  if (extension === "jpg" || extension === "jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (extension === "png") return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value);
  if (extension === "pdf") return String.fromCharCode(...bytes.slice(0, 5)) === "%PDF-";
  if (extension === "doc") return [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((value, index) => bytes[index] === value);
  if (extension === "docx") return bytes[0] === 0x50 && bytes[1] === 0x4b && [0x03, 0x05, 0x07].includes(bytes[2]) && [0x04, 0x06, 0x08].includes(bytes[3]);
  return false;
}

async function sha256Hex(buffer: ArrayBuffer) {
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function POST(request: Request) {
  let objectKey = "";
  let documentId = 0;
  try {
    const { profile } = await requireLocalProfile(request, ["customer", "vendor", "delivery"], { allowIncompleteVendor: true });
    const form = await request.formData();
    const file = form.get("file");
    const purpose = String(form.get("purpose") ?? "").trim();
    if (!(file instanceof File)) return Response.json({ error: "Choose a document to upload" }, { status: 400 });
    if (purpose === "delivery_proof") {
      return Response.json({ error: "This document upload is not available" }, { status: 409 });
    }
    if (!allowedPurposes.has(purpose)) return Response.json({ error: "Document purpose is invalid" }, { status: 400 });
    if (!file.size || file.size > MAX_FILE_BYTES) return Response.json({ error: "Document must be smaller than 8 MB" }, { status: 400 });
    const filename = file.name.replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 160);
    const extension = filename.split(".").pop()?.toLowerCase() ?? "";
    if (!mimeByExtension[extension]) return Response.json({ error: "Only JPG, JPEG, PNG, PDF, DOC and DOCX documents are accepted" }, { status: 400 });
    const declaredMime = file.type || "application/octet-stream";
    if (!mimeByExtension[extension].includes(declaredMime)) return Response.json({ error: "The filename and document type do not match" }, { status: 400 });
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer.slice(0, 16));
    if (!matchesSignature(extension, bytes)) return Response.json({ error: "The document contents do not match its file type" }, { status: 400 });

    let vendorId: number | null = null;
    if (purpose === "drug_licence" || purpose === "pharmacist_registration") {
      if (profile.role !== "vendor") return Response.json({ error: "Only a pharmacy may upload this document" }, { status: 403 });
      vendorId = (await requireVendorOnboardingAccess(request)).vendorId;
    } else if (purpose === "offline_prescription") {
      if (profile.role !== "vendor") return Response.json({ error: "Only an operational pharmacy may capture a counter prescription" }, { status: 403 });
      vendorId = (await requireVendorPermission(request, "sale.write", { profile })).vendorId;
    } else if (purpose === "prescription" && profile.role !== "customer") {
      return Response.json({ error: "Only a customer may upload a prescription" }, { status: 403 });
    }
    const checksum = await sha256Hex(buffer);
    const candidateObjectKey = `${purpose}/${vendorId ?? profile.id}/${crypto.randomUUID()}.${extension}`;
    const db = getD1();
    documentId = await reserveDocumentUpload(db, {
      ownerProfileId: profile.id,
      vendorId,
      purpose,
      objectKey: candidateObjectKey,
      filename,
      mimeType: declaredMime,
      sizeBytes: file.size,
      checksum,
    });
    objectKey = candidateObjectKey;
    await getR2().put(objectKey, buffer, {
      httpMetadata: { contentType: declaredMime, contentDisposition: `inline; filename="${filename.replaceAll('"', "")}"` },
      customMetadata: { purpose, sha256: checksum, ownerProfileId: String(profile.id), vendorId: String(vendorId ?? "") },
    });
    const activated = await db.prepare(`UPDATE stored_documents SET status='active'
      WHERE id=? AND owner_profile_id=? AND status='upload_pending'`).bind(documentId, profile.id).run();
    if (!activated.meta.changes) throw new Error("Document metadata changed before upload activation");
    await appendAuditEvent({ vendorId, actorProfileId: profile.id, action: "document.uploaded", entityType: "stored_document", entityId: documentId, after: { purpose, filename, sizeBytes: file.size, sha256: checksum }, requestId: request.headers.get("cf-ray") ?? "" });
    return Response.json({ document: { id: documentId, filename, purpose, sizeBytes: file.size, status: "content_validated" } }, { status: 201 });
  } catch (error) {
    if (objectKey) {
      try { await getR2().delete(objectKey); } catch { /* best-effort R2 rollback */ }
    }
    if (documentId) {
      try { await getD1().prepare("DELETE FROM stored_documents WHERE id=?").bind(documentId).run(); } catch { /* best-effort metadata rollback */ }
    }
    if (error instanceof DocumentUploadQuotaError) {
      return documentUploadQuotaResponse(error);
    }
    return errorResponse(error);
  }
}
