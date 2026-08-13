import { appendAuditEvent } from "./audit.ts";
import { cleanText, escapeProductSqlLike, normalizeName } from "./product-master.ts";

export const manufacturerRequestTypes = ["new", "rename", "merge"] as const;
export const manufacturerRequestStatuses = ["all", "pending", "approved", "rejected", "withdrawn"] as const;
export type ManufacturerRequestType = typeof manufacturerRequestTypes[number];
export type ManufacturerRequestStatus = typeof manufacturerRequestStatuses[number];

export type ManufacturerGovernanceQuery = {
  query: string;
  status: ManufacturerRequestStatus;
  page: number;
  pageSize: number;
};

export type ManufacturerProposal = {
  requestType: ManufacturerRequestType;
  manufacturerId: number | null;
  targetManufacturerId: number | null;
  proposedName: string;
  normalizedProposedName: string;
};

type ManufacturerRequest = {
  id: number;
  requestType: ManufacturerRequestType;
  submittedVendorId: number;
  manufacturerId: number | null;
  targetManufacturerId: number | null;
  proposedName: string;
  normalizedProposedName: string;
  status: ManufacturerRequestStatus;
  version: number;
  manufacturerName: string | null;
  targetManufacturerName: string | null;
};

function boundedInteger(value: string | null, fallback: number, minimum: number, maximum: number) {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function positiveId(value: unknown, label: string) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw new Response(`${label} is invalid`, { status: 400 });
  return id;
}

export function parseManufacturerGovernanceQuery(input: URL | URLSearchParams): ManufacturerGovernanceQuery {
  const parameters = input instanceof URL ? input.searchParams : input;
  const status = parameters.get("status");
  return {
    query: cleanText(parameters.get("q"), 120),
    status: manufacturerRequestStatuses.includes(status as ManufacturerRequestStatus) ? status as ManufacturerRequestStatus : "all",
    page: boundedInteger(parameters.get("page"), 1, 1, 100_000),
    pageSize: boundedInteger(parameters.get("pageSize"), 20, 5, 50),
  };
}

export function parseManufacturerProposal(body: Record<string, unknown>): ManufacturerProposal {
  const requestType = cleanText(body.requestType, 20) as ManufacturerRequestType;
  if (!manufacturerRequestTypes.includes(requestType)) throw new Response("Choose new, rename, or merge", { status: 400 });
  const manufacturerId = requestType === "new" ? null : positiveId(body.manufacturerId, "Manufacturer");
  const targetManufacturerId = requestType === "merge" ? positiveId(body.targetManufacturerId, "Canonical target manufacturer") : null;
  if (manufacturerId && targetManufacturerId && manufacturerId === targetManufacturerId) {
    throw new Response("A manufacturer cannot be merged into itself", { status: 400 });
  }
  const proposedName = requestType === "merge" ? "" : cleanText(body.proposedName, 180);
  const normalizedProposedName = normalizeName(proposedName);
  if (requestType !== "merge" && (proposedName.length < 2 || normalizedProposedName.length < 2)) {
    throw new Response("Manufacturer name must contain at least two letters or numbers", { status: 400 });
  }
  return { requestType, manufacturerId, targetManufacturerId, proposedName, normalizedProposedName };
}

export async function listCanonicalManufacturers(database: D1Database, query: string, limit = 100) {
  const normalizedQuery = normalizeName(query);
  const pattern = `%${escapeProductSqlLike(normalizedQuery)}%`;
  const rows = await database.prepare(`
    SELECT manufacturer.id, manufacturer.name, manufacturer.normalized_name AS normalizedName,
      COUNT(DISTINCT product.id) AS linkedProducts,
      GROUP_CONCAT(DISTINCT CASE WHEN alias.normalized_alias <> manufacturer.normalized_name THEN alias.alias_name END) AS aliases
    FROM manufacturers manufacturer
    JOIN manufacturer_canonical_state state
      ON state.manufacturer_id = manufacturer.id AND state.status = 'active'
    LEFT JOIN manufacturer_aliases alias ON alias.manufacturer_id = manufacturer.id
    LEFT JOIN products product ON product.manufacturer_id = manufacturer.id
    WHERE (? = '' OR manufacturer.normalized_name LIKE ? ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM manufacturer_aliases matched
        WHERE matched.manufacturer_id = manufacturer.id AND matched.normalized_alias LIKE ? ESCAPE '\\'))
    GROUP BY manufacturer.id, manufacturer.name, manufacturer.normalized_name
    ORDER BY linkedProducts DESC, manufacturer.name, manufacturer.id
    LIMIT ?
  `).bind(normalizedQuery, pattern, pattern, Math.max(5, Math.min(100, limit))).all();
  return rows.results;
}

export async function listManufacturerRequests(
  database: D1Database,
  filters: ManufacturerGovernanceQuery,
  scope: { role: "vendor"; vendorId: number } | { role: "admin" },
) {
  const predicates: string[] = [];
  const bindings: Array<string | number> = [];
  if (scope.role === "vendor") {
    predicates.push("request.submitted_vendor_id = ?");
    bindings.push(scope.vendorId);
  }
  if (filters.status !== "all") {
    predicates.push("request.status = ?");
    bindings.push(filters.status);
  }
  const normalizedQuery = normalizeName(filters.query);
  if (normalizedQuery) {
    const pattern = `%${escapeProductSqlLike(normalizedQuery)}%`;
    predicates.push("(request.normalized_proposed_name LIKE ? ESCAPE '\\' OR source.normalized_name LIKE ? ESCAPE '\\' OR target.normalized_name LIKE ? ESCAPE '\\' OR vendor.business_name LIKE ? ESCAPE '\\')");
    bindings.push(pattern, pattern, pattern, pattern);
  }
  const where = predicates.length ? predicates.join(" AND ") : "1 = 1";
  const [count, rows] = await Promise.all([
    database.prepare(`SELECT COUNT(*) AS count FROM manufacturer_change_requests request
      LEFT JOIN manufacturers source ON source.id = request.manufacturer_id
      LEFT JOIN manufacturers target ON target.id = request.target_manufacturer_id
      LEFT JOIN vendors vendor ON vendor.id = request.submitted_vendor_id WHERE ${where}`).bind(...bindings).first<{ count: number }>(),
    database.prepare(`
      SELECT request.id, request.request_type AS requestType,
        request.submitted_vendor_id AS submittedVendorId, vendor.business_name AS submittedVendorName,
        request.manufacturer_id AS manufacturerId, source.name AS manufacturerName,
        request.target_manufacturer_id AS targetManufacturerId, target.name AS targetManufacturerName,
        request.proposed_name AS proposedName, request.status,
        request.review_reason AS reviewReason, request.version,
        request.created_at AS createdAt, request.updated_at AS updatedAt
      FROM manufacturer_change_requests request
      LEFT JOIN manufacturers source ON source.id = request.manufacturer_id
      LEFT JOIN manufacturers target ON target.id = request.target_manufacturer_id
      LEFT JOIN vendors vendor ON vendor.id = request.submitted_vendor_id
      WHERE ${where}
      ORDER BY CASE request.status WHEN 'pending' THEN 0 WHEN 'rejected' THEN 1 ELSE 2 END,
        request.updated_at DESC, request.id DESC LIMIT ? OFFSET ?
    `).bind(...bindings, filters.pageSize, (filters.page - 1) * filters.pageSize).all(),
  ]);
  const total = Number(count?.count ?? 0);
  return { requests: rows.results, pagination: { page: filters.page, pageSize: filters.pageSize, total, totalPages: Math.max(1, Math.ceil(total / filters.pageSize)) } };
}

export async function loadManufacturerRequest(database: D1Database, id: number) {
  return database.prepare(`
    SELECT request.id, request.request_type AS requestType,
      request.submitted_vendor_id AS submittedVendorId,
      request.manufacturer_id AS manufacturerId, source.name AS manufacturerName,
      request.target_manufacturer_id AS targetManufacturerId, target.name AS targetManufacturerName,
      request.proposed_name AS proposedName, request.normalized_proposed_name AS normalizedProposedName,
      request.status, request.version
    FROM manufacturer_change_requests request
    LEFT JOIN manufacturers source ON source.id = request.manufacturer_id
    LEFT JOIN manufacturers target ON target.id = request.target_manufacturer_id
    WHERE request.id = ? LIMIT 1
  `).bind(id).first<ManufacturerRequest>();
}

function approvalCondition() {
  return `EXISTS (SELECT 1 FROM manufacturer_change_requests request
    WHERE request.id = ? AND request.status = 'approved' AND request.reviewed_by_profile_id = ?)`;
}

async function runApprovalBatch(database: D1Database, statements: D1PreparedStatement[], conflictMessage: string) {
  try {
    const results = await database.batch(statements);
    if (!results[0].meta.changes) throw new Response(conflictMessage, { status: 409 });
    return results;
  } catch (error) {
    if (error instanceof Response) throw error;
    if (error instanceof Error && /unique|constraint|manufacturer/i.test(error.message)) {
      throw new Response(conflictMessage, { status: 409 });
    }
    throw error;
  }
}

async function approveNew(database: D1Database, request: ManufacturerRequest, actorProfileId: number, reason: string) {
  const statements = [
    database.prepare(`UPDATE manufacturer_change_requests SET status='approved', reviewed_by_profile_id=?,
      review_reason=?, reviewed_at=CURRENT_TIMESTAMP, version=version+1, updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND request_type='new' AND status='pending' AND version=?
        AND NOT EXISTS (SELECT 1 FROM manufacturers WHERE normalized_name=?)
        AND NOT EXISTS (SELECT 1 FROM manufacturer_aliases WHERE normalized_alias=?)`).bind(actorProfileId, reason, request.id, request.version, request.normalizedProposedName, request.normalizedProposedName),
    database.prepare(`INSERT INTO manufacturers (name, normalized_name)
      SELECT proposed_name, normalized_proposed_name FROM manufacturer_change_requests request
      WHERE request.id=? AND request.status='approved' AND request.reviewed_by_profile_id=?`).bind(request.id, actorProfileId),
    database.prepare(`INSERT INTO manufacturer_canonical_state (manufacturer_id, status, source)
      SELECT manufacturer.id, 'active', 'governed_creation' FROM manufacturers manufacturer
      JOIN manufacturer_change_requests request ON request.normalized_proposed_name=manufacturer.normalized_name
      WHERE request.id=? AND request.reviewed_by_profile_id=?`).bind(request.id, actorProfileId),
    database.prepare(`INSERT INTO manufacturer_aliases (manufacturer_id, alias_name, normalized_alias, provenance, created_by_profile_id)
      SELECT manufacturer.id, manufacturer.name, manufacturer.normalized_name, 'governed_creation', ?
      FROM manufacturers manufacturer JOIN manufacturer_change_requests request
        ON request.normalized_proposed_name=manufacturer.normalized_name
      WHERE request.id=? AND request.reviewed_by_profile_id=?`).bind(actorProfileId, request.id, actorProfileId),
    database.prepare(`INSERT INTO manufacturer_governance_events (request_id, event_type, actor_profile_id, manufacturer_id, detail_json)
      SELECT request.id, 'approved_new', ?, manufacturer.id, ? FROM manufacturer_change_requests request
      JOIN manufacturers manufacturer ON manufacturer.normalized_name=request.normalized_proposed_name
      WHERE request.id=? AND request.reviewed_by_profile_id=?`).bind(actorProfileId, JSON.stringify({ proposedName: request.proposedName }), request.id, actorProfileId),
  ];
  await runApprovalBatch(database, statements, "The manufacturer request changed or now conflicts with an existing name");
  const manufacturer = await database.prepare("SELECT id, name FROM manufacturers WHERE normalized_name=? LIMIT 1").bind(request.normalizedProposedName).first<{ id: number; name: string }>();
  return { manufacturerId: manufacturer?.id ?? null, manufacturerName: manufacturer?.name ?? request.proposedName };
}

async function approveRename(database: D1Database, request: ManufacturerRequest, actorProfileId: number, reason: string) {
  const statements = [
    database.prepare(`UPDATE manufacturer_change_requests SET status='approved', reviewed_by_profile_id=?,
      review_reason=?, reviewed_at=CURRENT_TIMESTAMP, version=version+1, updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND request_type='rename' AND status='pending' AND version=?
        AND EXISTS (SELECT 1 FROM manufacturer_canonical_state WHERE manufacturer_id=? AND status='active')
        AND NOT EXISTS (SELECT 1 FROM manufacturers WHERE normalized_name=? AND id<>?)
        AND NOT EXISTS (SELECT 1 FROM manufacturer_aliases WHERE normalized_alias=? AND manufacturer_id<>?)`).bind(actorProfileId, reason, request.id, request.version, request.manufacturerId, request.normalizedProposedName, request.manufacturerId, request.normalizedProposedName, request.manufacturerId),
    database.prepare(`INSERT INTO manufacturer_aliases (manufacturer_id, alias_name, normalized_alias, provenance, source_manufacturer_id, created_by_profile_id)
      SELECT manufacturer.id, manufacturer.name, manufacturer.normalized_name, 'rename', manufacturer.id, ?
      FROM manufacturers manufacturer WHERE manufacturer.id=? AND ${approvalCondition()}
        AND NOT EXISTS (SELECT 1 FROM manufacturer_aliases WHERE normalized_alias=manufacturer.normalized_name)`).bind(actorProfileId, request.manufacturerId, request.id, actorProfileId),
    database.prepare(`UPDATE manufacturers SET name=(SELECT proposed_name FROM manufacturer_change_requests WHERE id=?),
      normalized_name=(SELECT normalized_proposed_name FROM manufacturer_change_requests WHERE id=?)
      WHERE id=? AND ${approvalCondition()}`).bind(request.id, request.id, request.manufacturerId, request.id, actorProfileId),
    database.prepare(`UPDATE products SET manufacturer=(SELECT proposed_name FROM manufacturer_change_requests WHERE id=?), updated_at=CURRENT_TIMESTAMP
      WHERE manufacturer_id=? AND ${approvalCondition()}`).bind(request.id, request.manufacturerId, request.id, actorProfileId),
    database.prepare(`UPDATE manufacturer_canonical_state SET version=version+1, updated_at=CURRENT_TIMESTAMP
      WHERE manufacturer_id=? AND status='active' AND ${approvalCondition()}`).bind(request.manufacturerId, request.id, actorProfileId),
    database.prepare(`INSERT INTO manufacturer_governance_events (request_id, event_type, actor_profile_id, manufacturer_id, detail_json)
      SELECT id, 'approved_rename', ?, manufacturer_id, ? FROM manufacturer_change_requests
      WHERE id=? AND reviewed_by_profile_id=?`).bind(actorProfileId, JSON.stringify({ before: request.manufacturerName, after: request.proposedName }), request.id, actorProfileId),
  ];
  await runApprovalBatch(database, statements, "The rename request changed or now conflicts with an existing name or alias");
  return { manufacturerId: request.manufacturerId, manufacturerName: request.proposedName };
}

async function approveMerge(database: D1Database, request: ManufacturerRequest, actorProfileId: number, reason: string) {
  const statements = [
    database.prepare(`UPDATE manufacturer_change_requests SET status='approved', reviewed_by_profile_id=?,
      review_reason=?, reviewed_at=CURRENT_TIMESTAMP, version=version+1, updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND request_type='merge' AND status='pending' AND version=? AND manufacturer_id<>target_manufacturer_id
        AND EXISTS (SELECT 1 FROM manufacturer_canonical_state WHERE manufacturer_id=manufacturer_change_requests.manufacturer_id AND status='active')
        AND EXISTS (SELECT 1 FROM manufacturer_canonical_state WHERE manufacturer_id=manufacturer_change_requests.target_manufacturer_id AND status='active')`).bind(actorProfileId, reason, request.id, request.version),
    database.prepare(`INSERT INTO manufacturer_aliases (manufacturer_id, alias_name, normalized_alias, provenance, source_manufacturer_id, created_by_profile_id)
      SELECT request.target_manufacturer_id, source.name, source.normalized_name, 'merge', source.id, ?
      FROM manufacturer_change_requests request JOIN manufacturers source ON source.id=request.manufacturer_id
      WHERE request.id=? AND request.reviewed_by_profile_id=?
        AND NOT EXISTS (SELECT 1 FROM manufacturer_aliases WHERE normalized_alias=source.normalized_name)`).bind(actorProfileId, request.id, actorProfileId),
    database.prepare(`UPDATE manufacturer_aliases SET manufacturer_id=?, source_manufacturer_id=COALESCE(source_manufacturer_id, ?)
      WHERE manufacturer_id=? AND ${approvalCondition()}`).bind(request.targetManufacturerId, request.manufacturerId, request.manufacturerId, request.id, actorProfileId),
    database.prepare(`UPDATE products SET manufacturer_id=?, manufacturer=(SELECT name FROM manufacturers WHERE id=?), updated_at=CURRENT_TIMESTAMP
      WHERE manufacturer_id=? AND ${approvalCondition()}`).bind(request.targetManufacturerId, request.targetManufacturerId, request.manufacturerId, request.id, actorProfileId),
    database.prepare(`UPDATE manufacturer_canonical_state SET merged_into_manufacturer_id=?,
      version=version+1, updated_at=CURRENT_TIMESTAMP
      WHERE merged_into_manufacturer_id=? AND status='merged' AND ${approvalCondition()}`).bind(request.targetManufacturerId, request.manufacturerId, request.id, actorProfileId),
    database.prepare(`UPDATE manufacturer_canonical_state SET status='merged', merged_into_manufacturer_id=?,
      version=version+1, updated_at=CURRENT_TIMESTAMP WHERE manufacturer_id=? AND status='active' AND ${approvalCondition()}`).bind(request.targetManufacturerId, request.manufacturerId, request.id, actorProfileId),
    database.prepare(`INSERT INTO manufacturer_governance_events (request_id, event_type, actor_profile_id, manufacturer_id, target_manufacturer_id, detail_json)
      SELECT id, 'approved_merge', ?, manufacturer_id, target_manufacturer_id, ? FROM manufacturer_change_requests
      WHERE id=? AND reviewed_by_profile_id=?`).bind(actorProfileId, JSON.stringify({ source: request.manufacturerName, target: request.targetManufacturerName }), request.id, actorProfileId),
  ];
  await runApprovalBatch(database, statements, "The merge request changed or one manufacturer is no longer canonical and active");
  return { manufacturerId: request.targetManufacturerId, manufacturerName: request.targetManufacturerName };
}

export async function approveManufacturerRequest(database: D1Database, request: ManufacturerRequest, actorProfileId: number, reason: string, requestId = "") {
  const detail = request.requestType === "new"
    ? await approveNew(database, request, actorProfileId, reason)
    : request.requestType === "rename"
      ? await approveRename(database, request, actorProfileId, reason)
      : await approveMerge(database, request, actorProfileId, reason);
  await appendAuditEvent({
    vendorId: request.submittedVendorId, actorProfileId, action: `admin.manufacturer.${request.requestType}.approved`,
    entityType: "manufacturer_change_request", entityId: request.id, before: request,
    after: { status: "approved", ...detail }, reason, requestId,
  }, database);
  return detail;
}
