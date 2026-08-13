import { getD1 } from "../../../../db/d1";
import { errorResponse } from "../../../../lib/auth-server";
import { requireVendorPermission } from "../../../../lib/vendor-access";
import { normalizeBarcode, positiveInteger, presentationToBase, PricingGovernanceError, validatePricePolicy, isoDate } from "../../../../lib/pricing-governance";

const headers = { "Cache-Control": "private, no-store" };

export async function GET(request: Request) {
  try {
    const { vendorId } = await requireVendorPermission(request, "inventory.read");
    const url = new URL(request.url); const productId = Number(url.searchParams.get("productId") ?? 0); const inventoryId = Number(url.searchParams.get("inventoryId") ?? 0);
    if (!Number.isInteger(productId) && !Number.isInteger(inventoryId)) return Response.json({ error: "Choose a product or inventory batch" }, { status: 400, headers });
    const db = getD1();
    const owned = inventoryId > 0
      ? await db.prepare("SELECT product_id AS productId FROM pharmacy_inventory WHERE id=? AND vendor_id=?").bind(inventoryId, vendorId).first<{ productId: number }>()
      : { productId };
    if (!owned || Number(owned.productId) < 1) return Response.json({ error: "Inventory batch was not found" }, { status: 404, headers });
    const [prices, conversions, barcodes] = await db.batch([
      db.prepare("SELECT id,inventory_id AS inventoryId,purchase_price_paise AS purchasePricePaise,sale_price_paise AS salePricePaise,mrp_paise AS mrpPaise,gst_percent AS gstPercent,effective_from AS effectiveFrom,effective_until AS effectiveUntil,source,reason FROM inventory_price_history WHERE vendor_id=? AND product_id=? ORDER BY effective_from DESC,id DESC").bind(vendorId, owned.productId),
      db.prepare("SELECT id,product_id AS productId,presentation_uom AS presentationUom,base_uom AS baseUom,base_units_per_presentation AS baseUnitsPerPresentation,governance_status AS governanceStatus,effective_from AS effectiveFrom,effective_until AS effectiveUntil,review_reason AS reviewReason FROM product_pack_conversions WHERE product_id=? AND (governance_status='approved' OR submitted_vendor_id=?) ORDER BY presentation_uom").bind(owned.productId, vendorId),
      db.prepare("SELECT id,product_id AS productId,code,symbology,status,review_reason AS reviewReason FROM product_barcodes WHERE product_id=? AND (status='approved' OR submitted_vendor_id=?) ORDER BY code").bind(owned.productId, vendorId),
    ]);
    return Response.json({ productId: owned.productId, prices: prices.results, conversions: conversions.results, barcodes: barcodes.results }, { headers });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const { profile, vendorId } = await requireVendorPermission(request, "inventory.write");
    const body = await request.json() as Record<string, unknown>; const action = String(body.action ?? ""); const db = getD1();
    if (action === "price") {
      const inventoryId = positiveInteger(body.inventoryId, "Inventory batch");
      const inventory = await db.prepare("SELECT id,product_id AS productId,purchase_price_paise AS purchasePricePaise,sale_price_paise AS salePricePaise,mrp_paise AS mrpPaise,gst_percent AS gstPercent FROM pharmacy_inventory WHERE id=? AND vendor_id=? AND active=1").bind(inventoryId, vendorId).first<{id:number;productId:number;purchasePricePaise:number;salePricePaise:number;mrpPaise:number;gstPercent:number}>();
      if (!inventory) return Response.json({ error: "Inventory batch was not found" }, { status: 404, headers });
      const policy = validatePricePolicy({ purchasePricePaise: body.purchasePricePaise ?? inventory.purchasePricePaise, salePricePaise: body.salePricePaise, mrpPaise: body.mrpPaise, gstPercent: body.gstPercent ?? inventory.gstPercent });
      const effectiveFrom = isoDate(body.effectiveFrom ?? new Date().toISOString().slice(0, 10), "Effective date")!;
      const reason = String(body.reason ?? "").trim().slice(0, 240); if (reason.length < 5) return Response.json({ error: "A pricing reason is required" }, { status: 400, headers });
      const result = await db.batch([
        db.prepare("INSERT INTO inventory_price_history (inventory_id,vendor_id,product_id,purchase_price_paise,sale_price_paise,mrp_paise,gst_percent,effective_from,source,reason,created_by_profile_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(inventoryId,vendorId,inventory.productId,policy.purchasePricePaise,policy.salePricePaise,policy.mrpPaise,policy.gstPercent,effectiveFrom,"vendor",reason,profile.id),
        db.prepare("UPDATE pharmacy_inventory SET purchase_price_paise=?,sale_price_paise=?,mrp_paise=?,gst_percent=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND vendor_id=? AND active=1 AND ?<=date('now')").bind(policy.purchasePricePaise,policy.salePricePaise,policy.mrpPaise,policy.gstPercent,inventoryId,vendorId,effectiveFrom),
      ]);
      return Response.json({ saved: true, effectiveFrom, appliedNow: Number(result[1]?.meta.changes ?? 0) === 1, ceilingAdvisory: policy.ceilingAdvisory }, { status: 201, headers });
    }
    if (action === "conversion") {
      const requestedProductId = positiveInteger(body.productId, "Product");
      const product = await db.prepare("SELECT id FROM products WHERE id=? OR legacy_id=? LIMIT 1").bind(requestedProductId, requestedProductId).first<{ id: number }>();
      if (!product) return Response.json({ error: "Product was not found" }, { status: 404, headers });
      const productId = product.id; const presentationUom = String(body.presentationUom ?? "").trim().toLowerCase().slice(0, 40); const baseUom = String(body.baseUom ?? "unit").trim().toLowerCase().slice(0, 40);
      if (!presentationUom || !baseUom) throw new PricingGovernanceError("Units are required");
      const baseUnits = positiveInteger(body.baseUnitsPerPresentation, "Conversion factor"); presentationToBase(1, baseUnits); const effectiveFrom = isoDate(body.effectiveFrom ?? new Date().toISOString().slice(0, 10), "Effective date")!;
      const inserted = await db.prepare("INSERT INTO product_pack_conversions (product_id,presentation_uom,base_uom,base_units_per_presentation,governance_status,submitted_vendor_id,effective_from) VALUES (?,?,?,?, 'pending',?,?) RETURNING id").bind(productId,presentationUom,baseUom,baseUnits,vendorId,effectiveFrom).first<{id:number}>();
      return Response.json({ saved: true, conversionId: inserted?.id ?? null, governanceStatus: "pending" }, { status: 201, headers });
    }
    if (action === "barcode") {
      const requestedProductId = positiveInteger(body.productId, "Product");
      const product = await db.prepare("SELECT id FROM products WHERE id=? OR legacy_id=? LIMIT 1").bind(requestedProductId, requestedProductId).first<{ id: number }>();
      if (!product) return Response.json({ error: "Product was not found" }, { status: 404, headers });
      const productId = product.id; const barcode = normalizeBarcode(body.code, body.symbology);
      const inserted = await db.prepare("INSERT INTO product_barcodes (product_id,code,symbology,status,submitted_vendor_id) VALUES (?,?,?,'pending',?) RETURNING id").bind(productId,barcode.code,barcode.symbology,vendorId).first<{id:number}>();
      return Response.json({ saved: true, barcodeId: inserted?.id ?? null, status: "pending" }, { status: 201, headers });
    }
    return Response.json({ error: "Pricing action is invalid" }, { status: 400, headers });
  } catch (error) {
    if (error instanceof PricingGovernanceError) return Response.json({ error: error.message }, { status: error.status, headers });
    return errorResponse(error);
  }
}
