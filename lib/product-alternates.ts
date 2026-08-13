import { appendAuditEvent } from "./audit.ts";
import { getD1 } from "../db/d1.ts";
import { cleanText, escapeProductSqlLike, normalizeName } from "./product-master.ts";
import { requireVendorPermission } from "./vendor-access.ts";

export const alternateGovernanceStatuses = ["all", "pending", "approved", "rejected", "inactive", "withdrawn"] as const;
export type AlternateGovernanceStatus = typeof alternateGovernanceStatuses[number];

export type AlternateQuery = {
  productId: number | null;
  query: string;
  status: AlternateGovernanceStatus;
  page: number;
  pageSize: number;
};

export type CompatibleAlternatePair = {
  productId: number;
  alternateProductId: number;
  productName: string;
  alternateProductName: string;
  normalizedGenericName: string;
  genericName: string;
  dosageFormId: number;
  dosageFormName: string;
  strengthValue: string;
  strengthUnit: string;
};

function boundedInteger(value: string | null, fallback: number, minimum: number, maximum: number) {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function oneOf<const Values extends readonly string[]>(value: string | null, values: Values, fallback: Values[number]) {
  return values.includes(value ?? "") ? value as Values[number] : fallback;
}

export function parseAlternateQuery(input: URL | URLSearchParams): AlternateQuery {
  const parameters = input instanceof URL ? input.searchParams : input;
  const rawProductId = Number(parameters.get("productId"));
  return {
    productId: Number.isInteger(rawProductId) && rawProductId > 0 ? rawProductId : null,
    query: cleanText(parameters.get("q"), 120),
    status: oneOf(parameters.get("status"), alternateGovernanceStatuses, "all"),
    page: boundedInteger(parameters.get("page"), 1, 1, 100_000),
    pageSize: boundedInteger(parameters.get("pageSize"), 12, 5, 50),
  };
}

export function canonicalProductPair(firstProductId: unknown, secondProductId: unknown) {
  const first = Number(firstProductId);
  const second = Number(secondProductId);
  if (!Number.isInteger(first) || first < 1 || !Number.isInteger(second) || second < 1) {
    throw new Response("Choose two valid products", { status: 400 });
  }
  if (first === second) throw new Response("A product cannot be its own alternate", { status: 400 });
  return first < second
    ? { productId: first, alternateProductId: second }
    : { productId: second, alternateProductId: first };
}

export async function requireAlternateSubmissionAccess(request: Request) {
  const access = await requireVendorPermission(request, "product.submit");
  if (access.staffRole === "owner") return access;
  if (access.staffRole !== "pharmacist") {
    throw new Response("Only the pharmacy owner or a verified pharmacist may propose an alternate", { status: 403 });
  }
  const pharmacist = await getD1().prepare(`
    SELECT id FROM pharmacists
    WHERE vendor_id = ? AND profile_id = ? AND active = 1
      AND verification_status = 'verified'
      AND (valid_until IS NULL OR date(valid_until) >= date('now'))
    LIMIT 1
  `).bind(access.vendorId, access.profile.id).first();
  if (!pharmacist) throw new Response("A currently verified pharmacist profile is required to propose clinical alternates", { status: 403 });
  return access;
}

export async function loadCompatibleAlternatePair(database: D1Database, firstProductId: unknown, secondProductId: unknown) {
  const pair = canonicalProductPair(firstProductId, secondProductId);
  const result = await database.prepare(`
    SELECT product.id AS productId, alternate.id AS alternateProductId,
      product.trade_name AS productName, alternate.trade_name AS alternateProductName,
      product.normalized_generic_name AS normalizedGenericName,
      product.generic_name AS genericName, product.dosage_form_id AS dosageFormId,
      form.name AS dosageFormName, product.strength_value AS strengthValue,
      product.strength_unit AS strengthUnit
    FROM products product
    JOIN products alternate ON alternate.id = ?
    JOIN dosage_forms form ON form.id = product.dosage_form_id AND form.status = 'active'
    WHERE product.id = ?
      AND product.active = 1 AND product.governance_status = 'approved'
      AND alternate.active = 1 AND alternate.governance_status = 'approved'
      AND trim(product.normalized_generic_name) <> ''
      AND product.normalized_generic_name = alternate.normalized_generic_name
      AND product.dosage_form_id = alternate.dosage_form_id
      AND product.strength_value = alternate.strength_value
      AND product.strength_unit = alternate.strength_unit
    LIMIT 1
  `).bind(pair.alternateProductId, pair.productId).first<CompatibleAlternatePair>();
  if (!result) {
    throw new Response("Alternates require two active approved products with the exact same normalized generic, dosage form, strength value and strength unit", { status: 409 });
  }
  return result;
}

export async function listVendorAlternateCandidates(database: D1Database, vendorId: number, filters: AlternateQuery) {
  if (!filters.productId) throw new Response("Choose an approved product before searching alternates", { status: 400 });
  const base = await database.prepare(`
    SELECT product.id, product.trade_name AS tradeName, product.generic_name AS genericName,
      product.normalized_generic_name AS normalizedGenericName,
      product.dosage_form_id AS dosageFormId, form.name AS dosageFormName,
      product.strength_value AS strengthValue, product.strength_unit AS strengthUnit
    FROM products product JOIN dosage_forms form ON form.id = product.dosage_form_id AND form.status = 'active'
    WHERE product.id = ? AND product.active = 1 AND product.governance_status = 'approved'
      AND trim(product.normalized_generic_name) <> ''
      AND product.strength_value IS NOT NULL AND product.strength_unit IS NOT NULL
    LIMIT 1
  `).bind(filters.productId).first<{
    id: number; tradeName: string; genericName: string; normalizedGenericName: string;
    dosageFormId: number; dosageFormName: string; strengthValue: string; strengthUnit: string;
  }>();
  if (!base) throw new Response("The selected product is not eligible for governed alternate search", { status: 409 });
  const query = normalizeName(filters.query);
  const pattern = `%${escapeProductSqlLike(query)}%`;
  const bindings = [
    base.id,
    base.normalizedGenericName,
    base.dosageFormId,
    base.strengthValue,
    base.strengthUnit,
    query,
    pattern,
    pattern,
    filters.pageSize,
    (filters.page - 1) * filters.pageSize,
  ];
  const rows = await database.prepare(`
    SELECT candidate.id, candidate.trade_name AS tradeName, candidate.generic_name AS genericName,
      form.name AS dosageFormName, candidate.strength_value AS strengthValue,
      candidate.strength_unit AS strengthUnit, manufacturer.name AS manufacturerName,
      link.id AS linkId, link.governance_status AS linkStatus,
      CASE WHEN link.submitted_vendor_id = ? THEN 1 ELSE 0 END AS ownedProposal
    FROM products candidate
    JOIN dosage_forms form ON form.id = candidate.dosage_form_id AND form.status = 'active'
    JOIN manufacturers manufacturer ON manufacturer.id = candidate.manufacturer_id
    JOIN manufacturer_canonical_state manufacturer_state
      ON manufacturer_state.manufacturer_id = manufacturer.id AND manufacturer_state.status = 'active'
    LEFT JOIN product_alternates link
      ON link.product_id = min(candidate.id, ?)
        AND link.alternate_product_id = max(candidate.id, ?)
        AND (link.governance_status = 'approved' OR link.submitted_vendor_id = ?)
    WHERE candidate.id <> ?
      AND candidate.active = 1 AND candidate.governance_status = 'approved'
      AND candidate.normalized_generic_name = ?
      AND candidate.dosage_form_id = ?
      AND candidate.strength_value = ? AND candidate.strength_unit = ?
      AND (? = '' OR candidate.normalized_trade_name LIKE ? ESCAPE '\\'
        OR manufacturer.normalized_name LIKE ? ESCAPE '\\')
    ORDER BY CASE link.governance_status WHEN 'approved' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
      candidate.normalized_trade_name, candidate.id
    LIMIT ? OFFSET ?
  `).bind(
    vendorId,
    base.id,
    base.id,
    vendorId,
    ...bindings,
  ).all();
  const count = await database.prepare(`
    SELECT COUNT(*) AS count FROM products candidate
    JOIN manufacturers manufacturer ON manufacturer.id = candidate.manufacturer_id
    JOIN manufacturer_canonical_state manufacturer_state
      ON manufacturer_state.manufacturer_id = manufacturer.id AND manufacturer_state.status = 'active'
    WHERE candidate.id <> ?
      AND candidate.active = 1 AND candidate.governance_status = 'approved'
      AND candidate.normalized_generic_name = ?
      AND candidate.dosage_form_id = ?
      AND candidate.strength_value = ? AND candidate.strength_unit = ?
      AND (? = '' OR candidate.normalized_trade_name LIKE ? ESCAPE '\\'
        OR manufacturer.normalized_name LIKE ? ESCAPE '\\')
  `).bind(base.id, base.normalizedGenericName, base.dosageFormId, base.strengthValue, base.strengthUnit, query, pattern, pattern).first<{ count: number }>();
  const total = Number(count?.count ?? 0);
  return {
    base,
    candidates: rows.results,
    pagination: { page: filters.page, pageSize: filters.pageSize, total, totalPages: Math.max(1, Math.ceil(total / filters.pageSize)) },
    policy: {
      compatibility: "exact_normalized_generic_dosage_form_strength_value_unit",
      automaticSubstitution: false,
      approvalAuthority: "active_admin",
    },
  };
}

export async function listAdminAlternateQueue(database: D1Database, filters: AlternateQuery) {
  const predicates: string[] = [];
  const bindings: Array<string | number> = [];
  if (filters.status !== "all") {
    predicates.push("link.governance_status = ?");
    bindings.push(filters.status);
  }
  const query = normalizeName(filters.query);
  if (query) {
    const pattern = `%${escapeProductSqlLike(query)}%`;
    predicates.push(`(product.normalized_trade_name LIKE ? ESCAPE '\\'
      OR alternate.normalized_trade_name LIKE ? ESCAPE '\\'
      OR product.normalized_generic_name LIKE ? ESCAPE '\\'
      OR vendor.business_name LIKE ? ESCAPE '\\')`);
    bindings.push(pattern, pattern, pattern, pattern);
  }
  const where = predicates.length ? predicates.join(" AND ") : "1 = 1";
  const [count, rows] = await Promise.all([
    database.prepare(`
      SELECT COUNT(*) AS count FROM product_alternates link
      JOIN products product ON product.id = link.product_id
      JOIN products alternate ON alternate.id = link.alternate_product_id
      LEFT JOIN vendors vendor ON vendor.id = link.submitted_vendor_id
      WHERE ${where}
    `).bind(...bindings).first<{ count: number }>(),
    database.prepare(`
      SELECT link.id, link.product_id AS productId, link.alternate_product_id AS alternateProductId,
        product.trade_name AS productName, alternate.trade_name AS alternateProductName,
        product.generic_name AS genericName, form.name AS dosageFormName,
        product.strength_value AS strengthValue, product.strength_unit AS strengthUnit,
        link.submitted_vendor_id AS submittedVendorId, vendor.business_name AS submittedVendorName,
        link.governance_status AS governanceStatus, link.review_reason AS reviewReason,
        link.created_at AS createdAt, link.updated_at AS updatedAt,
        CASE WHEN product.active = 1 AND product.governance_status = 'approved'
          AND alternate.active = 1 AND alternate.governance_status = 'approved'
          AND trim(product.normalized_generic_name) <> ''
          AND product.normalized_generic_name = alternate.normalized_generic_name
          AND product.dosage_form_id = alternate.dosage_form_id
          AND product.strength_value = alternate.strength_value
          AND product.strength_unit = alternate.strength_unit THEN 1 ELSE 0 END AS currentlyCompatible
      FROM product_alternates link
      JOIN products product ON product.id = link.product_id
      JOIN products alternate ON alternate.id = link.alternate_product_id
      LEFT JOIN dosage_forms form ON form.id = product.dosage_form_id
      LEFT JOIN vendors vendor ON vendor.id = link.submitted_vendor_id
      WHERE ${where}
      ORDER BY CASE link.governance_status WHEN 'pending' THEN 0 WHEN 'rejected' THEN 1 WHEN 'approved' THEN 2 ELSE 3 END,
        link.updated_at DESC, link.id DESC
      LIMIT ? OFFSET ?
    `).bind(...bindings, filters.pageSize, (filters.page - 1) * filters.pageSize).all(),
  ]);
  const total = Number(count?.count ?? 0);
  return {
    alternates: rows.results,
    pagination: { page: filters.page, pageSize: filters.pageSize, total, totalPages: Math.max(1, Math.ceil(total / filters.pageSize)) },
    filters,
    policy: { automaticSubstitution: false, approvalAuthority: "active_admin" },
  };
}

export async function deactivateAlternatesForProduct(
  database: D1Database,
  productId: number,
  actorProfileId: number,
  reason: string,
  requestId: string,
) {
  const links = await database.prepare(`
    SELECT id, product_id AS productId, alternate_product_id AS alternateProductId,
      submitted_vendor_id AS submittedVendorId, governance_status AS governanceStatus
    FROM product_alternates
    WHERE governance_status = 'approved' AND (product_id = ? OR alternate_product_id = ?)
  `).bind(productId, productId).all<{
    id: number; productId: number; alternateProductId: number;
    submittedVendorId: number | null; governanceStatus: string;
  }>();
  for (const link of links.results) {
    const result = await database.prepare(`
      UPDATE product_alternates SET governance_status = 'inactive', reviewed_by_profile_id = ?,
        review_reason = ?, reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND governance_status = 'approved'
    `).bind(actorProfileId, reason, link.id).run();
    if (!result.meta.changes) continue;
    await appendAuditEvent({
      vendorId: link.submittedVendorId,
      actorProfileId,
      action: "admin.product_alternate.deactivated",
      entityType: "product_alternate",
      entityId: link.id,
      before: link,
      after: { governanceStatus: "inactive" },
      reason,
      requestId,
    }, database);
  }
  return links.results.length;
}
