import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

export type TaxInvoiceLine = {
  id: number;
  lineNumber: number;
  sourceItemId: number;
  productName: string;
  hsnCode: string;
  batchNumber: string;
  expiryDate: string;
  quantity: number;
  unitPricePaise: number;
  grossPaise: number;
  discountPaise: number;
  taxablePaise: number;
  gstPercent: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  lineTotalPaise: number;
};

export type TaxInvoiceSnapshot = {
  id: number;
  invoiceNumber: string;
  vendorId: number;
  sourceType: "online_order" | "offline_sale";
  sourceId: number;
  sourceNumber: string;
  sellerName: string;
  sellerAddress: string;
  sellerEmail: string;
  sellerGstin: string;
  buyerName: string;
  buyerAddress: string;
  buyerGstin: string;
  placeOfSupplyStateCode: string;
  paymentMode: string;
  currency: "INR";
  grossPaise: number;
  discountPaise: number;
  subtotalPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  deliveryFeePaise: number;
  totalPaise: number;
  irn: string;
  qrCodePayload: string;
  snapshotVersion: number;
  issuedAt: string;
  lines: TaxInvoiceLine[];
};

type TaxInvoiceRow = Omit<TaxInvoiceSnapshot, "lines">;

export class TaxInvoiceError extends Error {
  readonly status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.name = "TaxInvoiceError";
    this.status = status;
  }
}

const HEADER_QUERY = `SELECT invoice.id,invoice.invoice_number AS invoiceNumber,invoice.vendor_id AS vendorId,
  invoice.source_type AS sourceType,invoice.source_id AS sourceId,invoice.source_number AS sourceNumber,
  invoice.seller_name AS sellerName,invoice.seller_address AS sellerAddress,invoice.seller_email AS sellerEmail,
  invoice.seller_gstin AS sellerGstin,invoice.buyer_name AS buyerName,invoice.buyer_address AS buyerAddress,
  invoice.buyer_gstin AS buyerGstin,invoice.place_of_supply_state_code AS placeOfSupplyStateCode,
  invoice.payment_mode AS paymentMode,invoice.currency,invoice.gross_paise AS grossPaise,
  invoice.discount_paise AS discountPaise,invoice.subtotal_paise AS subtotalPaise,
  invoice.cgst_paise AS cgstPaise,invoice.sgst_paise AS sgstPaise,invoice.igst_paise AS igstPaise,
  invoice.delivery_fee_paise AS deliveryFeePaise,invoice.total_paise AS totalPaise,
  invoice.irn,invoice.qr_code_payload AS qrCodePayload,invoice.snapshot_version AS snapshotVersion,
  invoice.issued_at AS issuedAt FROM tax_invoices invoice`;

const LINE_QUERY = `SELECT id,line_number AS lineNumber,source_item_id AS sourceItemId,product_name AS productName,
  hsn_code AS hsnCode,batch_number AS batchNumber,expiry_date AS expiryDate,quantity,
  unit_price_paise AS unitPricePaise,gross_paise AS grossPaise,discount_paise AS discountPaise,
  taxable_paise AS taxablePaise,gst_percent AS gstPercent,cgst_paise AS cgstPaise,
  sgst_paise AS sgstPaise,igst_paise AS igstPaise,line_total_paise AS lineTotalPaise
  FROM tax_invoice_lines WHERE invoice_id=? ORDER BY line_number`;

export function prepareOnlineTaxInvoiceStatement(
  database: D1Database,
  orderId: number,
  issuedByProfileId: number,
) {
  return database.prepare(`INSERT INTO tax_invoices (invoice_number,vendor_id,source_type,source_id,source_number,
    seller_name,seller_address,seller_email,seller_gstin,buyer_name,buyer_address,buyer_gstin,
    place_of_supply_state_code,payment_mode,currency,gross_paise,discount_paise,subtotal_paise,
    cgst_paise,sgst_paise,igst_paise,delivery_fee_paise,total_paise,snapshot_version,issued_by_profile_id)
    SELECT 'GST-'||source.order_number,source.vendor_id,'online_order',source.id,source.order_number,
      COALESCE(NULLIF(trim(vendor.business_name),''),'Registered pharmacy'),
      COALESCE(NULLIF(trim(vendor.address),''),'Registered pharmacy address unavailable'),
      COALESCE(vendor.email,''),vendor.gst_number,source.customer_name,source.delivery_address,'',
      source.place_of_supply_state_code,source.payment_method,'INR',
      COALESCE(SUM(item.unit_price_paise*item.quantity),0),COALESCE(SUM(item.discount_paise),0),
      source.subtotal_paise,COALESCE(SUM(item.cgst_paise),0),COALESCE(SUM(item.sgst_paise),0),
      COALESCE(SUM(item.igst_paise),0),source.delivery_fee_paise,source.total_paise,1,?
    FROM orders source JOIN vendors vendor ON vendor.id=source.vendor_id
    JOIN order_items item ON item.order_id=source.id
    WHERE source.id=? AND source.delivery_status='delivered' AND source.payment_status='paid'
      AND (source.payment_method <> 'cod' OR EXISTS (SELECT 1 FROM cod_collection_evidence collection
        WHERE collection.order_id=source.id AND collection.collection_status='collected'))
      AND NOT EXISTS (SELECT 1 FROM tax_invoices invoice WHERE invoice.source_type='online_order' AND invoice.source_id=source.id)
    GROUP BY source.id,source.order_number,source.vendor_id,vendor.business_name,vendor.address,vendor.email,
      vendor.gst_number,source.customer_name,source.delivery_address,source.place_of_supply_state_code,
      source.payment_method,source.subtotal_paise,source.delivery_fee_paise,source.total_paise`)
    .bind(issuedByProfileId, orderId);
}

export function prepareOfflineTaxInvoiceStatement(
  database: D1Database,
  saleNumber: string,
  issuedByProfileId: number,
) {
  return database.prepare(`INSERT INTO tax_invoices (invoice_number,vendor_id,source_type,source_id,source_number,
    seller_name,seller_address,seller_email,seller_gstin,buyer_name,buyer_address,buyer_gstin,
    place_of_supply_state_code,payment_mode,currency,gross_paise,discount_paise,subtotal_paise,
    cgst_paise,sgst_paise,igst_paise,delivery_fee_paise,total_paise,snapshot_version,issued_by_profile_id)
    SELECT 'GST-'||source.sale_number,source.vendor_id,'offline_sale',source.id,source.sale_number,
      COALESCE(NULLIF(trim(vendor.business_name),''),'Registered pharmacy'),
      COALESCE(NULLIF(trim(vendor.address),''),'Registered pharmacy address unavailable'),
      COALESCE(vendor.email,''),vendor.gst_number,source.customer_name,'',source.buyer_gstin,
      source.place_of_supply_state_code,source.payment_mode,'INR',source.gross_paise,source.discount_paise,
      source.subtotal_paise,source.cgst_paise,source.sgst_paise,source.igst_paise,0,source.total_paise,1,?
    FROM offline_sales source JOIN vendors vendor ON vendor.id=source.vendor_id
    WHERE source.sale_number=? AND NOT EXISTS (SELECT 1 FROM tax_invoices invoice
      WHERE invoice.source_type='offline_sale' AND invoice.source_id=source.id)`)
    .bind(issuedByProfileId, saleNumber);
}

function validateSnapshot(invoice: TaxInvoiceSnapshot) {
  if (invoice.snapshotVersion !== 1 || invoice.currency !== "INR" || !invoice.lines.length) {
    throw new TaxInvoiceError("The tax invoice snapshot is incomplete");
  }
  const sum = (field: keyof Pick<TaxInvoiceLine, "grossPaise" | "discountPaise" | "taxablePaise" | "cgstPaise" | "sgstPaise" | "igstPaise" | "lineTotalPaise">) =>
    invoice.lines.reduce((total, line) => total + line[field], 0);
  const linesAreSequential = invoice.lines.every((line, index) => line.lineNumber === index + 1);
  if (!linesAreSequential || sum("grossPaise") !== invoice.grossPaise || sum("discountPaise") !== invoice.discountPaise
    || sum("taxablePaise") !== invoice.subtotalPaise || sum("cgstPaise") !== invoice.cgstPaise
    || sum("sgstPaise") !== invoice.sgstPaise || sum("igstPaise") !== invoice.igstPaise
    || sum("lineTotalPaise") + invoice.deliveryFeePaise !== invoice.totalPaise) {
    throw new TaxInvoiceError("The tax invoice snapshot failed its paise-level integrity check");
  }
}

async function loadInvoice(database: D1Database, row: TaxInvoiceRow | null) {
  if (!row) return null;
  const result = await database.prepare(LINE_QUERY).bind(row.id).all<TaxInvoiceLine>();
  const invoice = { ...row, lines: result.results } as TaxInvoiceSnapshot;
  validateSnapshot(invoice);
  return invoice;
}

export async function getCustomerTaxInvoice(database: D1Database, invoiceId: number, customerProfileId: number) {
  const row = await database.prepare(`${HEADER_QUERY}
    WHERE invoice.id=? AND (
      (invoice.source_type='online_order' AND EXISTS (SELECT 1 FROM orders source
        WHERE source.id=invoice.source_id AND source.customer_profile_id=?))
      OR (invoice.source_type='offline_sale' AND EXISTS (SELECT 1 FROM offline_sales source
        WHERE source.id=invoice.source_id AND source.customer_profile_id=?))
    ) LIMIT 1`).bind(invoiceId, customerProfileId, customerProfileId).first<TaxInvoiceRow>();
  return loadInvoice(database, row);
}

export async function getVendorTaxInvoice(database: D1Database, invoiceId: number, vendorId: number) {
  const row = await database.prepare(`${HEADER_QUERY} WHERE invoice.id=? AND invoice.vendor_id=? LIMIT 1`)
    .bind(invoiceId, vendorId).first<TaxInvoiceRow>();
  return loadInvoice(database, row);
}

function escapeHtml(value: unknown) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  }[character]!));
}

function money(paise: number) {
  return `INR ${(paise / 100).toFixed(2)}`;
}

function displayDate(value: string) {
  const date = new Date(value.endsWith("Z") || /[+-]\d\d:\d\d$/.test(value) ? value : `${value.replace(" ", "T")}Z`);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium", timeStyle: "short", timeZone: "UTC",
  }).format(date);
}

export function renderTaxInvoiceHtml(invoice: TaxInvoiceSnapshot) {
  validateSnapshot(invoice);
  const lineRows = invoice.lines.map((line) => `<tr><td>${line.lineNumber}</td><td>${escapeHtml(line.productName)}<small>Batch ${escapeHtml(line.batchNumber)}${line.expiryDate ? ` · Exp ${escapeHtml(line.expiryDate)}` : ""}</small></td><td>${escapeHtml(line.hsnCode || "-")}</td><td class="num">${line.quantity}</td><td class="num">${money(line.unitPricePaise)}</td><td class="num">${money(line.discountPaise)}</td><td class="num">${line.gstPercent}%</td><td class="num">${money(line.lineTotalPaise)}</td></tr>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>GST invoice ${escapeHtml(invoice.invoiceNumber)}</title><style>
    @page{size:A4;margin:16mm}*{box-sizing:border-box}body{font:13px system-ui,-apple-system,sans-serif;color:#17352d;margin:0 auto;max-width:960px;padding:28px}h1{font-size:24px;margin:0}.head,.parties,.totals{display:grid;gap:20px}.head{grid-template-columns:1fr auto;border-bottom:3px solid #16846b;padding-bottom:18px}.parties{grid-template-columns:1fr 1fr;margin:22px 0}.box{border:1px solid #ccdcd7;padding:14px;border-radius:8px}.muted,small{color:#62766f}small{display:block;margin-top:3px}table{border-collapse:collapse;width:100%;font-size:11px}th,td{border-bottom:1px solid #dce8e4;padding:9px 6px;text-align:left;vertical-align:top}.num{text-align:right;white-space:nowrap}.totals{grid-template-columns:1fr minmax(280px,38%);margin-top:18px}.total-row{display:flex;justify-content:space-between;padding:6px 0}.grand{border-top:2px solid #17352d;font-size:16px;font-weight:700;margin-top:5px;padding-top:10px}footer{border-top:1px solid #ccdcd7;margin-top:28px;padding-top:14px;font-size:11px;color:#62766f}@media print{body{padding:0}.no-print{display:none}}
  </style></head><body><header class="head"><div><h1>GST tax invoice</h1><p class="muted">Original for recipient · immutable URMED snapshot v${invoice.snapshotVersion}</p></div><div><strong>${escapeHtml(invoice.invoiceNumber)}</strong><br><span class="muted">Issued ${escapeHtml(displayDate(invoice.issuedAt))}</span></div></header>
  <section class="parties"><div class="box"><strong>Seller</strong><h2>${escapeHtml(invoice.sellerName)}</h2><p>${escapeHtml(invoice.sellerAddress)}</p>${invoice.sellerEmail ? `<p>${escapeHtml(invoice.sellerEmail)}</p>` : ""}<p>GSTIN: <strong>${escapeHtml(invoice.sellerGstin || "Not registered")}</strong></p></div><div class="box"><strong>Bill to</strong><h2>${escapeHtml(invoice.buyerName)}</h2>${invoice.buyerAddress ? `<p>${escapeHtml(invoice.buyerAddress)}</p>` : ""}<p>Buyer GSTIN: <strong>${escapeHtml(invoice.buyerGstin || "Unregistered")}</strong></p><p>Place of supply: ${escapeHtml(invoice.placeOfSupplyStateCode)}</p></div></section>
  <p><strong>${invoice.sourceType === "online_order" ? "Order" : "Counter sale"}:</strong> ${escapeHtml(invoice.sourceNumber)} · <strong>Payment:</strong> ${escapeHtml(invoice.paymentMode.toUpperCase())}</p>
  <table><thead><tr><th>#</th><th>Medicine</th><th>HSN</th><th class="num">Qty</th><th class="num">Unit</th><th class="num">Discount</th><th class="num">GST</th><th class="num">Amount</th></tr></thead><tbody>${lineRows}</tbody></table>
  <section class="totals"><p class="muted">All values are in Indian rupees. This GST invoice is distinct from the payment-provider receipt.</p><div><div class="total-row"><span>Gross</span><span>${money(invoice.grossPaise)}</span></div><div class="total-row"><span>Discount</span><span>-${money(invoice.discountPaise)}</span></div><div class="total-row"><span>Taxable value</span><span>${money(invoice.subtotalPaise)}</span></div><div class="total-row"><span>CGST</span><span>${money(invoice.cgstPaise)}</span></div><div class="total-row"><span>SGST</span><span>${money(invoice.sgstPaise)}</span></div><div class="total-row"><span>IGST</span><span>${money(invoice.igstPaise)}</span></div><div class="total-row"><span>Delivery</span><span>${money(invoice.deliveryFeePaise)}</span></div><div class="total-row grand"><span>Total</span><span>${money(invoice.totalPaise)}</span></div></div></section>
  <footer>System-generated tax invoice. The header and medicine lines are retained as one immutable source snapshot. No customer or pharmacy coordinates are included.</footer></body></html>`;
}

function pdfSafe(value: unknown) {
  return String(value ?? "").normalize("NFKD").replace(/[^\x20-\x7E]/g, " ").replace(/\s+/g, " ").trim();
}

function wrapText(value: string, font: PDFFont, size: number, width: number) {
  const words = pdfSafe(value).split(" ").filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= width) line = candidate;
    else {
      if (line) lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

export async function renderTaxInvoicePdf(invoice: TaxInvoiceSnapshot) {
  validateSnapshot(invoice);
  const document = await PDFDocument.create();
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const issued = new Date(invoice.issuedAt.endsWith("Z") ? invoice.issuedAt : `${invoice.issuedAt.replace(" ", "T")}Z`);
  const stableDate = Number.isNaN(issued.valueOf()) ? new Date("2000-01-01T00:00:00Z") : issued;
  document.setTitle(`GST invoice ${pdfSafe(invoice.invoiceNumber)}`);
  document.setAuthor(pdfSafe(invoice.sellerName));
  document.setSubject(`Immutable GST tax invoice for ${pdfSafe(invoice.sourceNumber)}`);
  document.setCreator("URMED tax invoice renderer v1");
  document.setProducer("URMED tax invoice renderer v1");
  document.setCreationDate(stableDate);
  document.setModificationDate(stableDate);

  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const margin = 42;
  let page!: PDFPage;
  let y = 0;
  const addPage = () => {
    page = document.addPage([pageWidth, pageHeight]);
    y = pageHeight - margin;
    page.drawText("GST TAX INVOICE", { x: margin, y, size: 18, font: bold, color: rgb(0.08, 0.42, 0.34) });
    page.drawText(pdfSafe(invoice.invoiceNumber), { x: pageWidth - margin - bold.widthOfTextAtSize(pdfSafe(invoice.invoiceNumber), 11), y: y + 2, size: 11, font: bold });
    y -= 26;
    page.drawLine({ start: { x: margin, y }, end: { x: pageWidth - margin, y }, thickness: 1.5, color: rgb(0.08, 0.42, 0.34) });
    y -= 18;
  };
  const ensure = (height: number) => { if (y - height < 64) addPage(); };
  const drawWrapped = (value: string, x: number, width: number, options: { size?: number; font?: PDFFont; gap?: number } = {}) => {
    const font = options.font ?? regular;
    const size = options.size ?? 9;
    const gap = options.gap ?? size + 3;
    for (const line of wrapText(value, font, size, width)) {
      ensure(gap);
      page.drawText(line, { x, y, size, font, color: rgb(0.09, 0.21, 0.18) });
      y -= gap;
    }
  };
  addPage();
  drawWrapped(`Issued ${displayDate(invoice.issuedAt)} | ${invoice.sourceType === "online_order" ? "Order" : "Counter sale"} ${invoice.sourceNumber} | Payment ${invoice.paymentMode.toUpperCase()}`, margin, pageWidth - margin * 2);
  y -= 7;
  const sellerTop = y;
  drawWrapped("SELLER", margin, 235, { font: bold, size: 9 });
  drawWrapped(invoice.sellerName, margin, 235, { font: bold, size: 11 });
  drawWrapped(invoice.sellerAddress, margin, 235);
  drawWrapped(`GSTIN: ${invoice.sellerGstin || "Not registered"}`, margin, 235);
  const sellerBottom = y;
  y = sellerTop;
  drawWrapped("BILL TO", 315, 235, { font: bold, size: 9 });
  drawWrapped(invoice.buyerName, 315, 235, { font: bold, size: 11 });
  if (invoice.buyerAddress) drawWrapped(invoice.buyerAddress, 315, 235);
  drawWrapped(`Buyer GSTIN: ${invoice.buyerGstin || "Unregistered"} | Place of supply: ${invoice.placeOfSupplyStateCode}`, 315, 235);
  y = Math.min(y, sellerBottom) - 14;

  for (const line of invoice.lines) {
    ensure(55);
    page.drawLine({ start: { x: margin, y: y + 8 }, end: { x: pageWidth - margin, y: y + 8 }, thickness: 0.5, color: rgb(0.78, 0.85, 0.82) });
    page.drawText(`${line.lineNumber}.`, { x: margin, y, size: 9, font: bold });
    const nameLines = wrapText(line.productName, regular, 9, 220).slice(0, 2);
    nameLines.forEach((text, index) => page.drawText(text, { x: margin + 18, y: y - index * 11, size: 9, font: index ? regular : bold }));
    page.drawText(`Batch ${pdfSafe(line.batchNumber)} | Exp ${pdfSafe(line.expiryDate || "-")} | HSN ${pdfSafe(line.hsnCode || "-")} | GST ${line.gstPercent}%`, { x: margin + 18, y: y - nameLines.length * 11, size: 7.5, font: regular, color: rgb(0.35, 0.43, 0.4) });
    const amount = money(line.lineTotalPaise);
    page.drawText(`${line.quantity} x ${money(line.unitPricePaise)}`, { x: 355, y, size: 8, font: regular });
    page.drawText(amount, { x: pageWidth - margin - bold.widthOfTextAtSize(amount, 9), y, size: 9, font: bold });
    y -= Math.max(42, nameLines.length * 11 + 22);
  }
  ensure(150);
  y -= 5;
  const totals: Array<[string, number]> = [
    ["Gross", invoice.grossPaise], ["Discount", -invoice.discountPaise], ["Taxable value", invoice.subtotalPaise],
    ["CGST", invoice.cgstPaise], ["SGST", invoice.sgstPaise], ["IGST", invoice.igstPaise], ["Delivery", invoice.deliveryFeePaise],
  ];
  for (const [label, amount] of totals) {
    const amountText = money(Math.abs(amount));
    page.drawText(label, { x: 355, y, size: 9, font: regular });
    page.drawText(`${amount < 0 ? "-" : ""}${amountText}`, { x: pageWidth - margin - regular.widthOfTextAtSize(`${amount < 0 ? "-" : ""}${amountText}`, 9), y, size: 9, font: regular });
    y -= 15;
  }
  page.drawLine({ start: { x: 350, y: y + 6 }, end: { x: pageWidth - margin, y: y + 6 }, thickness: 1.2 });
  const total = money(invoice.totalPaise);
  page.drawText("TOTAL", { x: 355, y: y - 5, size: 12, font: bold });
  page.drawText(total, { x: pageWidth - margin - bold.widthOfTextAtSize(total, 12), y: y - 5, size: 12, font: bold });

  const pages = document.getPages();
  pages.forEach((current, index) => {
    current.drawText(`Immutable URMED invoice snapshot v1 | Page ${index + 1} of ${pages.length} | Payment receipt is separate`, {
      x: margin, y: 28, size: 7.5, font: regular, color: rgb(0.35, 0.43, 0.4),
    });
  });
  return document.save({ useObjectStreams: false });
}

export function taxInvoiceFilename(invoiceNumber: string, extension: "pdf" | "html") {
  const safe = invoiceNumber.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 100) || "invoice";
  return `URMED-GST-${safe}.${extension}`;
}

export async function taxInvoiceResponse(invoice: TaxInvoiceSnapshot, format: string | null) {
  const selected = format || "pdf";
  if (selected !== "pdf" && selected !== "html") {
    return Response.json({ error: "Invoice format must be pdf or html" }, { status: 400, headers: { "Cache-Control": "private, no-store" } });
  }
  const commonHeaders = {
    "Cache-Control": "private, no-store, max-age=0",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
  };
  if (selected === "html") return new Response(renderTaxInvoiceHtml(invoice), { headers: {
    ...commonHeaders, "Content-Type": "text/html; charset=utf-8", "Content-Disposition": `inline; filename="${taxInvoiceFilename(invoice.invoiceNumber, "html")}"`,
  } });
  const rendered = await renderTaxInvoicePdf(invoice);
  const pdf = new Uint8Array(rendered.byteLength);
  pdf.set(rendered);
  return new Response(pdf.buffer, { headers: {
    ...commonHeaders, "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${taxInvoiceFilename(invoice.invoiceNumber, "pdf")}"`,
  } });
}
