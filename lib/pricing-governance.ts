export const GTIN_SYMBOLOGIES = ["GTIN-8", "GTIN-12", "GTIN-13", "GTIN-14"] as const;
export type GtinSymbology = typeof GTIN_SYMBOLOGIES[number];

export class PricingGovernanceError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.name = "PricingGovernanceError"; this.status = status; }
}

export function positiveInteger(value: unknown, label: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new PricingGovernanceError(`${label} must be a positive integer`);
  return parsed;
}

export function isoDate(value: unknown, label: string, required = true) {
  const text = String(value ?? "").trim();
  if (!text && !required) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new PricingGovernanceError(`${label} must be YYYY-MM-DD`);
  const date = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== text) throw new PricingGovernanceError(`${label} is invalid`);
  return text;
}

export function validatePricePolicy(input: { purchasePricePaise: unknown; salePricePaise: unknown; mrpPaise: unknown; gstPercent: unknown }, ceilingPaise?: number | null, enforceCeiling = false) {
  const purchasePricePaise = Number(input.purchasePricePaise);
  const salePricePaise = Number(input.salePricePaise);
  const mrpPaise = Number(input.mrpPaise);
  const gstPercent = Number(input.gstPercent);
  if (!Number.isSafeInteger(purchasePricePaise) || purchasePricePaise < 0) throw new PricingGovernanceError("Purchase price is invalid");
  if (!Number.isSafeInteger(salePricePaise) || salePricePaise <= 0) throw new PricingGovernanceError("Sale price must be positive");
  if (!Number.isSafeInteger(mrpPaise) || mrpPaise <= 0 || salePricePaise > mrpPaise) throw new PricingGovernanceError("Sale price cannot exceed tax-inclusive MRP");
  if (![0, 5, 12, 18, 28].includes(gstPercent)) throw new PricingGovernanceError("GST must be 0, 5, 12, 18 or 28 percent");
  if (enforceCeiling && ceilingPaise == null) throw new PricingGovernanceError("An approved effective ceiling is required while NPPA enforcement is enabled", 409);
  if (enforceCeiling && mrpPaise > ceilingPaise!) throw new PricingGovernanceError("MRP exceeds the effective governed ceiling", 409);
  return { purchasePricePaise, salePricePaise, mrpPaise, gstPercent, ceilingAdvisory: ceilingPaise != null && mrpPaise > ceilingPaise };
}

export function presentationToBase(quantity: unknown, baseUnitsPerPresentation: unknown) {
  const amount = positiveInteger(quantity, "Presentation quantity");
  const conversion = positiveInteger(baseUnitsPerPresentation, "Conversion factor");
  const result = amount * conversion;
  if (!Number.isSafeInteger(result)) throw new PricingGovernanceError("Converted quantity is too large");
  return result;
}

export function normalizeBarcode(value: unknown, symbology: unknown = "GTIN-13") {
  const code = String(value ?? "").trim();
  const normalizedSymbology = String(symbology ?? "GTIN-13").trim().toUpperCase() as GtinSymbology;
  if (!GTIN_SYMBOLOGIES.includes(normalizedSymbology)) throw new PricingGovernanceError("Barcode symbology must be GTIN-8, GTIN-12, GTIN-13 or GTIN-14");
  const expectedLength = Number(normalizedSymbology.slice(5));
  if (!new RegExp(`^\\d{${expectedLength}}$`).test(code)) throw new PricingGovernanceError(`${normalizedSymbology} must contain ${expectedLength} digits`);
  let sum = 0;
  for (let index = code.length - 2, position = 0; index >= 0; index -= 1, position += 1) sum += Number(code[index]) * (position % 2 === 0 ? 3 : 1);
  const check = (10 - (sum % 10)) % 10;
  if (check !== Number(code.at(-1))) throw new PricingGovernanceError("Barcode check digit is invalid");
  return { code, symbology: normalizedSymbology };
}

export function effectivePrice(rows: Array<{ effectiveFrom: string; salePricePaise: number; mrpPaise: number }>, asOf: string) {
  return rows.filter((row) => row.effectiveFrom <= asOf).toSorted((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0] ?? null;
}
