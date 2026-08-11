import { getD1 } from "../../../db/d1";
import { appendAuditEvent } from "../../../lib/audit";
import { errorResponse } from "../../../lib/auth-server";
import { asPositiveInteger, rupeesToPaise } from "../../../lib/money";
import { requireVendorPermission } from "../../../lib/vendor-access";

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
        po.total_paise AS totalPaise, po.payment_status AS paymentStatus, po.status,
        po.posted_at AS postedAt, s.business_name AS supplierName, COUNT(poi.id) AS lineCount
      FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
      LEFT JOIN purchase_order_items poi ON poi.purchase_order_id = po.id
      WHERE po.vendor_id = ? GROUP BY po.id, s.business_name ORDER BY po.invoice_date DESC, po.id DESC LIMIT 100
    `).bind(vendorId),
    db.prepare(`
      SELECT id, account_code AS accountCode, entry_date AS entryDate, description,
        debit_paise AS debitPaise, credit_paise AS creditPaise,
        reference_type AS referenceType, reference_id AS referenceId
      FROM ledger_entries WHERE vendor_id = ? AND reference_type = 'purchase_order'
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
    const { profile, vendorId } = await requireVendorPermission(request, "purchase.write");
    const body = await request.json() as Record<string, unknown>;
    const supplierId = asPositiveInteger(body.supplierId, "Supplier", 1000000000);
    const invoiceNumber = clean(body.invoiceNumber, 100);
    const invoiceDate = isoDate(body.invoiceDate, "Invoice date")!;
    const today = new Date().toISOString().slice(0, 10);
    const rawItems = Array.isArray(body.items) ? body.items as Array<Record<string, unknown>> : [];
    if (!invoiceNumber) return Response.json({ error: "Invoice number is required" }, { status: 400 });
    if (invoiceDate > today) return Response.json({ error: "Invoice date cannot be in the future" }, { status: 400 });
    if (rawItems.length < 1 || rawItems.length > 30) return Response.json({ error: "A purchase must contain between 1 and 30 product rows" }, { status: 400 });
    const db = getD1();
    const supplier = await db.prepare("SELECT id, business_name AS businessName FROM suppliers WHERE id = ? AND vendor_id = ? AND status = 'active' LIMIT 1").bind(supplierId, vendorId).first<{ id: number; businessName: string }>();
    if (!supplier) return Response.json({ error: "Choose an active supplier belonging to this pharmacy" }, { status: 400 });
    const duplicate = await db.prepare("SELECT id FROM purchase_orders WHERE vendor_id = ? AND supplier_id = ? AND invoice_number = ? LIMIT 1").bind(vendorId, supplierId, invoiceNumber).first();
    if (duplicate) return Response.json({ error: "This supplier invoice has already been posted" }, { status: 409 });

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
      const existingBatch=await db.prepare(`SELECT expiry_date AS expiryDate FROM pharmacy_inventory WHERE vendor_id=? AND product_id=? AND batch_number=? LIMIT 1`)
        .bind(vendorId,product.id,batchNumber).first<{expiryDate:string}>();
      if(existingBatch&&existingBatch.expiryDate!==expiryDate)return Response.json({error:`${rowLabel}: this batch already exists with a different expiry date`},{status:409});
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
      const taxablePaise = purchasePricePaise * quantity;
      const taxPaise = Math.round(taxablePaise * gstPercent / 100);
      items.push({ legacyId, productId: product.id, productName: product.name, batchNumber, expiryDate, manufacturingDate, dosage: clean(row.dosage, 80), quantity, freeQuantity, purchasePricePaise, salePricePaise, mrpPaise, gstPercent, taxablePaise, taxPaise, lineTotalPaise: taxablePaise + taxPaise });
    }

    const subtotalPaise = items.reduce((sum, item) => sum + item.taxablePaise, 0);
    const taxPaise = items.reduce((sum, item) => sum + item.taxPaise, 0);
    const totalPaise = subtotalPaise + taxPaise;
    const purchaseNumber = `PO-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`;
    const statements = [
      db.prepare(`INSERT INTO purchase_orders (purchase_number, vendor_id, supplier_id, invoice_number, invoice_date,
        subtotal_paise, tax_paise, total_paise, payment_status, status, created_by_profile_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unpaid', 'posting', ?)`)
        .bind(purchaseNumber, vendorId, supplierId, invoiceNumber, invoiceDate, subtotalPaise, taxPaise, totalPaise, profile.id),
    ];
    for (const item of items) {
      statements.push(
        db.prepare(`INSERT INTO pharmacy_inventory (vendor_id, product_id, batch_number, expiry_date, manufacturing_date,
          dosage, purchase_price_paise, sale_price_paise, mrp_paise, quantity, gst_percent, quarantine_status, active)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'available', 1)
          ON CONFLICT(vendor_id, product_id, batch_number) DO UPDATE SET
            expiry_date = excluded.expiry_date, manufacturing_date = excluded.manufacturing_date,
            dosage = excluded.dosage, purchase_price_paise = excluded.purchase_price_paise,
            sale_price_paise = excluded.sale_price_paise, mrp_paise = excluded.mrp_paise,
            quantity = pharmacy_inventory.quantity + excluded.quantity,
            gst_percent = excluded.gst_percent, updated_at = CURRENT_TIMESTAMP`)
          .bind(vendorId, item.productId, item.batchNumber, item.expiryDate, item.manufacturingDate, item.dosage, item.purchasePricePaise, item.salePricePaise, item.mrpPaise, item.quantity + item.freeQuantity, item.gstPercent),
        db.prepare(`INSERT INTO purchase_order_items (purchase_order_id, product_id, inventory_id, batch_number,
          expiry_date, manufacturing_date, dosage, quantity, free_quantity, purchase_price_paise,
          sale_price_paise, mrp_paise, gst_percent, taxable_paise, tax_paise, line_total_paise)
          SELECT po.id, ?, i.id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          FROM purchase_orders po JOIN pharmacy_inventory i
            ON i.vendor_id = po.vendor_id AND i.product_id = ? AND i.batch_number = ?
          WHERE po.purchase_number = ?`)
          .bind(item.productId, item.batchNumber, item.expiryDate, item.manufacturingDate, item.dosage, item.quantity, item.freeQuantity, item.purchasePricePaise, item.salePricePaise, item.mrpPaise, item.gstPercent, item.taxablePaise, item.taxPaise, item.lineTotalPaise, item.productId, item.batchNumber, purchaseNumber),
        db.prepare(`INSERT INTO stock_ledger (vendor_id, inventory_id, movement_type, quantity_delta, balance_after,
          reference_type, reference_id, reason, actor_profile_id)
          SELECT ?, i.id, 'purchase_received', ?, i.quantity, 'purchase_order', po.id, ?, ?
          FROM pharmacy_inventory i JOIN purchase_orders po ON po.purchase_number = ?
          WHERE i.vendor_id = ? AND i.product_id = ? AND i.batch_number = ?`)
          .bind(vendorId, item.quantity + item.freeQuantity, `Supplier invoice ${invoiceNumber}`, profile.id, purchaseNumber, vendorId, item.productId, item.batchNumber),
      );
    }
    statements.push(
      db.prepare(`INSERT INTO ledger_entries (vendor_id, account_code, entry_date, description, debit_paise, credit_paise,
        reference_type, reference_id, created_by_profile_id)
        SELECT ?, 'PURCHASES', ?, ?, ?, 0, 'purchase_order', id, ? FROM purchase_orders WHERE purchase_number = ?`)
        .bind(vendorId, invoiceDate, `Purchase from ${supplier.businessName} · ${invoiceNumber}`, totalPaise, profile.id, purchaseNumber),
      db.prepare(`INSERT INTO ledger_entries (vendor_id, account_code, entry_date, description, debit_paise, credit_paise,
        reference_type, reference_id, created_by_profile_id)
        SELECT ?, 'ACCOUNTS_PAYABLE', ?, ?, 0, ?, 'purchase_order', id, ? FROM purchase_orders WHERE purchase_number = ?`)
        .bind(vendorId, invoiceDate, `Payable to ${supplier.businessName} · ${invoiceNumber}`, totalPaise, profile.id, purchaseNumber),
      db.prepare("UPDATE purchase_orders SET status = 'received', posted_at = CURRENT_TIMESTAMP WHERE purchase_number = ?").bind(purchaseNumber),
    );
    await db.batch(statements);
    const saved = await db.prepare("SELECT id FROM purchase_orders WHERE purchase_number = ? LIMIT 1").bind(purchaseNumber).first<{ id: number }>();
    await appendAuditEvent({ vendorId, actorProfileId: profile.id, action: "purchase.received", entityType: "purchase_order", entityId: saved?.id ?? purchaseNumber, after: { purchaseNumber, supplierId, invoiceNumber, invoiceDate, subtotalPaise, taxPaise, totalPaise, items: items.map(({ productId, productName, batchNumber, quantity, freeQuantity }) => ({ productId, productName, batchNumber, quantity, freeQuantity })) }, requestId: request.headers.get("cf-ray") ?? "" });
    return Response.json({ saved: true, purchaseNumber, ...(await loadPurchases(vendorId)) }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
