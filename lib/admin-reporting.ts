import { haversineKm, isValidGeoPoint } from "./geo.ts";
import { effectivePriceFallbackSql } from "./effective-pricing.ts";

export type ReportPagination = { page: number; pageSize: number; total: number; totalPages: number };

/**
 * Synchronous exports are deliberately bounded.  They are generated inside the
 * request and must never attempt to materialize an unbounded report in Worker
 * memory.  Callers should narrow the filters (or use the paginated JSON API)
 * when the filtered result exceeds this limit.
 */
export const REPORT_EXPORT_MAX_ROWS = 5_000;
/**
 * Home-delivery filtering includes derived distance/SLA values that are
 * intentionally calculated in the Worker. Keep the date range bounded and
 * refuse an exceptionally large candidate set explicitly rather than
 * silently dropping rows before those filters run.
 */
const REPORT_QUERY_MAX_ROWS = 100_000;

export class AdminReportError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "AdminReportError";
    this.status = status;
  }
}

function integer(value: string | null, fallback: number, minimum: number, maximum: number) {
  if (value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new AdminReportError("A report filter is invalid");
  return parsed;
}

function optionalInteger(value: string | null, minimum: number, maximum: number) {
  if (value === null || value === "") return null;
  return integer(value, minimum, minimum, maximum);
}

function choice<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  if (!value) return fallback;
  if (!allowed.includes(value as T)) throw new AdminReportError("A report filter is invalid");
  return value as T;
}

function boundedText(value: string | null, maximum: number) {
  return String(value ?? "").trim().slice(0, maximum);
}

function isoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export function parseReportDateRange(parameters: URLSearchParams, now = new Date(), maximumDays = 366) {
  const today = now.toISOString().slice(0, 10);
  const defaultStart = new Date(`${today}T00:00:00.000Z`);
  defaultStart.setUTCDate(defaultStart.getUTCDate() - 29);
  const dateFrom = parameters.get("dateFrom") || defaultStart.toISOString().slice(0, 10);
  const dateTo = parameters.get("dateTo") || today;
  if (!isoDate(dateFrom) || !isoDate(dateTo)) throw new AdminReportError("Report dates must use YYYY-MM-DD");
  const days = Math.floor((Date.parse(`${dateTo}T00:00:00Z`) - Date.parse(`${dateFrom}T00:00:00Z`)) / 86_400_000) + 1;
  if (days < 1) throw new AdminReportError("Report start date must not be after its end date");
  if (days > maximumDays) throw new AdminReportError(`Report date range cannot exceed ${maximumDays} days`);
  return { dateFrom, dateTo, days };
}

function reportTimestampBounds(dates: { dateFrom: string; dateTo: string }) {
  const from = `${dates.dateFrom}T00:00:00.000Z`;
  const to = new Date(`${dates.dateTo}T00:00:00.000Z`);
  to.setUTCDate(to.getUTCDate() + 1);
  return { from, to: to.toISOString() };
}

function pagination(parameters: URLSearchParams, exportMode = false) {
  if (exportMode) return { page: 1, pageSize: REPORT_EXPORT_MAX_ROWS + 1 };
  return {
    page: integer(parameters.get("page"), 1, 1, 100_000),
    pageSize: integer(parameters.get("pageSize"), 25, 5, 100),
  };
}

function pageMeta(page: number, pageSize: number, total: number): ReportPagination {
  return { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

function like(value: string) {
  return `%${value.toLowerCase().replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

function formatCsvCell(value: unknown) {
  const raw = String(value ?? "");
  const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function reportCsv(headers: string[], rows: unknown[][]) {
  return [headers, ...rows].map((row) => row.map(formatCsvCell).join(",")).join("\r\n");
}

export function wantsCsv(url: URL) {
  const format = url.searchParams.get("format");
  if (format && !["csv", "xlsx", "pdf"].includes(format)) throw new AdminReportError("Report format is invalid");
  return format === "csv";
}

export function reportFormat(url: URL): "json" | "csv" | "xlsx" | "pdf" {
  const format = url.searchParams.get("format") ?? "json";
  if (!["json", "csv", "xlsx", "pdf"].includes(format)) throw new AdminReportError("Report format is invalid");
  return format as "json" | "csv" | "xlsx" | "pdf";
}

function xml(value: unknown) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;"); }

async function xlsxBytes(headers: string[], rows: unknown[][]) {
  const { zipSync, strToU8 } = await import("fflate");
  const values = [headers, ...rows];
  const cells = values.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((value, colIndex) => { const ref = `${String.fromCharCode(65 + colIndex)}${rowIndex + 1}`; return typeof value === "number" ? `<c r="${ref}"><v>${value}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t>${xml(value)}</t></is></c>`; }).join("")}</row>`).join("");
  const files = {
    "[Content_Types].xml": strToU8(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    "xl/workbook.xml": strToU8(`<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Report" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`),
    "xl/worksheets/sheet1.xml": strToU8(`<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${cells}</sheetData></worksheet>`),
  };
  return zipSync(files, { level: 6 });
}

async function pdfBytes(title: string, headers: string[], rows: unknown[][]) {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const document = await PDFDocument.create(); let page = document.addPage([595, 842]); const font = await document.embedFont(StandardFonts.Helvetica); let y = 800;
  const draw = (value: string, size = 8) => { if (y < 45) { page = document.addPage([595, 842]); y = 800; } page.drawText(value.slice(0, 120), { x: 36, y, size, font, color: rgb(0.08, 0.16, 0.15) }); y -= size + 7; };
  draw(title, 15); draw(headers.join(" | "), 8); for (const row of rows) draw(row.map((value) => String(value ?? "")).join(" | ")); return document.save();
}

export async function reportExportResponse(filename: string, title: string, headers: string[], rows: unknown[][], format: "csv" | "xlsx" | "pdf") {
  const common = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
  if (format === "csv") return csvResponse(filename.replace(/\.[^.]+$/, ".csv"), headers, rows);
  if (format === "xlsx") return new Response(await xlsxBytes(headers, rows) as unknown as BodyInit, { headers: { ...common, "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="${filename.replace(/\.[^.]+$/, ".xlsx")}"` } });
  return new Response(await pdfBytes(title, headers, rows) as unknown as BodyInit, { headers: { ...common, "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${filename.replace(/\.[^.]+$/, ".pdf")}"` } });
}

export function csvResponse(filename: string, headers: string[], rows: unknown[][]) {
  return new Response(reportCsv(headers, rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

type StockRow = {
  groupKey: string; medicineId: number | null; medicineName: string; manufacturerId: number | null;
  manufacturerName: string; medicineCount: number; storeCount: number; batchCount: number;
  physicalQuantity: number; reservedQuantity: number; availableQuantity: number; quarantinedQuantity: number;
  expiredQuantity: number; lowBatchCount: number; stockCostPaise: number; retailValuePaise: number;
  nearestExpiry: string | null;
};

export async function loadAdminStockReport(database: D1Database, url: URL) {
  const parameters = url.searchParams;
  const exportMode = ["csv", "xlsx", "pdf"].includes(parameters.get("format") ?? "");
  const { page, pageSize } = pagination(parameters, exportMode);
  const groupBy = choice(parameters.get("groupBy"), ["medicine", "manufacturer"] as const, "medicine");
  const stockState = choice(parameters.get("stockState"), ["all", "available", "low", "zero", "reserved", "quarantined", "expired"] as const, "all");
  const direction = choice(parameters.get("direction"), ["asc", "desc"] as const, "asc");
  const sort = choice(parameters.get("sort"), ["medicine", "manufacturer", "physical", "available", "value", "expiry"] as const, groupBy === "medicine" ? "medicine" : "manufacturer");
  const vendorId = optionalInteger(parameters.get("vendorId"), 1, 1_000_000_000);
  const query = boundedText(parameters.get("q"), 100);
  const search = like(query);
  const groupKey = groupBy === "medicine"
    ? "CAST(p.id AS TEXT)"
    : "COALESCE(CAST(p.manufacturer_id AS TEXT), 'name:' || lower(trim(p.manufacturer)), 'unknown')";
  const medicineId = groupBy === "medicine" ? "p.id" : "NULL";
  const medicineName = groupBy === "medicine" ? "p.name" : "''";
  const manufacturerId = groupBy === "medicine" ? "p.manufacturer_id" : "MIN(p.manufacturer_id)";
  const manufacturerName = "COALESCE(m.name, NULLIF(trim(p.manufacturer), ''), 'Unknown manufacturer')";
  const groupColumns = groupBy === "medicine"
    ? "p.id, p.name, p.manufacturer_id, COALESCE(m.name, NULLIF(trim(p.manufacturer), ''), 'Unknown manufacturer')"
    : `${groupKey}, ${manufacturerName}`;
  const statePredicate: Record<typeof stockState, string> = {
    all: "1=1",
    available: "availableQuantity > 0",
    low: "lowBatchCount > 0",
    zero: "physicalQuantity = 0",
    reserved: "reservedQuantity > 0",
    quarantined: "quarantinedQuantity > 0",
    expired: "expiredQuantity > 0",
  };
  const sortExpression: Record<typeof sort, string> = {
    medicine: "lower(medicineName)",
    manufacturer: "lower(manufacturerName)",
    physical: "physicalQuantity",
    available: "availableQuantity",
    value: "retailValuePaise",
    expiry: "CASE WHEN nearestExpiry IS NULL THEN 1 ELSE 0 END, nearestExpiry",
  };
  const common = `WITH grouped AS (
    SELECT ${groupKey} AS groupKey, ${medicineId} AS medicineId, ${medicineName} AS medicineName,
      ${manufacturerId} AS manufacturerId, ${manufacturerName} AS manufacturerName,
      COUNT(DISTINCT p.id) AS medicineCount, COUNT(DISTINCT i.vendor_id) AS storeCount,
      COUNT(*) AS batchCount, COALESCE(SUM(i.quantity),0) AS physicalQuantity,
      COALESCE(SUM(i.reserved_quantity),0) AS reservedQuantity,
      COALESCE(SUM(CASE WHEN i.quarantine_status='available'
        AND i.cold_chain_status IN ('not_applicable','within_range')
        AND (i.expiry_date IS NULL OR date(i.expiry_date)>=date('now'))
        THEN MAX(i.quantity-i.reserved_quantity,0) ELSE 0 END),0) AS availableQuantity,
      COALESCE(SUM(CASE WHEN i.quarantine_status<>'available' THEN i.quantity ELSE 0 END),0) AS quarantinedQuantity,
      COALESCE(SUM(CASE WHEN i.expiry_date IS NOT NULL AND date(i.expiry_date)<date('now') THEN i.quantity ELSE 0 END),0) AS expiredQuantity,
      SUM(CASE WHEN i.quantity-i.reserved_quantity<=i.reorder_level THEN 1 ELSE 0 END) AS lowBatchCount,
      COALESCE(SUM(${effectivePriceFallbackSql("i", "purchase_price_paise")}*i.quantity),0) AS stockCostPaise,
      COALESCE(SUM(${effectivePriceFallbackSql("i", "sale_price_paise")}*i.quantity),0) AS retailValuePaise,
      MIN(CASE WHEN i.expiry_date IS NOT NULL AND date(i.expiry_date)>=date('now') THEN i.expiry_date END) AS nearestExpiry
    FROM pharmacy_inventory i JOIN products p ON p.id=i.product_id
    LEFT JOIN manufacturers m ON m.id=p.manufacturer_id
    JOIN vendors v ON v.id=i.vendor_id
    WHERE i.active=1 AND (? IS NULL OR i.vendor_id=?)
      AND (?='' OR lower(p.name) LIKE ? ESCAPE '\\' OR lower(COALESCE(m.name,p.manufacturer,'')) LIKE ? ESCAPE '\\'
        OR lower(v.business_name) LIKE ? ESCAPE '\\')
    GROUP BY ${groupColumns}
  ), filtered AS (SELECT * FROM grouped WHERE ${statePredicate[stockState]})`;
  const binds = [vendorId, vendorId, query, search, search, search];
  const [rowsResult, summary] = await Promise.all([
    database.prepare(`${common} SELECT * FROM filtered ORDER BY ${sortExpression[sort]} ${direction.toUpperCase()}, groupKey LIMIT ? OFFSET ?`)
      .bind(...binds, pageSize, (page - 1) * pageSize).all<StockRow>(),
    database.prepare(`${common} SELECT COUNT(*) AS total, COALESCE(SUM(physicalQuantity),0) AS physicalQuantity,
      COALESCE(SUM(reservedQuantity),0) AS reservedQuantity, COALESCE(SUM(availableQuantity),0) AS availableQuantity,
      COALESCE(SUM(stockCostPaise),0) AS stockCostPaise, COALESCE(SUM(retailValuePaise),0) AS retailValuePaise
      FROM filtered`).bind(...binds).first<{ total: number; physicalQuantity: number; reservedQuantity: number; availableQuantity: number; stockCostPaise: number; retailValuePaise: number }>(),
  ]);
  const total = Number(summary?.total ?? 0);
  if (exportMode && total > REPORT_EXPORT_MAX_ROWS) {
    throw new AdminReportError(`This export contains ${total} rows; narrow the filters to ${REPORT_EXPORT_MAX_ROWS.toLocaleString()} rows or fewer`, 422);
  }
  return { report: "stock" as const, groupBy, rows: rowsResult.results, summary: summary ?? { total: 0, physicalQuantity: 0, reservedQuantity: 0, availableQuantity: 0, stockCostPaise: 0, retailValuePaise: 0 }, pagination: pageMeta(page, pageSize, total) };
}

type SalesRow = {
  groupKey: string; activityDate: string; channel: "online" | "offline"; productId: number | null;
  medicineName: string; manufacturerName: string; transactions: number; returnTransactions: number;
  soldQuantity: number; returnedQuantity: number; grossSalesPaise: number; returnedPaise: number; netSalesPaise: number;
};

export async function loadAdminSalesReport(database: D1Database, url: URL) {
  const parameters = url.searchParams;
  const dates = parseReportDateRange(parameters);
  const timestamps = reportTimestampBounds(dates);
  const exportMode = ["csv", "xlsx", "pdf"].includes(parameters.get("format") ?? "");
  const { page, pageSize } = pagination(parameters, exportMode);
  const groupBy = choice(parameters.get("groupBy"), ["date", "medicine"] as const, "date");
  const channel = choice(parameters.get("channel"), ["all", "online", "offline"] as const, "all");
  const sort = choice(parameters.get("sort"), ["date", "medicine", "gross", "returns", "net", "quantity"] as const, groupBy === "date" ? "date" : "medicine");
  const direction = choice(parameters.get("direction"), ["asc", "desc"] as const, sort === "date" ? "desc" : "asc");
  const vendorId = optionalInteger(parameters.get("vendorId"), 1, 1_000_000_000);
  const query = boundedText(parameters.get("q"), 100);
  const search = like(query);
  const groupKey = groupBy === "date" ? "activityDate" : "CAST(productId AS TEXT)";
  const selectedDate = groupBy === "date" ? "activityDate" : "''";
  const selectedProduct = groupBy === "medicine" ? "productId" : "NULL";
  const selectedMedicine = groupBy === "medicine" ? "medicineName" : "''";
  const selectedManufacturer = groupBy === "medicine" ? "manufacturerName" : "''";
  const groupedBy = groupBy === "date" ? "activityDate, channel" : "productId, medicineName, manufacturerName, channel";
  const sortExpression: Record<typeof sort, string> = {
    date: "activityDate",
    medicine: "lower(medicineName)",
    gross: "grossSalesPaise",
    returns: "returnedPaise",
    net: "netSalesPaise",
    quantity: "soldQuantity-returnedQuantity",
  };
  const common = `WITH activity AS (
    SELECT invoice.issued_at AS activityAt,date(invoice.issued_at) AS activityDate,'online' AS channel,o.vendor_id AS vendorId,
      item.product_id AS productId,p.name AS medicineName,
      COALESCE(m.name,NULLIF(trim(p.manufacturer),''),'Unknown manufacturer') AS manufacturerName,
      'online:'||o.id AS saleKey,'' AS returnKey,item.quantity AS soldQuantity,0 AS returnedQuantity,
      item.line_total_paise AS grossSalesPaise,0 AS returnedPaise
    FROM orders o JOIN order_items item ON item.order_id=o.id JOIN products p ON p.id=item.product_id
    LEFT JOIN manufacturers m ON m.id=p.manufacturer_id
    JOIN tax_invoices invoice ON invoice.source_type='online_order' AND invoice.source_id=o.id
    WHERE o.order_status='completed'
    UNION ALL
    SELECT event.created_at,date(event.created_at),'offline',sale.vendor_id,item.product_id,p.name,
      COALESCE(m.name,NULLIF(trim(p.manufacturer),''),'Unknown manufacturer'),
      'offline:'||sale.id,'',item.quantity,0,item.line_total_paise,0
    FROM offline_sales sale JOIN offline_sale_events event ON event.offline_sale_id=sale.id AND event.event_type='completed'
    JOIN offline_sale_items item ON item.offline_sale_id=sale.id JOIN products p ON p.id=item.product_id
    LEFT JOIN manufacturers m ON m.id=p.manufacturer_id
    UNION ALL
    SELECT return_record.created_at,date(return_record.created_at),return_record.source_type,return_record.vendor_id,
      inventory.product_id,p.name,COALESCE(m.name,NULLIF(trim(p.manufacturer),''),'Unknown manufacturer'),
      '',return_record.source_type||':'||return_record.id,0,return_item.quantity,0,return_item.amount_paise
    FROM sales_returns return_record JOIN sales_return_items return_item ON return_item.sales_return_id=return_record.id
    JOIN pharmacy_inventory inventory ON inventory.id=return_item.inventory_id JOIN products p ON p.id=inventory.product_id
    LEFT JOIN manufacturers m ON m.id=p.manufacturer_id
    WHERE return_record.status='completed' AND return_record.source_type IN ('online','offline')
  ), filtered AS (
    SELECT * FROM activity WHERE activityAt >= ? AND activityAt < ? AND (?='all' OR channel=?)
      AND (? IS NULL OR vendorId=?) AND (?='' OR lower(medicineName) LIKE ? ESCAPE '\\'
        OR lower(manufacturerName) LIKE ? ESCAPE '\\')
  ), grouped AS (
    SELECT ${groupKey}||':'||channel AS groupKey,${selectedDate} AS activityDate,channel,
      ${selectedProduct} AS productId,${selectedMedicine} AS medicineName,${selectedManufacturer} AS manufacturerName,
      COUNT(DISTINCT NULLIF(saleKey,'')) AS transactions,COUNT(DISTINCT NULLIF(returnKey,'')) AS returnTransactions,
      SUM(soldQuantity) AS soldQuantity,SUM(returnedQuantity) AS returnedQuantity,
      SUM(grossSalesPaise) AS grossSalesPaise,SUM(returnedPaise) AS returnedPaise,
      SUM(grossSalesPaise)-SUM(returnedPaise) AS netSalesPaise
    FROM filtered GROUP BY ${groupedBy}
  )`;
  const binds = [timestamps.from, timestamps.to, channel, channel, vendorId, vendorId, query, search, search];
  const [rowsResult, summary] = await Promise.all([
    database.prepare(`${common} SELECT * FROM grouped ORDER BY ${sortExpression[sort]} ${direction.toUpperCase()},channel,groupKey LIMIT ? OFFSET ?`)
      .bind(...binds, pageSize, (page - 1) * pageSize).all<SalesRow>(),
    database.prepare(`${common} SELECT (SELECT COUNT(*) FROM grouped) AS total,
      COUNT(DISTINCT NULLIF(saleKey,'')) AS transactions,COUNT(DISTINCT NULLIF(returnKey,'')) AS returnTransactions,
      COALESCE(SUM(soldQuantity),0) AS soldQuantity,COALESCE(SUM(returnedQuantity),0) AS returnedQuantity,
      COALESCE(SUM(grossSalesPaise),0) AS grossSalesPaise,COALESCE(SUM(returnedPaise),0) AS returnedPaise,
      COALESCE(SUM(grossSalesPaise),0)-COALESCE(SUM(returnedPaise),0) AS netSalesPaise FROM filtered`)
      .bind(...binds).first<{ total: number; transactions: number; returnTransactions: number; soldQuantity: number; returnedQuantity: number; grossSalesPaise: number; returnedPaise: number; netSalesPaise: number }>(),
  ]);
  const total = Number(summary?.total ?? 0);
  if (exportMode && total > REPORT_EXPORT_MAX_ROWS) {
    throw new AdminReportError(`This export contains ${total} rows; narrow the filters to ${REPORT_EXPORT_MAX_ROWS.toLocaleString()} rows or fewer`, 422);
  }
  return { report: "sales" as const, groupBy, dates, rows: rowsResult.results, summary: summary ?? { total: 0, transactions: 0, returnTransactions: 0, soldQuantity: 0, returnedQuantity: 0, grossSalesPaise: 0, returnedPaise: 0, netSalesPaise: 0 }, pagination: pageMeta(page, pageSize, total), recognition: "completed_sales_and_completed_returns" as const };
}

type ExpenseRow = {
  groupKey: string; expenseId: number | null; label: string; expenseDate: string; expenseHead: string;
  businessName: string; purpose: string; paymentMode: string; entryCount: number; amountPaise: number;
};

export async function loadAdminExpenseReport(database: D1Database, url: URL) {
  const parameters = url.searchParams;
  const dates = parseReportDateRange(parameters);
  const exportMode = ["csv", "xlsx", "pdf"].includes(parameters.get("format") ?? "");
  const { page, pageSize } = pagination(parameters, exportMode);
  const groupBy = choice(parameters.get("groupBy"), ["entry", "date", "head", "store"] as const, "date");
  const scope = choice(parameters.get("scope"), ["all", "store", "platform"] as const, "all");
  const payment = choice(parameters.get("payment"), ["all", "cash", "upi", "bank", "card", "other"] as const, "all");
  const sort = choice(parameters.get("sort"), ["date", "head", "store", "amount"] as const, groupBy === "date" || groupBy === "entry" ? "date" : groupBy);
  const direction = choice(parameters.get("direction"), ["asc", "desc"] as const, sort === "date" || sort === "amount" ? "desc" : "asc");
  const vendorId = optionalInteger(parameters.get("vendorId"), 1, 1_000_000_000);
  const head = boundedText(parameters.get("head"), 100);
  const query = boundedText(parameters.get("q"), 100);
  const search = like(query);
  const paymentPredicate: Record<typeof payment, string> = {
    all: "1=1", cash: "lower(paymentMode)='cash'", upi: "lower(paymentMode)='upi'",
    bank: "lower(paymentMode) LIKE '%bank%'", card: "lower(paymentMode) LIKE '%card%'",
    other: "lower(paymentMode)<>'cash' AND lower(paymentMode)<>'upi' AND lower(paymentMode) NOT LIKE '%bank%' AND lower(paymentMode) NOT LIKE '%card%'",
  };
  const grouping = {
    entry: { key: "CAST(id AS TEXT)", id: "id", label: "purpose", date: "expenseDate", head: "expenseHead", store: "businessName", purpose: "purpose", payment: "paymentMode", by: "id,expenseDate,expenseHead,businessName,purpose,paymentMode" },
    date: { key: "expenseDate", id: "NULL", label: "expenseDate", date: "expenseDate", head: "''", store: "''", purpose: "''", payment: "''", by: "expenseDate" },
    head: { key: "lower(expenseHead)", id: "NULL", label: "expenseHead", date: "''", head: "expenseHead", store: "''", purpose: "''", payment: "''", by: "lower(expenseHead),expenseHead" },
    store: { key: "COALESCE(CAST(vendorId AS TEXT),'platform')", id: "NULL", label: "businessName", date: "''", head: "''", store: "businessName", purpose: "''", payment: "''", by: "vendorId,businessName" },
  }[groupBy];
  const sortExpression: Record<typeof sort, string> = { date: "expenseDate", head: "lower(expenseHead)", store: "lower(businessName)", amount: "amountPaise" };
  const common = `WITH filtered AS (
    SELECT e.id,e.vendor_id AS vendorId,e.expense_date AS expenseDate,e.expense_head AS expenseHead,
      COALESCE(v.business_name,'Platform / unallocated') AS businessName,e.purpose,e.payment_mode AS paymentMode,e.amount_paise AS amountPaise
    FROM expenses e LEFT JOIN vendors v ON v.id=e.vendor_id
    WHERE e.expense_date BETWEEN ? AND ? AND (? IS NULL OR e.vendor_id=?)
      AND (?='all' OR (?='store' AND e.vendor_id IS NOT NULL) OR (?='platform' AND e.vendor_id IS NULL))
      AND (?='' OR lower(e.expense_head)=lower(?))
      AND (?='' OR lower(e.purpose) LIKE ? ESCAPE '\\' OR lower(e.expense_head) LIKE ? ESCAPE '\\'
        OR lower(COALESCE(v.business_name,'')) LIKE ? ESCAPE '\\')
  ), payment_filtered AS (SELECT * FROM filtered WHERE ${paymentPredicate[payment]}), grouped AS (
    SELECT ${grouping.key} AS groupKey,${grouping.id} AS expenseId,${grouping.label} AS label,
      ${grouping.date} AS expenseDate,${grouping.head} AS expenseHead,${grouping.store} AS businessName,
      ${grouping.purpose} AS purpose,${grouping.payment} AS paymentMode,COUNT(*) AS entryCount,SUM(amountPaise) AS amountPaise
    FROM payment_filtered GROUP BY ${grouping.by}
  )`;
  const binds = [dates.dateFrom, dates.dateTo, vendorId, vendorId, scope, scope, scope, head, head, query, search, search, search];
  const [rowsResult, summary] = await Promise.all([
    database.prepare(`${common} SELECT * FROM grouped ORDER BY ${sortExpression[sort]} ${direction.toUpperCase()},groupKey LIMIT ? OFFSET ?`)
      .bind(...binds, pageSize, (page - 1) * pageSize).all<ExpenseRow>(),
    database.prepare(`${common} SELECT COUNT(*) AS total,COALESCE(SUM(entryCount),0) AS entryCount,
      COALESCE(SUM(amountPaise),0) AS amountPaise FROM grouped`).bind(...binds)
      .first<{ total: number; entryCount: number; amountPaise: number }>(),
  ]);
  const total = Number(summary?.total ?? 0);
  if (exportMode && total > REPORT_EXPORT_MAX_ROWS) {
    throw new AdminReportError(`This export contains ${total} rows; narrow the filters to ${REPORT_EXPORT_MAX_ROWS.toLocaleString()} rows or fewer`, 422);
  }
  return { report: "expenses" as const, groupBy, dates, rows: rowsResult.results, summary: summary ?? { total: 0, entryCount: 0, amountPaise: 0 }, pagination: pageMeta(page, pageSize, total) };
}

type DeliveryCandidate = {
  orderId: number; orderNumber: string; vendorId: number; businessName: string; deliveryMethod: "pharmacy" | "urmed";
  deliveryStatus: string; paymentMethod: "online" | "cod"; paymentStatus: string; deliveryFeePaise: number;
  orderTotalPaise: number; createdAt: string; riderName: string; assignmentStatus: string;
  assignedAt: string | null; pickedUpAt: string | null; deliveredAt: string | null;
  originLatitude: string; originLongitude: string; destinationLatitude: string; destinationLongitude: string;
};

export type DeliveryReportRow = Omit<DeliveryCandidate, "originLatitude" | "originLongitude" | "destinationLatitude" | "destinationLongitude"> & {
  estimatedDistanceKm: number | null; elapsedMinutes: number; slaStatus: "met" | "missed" | "pending";
};

function coordinate(value: string) {
  if (!value.trim()) return Number.NaN;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export function calculateDeliveryReportRow(candidate: DeliveryCandidate, slaTargetMinutes: number, now = new Date()): DeliveryReportRow {
  const origin = { latitude: coordinate(candidate.originLatitude), longitude: coordinate(candidate.originLongitude) };
  const destination = { latitude: coordinate(candidate.destinationLatitude), longitude: coordinate(candidate.destinationLongitude) };
  const rawDistance = isValidGeoPoint(origin) && isValidGeoPoint(destination) ? haversineKm(origin, destination) : Number.NaN;
  const end = candidate.deliveredAt ? Date.parse(candidate.deliveredAt) : now.valueOf();
  const start = Date.parse(candidate.createdAt);
  const elapsedMinutes = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, Math.round((end - start) / 60_000)) : 0;
  const slaStatus = !candidate.deliveredAt ? "pending" : elapsedMinutes <= slaTargetMinutes ? "met" : "missed";
  const { originLatitude: _originLatitude, originLongitude: _originLongitude, destinationLatitude: _destinationLatitude, destinationLongitude: _destinationLongitude, ...safe } = candidate;
  void _originLatitude; void _originLongitude; void _destinationLatitude; void _destinationLongitude;
  return { ...safe, estimatedDistanceKm: Number.isFinite(rawDistance) ? Math.round(rawDistance * 10) / 10 : null, elapsedMinutes, slaStatus };
}

export async function loadAdminDeliveryReport(database: D1Database, url: URL, now = new Date()) {
  const parameters = url.searchParams;
  const dates = parseReportDateRange(parameters, now, 92);
  const timestamps = reportTimestampBounds(dates);
  const exportMode = ["csv", "xlsx", "pdf"].includes(parameters.get("format") ?? "");
  const { page, pageSize } = pagination(parameters, exportMode);
  const method = choice(parameters.get("method"), ["all", "pharmacy", "urmed"] as const, "all");
  const status = choice(parameters.get("status"), ["all", "awaiting_confirmation", "pharmacist_review", "confirmed", "packed", "ready_for_pickup", "assigned", "picked_up", "out_for_delivery", "delivered", "cancelled"] as const, "all");
  const rider = choice(parameters.get("rider"), ["all", "assigned", "unassigned"] as const, "all");
  const cod = choice(parameters.get("cod"), ["all", "cod", "prepaid", "due", "paid"] as const, "all");
  const sla = choice(parameters.get("sla"), ["all", "met", "missed", "pending"] as const, "all");
  const sort = choice(parameters.get("sort"), ["date", "store", "status", "fee", "distance", "sla"] as const, "date");
  const direction = choice(parameters.get("direction"), ["asc", "desc"] as const, sort === "store" || sort === "status" ? "asc" : "desc");
  const vendorId = optionalInteger(parameters.get("vendorId"), 1, 1_000_000_000);
  const minDistanceKm = optionalInteger(parameters.get("minDistanceKm"), 0, 1_000);
  const maxDistanceKm = optionalInteger(parameters.get("maxDistanceKm"), 0, 1_000);
  const minFeePaise = optionalInteger(parameters.get("minFeePaise"), 0, 100_000_000);
  const maxFeePaise = optionalInteger(parameters.get("maxFeePaise"), 0, 100_000_000);
  const slaTargetMinutes = integer(parameters.get("slaTargetMinutes"), 120, 15, 1_440);
  if (minDistanceKm !== null && maxDistanceKm !== null && minDistanceKm > maxDistanceKm) throw new AdminReportError("Minimum distance cannot exceed maximum distance");
  if (minFeePaise !== null && maxFeePaise !== null && minFeePaise > maxFeePaise) throw new AdminReportError("Minimum fee cannot exceed maximum fee");
  const query = boundedText(parameters.get("q"), 100);
  const search = like(query);
  const candidates = await database.prepare(`SELECT o.id AS orderId,o.order_number AS orderNumber,o.vendor_id AS vendorId,
    v.business_name AS businessName,o.delivery_method AS deliveryMethod,o.delivery_status AS deliveryStatus,
    o.payment_method AS paymentMethod,o.payment_status AS paymentStatus,o.delivery_fee_paise AS deliveryFeePaise,
    o.total_paise AS orderTotalPaise,o.created_at AS createdAt,COALESCE(rider_profile.name,'') AS riderName,
    COALESCE(assignment.status,'') AS assignmentStatus,assignment.assigned_at AS assignedAt,
    assignment.picked_up_at AS pickedUpAt,
    COALESCE(assignment.delivered_at,(SELECT MAX(event.created_at) FROM delivery_events event
      WHERE event.order_id=o.id AND event.status='delivered')) AS deliveredAt,
    COALESCE(public_location.latitude,v.latitude) AS originLatitude,
    COALESCE(public_location.longitude,v.longitude) AS originLongitude,
    o.latitude AS destinationLatitude,o.longitude AS destinationLongitude
    FROM orders o JOIN vendors v ON v.id=o.vendor_id
    LEFT JOIN vendor_public_locations public_location ON public_location.vendor_id=v.id
      AND public_location.publication_status='published'
    LEFT JOIN delivery_assignments assignment ON assignment.id=(SELECT latest.id FROM delivery_assignments latest
      WHERE latest.order_id=o.id AND latest.status<>'cancelled' ORDER BY latest.id DESC LIMIT 1)
    LEFT JOIN delivery_agents agent ON agent.id=assignment.agent_id
    LEFT JOIN account_profiles rider_profile ON rider_profile.id=agent.profile_id
    WHERE o.delivery_method IN ('pharmacy','urmed') AND o.created_at >= ? AND o.created_at < ?
      AND (? IS NULL OR o.vendor_id=?) AND (?='all' OR o.delivery_method=?)
      AND (?='all' OR o.delivery_status=?)
      AND (?='' OR lower(o.order_number) LIKE ? ESCAPE '\\' OR lower(v.business_name) LIKE ? ESCAPE '\\'
        OR lower(COALESCE(rider_profile.name,'')) LIKE ? ESCAPE '\\')
    ORDER BY o.created_at DESC,o.id DESC LIMIT ${REPORT_QUERY_MAX_ROWS + 1}`)
    .bind(timestamps.from, timestamps.to, vendorId, vendorId, method, method, status, status, query, search, search, search)
    .all<DeliveryCandidate>();
  if (candidates.results.length > REPORT_QUERY_MAX_ROWS) {
    throw new AdminReportError(`This delivery report contains more than ${REPORT_QUERY_MAX_ROWS.toLocaleString()} candidate rows; narrow the date range or filters`, 422);
  }
  const rows = candidates.results.map((candidate) => calculateDeliveryReportRow(candidate, slaTargetMinutes, now)).filter((row) => {
    if (rider === "assigned" && !row.riderName) return false;
    if (rider === "unassigned" && row.riderName) return false;
    if (cod === "cod" && row.paymentMethod !== "cod") return false;
    if (cod === "prepaid" && row.paymentMethod !== "online") return false;
    if (cod === "due" && !(row.paymentMethod === "cod" && row.paymentStatus !== "paid")) return false;
    if (cod === "paid" && !(row.paymentMethod === "cod" && row.paymentStatus === "paid")) return false;
    if (sla !== "all" && row.slaStatus !== sla) return false;
    if (minDistanceKm !== null && (row.estimatedDistanceKm === null || row.estimatedDistanceKm < minDistanceKm)) return false;
    if (maxDistanceKm !== null && (row.estimatedDistanceKm === null || row.estimatedDistanceKm > maxDistanceKm)) return false;
    if (minFeePaise !== null && row.deliveryFeePaise < minFeePaise) return false;
    if (maxFeePaise !== null && row.deliveryFeePaise > maxFeePaise) return false;
    return true;
  });
  const comparators: Record<typeof sort, (left: DeliveryReportRow, right: DeliveryReportRow) => number> = {
    date: (left, right) => left.createdAt.localeCompare(right.createdAt),
    store: (left, right) => left.businessName.localeCompare(right.businessName),
    status: (left, right) => left.deliveryStatus.localeCompare(right.deliveryStatus),
    fee: (left, right) => left.deliveryFeePaise - right.deliveryFeePaise,
    distance: (left, right) => (left.estimatedDistanceKm ?? -1) - (right.estimatedDistanceKm ?? -1),
    sla: (left, right) => left.elapsedMinutes - right.elapsedMinutes,
  };
  rows.sort((left, right) => (direction === "asc" ? 1 : -1) * comparators[sort](left, right) || right.orderId - left.orderId);
  const total = rows.length;
  if (exportMode && total > REPORT_EXPORT_MAX_ROWS) {
    throw new AdminReportError(`This export contains ${total} rows; narrow the filters to ${REPORT_EXPORT_MAX_ROWS.toLocaleString()} rows or fewer`, 422);
  }
  const pagedRows = rows.slice((page - 1) * pageSize, page * pageSize);
  const distanceRows = rows.filter((row) => row.estimatedDistanceKm !== null);
  return {
    report: "home_delivery" as const,
    dates,
    slaTargetMinutes,
    distanceBasis: "straight_line_estimate" as const,
    rows: pagedRows,
    summary: {
      total,
      delivered: rows.filter((row) => row.deliveryStatus === "delivered").length,
      pending: rows.filter((row) => !["delivered", "cancelled"].includes(row.deliveryStatus)).length,
      deliveryFeesPaise: rows.reduce((sum, row) => sum + row.deliveryFeePaise, 0),
      codOutstandingPaise: rows.filter((row) => row.paymentMethod === "cod" && row.paymentStatus !== "paid").reduce((sum, row) => sum + row.orderTotalPaise, 0),
      slaMet: rows.filter((row) => row.slaStatus === "met").length,
      slaMissed: rows.filter((row) => row.slaStatus === "missed").length,
      averageEstimatedDistanceKm: distanceRows.length ? Math.round(distanceRows.reduce((sum, row) => sum + (row.estimatedDistanceKm ?? 0), 0) / distanceRows.length * 10) / 10 : null,
    },
    pagination: pageMeta(page, pageSize, total),
  };
}
