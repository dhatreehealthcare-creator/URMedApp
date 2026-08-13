export const productGovernanceStatuses = ["all", "pending", "approved", "rejected", "inactive"] as const;
export const productDrugSchedules = ["OTC", "G", "H", "H1", "X", "NDPS", "UNCLASSIFIED"] as const;
export const productGstPercents = [0, 5, 12, 18, 28] as const;

export type ProductGovernanceStatus = typeof productGovernanceStatuses[number];

export type ProductMasterQuery = {
  query: string;
  status: ProductGovernanceStatus;
  manufacturerQuery: string;
  page: number;
  pageSize: number;
};

export type StructuredProductInput = {
  genericName: string;
  normalizedGenericName: string;
  tradeName: string;
  normalizedTradeName: string;
  dosageFormId: number;
  manufacturerId: number;
  strengthValue: string;
  strengthUnit: string;
  packType: string;
  packSizeValue: string;
  packSizeUnit: string;
  dispensingUom: string;
  prescriptionRequired: boolean;
  gstPercent: number;
  hsnCode: string;
  drugSchedule: typeof productDrugSchedules[number];
  productInformation: string;
  coldChainRequired: boolean;
};

export type ProductReferences = {
  dosageFormName: string;
  manufacturerName: string;
};

function boundedInteger(value: string | null, fallback: number, minimum: number, maximum: number) {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function oneOf<const Values extends readonly string[]>(value: string | null, values: Values, fallback: Values[number]) {
  return values.includes(value ?? "") ? value as Values[number] : fallback;
}

export function parseProductMasterQuery(input: URL | URLSearchParams): ProductMasterQuery {
  const parameters = input instanceof URL ? input.searchParams : input;
  return {
    query: cleanText(parameters.get("q"), 120),
    status: oneOf(parameters.get("status"), productGovernanceStatuses, "all"),
    manufacturerQuery: normalizeName(parameters.get("manufacturerQ") ?? "").slice(0, 100),
    page: boundedInteger(parameters.get("page"), 1, 1, 100_000),
    pageSize: boundedInteger(parameters.get("pageSize"), 12, 5, 50),
  };
}

export function cleanText(value: unknown, maximum: number) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum);
}

export function normalizeName(value: unknown) {
  return cleanText(value, 260).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function escapeProductSqlLike(value: string) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export function vendorProductSource(vendorId: number) {
  return `vendor_submission:${vendorId}`;
}

function requiredText(value: unknown, label: string, maximum: number, minimum = 1) {
  const normalized = cleanText(value, maximum);
  if (normalized.length < minimum) throw new Response(`${label} is required`, { status: 400 });
  return normalized;
}

function positiveInteger(value: unknown, label: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1_000_000_000) {
    throw new Response(`${label} is invalid`, { status: 400 });
  }
  return parsed;
}

export function canonicalPositiveDecimal(value: unknown, label: string) {
  const input = cleanText(value, 30);
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(input) || Number(input) <= 0) {
    throw new Response(`${label} must be a positive number with up to 6 decimal places`, { status: 400 });
  }
  const [whole, fraction = ""] = input.split(".");
  const canonicalFraction = fraction.replace(/0+$/, "");
  return canonicalFraction ? `${whole}.${canonicalFraction}` : whole;
}

function normalizedUnit(value: unknown, label: string) {
  const unit = cleanText(value, 40).toLowerCase();
  if (!unit || !/^[a-z0-9%/. -]+$/.test(unit)) throw new Response(`${label} is invalid`, { status: 400 });
  return unit;
}

function explicitBoolean(value: unknown, label: string) {
  if (value === true || value === 1 || value === "1" || value === "true") return true;
  if (value === false || value === 0 || value === "0" || value === "false") return false;
  throw new Response(`${label} must be yes or no`, { status: 400 });
}

export function parseStructuredProductInput(body: Record<string, unknown>): StructuredProductInput {
  const genericName = requiredText(body.genericName, "Drug/generic name", 180, 2);
  const tradeName = requiredText(body.tradeName, "Trade name", 240, 2);
  const normalizedGenericName = normalizeName(genericName);
  const normalizedTradeName = normalizeName(tradeName);
  if (normalizedGenericName.length < 2 || normalizedTradeName.length < 2) {
    throw new Response("Drug and trade names must contain letters or numbers", { status: 400 });
  }
  const gstPercent = Number(body.gstPercent);
  if (!productGstPercents.includes(gstPercent as typeof productGstPercents[number])) {
    throw new Response("GST must be 0, 5, 12, 18 or 28 percent", { status: 400 });
  }
  const drugSchedule = oneOf(cleanText(body.drugSchedule, 20), productDrugSchedules, "UNCLASSIFIED");
  const hsnCode = cleanText(body.hsnCode, 8);
  if (hsnCode && !/^(?:\d{4}|\d{6}|\d{8})$/.test(hsnCode)) {
    throw new Response("HSN must contain 4, 6 or 8 digits", { status: 400 });
  }
  const packType = normalizedUnit(body.packType, "Pack type");
  if (packType.includes("/")) throw new Response("Pack type is invalid", { status: 400 });
  return {
    genericName,
    normalizedGenericName,
    tradeName,
    normalizedTradeName,
    dosageFormId: positiveInteger(body.dosageFormId, "Dosage form"),
    manufacturerId: positiveInteger(body.manufacturerId, "Manufacturer"),
    strengthValue: canonicalPositiveDecimal(body.strengthValue, "Strength"),
    strengthUnit: normalizedUnit(body.strengthUnit, "Strength unit"),
    packType,
    packSizeValue: canonicalPositiveDecimal(body.packSizeValue, "Pack size"),
    packSizeUnit: normalizedUnit(body.packSizeUnit, "Pack-size unit"),
    dispensingUom: normalizedUnit(body.dispensingUom, "Dispensing UOM"),
    prescriptionRequired: explicitBoolean(body.prescriptionRequired, "Prescription requirement"),
    gstPercent,
    hsnCode,
    drugSchedule,
    productInformation: cleanText(body.productInformation, 2_000),
    coldChainRequired: explicitBoolean(body.coldChainRequired ?? false, "Cold-chain requirement"),
  };
}

export async function loadProductReferences(database: D1Database, input: StructuredProductInput): Promise<ProductReferences> {
  const [dosageForm, manufacturer] = await database.batch([
    database.prepare("SELECT name FROM dosage_forms WHERE id = ? AND status = 'active' LIMIT 1").bind(input.dosageFormId),
    database.prepare(`SELECT manufacturer.name FROM manufacturers manufacturer
      JOIN manufacturer_canonical_state state ON state.manufacturer_id = manufacturer.id AND state.status = 'active'
      WHERE manufacturer.id = ? LIMIT 1`).bind(input.manufacturerId),
  ]);
  const dosageFormName = String(dosageForm.results[0]?.name ?? "");
  const manufacturerName = String(manufacturer.results[0]?.name ?? "");
  if (!dosageFormName) throw new Response("Choose an active dosage form", { status: 400 });
  if (!manufacturerName) throw new Response("Choose a valid manufacturer", { status: 400 });
  return { dosageFormName, manufacturerName };
}

export function structuredLegacyFields(input: StructuredProductInput, references: ProductReferences) {
  const titlePackType = input.packType.replace(/\b\w/g, (character) => character.toUpperCase());
  return {
    name: input.tradeName,
    normalizedName: normalizeName(`${input.tradeName} ${input.genericName}`),
    composition: `${input.genericName}(${input.strengthValue}${input.strengthUnit})`,
    manufacturer: references.manufacturerName,
    packaging: `${titlePackType} of ${input.packSizeValue}${input.packSizeUnit}`,
  };
}

export function structuredProductAudit(input: StructuredProductInput, references: ProductReferences) {
  return {
    genericName: input.genericName,
    tradeName: input.tradeName,
    dosageFormId: input.dosageFormId,
    dosageFormName: references.dosageFormName,
    manufacturerId: input.manufacturerId,
    manufacturerName: references.manufacturerName,
    strengthValue: input.strengthValue,
    strengthUnit: input.strengthUnit,
    packType: input.packType,
    packSizeValue: input.packSizeValue,
    packSizeUnit: input.packSizeUnit,
    dispensingUom: input.dispensingUom,
    prescriptionRequired: input.prescriptionRequired,
    gstPercent: input.gstPercent,
    hsnCode: input.hsnCode,
    drugSchedule: input.drugSchedule,
    coldChainRequired: input.coldChainRequired,
  };
}

export function productDuplicatePredicate(alias = "candidate") {
  return `${alias}.normalized_trade_name = ?
    AND ${alias}.dosage_form_id = ?
    AND ${alias}.strength_value = ?
    AND ${alias}.strength_unit = ?
    AND ${alias}.manufacturer_id = ?
    AND ${alias}.governance_status IN ('pending', 'approved')`;
}

export async function insertPendingProduct(
  database: D1Database,
  input: StructuredProductInput,
  references: ProductReferences,
  vendorId: number,
) {
  const legacy = structuredLegacyFields(input, references);
  return database.prepare(`
    INSERT INTO products (
      legacy_id, name, normalized_name, composition, manufacturer,
      manufacturer_id, dosage_form_id, strength_value, strength_unit,
      pack_type, pack_size_value, pack_size_unit, dispensing_uom,
      normalized_generic_name, normalized_trade_name,
      prescription_required, gst_percent, hsn_code, packaging,
      generic_name, trade_name, product_information, drug_schedule,
      cold_chain_required, governance_status, active, source, updated_at
    )
    SELECT
      CASE WHEN COALESCE(MAX(allocation.legacy_id), 0) < 900000000
        THEN 900000000 ELSE MAX(allocation.legacy_id) + 1 END,
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      'pending', 0, ?, CURRENT_TIMESTAMP
    FROM products allocation
    HAVING COALESCE(MAX(allocation.legacy_id), 0) < 999999999
      AND NOT EXISTS (
        SELECT 1 FROM products candidate WHERE ${productDuplicatePredicate("candidate")}
      )
    RETURNING id, legacy_id AS compatibilityId
  `).bind(
    legacy.name,
    legacy.normalizedName,
    legacy.composition,
    legacy.manufacturer,
    input.manufacturerId,
    input.dosageFormId,
    input.strengthValue,
    input.strengthUnit,
    input.packType,
    input.packSizeValue,
    input.packSizeUnit,
    input.dispensingUom,
    input.normalizedGenericName,
    input.normalizedTradeName,
    input.prescriptionRequired ? 1 : 0,
    input.gstPercent,
    input.hsnCode,
    legacy.packaging,
    input.genericName,
    input.tradeName,
    input.productInformation,
    input.drugSchedule,
    input.coldChainRequired ? 1 : 0,
    vendorProductSource(vendorId),
    input.normalizedTradeName,
    input.dosageFormId,
    input.strengthValue,
    input.strengthUnit,
    input.manufacturerId,
  ).first<{ id: number; compatibilityId: number }>();
}

export async function listProductMaster(
  database: D1Database,
  filters: ProductMasterQuery,
  scope: { role: "vendor"; vendorId: number } | { role: "admin" },
) {
  const predicates: string[] = [];
  const bindings: Array<string | number> = [];
  const submissionSource = scope.role === "vendor" ? vendorProductSource(scope.vendorId) : "";
  if (scope.role === "vendor") {
    predicates.push("((p.governance_status = 'approved' AND p.active = 1) OR p.source = ?)");
    bindings.push(submissionSource);
  }
  if (filters.status !== "all") {
    predicates.push("p.governance_status = ?");
    bindings.push(filters.status);
  }
  if (filters.query) {
    const pattern = `%${escapeProductSqlLike(normalizeName(filters.query))}%`;
    predicates.push(`(
      p.normalized_name LIKE ? ESCAPE '\\'
      OR p.normalized_generic_name LIKE ? ESCAPE '\\'
      OR p.normalized_trade_name LIKE ? ESCAPE '\\'
      OR EXISTS (
        SELECT 1 FROM manufacturers canonical
        JOIN manufacturer_canonical_state state ON state.manufacturer_id = canonical.id AND state.status = 'active'
        WHERE canonical.id = p.manufacturer_id
          AND (canonical.normalized_name LIKE ? ESCAPE '\\'
            OR EXISTS (SELECT 1 FROM manufacturer_aliases alias
              WHERE alias.manufacturer_id = canonical.id AND alias.normalized_alias LIKE ? ESCAPE '\\'))
      )
    )`);
    bindings.push(pattern, pattern, pattern, pattern, pattern);
  }
  const where = predicates.length ? predicates.join(" AND ") : "1 = 1";
  const productBindings: Array<string | number> = scope.role === "vendor" ? [submissionSource, ...bindings] : bindings;
  const submissionColumns = scope.role === "admin" ? `
        (SELECT event.vendor_id FROM audit_events event
          WHERE event.entity_type = 'product' AND event.entity_id = CAST(p.id AS TEXT)
            AND event.action = 'product.submitted'
          ORDER BY event.id LIMIT 1) AS submittedVendorId,
        (SELECT vendor.business_name FROM audit_events event
          JOIN vendors vendor ON vendor.id = event.vendor_id
          WHERE event.entity_type = 'product' AND event.entity_id = CAST(p.id AS TEXT)
            AND event.action = 'product.submitted'
          ORDER BY event.id LIMIT 1) AS submittedVendorName`
    : "NULL AS submittedVendorId, NULL AS submittedVendorName";
  const order = scope.role === "vendor"
    ? "ownedSubmission DESC, CASE p.governance_status WHEN 'pending' THEN 0 WHEN 'rejected' THEN 1 ELSE 2 END, p.updated_at DESC, p.id DESC"
    : "CASE p.governance_status WHEN 'pending' THEN 0 WHEN 'rejected' THEN 1 WHEN 'approved' THEN 2 ELSE 3 END, p.updated_at DESC, p.id DESC";
  const manufacturerPattern = `%${escapeProductSqlLike(filters.manufacturerQuery)}%`;
  const [count, products, dosageForms, manufacturers] = await Promise.all([
    database.prepare(`SELECT COUNT(*) AS count FROM products p WHERE ${where}`).bind(...bindings).first<{ count: number }>(),
    database.prepare(`
      SELECT p.id, p.legacy_id AS compatibilityId, p.generic_name AS genericName,
        p.trade_name AS tradeName, p.dosage_form_id AS dosageFormId,
        form.name AS dosageFormName, p.manufacturer_id AS manufacturerId,
        manufacturer.name AS manufacturerName, p.strength_value AS strengthValue,
        p.strength_unit AS strengthUnit, p.pack_type AS packType,
        p.pack_size_value AS packSizeValue, p.pack_size_unit AS packSizeUnit,
        p.dispensing_uom AS dispensingUom,
        p.prescription_required AS prescriptionRequired, p.gst_percent AS gstPercent,
        p.hsn_code AS hsnCode, p.drug_schedule AS drugSchedule,
        p.product_information AS productInformation,
        p.cold_chain_required AS coldChainRequired,
        p.governance_status AS governanceStatus, p.active,
        ${scope.role === "vendor" ? "CASE WHEN p.source = ? THEN 1 ELSE 0 END" : "0"} AS ownedSubmission,
        ${submissionColumns},
        p.migrated_at AS createdAt, p.updated_at AS updatedAt
      FROM products p
      LEFT JOIN dosage_forms form ON form.id = p.dosage_form_id
      LEFT JOIN manufacturers manufacturer ON manufacturer.id = p.manufacturer_id
      WHERE ${where}
      ORDER BY ${order}
      LIMIT ? OFFSET ?
    `).bind(...productBindings, filters.pageSize, (filters.page - 1) * filters.pageSize).all(),
    database.prepare(`
      SELECT id, code, slug, name FROM dosage_forms
      WHERE status = 'active' ORDER BY sort_order, id
    `).all(),
    database.prepare(`
      SELECT manufacturer.id, manufacturer.name, COUNT(product.id) AS linkedProducts
      FROM manufacturers manufacturer
      JOIN manufacturer_canonical_state state ON state.manufacturer_id = manufacturer.id AND state.status = 'active'
      LEFT JOIN products product ON product.manufacturer_id = manufacturer.id
      WHERE (? = '' OR manufacturer.normalized_name LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM manufacturer_aliases alias
          WHERE alias.manufacturer_id = manufacturer.id AND alias.normalized_alias LIKE ? ESCAPE '\\'))
      GROUP BY manufacturer.id, manufacturer.name
      ORDER BY linkedProducts DESC, manufacturer.name
      LIMIT 100
    `).bind(filters.manufacturerQuery, manufacturerPattern, manufacturerPattern).all(),
  ]);
  const total = Number(count?.count ?? 0);
  return {
    products: products.results,
    dosageForms: dosageForms.results,
    manufacturers: manufacturers.results,
    pagination: {
      page: filters.page,
      pageSize: filters.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / filters.pageSize)),
    },
    filters,
    governance: {
      vendorSubmissionState: "pending_inactive",
      approvalAuthority: "active_admin",
      compatibilityIdRangeStart: 900_000_000,
    },
  };
}
