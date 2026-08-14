export const DOCUMENT_UPLOAD_QUOTAS = {
  profile: { documents: 100, bytes: 256 * 1024 * 1024 },
  vendor: { documents: 500, bytes: 1024 * 1024 * 1024 },
} as const;

export class DocumentUploadQuotaError extends Error {
  readonly status: 413 | 429;
  readonly code: "document_storage_quota_exceeded" | "document_count_quota_exceeded" | "document_quota_changed";

  constructor(
    status: 413 | 429,
    code: "document_storage_quota_exceeded" | "document_count_quota_exceeded" | "document_quota_changed",
    message: string,
  ) {
    super(message);
    this.name = "DocumentUploadQuotaError";
    this.status = status;
    this.code = code;
  }
}

export function documentUploadQuotaResponse(error: DocumentUploadQuotaError) {
  return Response.json({ error: error.message, code: error.code }, {
    status: error.status,
    headers: { "Cache-Control": "no-store" },
  });
}

type Usage = { documentCount: number; totalBytes: number };

type ReservationInput = {
  ownerProfileId: number;
  vendorId: number | null;
  purpose: string;
  objectKey: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  checksum: string;
};

const quotaStatuses = "('active','upload_pending','quarantined')";

async function usage(database: D1Database, column: "owner_profile_id" | "vendor_id", id: number): Promise<Usage> {
  const row = await database.prepare(`SELECT COUNT(*) AS documentCount,
    COALESCE(SUM(size_bytes),0) AS totalBytes FROM stored_documents
    WHERE ${column}=? AND status IN ${quotaStatuses}`).bind(id).first<Usage>();
  return { documentCount: Number(row?.documentCount ?? 0), totalBytes: Number(row?.totalBytes ?? 0) };
}

function enforceUsage(current: Usage, incomingBytes: number, limit: { documents: number; bytes: number }) {
  if (current.documentCount >= limit.documents) {
    throw new DocumentUploadQuotaError(
      429,
      "document_count_quota_exceeded",
      "Document upload capacity has been reached. Remove an unused document or try again later",
    );
  }
  if (current.totalBytes + incomingBytes > limit.bytes) {
    throw new DocumentUploadQuotaError(
      413,
      "document_storage_quota_exceeded",
      "Document storage capacity has been reached. Remove an unused document before uploading another",
    );
  }
}

export async function assertDocumentUploadQuota(
  database: D1Database,
  ownerProfileId: number,
  vendorId: number | null,
  incomingBytes: number,
) {
  enforceUsage(await usage(database, "owner_profile_id", ownerProfileId), incomingBytes, DOCUMENT_UPLOAD_QUOTAS.profile);
  if (vendorId !== null) enforceUsage(await usage(database, "vendor_id", vendorId), incomingBytes, DOCUMENT_UPLOAD_QUOTAS.vendor);
}

/**
 * Atomically reserves existing stored_documents capacity before an R2 write.
 * Counting upload_pending rows closes the check/put race without new schema.
 */
export async function reserveDocumentUpload(database: D1Database, input: ReservationInput): Promise<number> {
  await assertDocumentUploadQuota(database, input.ownerProfileId, input.vendorId, input.sizeBytes);
  const inserted = await database.prepare(`INSERT INTO stored_documents
    (owner_profile_id,vendor_id,purpose,object_key,original_filename,mime_type,size_bytes,sha256,malware_status,status)
    SELECT ?,?,?,?,?,?,?,?,'pending_scan','upload_pending'
    WHERE (SELECT COUNT(*) FROM stored_documents
      WHERE owner_profile_id=? AND status IN ${quotaStatuses}) < ?
      AND (SELECT COALESCE(SUM(size_bytes),0) FROM stored_documents
        WHERE owner_profile_id=? AND status IN ${quotaStatuses}) + ? <= ?
      AND (? IS NULL OR (
        (SELECT COUNT(*) FROM stored_documents
          WHERE vendor_id=? AND status IN ${quotaStatuses}) < ?
        AND (SELECT COALESCE(SUM(size_bytes),0) FROM stored_documents
          WHERE vendor_id=? AND status IN ${quotaStatuses}) + ? <= ?
      ))`)
    .bind(
      input.ownerProfileId, input.vendorId, input.purpose, input.objectKey, input.filename,
      input.mimeType, input.sizeBytes, input.checksum,
      input.ownerProfileId, DOCUMENT_UPLOAD_QUOTAS.profile.documents,
      input.ownerProfileId, input.sizeBytes, DOCUMENT_UPLOAD_QUOTAS.profile.bytes,
      input.vendorId, input.vendorId, DOCUMENT_UPLOAD_QUOTAS.vendor.documents,
      input.vendorId, input.sizeBytes, DOCUMENT_UPLOAD_QUOTAS.vendor.bytes,
    ).run();
  if (inserted.meta.changes) return Number(inserted.meta.last_row_id);

  // A concurrent reservation may have consumed the remaining allowance after
  // preflight. Re-read for a stable limit response; otherwise ask for retry.
  await assertDocumentUploadQuota(database, input.ownerProfileId, input.vendorId, input.sizeBytes);
  throw new DocumentUploadQuotaError(
    429,
    "document_quota_changed",
    "Document upload capacity changed. Try the upload again",
  );
}
