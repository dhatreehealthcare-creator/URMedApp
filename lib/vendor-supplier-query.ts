export const vendorSupplierStatuses = ["all", "active", "inactive"] as const;
export const vendorSupplierSorts = ["name", "recent_purchase", "payable_high", "purchase_value_high"] as const;

export type VendorSupplierStatus = typeof vendorSupplierStatuses[number];
export type VendorSupplierSort = typeof vendorSupplierSorts[number];

export type VendorSupplierQuery = {
  query: string;
  status: VendorSupplierStatus;
  sort: VendorSupplierSort;
  page: number;
  pageSize: number;
};

function oneOf<const Values extends readonly string[]>(
  value: string | null,
  values: Values,
  fallback: Values[number],
) {
  return values.includes(value ?? "") ? value as Values[number] : fallback;
}

function boundedInteger(value: string | null, fallback: number, minimum: number, maximum: number) {
  if (value === null || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

export function escapeSupplierSqlLike(value: string) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export function parseVendorSupplierQuery(input: URL | URLSearchParams): VendorSupplierQuery {
  const parameters = input instanceof URL ? input.searchParams : input;
  return {
    query: (parameters.get("q") ?? "").trim().replace(/\s+/g, " ").slice(0, 100),
    status: oneOf(parameters.get("status"), vendorSupplierStatuses, "all"),
    sort: oneOf(parameters.get("sort"), vendorSupplierSorts, "name"),
    page: boundedInteger(parameters.get("page"), 1, 1, 100_000),
    pageSize: boundedInteger(parameters.get("pageSize"), 12, 5, 50),
  };
}

export function parseSupplierHistoryPage(input: URL | URLSearchParams) {
  const parameters = input instanceof URL ? input.searchParams : input;
  return {
    page: boundedInteger(parameters.get("page"), 1, 1, 100_000),
    pageSize: boundedInteger(parameters.get("pageSize"), 10, 5, 50),
  };
}

export function vendorSupplierSortExpression(sort: VendorSupplierSort) {
  if (sort === "recent_purchase") return "lastPurchaseDate IS NULL, date(lastPurchaseDate) DESC, supplier.business_name COLLATE NOCASE, supplier.id";
  if (sort === "payable_high") return "payablePaise DESC, supplier.business_name COLLATE NOCASE, supplier.id";
  if (sort === "purchase_value_high") return "grossPurchasePaise DESC, supplier.business_name COLLATE NOCASE, supplier.id";
  return "supplier.business_name COLLATE NOCASE, supplier.id";
}

