import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  DOCUMENT_UPLOAD_QUOTAS,
  DocumentUploadQuotaError,
  documentUploadQuotaResponse,
  reserveDocumentUpload,
} from "../lib/document-upload-quota.ts";

const route = readFileSync(new URL("../app/api/documents/route.ts", import.meta.url), "utf8");
const quotaSource = readFileSync(new URL("../lib/document-upload-quota.ts", import.meta.url), "utf8");

class Statement {
  parameters = [];
  constructor(database, sql) { this.database = database; this.sql = sql; }
  bind(...parameters) { this.parameters = parameters; return this; }
  async first() { return this.database.prepare(this.sql).get(...this.parameters); }
  async run() {
    const result = this.database.prepare(this.sql).run(...this.parameters);
    return { meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid) } };
  }
}

class D1 {
  constructor(database) { this.database = database; }
  prepare(sql) { return new Statement(this.database, sql); }
}

function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE stored_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_profile_id INTEGER,
    vendor_id INTEGER,
    purpose TEXT NOT NULL,
    object_key TEXT NOT NULL UNIQUE,
    original_filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    malware_status TEXT NOT NULL DEFAULT 'pending',
    status TEXT NOT NULL DEFAULT 'active'
  )`);
  return { sqlite, database: new D1(sqlite) };
}

function reservation(overrides = {}) {
  return {
    ownerProfileId: 1,
    vendorId: null,
    purpose: "prescription",
    objectKey: `prescription/1/${crypto.randomUUID()}.png`,
    filename: "prescription.png",
    mimeType: "image/png",
    sizeBytes: 1024,
    checksum: "a".repeat(64),
    ...overrides,
  };
}

function seed(sqlite, { ownerProfileId, vendorId = null, sizeBytes = 1, status = "active", sequence }) {
  sqlite.prepare(`INSERT INTO stored_documents
    (owner_profile_id,vendor_id,purpose,object_key,original_filename,mime_type,size_bytes,sha256,malware_status,status)
    VALUES (?,?,'prescription',?,'seed.png','image/png',?,'seed','content_validated',?)`)
    .run(ownerProfileId, vendorId, `seed/${sequence}`, sizeBytes, status);
}

test("profile document-count and byte quotas return stable non-enumerating errors", async (t) => {
  const countFixture = fixture();
  t.after(() => countFixture.sqlite.close());
  for (let index = 0; index < DOCUMENT_UPLOAD_QUOTAS.profile.documents; index += 1) {
    seed(countFixture.sqlite, { ownerProfileId: 1, sequence: index });
  }
  await assert.rejects(
    reserveDocumentUpload(countFixture.database, reservation()),
    (error) => error instanceof DocumentUploadQuotaError
      && error.status === 429
      && error.code === "document_count_quota_exceeded"
      && !/\b100\b/.test(error.message),
  );

  const byteFixture = fixture();
  t.after(() => byteFixture.sqlite.close());
  seed(byteFixture.sqlite, {
    ownerProfileId: 1,
    sizeBytes: DOCUMENT_UPLOAD_QUOTAS.profile.bytes - 10,
    sequence: "bytes",
  });
  await assert.rejects(
    reserveDocumentUpload(byteFixture.database, reservation({ sizeBytes: 11 })),
    (error) => error instanceof DocumentUploadQuotaError
      && error.status === 413
      && error.code === "document_storage_quota_exceeded"
      && !/\d+\s*(?:MB|GB|bytes)/i.test(error.message),
  );
});

test("quota HTTP responses are stable, private, and do not disclose account usage", async () => {
  for (const [status, code, message] of [
    [413, "document_storage_quota_exceeded", "Document storage capacity has been reached"],
    [429, "document_count_quota_exceeded", "Document upload capacity has been reached"],
  ]) {
    const response = documentUploadQuotaResponse(new DocumentUploadQuotaError(status, code, message));
    assert.equal(response.status, status);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { error: message, code });
  }
});

test("vendor count and byte quotas aggregate across uploader profiles", async (t) => {
  const countFixture = fixture();
  t.after(() => countFixture.sqlite.close());
  for (let index = 0; index < DOCUMENT_UPLOAD_QUOTAS.vendor.documents; index += 1) {
    seed(countFixture.sqlite, { ownerProfileId: index + 1, vendorId: 77, sequence: index });
  }
  await assert.rejects(
    reserveDocumentUpload(countFixture.database, reservation({ ownerProfileId: 999, vendorId: 77 })),
    (error) => error instanceof DocumentUploadQuotaError && error.status === 429,
  );

  const byteFixture = fixture();
  t.after(() => byteFixture.sqlite.close());
  const existingBytes = 255 * 1024 * 1024;
  for (let index = 0; index < 4; index += 1) {
    seed(byteFixture.sqlite, { ownerProfileId: index + 1, vendorId: 88, sizeBytes: existingBytes, sequence: index });
  }
  await assert.rejects(
    reserveDocumentUpload(byteFixture.database, reservation({ ownerProfileId: 99, vendorId: 88, sizeBytes: 5 * 1024 * 1024 })),
    (error) => error instanceof DocumentUploadQuotaError
      && error.status === 413
      && error.code === "document_storage_quota_exceeded",
  );
});

test("atomic upload_pending reservations close concurrent quota attempts", async (t) => {
  const { sqlite, database } = fixture();
  t.after(() => sqlite.close());
  for (let index = 0; index < DOCUMENT_UPLOAD_QUOTAS.profile.documents - 1; index += 1) {
    seed(sqlite, { ownerProfileId: 7, sequence: index });
  }
  const attempts = await Promise.allSettled([
    reserveDocumentUpload(database, reservation({ ownerProfileId: 7, objectKey: "race/one" })),
    reserveDocumentUpload(database, reservation({ ownerProfileId: 7, objectKey: "race/two" })),
  ]);
  assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = attempts.find((result) => result.status === "rejected");
  assert.ok(rejected?.reason instanceof DocumentUploadQuotaError);
  assert.equal(rejected.reason.status, 429);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM stored_documents WHERE owner_profile_id=7 AND status='upload_pending'").get().count, 1);
});

test("delivery proof is disabled before bytes or storage and R2 follows an atomic quota reservation", () => {
  assert.doesNotMatch(route.match(/const allowedPurposes[^;]+/)?.[0] ?? "", /delivery_proof/);
  const disabled = route.indexOf('purpose === "delivery_proof"');
  assert.ok(disabled >= 0);
  assert.ok(disabled < route.indexOf("file.arrayBuffer()"));
  assert.ok(disabled < route.indexOf("getR2().put"));
  assert.match(route, /This document upload is not available/);

  const reservation = route.indexOf("await reserveDocumentUpload(db");
  const r2Put = route.indexOf("await getR2().put");
  assert.ok(reservation >= 0 && reservation < r2Put);
  assert.match(route, /status='upload_pending'/);
  assert.match(route, /UPDATE stored_documents SET status='active'/);
  assert.match(route, /DELETE FROM stored_documents WHERE id=\?/);
  assert.match(route, /getR2\(\)\.delete\(objectKey\)/);
  assert.match(quotaSource, /'pending_scan','upload_pending'/);
  assert.match(quotaSource, /'quarantined'/);
  assert.match(route, /matchesSignature/);
});
