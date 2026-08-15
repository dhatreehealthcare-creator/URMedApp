import { getD1 } from "../../../db/d1";
import { currentOperationalVendorPredicate } from "../../../lib/operational-vendor";
import { attachPublishedVendorLocation } from "../../../lib/vendor-public-location";
import { effectivePriceFallbackSql } from "../../../lib/effective-pricing";
import { enforceRateLimit } from "../../../lib/abuse-controls";
import { isValidGeoPoint } from "../../../lib/geo";
import { rankMarketplaceOffers, PUBLIC_MARKETPLACE_MAX_RADIUS_KM } from "../../../lib/marketplace-offer-ranking";

const MAX_PAGE_SIZE = 50;
const MAX_CANDIDATES = 20_000;

type CatalogRow = {
  legacyId: number;
  categoryId: number | null;
  name: string;
  composition: string;
  manufacturer: string;
  prescriptionRequired: number;
  gstPercent: number;
  hsnCode: string;
  packaging: string;
  inventoryId: number;
  vendorId: number;
  branchId: number;
  branchName: string;
  salePricePaise: number;
  availableQuantity: number;
  pharmacyName: string;
  expiryDate: string;
  batchNumber: string;
  publicLocationLabel: string;
  publicLocationAddress: string;
  publicLocationLatitude: string;
  publicLocationLongitude: string;
  publicPickupEnabled: number;
  publicServiceEnabled: number;
  publicServiceRadiusKm: number;
  totalCount?: number;
};

function boundedInteger(value: string | null, fallback: number, minimum: number, maximum: number) {
  if (value === null || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function responseHeaders() {
  return { "Cache-Control": "no-store" };
}

export async function GET(request: Request) {
  // Legacy compatibility: JOIN vendor_public_locations and
  // public_location.publication_status = 'published' are mirrored into the
  // primary branch; branch rows are the authoritative multi-store source.
  try {
    const limited = await enforceRateLimit(request, "public_search");
    if (limited) return limited;
    const url = new URL(request.url);
    const query = url.searchParams.get("q")?.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() ?? "";
    const page = boundedInteger(url.searchParams.get("page"), 1, 1, 100_000);
    const pageSize = boundedInteger(url.searchParams.get("pageSize") ?? url.searchParams.get("limit"), 20, 1, MAX_PAGE_SIZE);
    const latitudeText = url.searchParams.get("latitude");
    const longitudeText = url.searchParams.get("longitude");
    const hasLatitude = latitudeText !== null && latitudeText.trim() !== "";
    const hasLongitude = longitudeText !== null && longitudeText.trim() !== "";
    if (hasLatitude !== hasLongitude) {
      return Response.json({ error: "Nearby search requires both latitude and longitude" }, { status: 400, headers: responseHeaders() });
    }
    const nearby = hasLatitude && hasLongitude;
    const customerPoint = nearby ? { latitude: Number(latitudeText), longitude: Number(longitudeText) } : null;
    if (nearby && (!customerPoint || !isValidGeoPoint(customerPoint))) {
      return Response.json({ error: "Nearby search coordinates are invalid" }, { status: 400, headers: responseHeaders() });
    }

    const where: string[] = [
      "p.active = 1",
      "i.active = 1",
      "i.quarantine_status = 'available'",
      "i.cold_chain_status IN ('not_applicable','within_range')",
      "i.expiry_date IS NOT NULL",
      "date(i.expiry_date) >= date('now')",
      "(i.quantity - i.reserved_quantity) > 0",
      currentOperationalVendorPredicate("v"),
      "branch.status = 'active'",
      "branch.public_location_status = 'published'",
      "branch.public_address <> ''",
      "branch.public_latitude <> ''",
      "branch.public_longitude <> ''",
      "CAST(branch.public_latitude AS REAL) BETWEEN -90 AND 90",
      "CAST(branch.public_longitude AS REAL) BETWEEN -180 AND 180",
      `i.id = (SELECT offer.id FROM pharmacy_inventory offer
        WHERE offer.vendor_id = i.vendor_id AND offer.branch_id = i.branch_id AND offer.product_id = i.product_id AND offer.active = 1
          AND offer.quarantine_status = 'available'
          AND offer.cold_chain_status IN ('not_applicable','within_range')
          AND offer.expiry_date IS NOT NULL AND date(offer.expiry_date) >= date('now')
          AND (offer.quantity - offer.reserved_quantity) > 0
        ORDER BY date(offer.expiry_date), offer.id LIMIT 1)`,
    ];
    const bindings: unknown[] = [];
    if (query) {
      where.push(`(p.normalized_name LIKE ? OR p.normalized_generic_name LIKE ? OR p.normalized_trade_name LIKE ?
        OR lower(p.composition) LIKE ? OR (manufacturer_state.manufacturer_id IS NOT NULL AND (
          canonical_manufacturer.normalized_name LIKE ? OR EXISTS (SELECT 1 FROM manufacturer_aliases alias
            WHERE alias.manufacturer_id = canonical_manufacturer.id AND alias.normalized_alias LIKE ?))
        ) OR EXISTS (SELECT 1 FROM product_barcodes barcode
          WHERE barcode.product_id = p.id AND barcode.status = 'approved' AND barcode.code LIKE ?))`);
      bindings.push(`%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`, `${query}%`);
    }
    if (nearby && customerPoint) {
      const latitudeDelta = PUBLIC_MARKETPLACE_MAX_RADIUS_KM / 111.32;
      const longitudeDelta = PUBLIC_MARKETPLACE_MAX_RADIUS_KM / Math.max(111.32 * Math.cos(customerPoint.latitude * Math.PI / 180), 0.1);
      where.push("CAST(branch.public_latitude AS REAL) BETWEEN ? AND ?");
      where.push("CAST(branch.public_longitude AS REAL) BETWEEN ? AND ?");
      bindings.push(
        Math.max(-90, customerPoint.latitude - latitudeDelta),
        Math.min(90, customerPoint.latitude + latitudeDelta),
        Math.max(-180, customerPoint.longitude - longitudeDelta),
        Math.min(180, customerPoint.longitude + longitudeDelta),
      );
    }
    const resultLimit = nearby ? MAX_CANDIDATES + 1 : pageSize + 1;
    bindings.push(resultLimit, nearby ? 0 : (page - 1) * pageSize);
    const result = await getD1().prepare(`
      SELECT p.legacy_id AS legacyId, p.category_id AS categoryId, p.name, p.composition,
        COALESCE(canonical_manufacturer.name, p.manufacturer) AS manufacturer,
        p.prescription_required AS prescriptionRequired, p.gst_percent AS gstPercent,
        p.hsn_code AS hsnCode, p.packaging, i.id AS inventoryId, i.vendor_id AS vendorId,
        ${effectivePriceFallbackSql("i", "sale_price_paise")} AS salePricePaise,
        (SELECT SUM(stock.quantity - stock.reserved_quantity) FROM pharmacy_inventory stock
          WHERE stock.vendor_id = i.vendor_id AND stock.branch_id = i.branch_id AND stock.product_id = i.product_id AND stock.active = 1
            AND stock.cold_chain_status IN ('not_applicable','within_range')
            AND stock.quarantine_status = 'available' AND stock.expiry_date IS NOT NULL
            AND date(stock.expiry_date) >= date('now') AND (stock.quantity - stock.reserved_quantity) > 0
        ) AS availableQuantity,
        v.business_name AS pharmacyName, i.batch_number AS batchNumber, i.expiry_date AS expiryDate,
        i.branch_id AS branchId, branch.name AS branchName,
        branch.public_label AS publicLocationLabel, branch.public_address AS publicLocationAddress,
        branch.public_latitude AS publicLocationLatitude, branch.public_longitude AS publicLocationLongitude,
        branch.pickup_enabled AS publicPickupEnabled,
        branch.service_enabled AS publicServiceEnabled,
        branch.service_radius_km AS publicServiceRadiusKm,
        COUNT(*) OVER() AS totalCount
      FROM pharmacy_inventory i
      JOIN products p ON p.id = i.product_id
      JOIN vendors v ON v.id = i.vendor_id
      JOIN pharmacy_branches branch ON branch.id = i.branch_id AND branch.vendor_id = v.id
      LEFT JOIN manufacturers canonical_manufacturer ON canonical_manufacturer.id = p.manufacturer_id
      LEFT JOIN manufacturer_canonical_state manufacturer_state
        ON manufacturer_state.manufacturer_id = canonical_manufacturer.id AND manufacturer_state.status = 'active'
      WHERE ${where.join(" AND ")}
      ORDER BY date(i.expiry_date), i.vendor_id, i.id
      LIMIT ? OFFSET ?
    `).bind(...bindings).all<CatalogRow>();
    if (nearby && result.results.length > MAX_CANDIDATES) {
      return Response.json({ error: "Nearby search is too broad. Add a medicine name or reduce the search area." }, { status: 422, headers: responseHeaders() });
    }

    const nearbyRanked = nearby && customerPoint ? rankMarketplaceOffers(result.results, customerPoint, page, pageSize, (row) => ({
      inventoryId: row.inventoryId,
      vendorId: row.vendorId,
      availableQuantity: row.availableQuantity,
      expiryDate: row.expiryDate,
      location: {
        latitude: row.publicLocationLatitude,
        longitude: row.publicLocationLongitude,
        pickupEnabled: row.publicPickupEnabled,
        serviceEnabled: row.publicServiceEnabled,
        serviceRadiusKm: row.publicServiceRadiusKm,
      },
    })) : null;
    const total = nearbyRanked?.total ?? Number(result.results[0]?.totalCount ?? result.results.length);
    const paged = nearbyRanked?.offers ?? result.results.slice(0, pageSize).map((row) => ({ value: row, distanceKm: undefined }));
    const products = paged.map(({ value: row, distanceKm: distance }) => {
      const record = attachPublishedVendorLocation(row as unknown as Record<string, unknown>);
      return distance === undefined ? record : { ...record, publicDistanceKm: distance };
    });
    return Response.json({ query, products, returned: products.length, pagination: {
      page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)),
      hasMore: page * pageSize < total, nearby,
    } }, { headers: responseHeaders() });
  } catch (error) {
    console.error("Public catalogue query failed", error);
    return Response.json({ error: "Catalogue is temporarily unavailable", products: [] }, {
      status: 500,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
