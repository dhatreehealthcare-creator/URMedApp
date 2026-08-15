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
import { effectivePriceFallbackSql } from "../../../lib/effective-pricing";
import { getRuntimeEnv } from "../../../lib/runtime-env";
import { enforceRateLimit } from "../../../lib/abuse-controls";
import { isValidGeoPoint } from "../../../lib/geo";
import { rankMarketplaceOffers, PUBLIC_MARKETPLACE_MAX_RADIUS_KM } from "../../../lib/marketplace-offer-ranking";

const PUBLIC_SEARCH_PAGE_SIZE = 20;
const PUBLIC_SEARCH_MAX_PAGE_SIZE = 50;
const PUBLIC_SEARCH_MAX_CANDIDATES = 20_000;

type InventoryRow = {
  id: number;
  vendorId: number;
  branchId: number | null;
  branchName?: string | null;
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
  totalCount?: number;
  publicLocationLabel?: string | null;
  publicLocationAddress?: string | null;
  publicLocationLatitude?: string | null;
  publicLocationLongitude?: string | null;
  publicPickupEnabled?: number | null;
  publicServiceEnabled?: number | null;
  publicServiceRadiusKm?: number | null;
};

function boundedInteger(value: string | null, fallback: number, minimum: number, maximum: number) {
  if (value === null || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

export async function GET(request: Request) {
  // Legacy compatibility: JOIN vendor_public_locations and
  // public_location.publication_status = 'published' are mirrored into the
  // primary branch; public discovery itself uses branch rows.
  try {
    const limited = await enforceRateLimit(request, "public_search");
    if (limited) return limited;
    const url = new URL(request.url);
    const mine = url.searchParams.get("scope") === "mine";
    const requestedMineBranchId = url.searchParams.get("branchId");
    const query = (url.searchParams.get("q") ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const page = boundedInteger(url.searchParams.get("page"), 1, 1, 100_000);
    const pageSize = boundedInteger(url.searchParams.get("pageSize"), PUBLIC_SEARCH_PAGE_SIZE, 1, PUBLIC_SEARCH_MAX_PAGE_SIZE);
    const latitudeText = url.searchParams.get("latitude");
    const longitudeText = url.searchParams.get("longitude");
    const hasLatitude = latitudeText !== null && latitudeText.trim() !== "";
    const hasLongitude = longitudeText !== null && longitudeText.trim() !== "";
    if (!mine && hasLatitude !== hasLongitude) {
      return Response.json({ error: "Nearby search requires both latitude and longitude" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    }
    const nearby = !mine && hasLatitude && hasLongitude;
    const customerPoint = nearby ? { latitude: Number(latitudeText), longitude: Number(longitudeText) } : null;
    if (nearby && (!customerPoint || !isValidGeoPoint(customerPoint))) {
      return Response.json({ error: "Nearby search coordinates are invalid" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    }
    const db = getD1();
    let where = `i.active = 1 AND i.quarantine_status = 'available' AND i.expiry_date IS NOT NULL
      AND i.cold_chain_status IN ('not_applicable','within_range') AND p.active = 1
      AND ${currentOperationalVendorPredicate("v")}
      AND date(i.expiry_date) >= date('now') AND (i.quantity - i.reserved_quantity) > 0
      AND i.id = (SELECT offer.id FROM pharmacy_inventory offer
        WHERE offer.vendor_id = i.vendor_id AND offer.branch_id = i.branch_id AND offer.product_id = i.product_id AND offer.active = 1
          AND offer.cold_chain_status IN ('not_applicable','within_range')
          AND offer.quarantine_status = 'available' AND offer.expiry_date IS NOT NULL
          AND date(offer.expiry_date) >= date('now') AND (offer.quantity - offer.reserved_quantity) > 0
        ORDER BY date(offer.expiry_date), offer.id LIMIT 1)`;
    const bindings: unknown[] = [];
    let purchaseColumn = "";
    let quantityColumn = `(SELECT SUM(stock.quantity - stock.reserved_quantity) FROM pharmacy_inventory stock
      WHERE stock.vendor_id = i.vendor_id AND stock.branch_id = i.branch_id AND stock.product_id = i.product_id AND stock.active = 1
        AND stock.cold_chain_status IN ('not_applicable','within_range')
        AND stock.quarantine_status = 'available' AND stock.expiry_date IS NOT NULL
        AND date(stock.expiry_date) >= date('now') AND (stock.quantity - stock.reserved_quantity) > 0)`;
    if (mine) {
      const { vendorId, branchId: staffBranchId } = await requireVendorPermission(request,"inventory.read");
      if (requestedMineBranchId !== null && (!/^\d+$/.test(requestedMineBranchId) || Number(requestedMineBranchId) < 1)) {
        return Response.json({ error: "Branch is invalid" }, { status: 400, headers: { "Cache-Control": "no-store" } });
      }
      if (staffBranchId !== null && requestedMineBranchId !== null && Number(requestedMineBranchId) !== staffBranchId) {
        return Response.json({ error: "Your staff access is limited to another pharmacy branch" }, { status: 403, headers: { "Cache-Control": "no-store" } });
      }
      where = "i.vendor_id = ?";
      bindings.push(vendorId);
      const effectiveMineBranchId = staffBranchId ?? (requestedMineBranchId === null ? null : Number(requestedMineBranchId));
      if (effectiveMineBranchId !== null) {
        where += " AND i.branch_id = ?";
        bindings.push(effectiveMineBranchId);
      }
      purchaseColumn = `, ${effectivePriceFallbackSql("i", "purchase_price_paise")} AS purchasePricePaise`;
      quantityColumn = "i.quantity";
    }
    if (!mine) {
      where += ` AND branch.status = 'active' AND branch.public_location_status = 'published'
        AND branch.public_address <> '' AND branch.public_latitude <> '' AND branch.public_longitude <> ''
        AND CAST(branch.public_latitude AS REAL) BETWEEN -90 AND 90
        AND CAST(branch.public_longitude AS REAL) BETWEEN -180 AND 180`;
    }
    if (query) {
      where += ` AND (p.normalized_name LIKE ? OR p.normalized_generic_name LIKE ? OR p.normalized_trade_name LIKE ? OR (manufacturer_state.manufacturer_id IS NOT NULL AND (
        canonical_manufacturer.normalized_name LIKE ? OR EXISTS (SELECT 1 FROM manufacturer_aliases alias
          WHERE alias.manufacturer_id = canonical_manufacturer.id AND alias.normalized_alias LIKE ?))
        ) OR EXISTS (SELECT 1 FROM product_barcodes barcode WHERE barcode.product_id=p.id AND barcode.status='approved' AND barcode.code LIKE ?))`;
      bindings.push(`%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`, `${query}%`);
    }
    if (nearby && customerPoint) {
      const latitudeDelta = PUBLIC_MARKETPLACE_MAX_RADIUS_KM / 111.32;
      const longitudeDelta = PUBLIC_MARKETPLACE_MAX_RADIUS_KM / Math.max(111.32 * Math.cos(customerPoint.latitude * Math.PI / 180), 0.1);
      where += ` AND CAST(branch.public_latitude AS REAL) BETWEEN ? AND ?
        AND CAST(branch.public_longitude AS REAL) BETWEEN ? AND ?`;
      bindings.push(
        Math.max(-90, customerPoint.latitude - latitudeDelta),
        Math.min(90, customerPoint.latitude + latitudeDelta),
        Math.max(-180, customerPoint.longitude - longitudeDelta),
        Math.min(180, customerPoint.longitude + longitudeDelta),
      );
    }
    const limit = nearby ? PUBLIC_SEARCH_MAX_CANDIDATES + 1 : (mine ? 200 : pageSize + 1);
    bindings.push(limit, mine || nearby ? 0 : (page - 1) * pageSize);
    const locationJoin = mine
      ? `LEFT JOIN pharmacy_branches branch ON branch.id = i.branch_id AND branch.vendor_id = v.id`
      : `JOIN pharmacy_branches branch ON branch.id = i.branch_id AND branch.vendor_id = v.id`;
    const result = await db.prepare(`
      SELECT i.id, i.vendor_id AS vendorId, i.product_id AS productId, p.legacy_id AS legacyId,
        p.name AS productName, COALESCE(canonical_manufacturer.name, p.manufacturer) AS manufacturer,
        p.prescription_required AS prescriptionRequired,
        v.business_name AS businessName, v.home_delivery AS homeDelivery,
        i.branch_id AS branchId, branch.name AS branchName,
        branch.public_label AS publicLocationLabel,
        branch.public_address AS publicLocationAddress,
        branch.public_latitude AS publicLocationLatitude,
        branch.public_longitude AS publicLocationLongitude,
        branch.pickup_enabled AS publicPickupEnabled,
        branch.service_enabled AS publicServiceEnabled,
        branch.service_radius_km AS publicServiceRadiusKm,
        i.batch_number AS batchNumber, i.expiry_date AS expiryDate,
        ${effectivePriceFallbackSql("i", "sale_price_paise")} AS salePricePaise, ${quantityColumn} AS quantity,
        i.reserved_quantity AS reservedQuantity, i.gst_percent AS gstPercent,
        i.reorder_level AS reorderLevel, i.quarantine_status AS quarantineStatus,
        COUNT(*) OVER() AS totalCount,
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
      ${locationJoin}
      WHERE ${where}
      ORDER BY CASE WHEN i.expiry_date IS NULL OR date(i.expiry_date) < date('now') THEN 0
        WHEN date(i.expiry_date) <= date('now', '+3 months') THEN 1 ELSE 2 END,
        date(i.expiry_date), i.updated_at DESC, i.vendor_id, i.id LIMIT ? OFFSET ?
    `).bind(...bindings).all<InventoryRow>();
    if (!mine && nearby && result.results.length > PUBLIC_SEARCH_MAX_CANDIDATES) {
      return Response.json({ error: "Nearby search is too broad. Add a medicine name or reduce the search area." }, { status: 422, headers: { "Cache-Control": "no-store" } });
    }
    const nearbyRanked = nearby && customerPoint ? rankMarketplaceOffers(result.results, customerPoint, page, pageSize, (row) => ({
      inventoryId: row.id,
      vendorId: row.vendorId,
      availableQuantity: row.quantity,
      expiryDate: row.expiryDate,
      location: {
        latitude: String(row.publicLocationLatitude ?? ""),
        longitude: String(row.publicLocationLongitude ?? ""),
        pickupEnabled: Number(row.publicPickupEnabled ?? 0),
        serviceEnabled: Number(row.publicServiceEnabled ?? 0),
        serviceRadiusKm: Number(row.publicServiceRadiusKm),
      },
    })) : null;
    const total = nearbyRanked?.total ?? Number(result.results[0]?.totalCount ?? result.results.length);
    const paged = nearbyRanked?.offers ?? result.results.slice(0, pageSize).map((row) => ({ value: row, distanceKm: undefined }));
    const inventory = paged.map(({ value: row, distanceKm: distance }) => {
      const publicRecord = mine ? row as unknown as Record<string, unknown> : redactPrivateVendorLocation(row);
      const attached = attachPublishedVendorLocation(publicRecord);
      return distance === undefined ? attached : { ...attached, publicDistanceKm: distance };
    });
    return Response.json({ inventory, pagination: {
      page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)),
      hasMore: page * pageSize < total,
      nearby,
    } }, { headers: { "Cache-Control": mine ? "private, no-store" : "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const { profile,vendorId,branchId: staffBranchId } = await requireVendorPermission(request,"inventory.write");
    const body = await request.json() as Record<string, unknown>;
    const requestedBranchId = body.branchId === undefined ? null : asPositiveInteger(body.branchId, "Branch", 1000000000);
    if (staffBranchId !== null && requestedBranchId !== null && requestedBranchId !== staffBranchId) {
      return Response.json({ error: "Your staff access is limited to another pharmacy branch" }, { status: 403 });
    }
    const branch = await getD1().prepare(`SELECT id FROM pharmacy_branches WHERE vendor_id = ? AND status = 'active'
      AND (id = ? OR (? IS NULL AND is_primary = 1)) LIMIT 1`).bind(vendorId, staffBranchId ?? requestedBranchId, staffBranchId ?? requestedBranchId).first<{ id: number }>();
    if (!branch) return Response.json({ error: "Choose an active pharmacy branch belonging to this pharmacy" }, { status: 400 });
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
    const ceiling = await getD1().prepare("SELECT ceiling_price_paise AS ceilingPaise FROM product_ceiling_prices WHERE product_id=(SELECT id FROM products WHERE legacy_id=?) AND date(effective_from)<=date('now') AND (effective_until IS NULL OR date(effective_until)>date('now')) ORDER BY date(effective_from) DESC,id DESC LIMIT 1").bind(legacyId).first<{ ceilingPaise:number }>();
    try { validatePricePolicy({ purchasePricePaise, salePricePaise, mrpPaise, gstPercent }, ceiling?.ceilingPaise ?? null, getRuntimeEnv().NPPA_CEILING_MODE === "enforce"); }
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
    const existing = await getD1().prepare(`SELECT id FROM pharmacy_inventory WHERE vendor_id=? AND branch_id=? AND product_id=? AND batch_number=? LIMIT 1`)
      .bind(vendorId,branch.id,product.id,batchNumber).first();
    if(existing)return Response.json({error:"This batch already exists. Use purchase receiving or an audited stock adjustment instead of replacing its quantity."},{status:409});
    const results=await getD1().batch([
      getD1().prepare(`
      INSERT INTO pharmacy_inventory (vendor_id, branch_id, product_id, batch_number, expiry_date, manufacturing_date,
        dosage, purchase_price_paise, sale_price_paise, mrp_paise, quantity, gst_percent, reorder_level, quarantine_status, active)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'available', 1)
    `).bind(
      vendorId, branch.id, product.id, batchNumber, expiryDate, manufacturingDate || null,
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
