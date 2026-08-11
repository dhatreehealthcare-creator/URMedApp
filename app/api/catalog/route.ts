import { getD1 } from "../../../db/d1";

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
    const url = new URL(request.url);
    const query = url.searchParams.get("q")?.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() ?? "";
    const requestedLimit = Number(url.searchParams.get("limit") ?? 20);
    const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? requestedLimit : 20, 1), 50);
    const db = getD1();
    let result;
    if (query) {
      result = await db.prepare(`
        SELECT p.legacy_id AS legacyId, p.category_id AS categoryId, p.name, p.composition,
          p.manufacturer, p.prescription_required AS prescriptionRequired,
          p.gst_percent AS gstPercent, p.hsn_code AS hsnCode, p.packaging,
          i.id AS inventoryId, i.sale_price_paise AS salePricePaise,
          (SELECT SUM(stock.quantity - stock.reserved_quantity) FROM pharmacy_inventory stock
            WHERE stock.vendor_id = i.vendor_id AND stock.product_id = i.product_id AND stock.active = 1
              AND stock.cold_chain_status IN ('not_applicable','within_range')
              AND stock.quarantine_status = 'available' AND stock.expiry_date IS NOT NULL
              AND date(stock.expiry_date) >= date('now') AND (stock.quantity - stock.reserved_quantity) > 0
          ) AS availableQuantity, v.business_name AS pharmacyName
        FROM products p
        LEFT JOIN pharmacy_inventory i ON i.id = (
          SELECT offer.id FROM pharmacy_inventory offer JOIN vendors offer_vendor ON offer_vendor.id = offer.vendor_id
          WHERE offer.product_id = p.id AND offer.active = 1 AND offer.quarantine_status = 'available'
            AND offer.cold_chain_status IN ('not_applicable','within_range')
            AND offer_vendor.approval_status = 'approved' AND offer_vendor.compliance_status = 'verified' AND offer_vendor.suspended_at IS NULL
            AND offer.expiry_date IS NOT NULL AND date(offer.expiry_date) >= date('now')
            AND (offer.quantity - offer.reserved_quantity) > 0
          ORDER BY date(offer.expiry_date), offer.id LIMIT 1
        )
        LEFT JOIN vendors v ON v.id = i.vendor_id
        WHERE p.active = 1 AND (p.normalized_name LIKE ? OR lower(p.composition) LIKE ? OR lower(p.manufacturer) LIKE ?)
        ORDER BY CASE WHEN i.id IS NOT NULL THEN 0 ELSE 1 END,
          CASE WHEN p.normalized_name LIKE ? THEN 0 ELSE 1 END, p.name
        LIMIT ?
      `).bind(`${query}%`, `%${query}%`, `%${query}%`, `${query}%`, limit).all<CatalogRow>();
    } else {
      result = await db.prepare(`
        SELECT p.legacy_id AS legacyId, p.category_id AS categoryId, p.name, p.composition,
          p.manufacturer, p.prescription_required AS prescriptionRequired,
          p.gst_percent AS gstPercent, p.hsn_code AS hsnCode, p.packaging,
          i.id AS inventoryId, i.sale_price_paise AS salePricePaise,
          (SELECT SUM(stock.quantity - stock.reserved_quantity) FROM pharmacy_inventory stock
            WHERE stock.vendor_id = i.vendor_id AND stock.product_id = i.product_id AND stock.active = 1
              AND stock.cold_chain_status IN ('not_applicable','within_range')
              AND stock.quarantine_status = 'available' AND stock.expiry_date IS NOT NULL
              AND date(stock.expiry_date) >= date('now') AND (stock.quantity - stock.reserved_quantity) > 0
          ) AS availableQuantity, v.business_name AS pharmacyName
        FROM products p
        LEFT JOIN pharmacy_inventory i ON i.id = (
          SELECT offer.id FROM pharmacy_inventory offer JOIN vendors offer_vendor ON offer_vendor.id = offer.vendor_id
          WHERE offer.product_id = p.id AND offer.active = 1 AND offer.quarantine_status = 'available'
            AND offer.cold_chain_status IN ('not_applicable','within_range')
            AND offer_vendor.approval_status = 'approved' AND offer_vendor.compliance_status = 'verified' AND offer_vendor.suspended_at IS NULL
            AND offer.expiry_date IS NOT NULL AND date(offer.expiry_date) >= date('now')
            AND (offer.quantity - offer.reserved_quantity) > 0
          ORDER BY date(offer.expiry_date), offer.id LIMIT 1
        )
        LEFT JOIN vendors v ON v.id = i.vendor_id
        WHERE p.active = 1
        ORDER BY CASE WHEN i.id IS NOT NULL THEN 0 ELSE 1 END, p.legacy_id LIMIT ?
      `).bind(limit).all<CatalogRow>();
    }
    return Response.json({ query, products: result.results, returned: result.results.length }, {
      headers: { "Cache-Control": "public, max-age=60" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Catalogue unavailable";
    return Response.json({ error: message, products: [] }, { status: 500 });
  }
}
