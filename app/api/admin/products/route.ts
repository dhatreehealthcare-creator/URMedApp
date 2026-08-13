import { getD1 } from "../../../../db/d1";
import { requireAdminProfile } from "../../../../lib/admin-access";
import { appendAuditEvent } from "../../../../lib/audit";
import { errorResponse } from "../../../../lib/auth-server";
import { deactivateAlternatesForProduct } from "../../../../lib/product-alternates";
import {
  cleanText,
  listProductMaster,
  loadProductReferences,
  parseProductMasterQuery,
  parseStructuredProductInput,
  productDuplicatePredicate,
  structuredLegacyFields,
  structuredProductAudit,
} from "../../../../lib/product-master";

type GovernedProduct = Record<string, unknown> & {
  id: number;
  submittedVendorId: number | null;
  governanceStatus: string;
  active: number;
};

function duplicateBindings(input: ReturnType<typeof parseStructuredProductInput>) {
  return [input.normalizedTradeName, input.dosageFormId, input.strengthValue, input.strengthUnit, input.manufacturerId];
}

async function loadGovernedProduct(id: number) {
  return getD1().prepare(`
    SELECT p.*, p.governance_status AS governanceStatus,
      (SELECT event.vendor_id FROM audit_events event
        WHERE event.entity_type = 'product' AND event.entity_id = CAST(p.id AS TEXT)
          AND event.action = 'product.submitted'
        ORDER BY event.id LIMIT 1) AS submittedVendorId
    FROM products p WHERE p.id = ? LIMIT 1
  `).bind(id).first<GovernedProduct>();
}

export async function GET(request: Request) {
  try {
    await requireAdminProfile(request);
    return Response.json(
      await listProductMaster(getD1(), parseProductMasterQuery(new URL(request.url)), { role: "admin" }),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const profile = await requireAdminProfile(request);
    const body = await request.json() as Record<string, unknown>;
    const id = Number(body.id);
    const action = cleanText(body.action, 30);
    const reason = cleanText(body.reason, 500);
    if (!Number.isInteger(id) || id < 1 || !["save", "approve", "reject", "deactivate"].includes(action)) {
      return Response.json({ error: "Choose a valid product governance action" }, { status: 400 });
    }
    const db = getD1();
    const before = await loadGovernedProduct(id);
    if (!before) return Response.json({ error: "Product was not found" }, { status: 404 });
    if (["reject", "deactivate"].includes(action) && reason.length < 5) {
      return Response.json({ error: "Add a clear governance reason" }, { status: 400 });
    }

    if (action === "save") {
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
          cold_chain_required = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND NOT EXISTS (
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
        ...duplicateBindings(input),
      ).run();
      if (!result.meta.changes) return Response.json({ error: "This product conflicts with another active or pending global variant" }, { status: 409 });
      const clinicalIdentityChanged =
        String(before.normalized_generic_name ?? "") !== input.normalizedGenericName
        || Number(before.dosage_form_id) !== input.dosageFormId
        || String(before.strength_value ?? "") !== input.strengthValue
        || String(before.strength_unit ?? "") !== input.strengthUnit;
      if (clinicalIdentityChanged) {
        await deactivateAlternatesForProduct(db, id, profile.id, "Product clinical identity changed; alternate requires fresh review", request.headers.get("cf-ray") ?? "");
      }
      const after = { ...structuredProductAudit(input, references), governanceStatus: before.governanceStatus, active: Boolean(before.active) };
      await appendAuditEvent({ vendorId: before.submittedVendorId, actorProfileId: profile.id, action: "admin.product.updated", entityType: "product", entityId: id, before, after, requestId: request.headers.get("cf-ray") ?? "" });
      return Response.json({ saved: true, product: { id, governanceStatus: before.governanceStatus, active: Boolean(before.active) } }, { headers: { "Cache-Control": "no-store" } });
    }

    if (action === "approve") {
      const ready = await db.prepare(`
        SELECT id FROM products product
        WHERE product.id = ?
          AND trim(product.generic_name) <> '' AND trim(product.trade_name) <> ''
          AND product.manufacturer_id IS NOT NULL AND product.dosage_form_id IS NOT NULL
          AND product.strength_value IS NOT NULL AND product.strength_unit IS NOT NULL
          AND product.pack_size_value IS NOT NULL AND product.pack_size_unit IS NOT NULL
          AND trim(product.dispensing_uom) <> ''
          AND NOT EXISTS (
            SELECT 1 FROM products candidate
            WHERE candidate.id <> product.id
              AND candidate.normalized_trade_name = product.normalized_trade_name
              AND candidate.dosage_form_id = product.dosage_form_id
              AND candidate.strength_value = product.strength_value
              AND candidate.strength_unit = product.strength_unit
              AND candidate.manufacturer_id = product.manufacturer_id
              AND candidate.governance_status = 'approved' AND candidate.active = 1
          )
        LIMIT 1
      `).bind(id).first();
      if (!ready) return Response.json({ error: "Complete every structured field and resolve duplicate global variants before approval" }, { status: 409 });
      const result = await db.prepare(`
        UPDATE products SET governance_status = 'approved', active = 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND governance_status IN ('pending', 'rejected', 'inactive') AND active = 0
      `).bind(id).run();
      if (!result.meta.changes) return Response.json({ error: "Only an inactive pending, rejected or inactive record can be approved" }, { status: 409 });
    } else if (action === "reject") {
      const result = await db.prepare(`
        UPDATE products SET governance_status = 'rejected', active = 0, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND governance_status = 'pending' AND active = 0
      `).bind(id).run();
      if (!result.meta.changes) return Response.json({ error: "Only a pending submission can be rejected" }, { status: 409 });
    } else {
      const stock = await db.prepare(`
        SELECT COUNT(*) AS count FROM pharmacy_inventory
        WHERE product_id = ? AND active = 1 AND (quantity > 0 OR reserved_quantity > 0)
      `).bind(id).first<{ count: number }>();
      if (Number(stock?.count ?? 0) > 0) {
        return Response.json({ error: "Deactivate or exhaust active inventory batches before deactivating the global product" }, { status: 409 });
      }
      const result = await db.prepare(`
        UPDATE products SET governance_status = 'inactive', active = 0, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND governance_status = 'approved' AND active = 1
      `).bind(id).run();
      if (!result.meta.changes) return Response.json({ error: "Only an active approved product can be deactivated" }, { status: 409 });
      await deactivateAlternatesForProduct(db, id, profile.id, "Product deactivated from global catalogue", request.headers.get("cf-ray") ?? "");
    }

    const governanceStatus = action === "approve" ? "approved" : action === "reject" ? "rejected" : "inactive";
    const active = action === "approve";
    await appendAuditEvent({
      vendorId: before.submittedVendorId,
      actorProfileId: profile.id,
      action: `admin.product.${action}`,
      entityType: "product",
      entityId: id,
      before,
      after: { governanceStatus, active },
      reason,
      requestId: request.headers.get("cf-ray") ?? "",
    });
    return Response.json({ saved: true, product: { id, governanceStatus, active } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
