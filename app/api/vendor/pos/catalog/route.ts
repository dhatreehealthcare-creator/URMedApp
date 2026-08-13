import { getD1 } from "../../../../../db/d1";
import { errorResponse } from "../../../../../lib/auth-server";
import { releaseExpiredReservations } from "../../../../../lib/inventory-reservations";
import { posProductRequiresPrescription } from "../../../../../lib/offline-pos";
import { requireVendorPermission } from "../../../../../lib/vendor-access";

type CatalogRow = {
  productId: number;
  productName: string;
  genericName: string;
  tradeName: string;
  manufacturer: string;
  strengthValue: string | null;
  strengthUnit: string | null;
  packType: string | null;
  packSizeValue: string | null;
  packSizeUnit: string | null;
  dispensingUom: string | null;
  prescriptionRequired: number;
  drugSchedule: string;
  hsnCode: string;
  availableQuantity: number;
  minimumPricePaise: number;
  maximumPricePaise: number;
  nextExpiryDate: string;
  batchCount: number;
  gstRates: string;
  totalCount: number;
};

function boundedInteger(value: string | null, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

export async function GET(request: Request) {
  try {
    const { vendorId } = await requireVendorPermission(request, "sale.write");
    const url = new URL(request.url);
    const query = (url.searchParams.get("q") ?? "").trim().toLowerCase().replace(/[%_]/g, "").slice(0, 100);
    const page = boundedInteger(url.searchParams.get("page"), 1, 1, 100_000);
    const pageSize = boundedInteger(url.searchParams.get("pageSize"), 20, 5, 50);
    const offset = (page - 1) * pageSize;
    const search = `%${query}%`;
    const db = getD1();
    await releaseExpiredReservations(db);
    const result = await db.prepare(`
      WITH product_stock AS (
        SELECT p.id AS productId, p.name AS productName, p.generic_name AS genericName,
          p.trade_name AS tradeName, p.manufacturer, p.strength_value AS strengthValue,
          p.strength_unit AS strengthUnit, p.pack_type AS packType,
          p.pack_size_value AS packSizeValue, p.pack_size_unit AS packSizeUnit,
          p.dispensing_uom AS dispensingUom, p.prescription_required AS prescriptionRequired,
          p.drug_schedule AS drugSchedule, p.hsn_code AS hsnCode,
          SUM(i.quantity - i.reserved_quantity) AS availableQuantity,
          MIN(i.sale_price_paise) AS minimumPricePaise,
          MAX(i.sale_price_paise) AS maximumPricePaise,
          MIN(i.expiry_date) AS nextExpiryDate, COUNT(*) AS batchCount,
          group_concat(DISTINCT i.gst_percent) AS gstRates
        FROM products p JOIN pharmacy_inventory i ON i.product_id = p.id
        WHERE i.vendor_id = ? AND p.active = 1 AND p.governance_status = 'approved'
          AND i.active = 1 AND i.quarantine_status = 'available'
          AND i.cold_chain_status IN ('not_applicable','within_range')
          AND i.expiry_date IS NOT NULL AND date(i.expiry_date) >= date('now')
          AND (i.quantity - i.reserved_quantity) > 0
          AND (? = '' OR lower(p.name) LIKE ? OR lower(p.generic_name) LIKE ?
            OR lower(p.trade_name) LIKE ? OR lower(p.manufacturer) LIKE ?)
        GROUP BY p.id, p.name, p.generic_name, p.trade_name, p.manufacturer,
          p.strength_value, p.strength_unit, p.pack_type, p.pack_size_value,
          p.pack_size_unit, p.dispensing_uom, p.prescription_required,
          p.drug_schedule, p.hsn_code
      ), counted AS (
        SELECT product_stock.*, COUNT(*) OVER() AS totalCount FROM product_stock
      )
      SELECT * FROM counted
      ORDER BY lower(productName), productId LIMIT ? OFFSET ?
    `).bind(vendorId, query, search, search, search, search, pageSize, offset).all<CatalogRow>();
    const total = Number(result.results[0]?.totalCount ?? 0);
    return Response.json({
      products: result.results.map((resultRow) => {
        const { totalCount, ...row } = resultRow;
        void totalCount;
        return {
          ...row,
          gstRates: String(row.gstRates ?? "").split(",").map(Number).filter(Number.isFinite).toSorted((a, b) => a - b),
          requiresPrescription: posProductRequiresPrescription(row),
          classificationRequired: row.drugSchedule === "UNCLASSIFIED",
        };
      }),
      pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
