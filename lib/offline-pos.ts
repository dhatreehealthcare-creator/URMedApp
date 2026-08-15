import { normalizeIndianMobile, normalizeProviderEmail } from "./identity-verification.ts";
import { currentOperationalVendorPredicate } from "./operational-vendor.ts";
import { allocateFefo, calculateGst } from "./order-controls.ts";
import { sha256Hex } from "./signatures.ts";
import { prepareOfflineTaxInvoiceStatement } from "./tax-invoice.ts";
import { effectivePriceFallbackSql } from "./effective-pricing.ts";

export const POS_PAYMENT_MODES = ["cash", "upi", "card", "credit"] as const;
export const POS_DRUG_SCHEDULES = ["OTC", "G", "H", "H1", "X", "NDPS", "UNCLASSIFIED"] as const;

export type PosPaymentMode = typeof POS_PAYMENT_MODES[number];
export type PosDrugSchedule = typeof POS_DRUG_SCHEDULES[number];
export type PosDiscount =
  | { type: "none" }
  | { type: "fixed"; amountPaise: number }
  | { type: "percent"; basisPoints: number };

export type PosSaleDraft = {
  idempotencyKey: string;
  branchId: number | null;
  customerProfileId: number | null;
  customerName: string;
  customerPhone: string;
  buyerGstin: string;
  placeOfSupplyStateCode: string;
  paymentMode: PosPaymentMode;
  discount: PosDiscount;
  prescriptionCaptureId: number | null;
  items: Array<{ productId: number; quantity: number }>;
};

export type PosPrescriptionCaptureDraft = {
  documentId: number;
  customerProfileId: number | null;
  patientName: string;
  patientAddress: string;
  prescriberName: string;
  prescriberAddress: string;
  prescribedOn: string;
  serialNumber: string;
  items: Array<{ productId: number; medicineText: string; quantityRequested: number }>;
};

export type PosPrescriptionReviewDraft = {
  decision: "approved" | "rejected" | "clarification_required";
  notes: string;
  items: Array<{ productId: number; quantityApproved: number }>;
};

export type PosAllocation = {
  inventoryId: number;
  productId: number;
  productName: string;
  batchNumber: string;
  expiryDate: string;
  quantity: number;
  unitPricePaise: number;
  gstPercent: number;
  hsnCode: string;
  mrpPaise: number | null;
  prescriptionRequired: boolean;
  drugSchedule: PosDrugSchedule;
  expectedQuantity: number;
  reservedQuantity: number;
};

export type PosStockBatch = Omit<PosAllocation, "quantity"> & { availableQuantity: number };

export type PosCalculatedLine = PosAllocation & {
  grossPaise: number;
  discountPaise: number;
  taxablePaise: number;
  taxPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  lineTotalPaise: number;
};

export class OfflinePosError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "OfflinePosError";
    this.status = status;
  }
}

function positiveInteger(value: unknown, label: string, maximum: number) {
  const result = Number(value);
  if (!Number.isInteger(result) || result < 1 || result > maximum) {
    throw new OfflinePosError(`${label} is invalid`);
  }
  return result;
}

function optionalPositiveInteger(value: unknown, label: string) {
  if (value === undefined || value === null || value === "") return null;
  return positiveInteger(value, label, 1_000_000_000);
}

function text(value: unknown, maximum: number) {
  return String(value ?? "").trim().slice(0, maximum);
}

export function normalizePosLookup(value: unknown) {
  const raw = text(value, 180);
  const phone = normalizeIndianMobile(raw);
  if (phone) return { kind: "phone" as const, value: phone };
  const email = normalizeProviderEmail(raw);
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { kind: "email" as const, value: email };
  throw new OfflinePosError("Enter an exact 10-digit mobile number or complete email address");
}

export function normalizePosGstin(value: unknown, required = false) {
  const gstin = text(value, 15).toUpperCase().replace(/\s/g, "");
  if (!gstin && !required) return "";
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin)) {
    throw new OfflinePosError("Buyer GSTIN is invalid");
  }
  return gstin;
}

export function parsePosDiscount(body: Record<string, unknown>): PosDiscount {
  const type = text(body.discountType, 20).toLowerCase() || "none";
  if (type === "none") return { type: "none" };
  const value = Number(body.discountValue);
  if (!Number.isFinite(value) || value < 0) throw new OfflinePosError("Discount is invalid");
  if (type === "fixed") {
    const amountPaise = Math.round(value * 100);
    if (amountPaise > 1_000_000_000) throw new OfflinePosError("Discount is invalid");
    return { type, amountPaise };
  }
  if (type === "percent") {
    const basisPoints = Math.round(value * 100);
    if (basisPoints < 0 || basisPoints > 10_000 || Math.abs(value * 100 - basisPoints) > 1e-7) {
      throw new OfflinePosError("Percentage discount must be between 0 and 100 with at most two decimal places");
    }
    return { type, basisPoints };
  }
  throw new OfflinePosError("Discount type is invalid");
}

export function parsePosSaleDraft(input: unknown): PosSaleDraft {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new OfflinePosError("Sale details are invalid");
  const body = input as Record<string, unknown>;
  const idempotencyKey = text(body.idempotencyKey, 120);
  if (!/^[A-Za-z0-9:_-]{8,120}$/.test(idempotencyKey)) throw new OfflinePosError("A valid idempotency key is required");

  const rawItems = Array.isArray(body.items) ? body.items : [];
  if (!rawItems.length || rawItems.length > 50) throw new OfflinePosError("Add between 1 and 50 medicines to the cart");
  const quantities = new Map<number, number>();
  for (const rawItem of rawItems) {
    if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) throw new OfflinePosError("Cart item is invalid");
    const item = rawItem as Record<string, unknown>;
    const productId = positiveInteger(item.productId, "Product", 1_000_000_000);
    const quantity = positiveInteger(item.quantity, "Quantity", 1_000);
    const combined = (quantities.get(productId) ?? 0) + quantity;
    if (combined > 1_000) throw new OfflinePosError("A medicine quantity cannot exceed 1,000 units");
    quantities.set(productId, combined);
  }
  if ([...quantities.values()].reduce((total, quantity) => total + quantity, 0) > 2_000) {
    throw new OfflinePosError("A counter sale cannot exceed 2,000 units");
  }

  const customerProfileId = optionalPositiveInteger(body.customerProfileId, "Customer");
  const suppliedPhone = text(body.customerPhone, 30);
  const customerPhone = suppliedPhone ? normalizeIndianMobile(suppliedPhone) : "";
  if (suppliedPhone && !customerPhone) throw new OfflinePosError("Customer mobile number must contain 10 digits");
  const customerName = text(body.customerName, 160) || "Walk-in customer";
  const paymentMode = text(body.paymentMode, 20).toLowerCase();
  if (!POS_PAYMENT_MODES.includes(paymentMode as PosPaymentMode)) throw new OfflinePosError("Payment mode is invalid");
  if (paymentMode === "credit" && !customerProfileId) {
    throw new OfflinePosError("A verified live customer is required for a credit sale");
  }
  const placeOfSupplyStateCode = text(body.placeOfSupplyStateCode, 2);
  if (!/^\d{2}$/.test(placeOfSupplyStateCode)) throw new OfflinePosError("Place of supply state code is invalid");

  return {
    idempotencyKey,
    branchId: optionalPositiveInteger(body.branchId, "Branch"),
    customerProfileId,
    customerName,
    customerPhone,
    buyerGstin: normalizePosGstin(body.buyerGstin),
    placeOfSupplyStateCode,
    paymentMode: paymentMode as PosPaymentMode,
    discount: parsePosDiscount(body),
    prescriptionCaptureId: optionalPositiveInteger(body.prescriptionCaptureId, "Prescription capture"),
    items: [...quantities].map(([productId, quantity]) => ({ productId, quantity })),
  };
}

export function parsePosPrescriptionCapture(input: unknown): PosPrescriptionCaptureDraft {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new OfflinePosError("Prescription details are invalid");
  const body = input as Record<string, unknown>;
  const prescribedOn = text(body.prescribedOn, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(prescribedOn) || Number.isNaN(Date.parse(`${prescribedOn}T00:00:00Z`))
    || prescribedOn > new Date().toISOString().slice(0, 10)) {
    throw new OfflinePosError("Prescription date is invalid");
  }
  const patientName = text(body.patientName, 140);
  const patientAddress = text(body.patientAddress, 500);
  const prescriberName = text(body.prescriberName, 140);
  const prescriberAddress = text(body.prescriberAddress, 500);
  if (patientName.length < 2 || patientAddress.length < 5 || prescriberName.length < 2 || prescriberAddress.length < 5) {
    throw new OfflinePosError("Patient and prescriber names and addresses are required");
  }
  const rawItems = Array.isArray(body.items) ? body.items : [];
  if (!rawItems.length || rawItems.length > 50) throw new OfflinePosError("Add between 1 and 50 prescription medicines");
  const items = new Map<number, { productId: number; medicineText: string; quantityRequested: number }>();
  for (const raw of rawItems) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new OfflinePosError("Prescription medicine is invalid");
    const item = raw as Record<string, unknown>;
    const productId = positiveInteger(item.productId, "Product", 1_000_000_000);
    if (items.has(productId)) throw new OfflinePosError("Each prescription medicine must appear once");
    const medicineText = text(item.medicineText, 180);
    if (medicineText.length < 2) throw new OfflinePosError("Prescription medicine name is required");
    items.set(productId, {
      productId,
      medicineText,
      quantityRequested: positiveInteger(item.quantityRequested, "Prescription quantity", 1_000),
    });
  }
  return {
    documentId: positiveInteger(body.documentId, "Document", 1_000_000_000),
    customerProfileId: optionalPositiveInteger(body.customerProfileId, "Customer"),
    patientName,
    patientAddress,
    prescriberName,
    prescriberAddress,
    prescribedOn,
    serialNumber: text(body.serialNumber, 80),
    items: [...items.values()],
  };
}

export function parsePosPrescriptionReview(input: unknown): PosPrescriptionReviewDraft {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new OfflinePosError("Review details are invalid");
  const body = input as Record<string, unknown>;
  const decision = text(body.decision, 30) as PosPrescriptionReviewDraft["decision"];
  if (!["approved", "rejected", "clarification_required"].includes(decision)) {
    throw new OfflinePosError("Review decision is invalid");
  }
  const notes = text(body.notes, 1_000);
  if (decision !== "approved" && notes.length < 5) throw new OfflinePosError("A clear review reason is required");
  const rawItems = Array.isArray(body.items) ? body.items : [];
  if (decision === "approved" && !rawItems.length) throw new OfflinePosError("Approve at least one prescription medicine");
  if (decision !== "approved" && rawItems.length) throw new OfflinePosError("Only approved reviews may include medicine quantities");
  const items = new Map<number, { productId: number; quantityApproved: number }>();
  for (const raw of rawItems) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new OfflinePosError("Approved medicine is invalid");
    const item = raw as Record<string, unknown>;
    const productId = positiveInteger(item.productId, "Product", 1_000_000_000);
    if (items.has(productId)) throw new OfflinePosError("Each approved medicine must appear once");
    items.set(productId, { productId, quantityApproved: positiveInteger(item.quantityApproved, "Approved quantity", 1_000) });
  }
  return { decision, notes, items: [...items.values()] };
}

export function posProductRequiresPrescription(input: { prescriptionRequired: boolean | number; drugSchedule: string }) {
  return Boolean(input.prescriptionRequired) || ["H", "H1", "X", "NDPS"].includes(input.drugSchedule);
}

export function assertPosProductsGoverned(inputs: Array<{ productName: string; drugSchedule: string }>) {
  const blocked = inputs.find((input) => input.drugSchedule === "UNCLASSIFIED");
  if (blocked) throw new OfflinePosError(`${blocked.productName} must be classified before it can be sold at the counter`, 409);
}

export function assertPrescriptionCoverage(
  allocations: Array<Pick<PosAllocation, "productId" | "productName" | "quantity" | "prescriptionRequired" | "drugSchedule">>,
  approvedItems: Array<{ productId: number; quantityApproved: number | null }>,
) {
  const required = new Map<number, { name: string; quantity: number }>();
  for (const allocation of allocations) {
    if (!posProductRequiresPrescription(allocation)) continue;
    const current = required.get(allocation.productId);
    required.set(allocation.productId, {
      name: allocation.productName,
      quantity: (current?.quantity ?? 0) + allocation.quantity,
    });
  }
  if (!required.size) return;
  const approved = new Map<number, number>();
  for (const item of approvedItems) {
    if (!Number.isInteger(item.productId) || item.productId < 1 || item.quantityApproved === null) continue;
    approved.set(item.productId, (approved.get(item.productId) ?? 0) + Math.max(0, item.quantityApproved));
  }
  for (const [productId, item] of required) {
    if ((approved.get(productId) ?? 0) < item.quantity) {
      throw new OfflinePosError(`The approved prescription does not cover ${item.name} in the requested quantity`, 409);
    }
  }
}

export function allocatePosProducts(
  requestedItems: Array<{ productId: number; quantity: number }>,
  batches: PosStockBatch[],
): PosAllocation[] {
  const batchesByProduct = new Map<number, PosStockBatch[]>();
  for (const batch of batches) {
    const current = batchesByProduct.get(batch.productId) ?? [];
    current.push(batch);
    batchesByProduct.set(batch.productId, current);
  }
  const allocations: PosAllocation[] = [];
  for (const request of requestedItems) {
    const candidates = batchesByProduct.get(request.productId) ?? [];
    if (!candidates.length) throw new OfflinePosError("A selected medicine is no longer available", 409);
    try {
      allocations.push(...allocateFefo(request.quantity, candidates).map(({ allocatedQuantity, availableQuantity: _available, ...batch }) => {
        void _available;
        return { ...batch, quantity: allocatedQuantity };
      }));
    } catch {
      throw new OfflinePosError(`${candidates[0].productName} does not have enough eligible FEFO stock`, 409);
    }
  }
  return allocations;
}

function discountTotal(grossPaise: number, discount: PosDiscount) {
  if (discount.type === "none") return 0;
  const result = discount.type === "fixed"
    ? discount.amountPaise
    : Number((BigInt(grossPaise) * BigInt(discount.basisPoints) + BigInt(5_000)) / BigInt(10_000));
  if (!Number.isSafeInteger(result) || result < 0 || result >= grossPaise) {
    throw new OfflinePosError("Discount must be less than the cart gross amount");
  }
  return result;
}

export function allocatePosDiscount(grossAmounts: number[], discount: PosDiscount) {
  if (!grossAmounts.length || grossAmounts.some((value) => !Number.isSafeInteger(value) || value < 1)) {
    throw new OfflinePosError("Cart line amount is invalid");
  }
  const grossTotal = grossAmounts.reduce((total, value) => total + value, 0);
  if (!Number.isSafeInteger(grossTotal)) throw new OfflinePosError("Cart amount is too large");
  const totalDiscount = discountTotal(grossTotal, discount);
  if (!totalDiscount) return grossAmounts.map(() => 0);

  const divisor = BigInt(grossTotal);
  const allocations = grossAmounts.map((gross, index) => {
    const numerator = BigInt(totalDiscount) * BigInt(gross);
    return { index, amount: Number(numerator / divisor), remainder: numerator % divisor };
  });
  let undistributed = totalDiscount - allocations.reduce((total, item) => total + item.amount, 0);
  for (const item of allocations.toSorted((left, right) => {
    if (left.remainder === right.remainder) return left.index - right.index;
    return left.remainder > right.remainder ? -1 : 1;
  })) {
    if (!undistributed) break;
    item.amount += 1;
    undistributed -= 1;
  }
  return allocations.toSorted((left, right) => left.index - right.index).map((item) => item.amount);
}

export function calculatePosTotals(
  allocations: PosAllocation[],
  discount: PosDiscount,
  sellerStateCode: string,
  placeOfSupplyStateCode: string,
) {
  if (!allocations.length) throw new OfflinePosError("No stock was allocated to the cart");
  assertPosProductsGoverned(allocations);
  const grossAmounts = allocations.map((line) => {
    const gross = line.unitPricePaise * line.quantity;
    if (!Number.isSafeInteger(gross) || gross < 1) throw new OfflinePosError("Cart line amount is invalid");
    return gross;
  });
  const discounts = allocatePosDiscount(grossAmounts, discount);
  const lines: PosCalculatedLine[] = allocations.map((line, index) => {
    const grossPaise = grossAmounts[index];
    const discountPaise = discounts[index];
    const taxablePaise = grossPaise - discountPaise;
    let gst;
    try {
      gst = calculateGst(taxablePaise, line.gstPercent, sellerStateCode, placeOfSupplyStateCode);
    } catch (error) {
      throw new OfflinePosError(error instanceof Error ? error.message : "GST calculation failed", 409);
    }
    return { ...line, grossPaise, discountPaise, taxablePaise, ...gst, lineTotalPaise: taxablePaise + gst.taxPaise };
  });
  return {
    lines,
    grossPaise: lines.reduce((sum, line) => sum + line.grossPaise, 0),
    discountPaise: lines.reduce((sum, line) => sum + line.discountPaise, 0),
    subtotalPaise: lines.reduce((sum, line) => sum + line.taxablePaise, 0),
    taxPaise: lines.reduce((sum, line) => sum + line.taxPaise, 0),
    cgstPaise: lines.reduce((sum, line) => sum + line.cgstPaise, 0),
    sgstPaise: lines.reduce((sum, line) => sum + line.sgstPaise, 0),
    igstPaise: lines.reduce((sum, line) => sum + line.igstPaise, 0),
    totalPaise: lines.reduce((sum, line) => sum + line.lineTotalPaise, 0),
  };
}

export async function posRequestFingerprint(draft: PosSaleDraft) {
  const canonical = {
    ...draft,
    // A linked profile is the canonical customer identity. Mutable display
    // claims must not turn a legitimate retry into an idempotency conflict.
    ...(draft.customerProfileId ? { customerName: "", customerPhone: "" } : {}),
    items: draft.items.toSorted((left, right) => left.productId - right.productId),
  };
  return sha256Hex(JSON.stringify(canonical));
}

type PosVendorRow = { gstNumber: string };
type PosCustomerRow = { id: number; name: string; phone: string };
type PosCaptureRow = { id: number; customerProfileId: number | null; pharmacistId: number };

export type PosReceipt = {
  id: number;
  saleNumber: string;
  invoiceId: number;
  invoiceNumber: string;
  customerName: string;
  customerPhone: string;
  paymentMode: string;
  grossPaise: number;
  discountPaise: number;
  subtotalPaise: number;
  taxPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalPaise: number;
  createdAt: string;
  lines: Array<{
    id: number;
    productName: string;
    batchNumber: string;
    expiryDate: string;
    quantity: number;
    unitPricePaise: number;
    discountPaise: number;
    gstPercent: number;
    taxablePaise: number;
    taxPaise: number;
    lineTotalPaise: number;
  }>;
};

function saleNumber() {
  return `POS-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${crypto.randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
}

export async function getPosReceipt(database: D1Database, vendorId: number, saleId: number): Promise<PosReceipt | null> {
  const sale = await database.prepare(`SELECT sale.id, sale.sale_number AS saleNumber,
    invoice.id AS invoiceId, invoice.invoice_number AS invoiceNumber, sale.customer_name AS customerName,
    sale.customer_phone AS customerPhone, sale.payment_mode AS paymentMode,
    sale.gross_paise AS grossPaise, sale.discount_paise AS discountPaise,
    sale.subtotal_paise AS subtotalPaise, sale.tax_paise AS taxPaise,
    sale.cgst_paise AS cgstPaise, sale.sgst_paise AS sgstPaise, sale.igst_paise AS igstPaise,
    sale.total_paise AS totalPaise, sale.created_at AS createdAt
    FROM offline_sales sale JOIN offline_sale_events event ON event.offline_sale_id = sale.id AND event.event_type = 'completed'
    JOIN tax_invoices invoice ON invoice.source_type = 'offline_sale' AND invoice.source_id = sale.id
    WHERE sale.id = ? AND sale.vendor_id = ? LIMIT 1`).bind(saleId, vendorId).first<Omit<PosReceipt, "lines">>();
  if (!sale) return null;
  const lines = await database.prepare(`SELECT id, product_name AS productName, batch_number AS batchNumber,
    expiry_date AS expiryDate, quantity, unit_price_paise AS unitPricePaise,
    discount_paise AS discountPaise, gst_percent AS gstPercent, taxable_paise AS taxablePaise,
    tax_paise AS taxPaise, line_total_paise AS lineTotalPaise
    FROM offline_sale_items WHERE offline_sale_id = ? ORDER BY id`).bind(saleId).all<PosReceipt["lines"][number]>();
  return { ...sale, lines: lines.results };
}

async function canonicalCustomer(database: D1Database, draft: PosSaleDraft) {
  if (!draft.customerProfileId) return draft;
  const customer = await database.prepare(`SELECT id, name, phone FROM account_profiles
    WHERE id = ? AND role = 'customer' AND status = 'active'
      AND email_verified = 1 AND phone_verified = 1 LIMIT 1`)
    .bind(draft.customerProfileId).first<PosCustomerRow>();
  if (!customer) throw new OfflinePosError("The selected verified live customer is unavailable", 409);
  return { ...draft, customerName: customer.name, customerPhone: customer.phone };
}

async function existingReceipt(database: D1Database, vendorId: number, draft: PosSaleDraft, fingerprint: string) {
  const existing = await database.prepare(`SELECT id, request_fingerprint AS requestFingerprint
    FROM offline_sales WHERE vendor_id = ? AND idempotency_key = ? LIMIT 1`)
    .bind(vendorId, draft.idempotencyKey).first<{ id: number; requestFingerprint: string }>();
  if (!existing) return null;
  if (existing.requestFingerprint !== fingerprint) {
    throw new OfflinePosError("This idempotency key was already used for a different counter sale", 409);
  }
  const receipt = await getPosReceipt(database, vendorId, existing.id);
  if (!receipt) throw new OfflinePosError("The original counter sale is still being finalized", 409);
  return receipt;
}

export async function completeOfflineSale(input: {
  database: D1Database;
  vendorId: number;
  actorProfileId: number;
  body: unknown;
}) {
  const { database, vendorId, actorProfileId } = input;
  let draft = await canonicalCustomer(database, parsePosSaleDraft(input.body));
  const fingerprint = await posRequestFingerprint(draft);
  const prior = await existingReceipt(database, vendorId, draft, fingerprint);
  if (prior) return { receipt: prior, replayed: true };

  const operationalVendor = currentOperationalVendorPredicate("vendor");
  const vendor = await database.prepare(`SELECT vendor.gst_number AS gstNumber FROM vendors vendor
    WHERE vendor.id = ? AND ${operationalVendor} LIMIT 1`).bind(vendorId).first<PosVendorRow>();
  if (!vendor) throw new OfflinePosError("This pharmacy cannot complete counter sales", 409);
  const sellerStateCode = /^\d{2}/.test(vendor.gstNumber) ? vendor.gstNumber.slice(0, 2) : "";

  const productIds = draft.items.map((item) => item.productId);
  const placeholders = productIds.map(() => "?").join(",");
  const batchesResult = await database.prepare(`SELECT inventory.id AS inventoryId,
    inventory.product_id AS productId, product.name AS productName,
    inventory.batch_number AS batchNumber, inventory.expiry_date AS expiryDate,
    ${effectivePriceFallbackSql("inventory", "sale_price_paise")} AS unitPricePaise,
    ${effectivePriceFallbackSql("inventory", "gst_percent")} AS gstPercent,
    product.hsn_code AS hsnCode, inventory.mrp_paise AS mrpPaise,
    product.prescription_required AS prescriptionRequired, product.drug_schedule AS drugSchedule,
    inventory.quantity AS expectedQuantity, inventory.reserved_quantity AS reservedQuantity,
    inventory.quantity - inventory.reserved_quantity AS availableQuantity
    FROM pharmacy_inventory inventory JOIN products product ON product.id = inventory.product_id
    WHERE inventory.vendor_id = ? AND inventory.branch_id = ? AND inventory.product_id IN (${placeholders})
      AND inventory.active = 1 AND inventory.quarantine_status = 'available'
      AND inventory.cold_chain_status IN ('not_applicable','within_range')
      AND inventory.expiry_date IS NOT NULL AND date(inventory.expiry_date) >= date('now')
      AND inventory.quantity - inventory.reserved_quantity > 0
      AND product.active = 1 AND product.governance_status = 'approved'
    ORDER BY inventory.product_id, date(inventory.expiry_date), inventory.id`)
    .bind(vendorId, draft.branchId ?? (await database.prepare("SELECT id FROM pharmacy_branches WHERE vendor_id = ? AND is_primary = 1 LIMIT 1").bind(vendorId).first<{ id: number }>())?.id ?? 0, ...productIds).all<PosStockBatch>();
  const allocations = allocatePosProducts(draft.items, batchesResult.results);
  const requiresPrescription = allocations.some(posProductRequiresPrescription);

  let capture: PosCaptureRow | null = null;
  if (requiresPrescription) {
    if (!draft.prescriptionCaptureId) throw new OfflinePosError("An approved counter prescription is required", 409);
    capture = await database.prepare(`SELECT capture.id, capture.customer_profile_id AS customerProfileId,
      review.pharmacist_id AS pharmacistId
      FROM offline_prescriptions capture JOIN offline_prescription_reviews review
        ON review.offline_prescription_id = capture.id AND review.decision = 'approved'
      WHERE capture.id = ? AND capture.vendor_id = ? AND capture.status = 'approved'
        AND NOT EXISTS (SELECT 1 FROM offline_sales used WHERE used.offline_prescription_id = capture.id)
      LIMIT 1`).bind(draft.prescriptionCaptureId, vendorId).first<PosCaptureRow>();
    if (!capture) throw new OfflinePosError("The counter prescription is not approved, belongs elsewhere, or was already used", 409);
    if (capture.customerProfileId !== null && capture.customerProfileId !== draft.customerProfileId) {
      throw new OfflinePosError("The approved prescription belongs to a different live customer", 409);
    }
    const approved = await database.prepare(`SELECT item.product_id AS productId, item.quantity_approved AS quantityApproved
      FROM offline_prescription_review_items item JOIN offline_prescription_reviews review ON review.id = item.review_id
      WHERE review.offline_prescription_id = ? AND review.decision = 'approved'`).bind(capture.id)
      .all<{ productId: number; quantityApproved: number }>();
    assertPrescriptionCoverage(allocations, approved.results);
  } else {
    draft = { ...draft, prescriptionCaptureId: null };
  }

  const totals = calculatePosTotals(allocations, draft.discount, sellerStateCode, draft.placeOfSupplyStateCode);
  if (!sellerStateCode && totals.lines.some((line) => line.gstPercent > 0)) {
    throw new OfflinePosError("The pharmacy must add a valid GSTIN before selling GST-rated stock", 409);
  }
  const number = saleNumber();
  const debitAccount = draft.paymentMode === "cash" ? "CASH_ON_HAND"
    : draft.paymentMode === "credit" ? "ACCOUNTS_RECEIVABLE" : "BANK_CLEARING";
  const evidence = JSON.stringify({
    saleNumber: number,
    idempotencyKey: draft.idempotencyKey,
    allocations: totals.lines.map((line) => ({ inventoryId: line.inventoryId, productId: line.productId, quantity: line.quantity })),
    grossPaise: totals.grossPaise,
    discountPaise: totals.discountPaise,
    taxPaise: totals.taxPaise,
    totalPaise: totals.totalPaise,
  });
  const branchId = draft.branchId ?? (await database.prepare("SELECT id FROM pharmacy_branches WHERE vendor_id = ? AND is_primary = 1 AND status = 'active' LIMIT 1").bind(vendorId).first<{ id: number }>())?.id ?? 0;
  if (!branchId) throw new OfflinePosError("Select an active pharmacy branch", 409);
  const statements: D1PreparedStatement[] = [
    database.prepare(`INSERT INTO offline_sales (sale_number,vendor_id,branch_id,customer_profile_id,customer_name,customer_phone,
      offline_prescription_id,idempotency_key,request_fingerprint,gross_paise,subtotal_paise,tax_paise,discount_paise,
      cgst_paise,sgst_paise,igst_paise,total_paise,payment_mode,buyer_gstin,place_of_supply_state_code,created_by_profile_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(number, vendorId, branchId, draft.customerProfileId,
      draft.customerName, draft.customerPhone, draft.prescriptionCaptureId, draft.idempotencyKey, fingerprint,
      totals.grossPaise, totals.subtotalPaise, totals.taxPaise, totals.discountPaise, totals.cgstPaise,
      totals.sgstPaise, totals.igstPaise, totals.totalPaise, draft.paymentMode, draft.buyerGstin,
      draft.placeOfSupplyStateCode, actorProfileId),
  ];
  for (const line of totals.lines) {
    statements.push(
      database.prepare(`INSERT INTO offline_sale_items (offline_sale_id,inventory_id,product_id,batch_number,expiry_date,
        quantity,product_name,unit_price_paise,gst_percent,hsn_code,mrp_paise,discount_paise,cgst_paise,sgst_paise,
        igst_paise,prescription_required,drug_schedule,taxable_paise,tax_paise,line_total_paise)
        SELECT id,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? FROM offline_sales WHERE sale_number = ?`)
        .bind(line.inventoryId, line.productId, line.batchNumber, line.expiryDate, line.quantity, line.productName,
          line.unitPricePaise, line.gstPercent, line.hsnCode, line.mrpPaise ?? 0, line.discountPaise,
          line.cgstPaise, line.sgstPaise, line.igstPaise, line.prescriptionRequired ? 1 : 0,
          line.drugSchedule, line.taxablePaise, line.taxPaise, line.lineTotalPaise, number),
      database.prepare(`UPDATE pharmacy_inventory SET quantity = quantity - ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND vendor_id = ? AND active = 1 AND quarantine_status = 'available'
          AND cold_chain_status IN ('not_applicable','within_range') AND date(expiry_date) >= date('now')
          AND quantity = ? AND reserved_quantity = ?
          AND quantity - reserved_quantity >= ?`).bind(line.quantity, line.inventoryId, vendorId,
          line.expectedQuantity, line.reservedQuantity, line.quantity),
      database.prepare(`INSERT INTO stock_ledger (vendor_id,inventory_id,movement_type,quantity_delta,balance_after,
        reference_type,reference_id,reason,actor_profile_id)
        SELECT ?,?,'offline_sale',-?,inventory.quantity,'offline_sale',sale.id,'Atomic counter FEFO allocation',?
        FROM pharmacy_inventory inventory JOIN offline_sales sale ON sale.sale_number = ?
        WHERE inventory.id = ? AND inventory.vendor_id = ?
          AND inventory.quantity = ? AND inventory.reserved_quantity = ?`).bind(vendorId, line.inventoryId, line.quantity,
          actorProfileId, number, line.inventoryId, vendorId, line.expectedQuantity - line.quantity, line.reservedQuantity),
    );
  }
  statements.push(
    prepareOfflineTaxInvoiceStatement(database, number, actorProfileId),
    database.prepare(`INSERT INTO ledger_entries (vendor_id,account_code,entry_date,description,debit_paise,credit_paise,
      reference_type,reference_id,created_by_profile_id)
      SELECT vendor_id,?,date('now'),'Counter receipt '||sale_number,total_paise,0,'offline_sale',id,?
      FROM offline_sales WHERE sale_number = ?`).bind(debitAccount, actorProfileId, number),
    database.prepare(`INSERT INTO ledger_entries (vendor_id,account_code,entry_date,description,debit_paise,credit_paise,
      reference_type,reference_id,created_by_profile_id)
      SELECT vendor_id,'SALES',date('now'),'Counter sale '||sale_number,0,subtotal_paise,'offline_sale',id,?
      FROM offline_sales WHERE sale_number = ?`).bind(actorProfileId, number),
  );
  for (const [account, amount] of [["CGST_PAYABLE", totals.cgstPaise], ["SGST_PAYABLE", totals.sgstPaise], ["IGST_PAYABLE", totals.igstPaise]] as const) {
    if (amount > 0) statements.push(database.prepare(`INSERT INTO ledger_entries (vendor_id,account_code,entry_date,
      description,debit_paise,credit_paise,reference_type,reference_id,created_by_profile_id)
      SELECT vendor_id,?,date('now'),'GST for '||sale_number,0,?,'offline_sale',id,?
      FROM offline_sales WHERE sale_number = ?`).bind(account, amount, actorProfileId, number));
  }
  if (capture) {
    for (const line of totals.lines.filter(posProductRequiresPrescription)) {
      const registerType = ["H1", "X", "NDPS"].includes(line.drugSchedule) ? line.drugSchedule : "PRESCRIPTION";
      const retentionMonths = line.drugSchedule === "H1" ? 36 : 24;
      statements.push(database.prepare(`INSERT INTO statutory_register_entries (vendor_id,register_type,serial_number,
        transaction_date,patient_name,patient_address,prescriber_name,prescriber_address,product_id,batch_number,
        quantity_supplied,source_type,source_id,pharmacist_id,retention_until)
        SELECT sale.vendor_id,?,sale.sale_number||'-'||?,date('now'),capture.patient_name,capture.patient_address,
          capture.prescriber_name,capture.prescriber_address,?,?,?,'offline_sale',sale.id,?,date('now',?)
        FROM offline_sales sale JOIN offline_prescriptions capture ON capture.id = sale.offline_prescription_id
        WHERE sale.sale_number = ?`).bind(registerType, line.inventoryId, line.productId, line.batchNumber, line.quantity,
          capture.pharmacistId, `+${retentionMonths} months`, number));
    }
  }
  statements.push(database.prepare(`INSERT INTO offline_sale_events (offline_sale_id,vendor_id,event_type,
    actor_profile_id,request_fingerprint,evidence_json)
    SELECT id,vendor_id,'completed',?,?,? FROM offline_sales WHERE sale_number = ?`)
    .bind(actorProfileId, fingerprint, evidence, number));

  try {
    await database.batch(statements);
  } catch (error) {
    const raced = await existingReceipt(database, vendorId, draft, fingerprint).catch(() => null);
    if (raced) return { receipt: raced, replayed: true };
    const message = error instanceof Error ? error.message : "";
    if (/offline_sale_stock_invalid|offline_sale_evidence_invalid|UNIQUE constraint failed/i.test(message)) {
      throw new OfflinePosError("Stock, prescription approval, or sale state changed. Refresh and retry.", 409);
    }
    throw error;
  }
  const saved = await database.prepare("SELECT id FROM offline_sales WHERE sale_number = ? LIMIT 1")
    .bind(number).first<{ id: number }>();
  if (!saved) throw new OfflinePosError("The counter sale could not be finalized", 409);
  const receipt = await getPosReceipt(database, vendorId, saved.id);
  if (!receipt) throw new OfflinePosError("The counter receipt could not be loaded", 409);
  return { receipt, replayed: false };
}
