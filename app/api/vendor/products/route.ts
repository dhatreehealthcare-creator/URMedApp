import { getD1 } from "../../../../db/d1";
import { appendAuditEvent } from "../../../../lib/audit";
import { errorResponse } from "../../../../lib/auth-server";
import {
  listProductMaster,
  insertPendingProduct,
  loadProductReferences,
  parseProductMasterQuery,
  parseStructuredProductInput,
  productDuplicatePredicate,
  structuredLegacyFields,
  structuredProductAudit,
  vendorProductSource,
} from "../../../../lib/product-master";
import { requireVendorPermission } from "../../../../lib/vendor-access";

function duplicateBindings(input: ReturnType<typeof parseStructuredProductInput>) {
  return [
    input.normalizedTradeName,
    input.dosageFormId,
    input.strengthValue,
    input.strengthUnit,
    input.manufacturerId,
  ];
}

export async function GET(request: Request) {
  try {
    const { vendorId } = await requireVendorPermission(request, "product.submit");
    return Response.json(
      await listProductMaster(getD1(), parseProductMasterQuery(new URL(request.url)), { role: "vendor", vendorId }),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const { profile, vendorId } = await requireVendorPermission(request, "product.submit");
    const body = await request.json() as Record<string, unknown>;
    const input = parseStructuredProductInput(body);
    const db = getD1();
    const references = await loadProductReferences(db, input);
    let inserted: { id: number; compatibilityId: number } | null;
    try {
      inserted = await insertPendingProduct(db, input, references, vendorId);
    } catch (error) {
      if (error instanceof Error && /unique|constraint/i.test(error.message)) {
        return Response.json({ error: "The catalogue changed while this product was submitted; review existing variants and retry" }, { status: 409 });
      }
      throw error;
    }
    if (!inserted) {
      return Response.json({ error: "This product variant already has an active or pending global record" }, { status: 409 });
    }
    await appendAuditEvent({
      vendorId,
      actorProfileId: profile.id,
      action: "product.submitted",
      entityType: "product",
      entityId: inserted.id,
      after: {
        ...structuredProductAudit(input, references),
        governanceStatus: "pending",
        active: false,
        compatibilityId: inserted.compatibilityId,
        compatibilityIdProvenance: "internal_governed_record",
      },
      requestId: request.headers.get("cf-ray") ?? "",
    });
    return Response.json({
      saved: true,
      product: { id: inserted.id, compatibilityId: inserted.compatibilityId, governanceStatus: "pending", active: false },
      message: "Product submitted for administrator governance review",
    }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const { profile, vendorId } = await requireVendorPermission(request, "product.submit");
    const body = await request.json() as Record<string, unknown>;
    const id = Number(body.id);
    if (!Number.isInteger(id) || id < 1) return Response.json({ error: "Product submission is invalid" }, { status: 400 });
    const db = getD1();
    const source = vendorProductSource(vendorId);
    const before = await db.prepare(`
      SELECT id, legacy_id AS compatibilityId, generic_name AS genericName,
        trade_name AS tradeName, governance_status AS governanceStatus, active
      FROM products
      WHERE id = ? AND source = ? AND governance_status IN ('pending', 'rejected') AND active = 0
      LIMIT 1
    `).bind(id, source).first<Record<string, unknown>>();
    if (!before) return Response.json({ error: "Product submission was not found" }, { status: 404 });

    if (body.action === "withdraw") {
      const result = await db.prepare(`
        UPDATE products SET governance_status = 'inactive', active = 0, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND source = ? AND governance_status IN ('pending', 'rejected') AND active = 0
      `).bind(id, source).run();
      if (!result.meta.changes) return Response.json({ error: "Product submission changed; refresh and retry" }, { status: 409 });
      await appendAuditEvent({ vendorId, actorProfileId: profile.id, action: "product.submission.withdrawn", entityType: "product", entityId: id, before, after: { governanceStatus: "inactive", active: false }, requestId: request.headers.get("cf-ray") ?? "" });
      return Response.json({ saved: true, product: { id, governanceStatus: "inactive", active: false } }, { headers: { "Cache-Control": "no-store" } });
    }

    const input = parseStructuredProductInput(body);
    const references = await loadProductReferences(db, input);
    const legacy = structuredLegacyFields(input, references);
    const result = await db.prepare(`
      UPDATE products SET
        name = ?, normalized_name = ?, composition = ?, manufacturer = ?,
        manufacturer_id = ?, dosage_form_id = ?, strength_value = ?, strength_unit = ?,
        pack_type = ?, pack_size_value = ?, pack_size_unit = ?, dispensing_uom = ?,
        normalized_generic_name = ?, normalized_trade_name = ?,
        prescription_required = ?, gst_percent = ?, hsn_code = ?, packaging = ?,
        generic_name = ?, trade_name = ?, product_information = ?, drug_schedule = ?,
        cold_chain_required = ?, governance_status = 'pending', active = 0, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND source = ? AND governance_status IN ('pending', 'rejected') AND active = 0
        AND NOT EXISTS (
          SELECT 1 FROM products candidate
          WHERE candidate.id <> products.id AND ${productDuplicatePredicate("candidate")}
        )
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
      id,
      source,
      ...duplicateBindings(input),
    ).run();
    if (!result.meta.changes) {
      return Response.json({ error: "This product variant conflicts with another active or pending global record" }, { status: 409 });
    }
    const after = { ...structuredProductAudit(input, references), governanceStatus: "pending", active: false };
    await appendAuditEvent({ vendorId, actorProfileId: profile.id, action: "product.submission.updated", entityType: "product", entityId: id, before, after, requestId: request.headers.get("cf-ray") ?? "" });
    return Response.json({ saved: true, product: { id, governanceStatus: "pending", active: false } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
