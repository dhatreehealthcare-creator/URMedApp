import { getD1 } from "../../../db/d1";
import { currentOperationalVendorPredicate } from "../../../lib/operational-vendor";
import { attachPublishedVendorLocation } from "../../../lib/vendor-public-location";
import { effectivePriceFallbackSql } from "../../../lib/effective-pricing";
import { enforceRateLimit } from "../../../lib/abuse-controls";

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
  inventoryId: number | null;
  salePricePaise: number | null;
  availableQuantity: number | null;
  pharmacyName: string | null;
};

export async function GET(request: Request) {
  try {
    const limited = await enforceRateLimit(request, "public_search");
    if (limited) return limited;
    const url = new URL(request.url);
    const query = url.searchParams.get("q")?.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() ?? "";
    const requestedLimit = Number(url.searchParams.get("limit") ?? 20);
    const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? requestedLimit : 20, 1), 50);
    const db = getD1();
    const operationalOffer = currentOperationalVendorPredicate("offer_vendor");
    let result;
    if (query) {
      result = await db.prepare(`
        SELECT p.legacy_id AS legacyId, p.category_id AS categoryId, p.name, p.composition,
          COALESCE(canonical_manufacturer.name, p.manufacturer) AS manufacturer, p.prescription_required AS prescriptionRequired,
          p.gst_percent AS gstPercent, p.hsn_code AS hsnCode, p.packaging,
          i.id AS inventoryId, ${effectivePriceFallbackSql("i", "sale_price_paise")} AS salePricePaise,
          (SELECT SUM(stock.quantity - stock.reserved_quantity) FROM pharmacy_inventory stock
            WHERE stock.vendor_id = i.vendor_id AND stock.product_id = i.product_id AND stock.active = 1
              AND stock.cold_chain_status IN ('not_applicable','within_range')
              AND stock.quarantine_status = 'available' AND stock.expiry_date IS NOT NULL
              AND date(stock.expiry_date) >= date('now') AND (stock.quantity - stock.reserved_quantity) > 0
          ) AS availableQuantity, v.business_name AS pharmacyName,
          public_location.label AS publicLocationLabel,
          public_location.address AS publicLocationAddress,
          public_location.latitude AS publicLocationLatitude,
          public_location.longitude AS publicLocationLongitude,
          public_location.pickup_enabled AS publicPickupEnabled,
          public_location.service_enabled AS publicServiceEnabled,
          public_location.service_radius_km AS publicServiceRadiusKm
        FROM products p
        LEFT JOIN manufacturers canonical_manufacturer ON canonical_manufacturer.id = p.manufacturer_id
        LEFT JOIN manufacturer_canonical_state manufacturer_state
          ON manufacturer_state.manufacturer_id = canonical_manufacturer.id AND manufacturer_state.status = 'active'
        LEFT JOIN pharmacy_inventory i ON i.id = (
          SELECT offer.id FROM pharmacy_inventory offer JOIN vendors offer_vendor ON offer_vendor.id = offer.vendor_id
          WHERE offer.product_id = p.id AND offer.active = 1 AND offer.quarantine_status = 'available'
            AND offer.cold_chain_status IN ('not_applicable','within_range')
            AND ${operationalOffer}
            AND offer.expiry_date IS NOT NULL AND date(offer.expiry_date) >= date('now')
            AND (offer.quantity - offer.reserved_quantity) > 0
          ORDER BY date(offer.expiry_date), offer.id LIMIT 1
        )
        LEFT JOIN vendors v ON v.id = i.vendor_id
        LEFT JOIN vendor_public_locations public_location
          ON public_location.vendor_id = v.id AND public_location.publication_status = 'published'
        WHERE p.active = 1 AND (p.normalized_name LIKE ? OR lower(p.composition) LIKE ?
          OR (manufacturer_state.manufacturer_id IS NOT NULL AND (
            canonical_manufacturer.normalized_name LIKE ?
            OR EXISTS (SELECT 1 FROM manufacturer_aliases alias
              WHERE alias.manufacturer_id = canonical_manufacturer.id AND alias.normalized_alias LIKE ?)
          )) OR EXISTS (SELECT 1 FROM product_barcodes barcode WHERE barcode.product_id=p.id AND barcode.status='approved' AND barcode.code LIKE ?))
        ORDER BY CASE WHEN i.id IS NOT NULL THEN 0 ELSE 1 END,
          CASE WHEN p.normalized_name LIKE ? THEN 0 ELSE 1 END, p.name
        LIMIT ?
      `).bind(`${query}%`, `%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`, `${query}%`, limit).all<CatalogRow>();
    } else {
      result = await db.prepare(`
        SELECT p.legacy_id AS legacyId, p.category_id AS categoryId, p.name, p.composition,
          COALESCE(canonical_manufacturer.name, p.manufacturer) AS manufacturer, p.prescription_required AS prescriptionRequired,
          p.gst_percent AS gstPercent, p.hsn_code AS hsnCode, p.packaging,
          i.id AS inventoryId, ${effectivePriceFallbackSql("i", "sale_price_paise")} AS salePricePaise,
          (SELECT SUM(stock.quantity - stock.reserved_quantity) FROM pharmacy_inventory stock
            WHERE stock.vendor_id = i.vendor_id AND stock.product_id = i.product_id AND stock.active = 1
              AND stock.cold_chain_status IN ('not_applicable','within_range')
              AND stock.quarantine_status = 'available' AND stock.expiry_date IS NOT NULL
              AND date(stock.expiry_date) >= date('now') AND (stock.quantity - stock.reserved_quantity) > 0
          ) AS availableQuantity, v.business_name AS pharmacyName,
          public_location.label AS publicLocationLabel,
          public_location.address AS publicLocationAddress,
          public_location.latitude AS publicLocationLatitude,
          public_location.longitude AS publicLocationLongitude,
          public_location.pickup_enabled AS publicPickupEnabled,
          public_location.service_enabled AS publicServiceEnabled,
          public_location.service_radius_km AS publicServiceRadiusKm
        FROM products p
        LEFT JOIN manufacturers canonical_manufacturer ON canonical_manufacturer.id = p.manufacturer_id
        LEFT JOIN manufacturer_canonical_state manufacturer_state
          ON manufacturer_state.manufacturer_id = canonical_manufacturer.id AND manufacturer_state.status = 'active'
        LEFT JOIN pharmacy_inventory i ON i.id = (
          SELECT offer.id FROM pharmacy_inventory offer JOIN vendors offer_vendor ON offer_vendor.id = offer.vendor_id
          WHERE offer.product_id = p.id AND offer.active = 1 AND offer.quarantine_status = 'available'
            AND offer.cold_chain_status IN ('not_applicable','within_range')
            AND ${operationalOffer}
            AND offer.expiry_date IS NOT NULL AND date(offer.expiry_date) >= date('now')
            AND (offer.quantity - offer.reserved_quantity) > 0
          ORDER BY date(offer.expiry_date), offer.id LIMIT 1
        )
        LEFT JOIN vendors v ON v.id = i.vendor_id
        LEFT JOIN vendor_public_locations public_location
          ON public_location.vendor_id = v.id AND public_location.publication_status = 'published'
        WHERE p.active = 1
        ORDER BY CASE WHEN i.id IS NOT NULL THEN 0 ELSE 1 END, p.legacy_id LIMIT ?
      `).bind(limit).all<CatalogRow>();
    }
    const products = result.results.map((product) => attachPublishedVendorLocation(product as unknown as Record<string, unknown>));
    return Response.json({ query, products, returned: products.length }, {
      headers: { "Cache-Control": "public, max-age=60" },
    });
  } catch (error) {
    console.error("Public catalogue query failed", error);
    return Response.json({ error: "Catalogue is temporarily unavailable", products: [] }, {
      status: 500,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
