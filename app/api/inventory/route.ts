import { getD1 } from "../../../db/d1";
import { appendAuditEvent } from "../../../lib/audit";
import { errorResponse } from "../../../lib/auth-server";
import { asPositiveInteger, rupeesToPaise } from "../../../lib/money";
import { isStrictIsoDate } from "../../../lib/date-controls";
import { redactPrivateVendorLocation } from "../../../lib/location-privacy";
import { currentOperationalVendorPredicate } from "../../../lib/operational-vendor";
import { requireVendorPermission } from "../../../lib/vendor-access";
import { attachPublishedVendorLocation } from "../../../lib/vendor-public-location";
import { validatePricePolicy } from "../../../lib/pricing-governance";

type InventoryRow = {
  id: number;
  vendorId: number;
  productId: number;
  legacyId: number;
  productName: string;
  manufacturer: string;
  prescriptionRequired: number;
  businessName: string;
  homeDelivery: number;
  batchNumber: string;
  expiryDate: string | null;
  purchasePricePaise?: number;
  salePricePaise: number;
  quantity: number;
  reservedQuantity: number;
  gstPercent: number;
  reorderLevel: number;
  quarantineStatus: string;
  expiryStatus: string;
};

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const mine = url.searchParams.get("scope") === "mine";
    const query = (url.searchParams.get("q") ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const db = getD1();
    let where = `i.active = 1 AND i.quarantine_status = 'available' AND i.expiry_date IS NOT NULL
      AND i.cold_chain_status IN ('not_applicable','within_range') AND p.active = 1
      AND ${currentOperationalVendorPredicate("v")}
      AND date(i.expiry_date) >= date('now') AND (i.quantity - i.reserved_quantity) > 0
      AND i.id = (SELECT offer.id FROM pharmacy_inventory offer
        WHERE offer.vendor_id = i.vendor_id AND offer.product_id = i.product_id AND offer.active = 1
          AND offer.cold_chain_status IN ('not_applicable','within_range')
          AND offer.quarantine_status = 'available' AND offer.expiry_date IS NOT NULL
          AND date(offer.expiry_date) >= date('now') AND (offer.quantity - offer.reserved_quantity) > 0
        ORDER BY date(offer.expiry_date), offer.id LIMIT 1)`;
    const bindings: unknown[] = [];
    let purchaseColumn = "";
    let quantityColumn = `(SELECT SUM(stock.quantity - stock.reserved_quantity) FROM pharmacy_inventory stock
      WHERE stock.vendor_id = i.vendor_id AND stock.product_id = i.product_id AND stock.active = 1
        AND stock.cold_chain_status IN ('not_applicable','within_range')
        AND stock.quarantine_status = 'available' AND stock.expiry_date IS NOT NULL
        AND date(stock.expiry_date) >= date('now') AND (stock.quantity - stock.reserved_quantity) > 0)`;
    if (mine) {
      const { vendorId } = await requireVendorPermission(request,"inventory.read");
      where = "i.vendor_id = ?";
      bindings.push(vendorId);
      purchaseColumn = ", i.purchase_price_paise AS purchasePricePaise";
      quantityColumn = "i.quantity";
    }
    if (query) {
      where += ` AND (p.normalized_name LIKE ? OR (manufacturer_state.manufacturer_id IS NOT NULL AND (
        canonical_manufacturer.normalized_name LIKE ? OR EXISTS (SELECT 1 FROM manufacturer_aliases alias
          WHERE alias.manufacturer_id = canonical_manufacturer.id AND alias.normalized_alias LIKE ?))))`;
      bindings.push(`%${query}%`, `%${query}%`, `%${query}%`);
    }
    bindings.push(mine ? 200 : 60);
    const result = await db.prepare(`
      SELECT i.id, i.vendor_id AS vendorId, i.product_id AS productId, p.legacy_id AS legacyId,
        p.name AS productName, COALESCE(canonical_manufacturer.name, p.manufacturer) AS manufacturer,
        p.prescription_required AS prescriptionRequired,
        v.business_name AS businessName, v.home_delivery AS homeDelivery,
        public_location.label AS publicLocationLabel,
        public_location.address AS publicLocationAddress,
        public_location.latitude AS publicLocationLatitude,
        public_location.longitude AS publicLocationLongitude,
        public_location.pickup_enabled AS publicPickupEnabled,
        public_location.service_enabled AS publicServiceEnabled,
        public_location.service_radius_km AS publicServiceRadiusKm,
        i.batch_number AS batchNumber, i.expiry_date AS expiryDate,
        i.sale_price_paise AS salePricePaise, ${quantityColumn} AS quantity,
        i.reserved_quantity AS reservedQuantity, i.gst_percent AS gstPercent,
        i.reorder_level AS reorderLevel, i.quarantine_status AS quarantineStatus,
        CASE WHEN i.expiry_date IS NULL THEN 'missing_expiry'
          WHEN date(i.expiry_date) < date('now') THEN 'expired'
          WHEN date(i.expiry_date) <= date('now', '+3 months') THEN 'near_expiry'
          ELSE 'valid' END AS expiryStatus ${purchaseColumn}
      FROM pharmacy_inventory i
      JOIN products p ON p.id = i.product_id
      LEFT JOIN manufacturers canonical_manufacturer ON canonical_manufacturer.id = p.manufacturer_id
      LEFT JOIN manufacturer_canonical_state manufacturer_state
        ON manufacturer_state.manufacturer_id = canonical_manufacturer.id AND manufacturer_state.status = 'active'
      JOIN vendors v ON v.id = i.vendor_id
      LEFT JOIN vendor_public_locations public_location
        ON public_location.vendor_id = v.id AND public_location.publication_status = 'published'
      WHERE ${where}
      ORDER BY CASE WHEN i.expiry_date IS NULL OR date(i.expiry_date) < date('now') THEN 0
        WHEN date(i.expiry_date) <= date('now', '+3 months') THEN 1 ELSE 2 END,
        date(i.expiry_date), i.updated_at DESC LIMIT ?
    `).bind(...bindings).all<InventoryRow>();
    const inventory = result.results.map((row) => attachPublishedVendorLocation(
      mine ? row as unknown as Record<string, unknown> : redactPrivateVendorLocation(row),
    ));
    return Response.json({ inventory }, { headers: { "Cache-Control": mine ? "private, no-store" : "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const { profile,vendorId } = await requireVendorPermission(request,"inventory.write");
    const body = await request.json() as Record<string, unknown>;
    const legacyId = asPositiveInteger(body.legacyId, "Recovered product ID", 1000000000);
    const batchNumber = String(body.batchNumber ?? "").trim().slice(0, 80);
    if (!batchNumber) return Response.json({ error: "Batch number is required" }, { status: 400 });
    const salePricePaise = rupeesToPaise(body.salePrice, "Sale price");
    if (salePricePaise < 1) return Response.json({ error: "Sale price must be more than zero" }, { status: 400 });
    const purchasePricePaise = rupeesToPaise(body.purchasePrice ?? 0, "Purchase price");
    const mrpPaise = rupeesToPaise(body.mrp ?? body.salePrice, "MRP");
    const quantity = Number(body.quantity);
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > 1000000) return Response.json({ error: "Quantity is invalid" }, { status: 400 });
    const gstPercent = Number(body.gstPercent ?? 0);
    try { validatePricePolicy({ purchasePricePaise, salePricePaise, mrpPaise, gstPercent }); }
    catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Pricing is invalid" }, { status: 400 }); }
    const expiryDate = String(body.expiryDate ?? "").trim();
    const today = new Date().toISOString().slice(0, 10);
    if (!isStrictIsoDate(expiryDate) || expiryDate <= today) {
      return Response.json({ error: "A valid future expiry date is required before stock can be activated" }, { status: 400 });
    }
    const manufacturingDate = String(body.manufacturingDate ?? "").trim();
    if (manufacturingDate && (!isStrictIsoDate(manufacturingDate) || manufacturingDate > today || manufacturingDate >= expiryDate)) {
      return Response.json({ error: "Manufacturing date must be valid, not future and earlier than expiry" }, { status: 400 });
    }
    const product = await getD1().prepare("SELECT id FROM products WHERE legacy_id = ? LIMIT 1").bind(legacyId).first<{ id: number }>();
    if (!product) return Response.json({ error: "Recovered product ID was not found" }, { status: 404 });
    const existing = await getD1().prepare(`SELECT id FROM pharmacy_inventory WHERE vendor_id=? AND product_id=? AND batch_number=? LIMIT 1`)
      .bind(vendorId,product.id,batchNumber).first();
    if(existing)return Response.json({error:"This batch already exists. Use purchase receiving or an audited stock adjustment instead of replacing its quantity."},{status:409});
    const results=await getD1().batch([
      getD1().prepare(`
      INSERT INTO pharmacy_inventory (vendor_id, product_id, batch_number, expiry_date, manufacturing_date,
        dosage, purchase_price_paise, sale_price_paise, mrp_paise, quantity, gst_percent, reorder_level, quarantine_status, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'available', 1)
    `).bind(
      vendorId, product.id, batchNumber, expiryDate, manufacturingDate || null,
      String(body.dosage ?? "").trim().slice(0, 80), purchasePricePaise, salePricePaise, mrpPaise, quantity, gstPercent,
      Math.max(0, Math.min(Number(body.reorderLevel ?? 5) || 5, 100000)),
      ),
      getD1().prepare(`INSERT INTO stock_ledger (vendor_id,inventory_id,movement_type,quantity_delta,balance_after,reference_type,reference_id,reason,actor_profile_id)
        SELECT vendor_id,id,'opening_stock',quantity,quantity,'inventory',id,'Audited opening stock entry',? FROM pharmacy_inventory
        WHERE vendor_id=? AND product_id=? AND batch_number=?`).bind(profile.id,vendorId,product.id,batchNumber),
    ]);
    const inventoryId=Number(results[0]?.meta.last_row_id);
    await appendAuditEvent({vendorId,actorProfileId:profile.id,action:"inventory.opening_stock",entityType:"inventory",entityId:inventoryId,after:{legacyId,batchNumber,expiryDate,manufacturingDate,quantity,purchasePricePaise,salePricePaise,gstPercent},requestId:request.headers.get("cf-ray")??""});
    return Response.json({ saved: true }, { status: 201, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
