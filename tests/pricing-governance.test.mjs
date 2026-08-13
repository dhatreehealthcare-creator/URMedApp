import assert from "node:assert/strict";
import test from "node:test";

const source = await import("../lib/pricing-governance.ts");

test("D-13 pricing policy treats sale price as GST-exclusive and MRP as tax-inclusive", () => {
  assert.deepEqual(source.validatePricePolicy({ purchasePricePaise: 100, salePricePaise: 120, mrpPaise: 150, gstPercent: 5 }), {
    purchasePricePaise: 100, salePricePaise: 120, mrpPaise: 150, gstPercent: 5, ceilingAdvisory: false,
  });
  assert.throws(() => source.validatePricePolicy({ purchasePricePaise: 100, salePricePaise: 151, mrpPaise: 150, gstPercent: 5 }), /MRP/);
  assert.throws(() => source.validatePricePolicy({ purchasePricePaise: 100, salePricePaise: 120, mrpPaise: 150, gstPercent: 7 }), /GST/);
});

test("presentation conversions are explicit integer base-unit conversions", () => {
  assert.equal(source.presentationToBase(3, 10), 30);
  assert.throws(() => source.presentationToBase(0, 10), /positive/);
  assert.throws(() => source.presentationToBase(1, 0), /positive/);
});

test("GTIN policy validates symbology and check digits", () => {
  assert.deepEqual(source.normalizeBarcode("4006381333931", "GTIN-13"), { code: "4006381333931", symbology: "GTIN-13" });
  assert.throws(() => source.normalizeBarcode("4006381333932", "GTIN-13"), /check digit/);
  assert.throws(() => source.normalizeBarcode("ABC", "GTIN-13"), /digits/);
});

test("effective price selection is deterministic by effective date", () => {
  assert.equal(source.effectivePrice([
    { effectiveFrom: "2026-01-01", salePricePaise: 100, mrpPaise: 120 },
    { effectiveFrom: "2026-03-01", salePricePaise: 110, mrpPaise: 130 },
  ], "2026-02-01")?.salePricePaise, 100);
  assert.equal(source.effectivePrice([], "2026-02-01"), null);
});

test("pricing API and migration expose governance routes and immutable history", async () => {
  const fs = await import("node:fs/promises");
  const route = await fs.readFile("app/api/vendor/pricing/route.ts", "utf8");
  const migration = await fs.readFile("drizzle/0052_pricing_uom_governance.sql", "utf8");
  assert.match(route, /export async function GET/);
  assert.match(route, /export async function POST/);
  assert.match(migration, /inventory_price_history/);
  assert.match(migration, /product_pack_conversions/);
  assert.match(migration, /product_barcodes/);
  assert.match(migration, /inventory_price_history_no_update/);
  assert.match(migration, /sale_price_paise` <= `mrp_paise/);
});
