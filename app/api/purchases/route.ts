import { getD1 } from "../../../db/d1";
import { appendAuditEvent } from "../../../lib/audit";
import { errorResponse } from "../../../lib/auth-server";
import { asPositiveInteger, rupeesToPaise } from "../../../lib/money";
import { calculatePurchaseLineAmounts, hasConflictingPurchaseBatch, isDuplicateSupplierInvoiceError } from "../../../lib/purchase-conflicts";
import { LEGACY_RECEIVED_PURCHASE_STATUS, PURCHASE_STATUS } from "../../../lib/purchase-status";
import { PurchaseTransitionError, receivePurchaseOrder, transitionPurchaseOrder } from "../../../lib/purchase-lifecycle";
import { requireVendorPermission } from "../../../lib/vendor-access";
import { getRuntimeEnv } from "../../../lib/runtime-env";
import { validatePricePolicy } from "../../../lib/pricing-governance";

const gstRates = new Set([0, 5, 12, 18, 28]);

function clean(value: unknown, maximum: number) {
  return String(value ?? "").trim().slice(0, maximum);
}

function isoDate(value: unknown, label: string, required = true) {
  const date = clean(value, 10);
  if (!date && !required) return null;
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date) throw new Response(`${label} is invalid`, { status: 400 });
  return date;
}

type PurchaseInput = {
  legacyId: number;
  productId: number;
  productName: string;
  batchNumber: string;
  expiryDate: string;
  manufacturingDate: string | null;
  dosage: string;
  quantity: number;
  freeQuantity: number;
  purchasePricePaise: number;
  salePricePaise: number;
  mrpPaise: number;
  gstPercent: number;
  taxablePaise: number;
  taxPaise: number;
  lineTotalPaise: number;
};

async function loadPurchases(vendorId: number) {
  const db = getD1();
  const [orders, ledger] = await db.batch([
    db.prepare(`
      SELECT po.id, po.purchase_number AS purchaseNumber, po.invoice_number AS invoiceNumber,
        po.invoice_date AS invoiceDate, po.subtotal_paise AS subtotalPaise, po.tax_paise AS taxPaise,
        po.total_paise AS totalPaise, po.payment_status AS paymentStatus,
        CASE WHEN po.status = ? THEN ? WHEN po.status = 'posting' THEN 'draft' ELSE po.status END AS status,
        po.posted_at AS postedAt, s.business_name AS supplierName, COUNT(poi.id) AS lineCount,
        COALESCE(SUM(poi.received_quantity + poi.received_free_quantity), 0) AS receivedUnitCount,
        COALESCE(SUM(poi.quantity + poi.free_quantity), 0) AS orderedUnitCount
      FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
      LEFT JOIN purchase_order_items poi ON poi.purchase_order_id = po.id
      WHERE po.vendor_id = ? GROUP BY po.id, s.business_name ORDER BY po.invoice_date DESC, po.id DESC LIMIT 100
    `).bind(LEGACY_RECEIVED_PURCHASE_STATUS, PURCHASE_STATUS.RECEIVED, vendorId),
    db.prepare(`
      SELECT id, account_code AS accountCode, entry_date AS entryDate, description,
        debit_paise AS debitPaise, credit_paise AS creditPaise,
        reference_type AS referenceType, reference_id AS referenceId
      FROM ledger_entries WHERE vendor_id = ? AND reference_type IN ('purchase_order', 'purchase_receipt')
      ORDER BY entry_date DESC, id DESC LIMIT 200
    `).bind(vendorId),
  ]);
  return { purchases: orders.results, ledger: ledger.results };
}

export async function GET(request: Request) {
  try {
    const { vendorId } = await requireVendorPermission(request, "purchase.write");
    return Response.json(await loadPurchases(vendorId), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const { profile, vendorId, branchId: staffBranchId } = await requireVendorPermission(request, "purchase.write");
    const body = await request.json() as Record<string, unknown>;
    const workflow = body.workflow === "draft" ? "draft" : "immediate_receipt";
    const requestedBranchId = body.branchId === undefined ? null : asPositiveInteger(body.branchId, "Branch", 1000000000);
    if (staffBranchId !== null && requestedBranchId !== null && requestedBranchId !== staffBranchId) {
      return Response.json({ error: "Your staff access is limited to another pharmacy branch" }, { status: 403 });
    }
    const supplierId = asPositiveInteger(body.supplierId, "Supplier", 1000000000);
    const invoiceNumber = clean(body.invoiceNumber, 100).toUpperCase();
    const invoiceDate = isoDate(body.invoiceDate, "Invoice date")!;
    const today = new Date().toISOString().slice(0, 10);
    const rawItems = Array.isArray(body.items) ? body.items as Array<Record<string, unknown>> : [];
    if (!invoiceNumber) return Response.json({ error: "Invoice number is required" }, { status: 400 });
    if (invoiceDate > today) return Response.json({ error: "Invoice date cannot be in the future" }, { status: 400 });
    if (rawItems.length < 1 || rawItems.length > 30) return Response.json({ error: "A purchase must contain between 1 and 30 product rows" }, { status: 400 });
    const db = getD1();
    const branch = await db.prepare(`SELECT id FROM pharmacy_branches
      WHERE vendor_id = ? AND status = 'active' AND (id = ? OR (? IS NULL AND is_primary = 1)) LIMIT 1`)
      .bind(vendorId, staffBranchId ?? requestedBranchId, staffBranchId ?? requestedBranchId).first<{ id: number }>();
    if (!branch) return Response.json({ error: "Choose an active pharmacy branch belonging to this pharmacy" }, { status: 400 });
    const branchId = branch.id;
    const supplier = await db.prepare("SELECT id, business_name AS businessName FROM suppliers WHERE id = ? AND vendor_id = ? AND status = 'active' LIMIT 1").bind(supplierId, vendorId).first<{ id: number; businessName: string }>();
    if (!supplier) return Response.json({ error: "Choose an active supplier belonging to this pharmacy" }, { status: 400 });
    const duplicate = await db.prepare(`SELECT id FROM purchase_orders
      WHERE vendor_id = ? AND supplier_id = ? AND invoice_number = ? COLLATE NOCASE LIMIT 1`)
      .bind(vendorId, supplierId, invoiceNumber).first();
    if (duplicate) return Response.json({ error: "This supplier invoice is already recorded" }, { status: 409 });

    const items: PurchaseInput[] = [];
    const batchKeys = new Set<string>();
    for (let index = 0; index < rawItems.length; index += 1) {
      const row = rawItems[index];
      const rowLabel = `Row ${index + 1}`;
      const legacyId = asPositiveInteger(row.legacyId, `${rowLabel} product ID`, 1000000000);
      const product = await db.prepare("SELECT id, name FROM products WHERE legacy_id = ? AND active = 1 LIMIT 1").bind(legacyId).first<{ id: number; name: string }>();
      if (!product) return Response.json({ error: `${rowLabel}: recovered product ID was not found` }, { status: 404 });
      const batchNumber = clean(row.batchNumber, 80).toUpperCase();
      if (!batchNumber) return Response.json({ error: `${rowLabel}: batch number is required` }, { status: 400 });
      const batchKey = `${product.id}:${batchNumber}`;
      if (batchKeys.has(batchKey)) return Response.json({ error: `${rowLabel}: the same product and batch appears twice` }, { status: 400 });
      batchKeys.add(batchKey);
      const expiryDate = isoDate(row.expiryDate, `${rowLabel} expiry date`)!;
      const manufacturingDate = isoDate(row.manufacturingDate, `${rowLabel} manufacturing date`, false);
      if (manufacturingDate && manufacturingDate > expiryDate) return Response.json({ error: `${rowLabel}: expiry must be after manufacturing date` }, { status: 400 });
      if (expiryDate <= invoiceDate || expiryDate <= today) return Response.json({ error: `${rowLabel}: expired stock cannot be received` }, { status: 400 });
      if (manufacturingDate && manufacturingDate > invoiceDate) return Response.json({ error: `${rowLabel}: manufacturing date cannot be after the invoice date` }, { status: 400 });
      const existingBatch = await db.prepare(`SELECT expiry_date AS expiryDate, manufacturing_date AS manufacturingDate
        FROM pharmacy_inventory WHERE vendor_id = ? AND branch_id = ? AND product_id = ? AND batch_number = ? LIMIT 1`)
        .bind(vendorId, branchId, product.id, batchNumber)
        .first<{ expiryDate: string | null; manufacturingDate: string | null }>();
      if (existingBatch && hasConflictingPurchaseBatch(existingBatch, { expiryDate, manufacturingDate })) {
        return Response.json({ error: `${rowLabel}: this product and batch already exists with different manufacturing or expiry dates` }, { status: 409 });
      }
      const quantity = asPositiveInteger(row.quantity, `${rowLabel} quantity`, 1000000);
      const freeQuantity = Math.max(0, Math.min(Number(row.freeQuantity ?? 0) || 0, 1000000));
      if (!Number.isInteger(freeQuantity)) return Response.json({ error: `${rowLabel}: free quantity is invalid` }, { status: 400 });
      const purchasePricePaise = rupeesToPaise(row.purchasePrice, `${rowLabel} purchase price`);
      const salePricePaise = rupeesToPaise(row.salePrice, `${rowLabel} sale price`);
      const mrpPaise = rupeesToPaise(row.mrp ?? row.salePrice, `${rowLabel} MRP`);
      if (purchasePricePaise < 1 || salePricePaise < 1) return Response.json({ error: `${rowLabel}: purchase and sale prices must be more than zero` }, { status: 400 });
      if (salePricePaise > mrpPaise) return Response.json({ error: `${rowLabel}: sale price cannot exceed MRP` }, { status: 400 });
      const gstPercent = Number(row.gstPercent);
      if (!gstRates.has(gstPercent)) return Response.json({ error: `${rowLabel}: GST must be 0, 5, 12, 18 or 28 percent` }, { status: 400 });
      const ceiling = await db.prepare("SELECT ceiling_price_paise AS ceilingPaise FROM product_ceiling_prices WHERE product_id=? AND date(effective_from)<=date(?) AND (effective_until IS NULL OR date(effective_until)>date(?)) ORDER BY date(effective_from) DESC,id DESC LIMIT 1").bind(product.id, invoiceDate, invoiceDate).first<{ ceilingPaise:number }>();
      try { validatePricePolicy({ purchasePricePaise, salePricePaise, mrpPaise, gstPercent }, ceiling?.ceilingPaise ?? null, getRuntimeEnv().NPPA_CEILING_MODE === "enforce"); }
      catch (error) { return Response.json({ error: `${rowLabel}: ${error instanceof Error ? error.message : "Pricing policy rejected"}` }, { status: 409 }); }
      const amounts = calculatePurchaseLineAmounts(purchasePricePaise, quantity, gstPercent);
      items.push({ legacyId, productId: product.id, productName: product.name, batchNumber, expiryDate, manufacturingDate, dosage: clean(row.dosage, 80), quantity, freeQuantity, purchasePricePaise, salePricePaise, mrpPaise, gstPercent, ...amounts });
    }

    const subtotalPaise = items.reduce((sum, item) => sum + item.taxablePaise, 0);
    const taxPaise = items.reduce((sum, item) => sum + item.taxPaise, 0);
    const totalPaise = subtotalPaise + taxPaise;
    const purchaseNumber = `PO-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`;
    const statements: D1PreparedStatement[] = [
      db.prepare(`INSERT INTO purchase_orders (purchase_number, vendor_id, branch_id, supplier_id, invoice_number, invoice_date,
        subtotal_paise, tax_paise, total_paise, payment_status, status, created_by_profile_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unpaid', 'draft', ?)`)
        .bind(purchaseNumber, vendorId, branchId, supplierId, invoiceNumber, invoiceDate, subtotalPaise, taxPaise, totalPaise, profile.id),
    ];
    for (const item of items) {
      statements.push(db.prepare(`INSERT INTO purchase_order_items (purchase_order_id, product_id, inventory_id, batch_number,
          expiry_date, manufacturing_date, dosage, quantity, free_quantity, purchase_price_paise,
          sale_price_paise, mrp_paise, gst_percent, taxable_paise, tax_paise, line_total_paise)
          SELECT po.id, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          FROM purchase_orders po WHERE po.purchase_number = ?`)
        .bind(item.productId, item.batchNumber, item.expiryDate, item.manufacturingDate, item.dosage,
          item.quantity, item.freeQuantity, item.purchasePricePaise, item.salePricePaise, item.mrpPaise,
          item.gstPercent, item.taxablePaise, item.taxPaise, item.lineTotalPaise, purchaseNumber));
    }
    await db.batch(statements);
    const saved = await db.prepare("SELECT id FROM purchase_orders WHERE purchase_number = ? LIMIT 1").bind(purchaseNumber).first<{ id: number }>();
    if (!saved) throw new Error("Purchase order could not be loaded");
    await appendAuditEvent({ vendorId, actorProfileId: profile.id, action: "purchase.draft_created", entityType: "purchase_order", entityId: saved.id, after: { purchaseNumber, supplierId, invoiceNumber, invoiceDate, subtotalPaise, taxPaise, totalPaise, workflow, items: items.map(({ productId, productName, batchNumber, quantity, freeQuantity }) => ({ productId, productName, batchNumber, quantity, freeQuantity })) }, requestId: request.headers.get("cf-ray") ?? "" });
    if (workflow === "immediate_receipt") {
      await transitionPurchaseOrder({ db, vendorId, actorProfileId: profile.id, purchaseOrderId: saved.id, action: "approve", requestId: request.headers.get("cf-ray") ?? "" });
      const savedItems = await db.prepare(`SELECT id, quantity, free_quantity AS freeQuantity
        FROM purchase_order_items WHERE purchase_order_id = ? ORDER BY id`).bind(saved.id)
        .all<{ id: number; quantity: number; freeQuantity: number }>();
      await receivePurchaseOrder({
        db, vendorId, actorProfileId: profile.id, purchaseOrderId: saved.id, receivedOn: invoiceDate,
        notes: "Compatibility immediate receipt", requestId: request.headers.get("cf-ray") ?? "",
        items: savedItems.results.map((item) => ({ purchaseOrderItemId: item.id, quantity: item.quantity, freeQuantity: item.freeQuantity })),
      });
    }
    return Response.json({ saved: true, purchaseOrderId: saved.id, purchaseNumber, status: workflow === "draft" ? PURCHASE_STATUS.DRAFT : PURCHASE_STATUS.RECEIVED, ...(await loadPurchases(vendorId)) }, { status: 201 });
  } catch (error) {
    if (error instanceof PurchaseTransitionError) return Response.json({ error: error.message }, { status: error.status });
    if (isDuplicateSupplierInvoiceError(error)) {
      return Response.json({ error: "This supplier invoice is already recorded" }, { status: 409 });
    }
    return errorResponse(error);
  }
}
