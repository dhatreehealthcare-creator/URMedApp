import { PricingGovernanceError } from "./pricing-governance.ts";

export type EffectivePrice = {
  inventoryId: number;
  vendorId: number;
  productId: number;
  purchasePricePaise: number;
  salePricePaise: number;
  mrpPaise: number;
  gstPercent: number;
  effectiveFrom: string;
  effectiveUntil: string | null;
};

/** Resolve the immutable price version that governs a batch at a transaction date. */
export async function resolveEffectivePrice(database: D1Database, inventoryId: number, asOf = new Date().toISOString().slice(0, 10)) {
  const row = await database.prepare(`
    SELECT inventory_id AS inventoryId, vendor_id AS vendorId, product_id AS productId,
      purchase_price_paise AS purchasePricePaise, sale_price_paise AS salePricePaise,
      mrp_paise AS mrpPaise, gst_percent AS gstPercent,
      effective_from AS effectiveFrom, effective_until AS effectiveUntil
    FROM inventory_price_history
    WHERE inventory_id=? AND date(effective_from)<=date(?)
      AND (effective_until IS NULL OR date(effective_until)>date(?))
    ORDER BY date(effective_from) DESC, id DESC LIMIT 1`).bind(inventoryId, asOf, asOf)
    .first<EffectivePrice>();
  if (!row) return null;
  if (row.salePricePaise <= 0 || row.salePricePaise > row.mrpPaise) {
    throw new PricingGovernanceError("The effective price record is invalid", 409);
  }
  return row;
}

/** SQL expression used in read paths; history is authoritative with inventory as legacy fallback. */
export function effectivePriceSql(alias: string, column: "sale_price_paise" | "mrp_paise" | "gst_percent" | "purchase_price_paise", asOfPlaceholder = "date('now')") {
  return `(SELECT history.${column} FROM inventory_price_history history WHERE history.inventory_id=${alias}.id AND date(history.effective_from)<=${asOfPlaceholder} AND (history.effective_until IS NULL OR date(history.effective_until)>${asOfPlaceholder}) ORDER BY date(history.effective_from) DESC, history.id DESC LIMIT 1)`;
}

export function effectivePriceFallbackSql(alias: string, column: "sale_price_paise" | "mrp_paise" | "gst_percent" | "purchase_price_paise", asOfPlaceholder = "date('now')") {
  return `COALESCE(${effectivePriceSql(alias, column, asOfPlaceholder)}, ${alias}.${column})`;
}
