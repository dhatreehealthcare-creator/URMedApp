import { getD1 } from "../../../../db/d1";
import { errorResponse } from "../../../../lib/auth-server";
import { nextPurchaseStatuses, type StoredPurchaseStatus } from "../../../../lib/purchase-status";
import { PurchaseTransitionError, receivePurchaseOrder, transitionPurchaseOrder } from "../../../../lib/purchase-lifecycle";
import { requireVendorPermission } from "../../../../lib/vendor-access";

type PurchaseDetailRow = {
  id: number;
  purchaseNumber: string;
  supplierId: number;
  supplierName: string;
  invoiceNumber: string;
  invoiceDate: string;
  subtotalPaise: number;
  taxPaise: number;
  totalPaise: number;
  paymentStatus: string;
  status: string;
  createdAt: string;
  approvedAt: string | null;
  postedAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string;
};

async function loadPurchase(db: D1Database, vendorId: number, purchaseOrderId: number) {
  const purchase = await db.prepare(`
    SELECT purchase.id, purchase.purchase_number AS purchaseNumber,
      purchase.supplier_id AS supplierId, supplier.business_name AS supplierName,
      purchase.invoice_number AS invoiceNumber, purchase.invoice_date AS invoiceDate,
      purchase.subtotal_paise AS subtotalPaise, purchase.tax_paise AS taxPaise,
      purchase.total_paise AS totalPaise, purchase.payment_status AS paymentStatus,
      CASE WHEN purchase.status = 'posted' THEN 'received'
        WHEN purchase.status = 'posting' THEN 'draft' ELSE purchase.status END AS status,
      purchase.created_at AS createdAt, purchase.approved_at AS approvedAt,
      purchase.posted_at AS postedAt, purchase.cancelled_at AS cancelledAt,
      purchase.cancellation_reason AS cancellationReason
    FROM purchase_orders purchase JOIN suppliers supplier ON supplier.id = purchase.supplier_id
    WHERE purchase.id = ? AND purchase.vendor_id = ? AND supplier.vendor_id = ? LIMIT 1
  `).bind(purchaseOrderId, vendorId, vendorId).first<PurchaseDetailRow>();
  if (!purchase) return null;
  const [items, receipts] = await Promise.all([
    db.prepare(`
      SELECT item.id, item.product_id AS productId, product.name AS productName,
        item.inventory_id AS inventoryId, item.batch_number AS batchNumber,
        item.expiry_date AS expiryDate, item.manufacturing_date AS manufacturingDate,
        item.dosage, item.quantity, item.free_quantity AS freeQuantity,
        item.received_quantity AS receivedQuantity,
        item.received_free_quantity AS receivedFreeQuantity,
        item.purchase_price_paise AS purchasePricePaise,
        item.sale_price_paise AS salePricePaise, item.mrp_paise AS mrpPaise,
        item.gst_percent AS gstPercent, item.taxable_paise AS taxablePaise,
        item.tax_paise AS taxPaise, item.line_total_paise AS lineTotalPaise
      FROM purchase_order_items item JOIN products product ON product.id = item.product_id
      WHERE item.purchase_order_id = ? ORDER BY item.id
    `).bind(purchaseOrderId).all(),
    db.prepare(`
      SELECT receipt.id, receipt.receipt_number AS receiptNumber,
        receipt.received_on AS receivedOn, receipt.notes, receipt.created_at AS createdAt,
        actor.name AS receivedBy,
        COALESCE(SUM(item.quantity + item.free_quantity), 0) AS unitCount
      FROM purchase_receipts receipt
      JOIN account_profiles actor ON actor.id = receipt.received_by_profile_id
      LEFT JOIN purchase_receipt_items item ON item.purchase_receipt_id = receipt.id
      WHERE receipt.purchase_order_id = ? AND receipt.vendor_id = ?
      GROUP BY receipt.id ORDER BY receipt.id DESC
    `).bind(purchaseOrderId, vendorId).all(),
  ]);
  return { ...purchase, items: items.results, receipts: receipts.results, nextStatuses: nextPurchaseStatuses(purchase.status as StoredPurchaseStatus) };
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { vendorId } = await requireVendorPermission(request, "purchase.write");
    const purchaseOrderId = Number((await context.params).id);
    if (!Number.isInteger(purchaseOrderId) || purchaseOrderId < 1) return Response.json({ error: "Purchase order is invalid" }, { status: 400 });
    const purchase = await loadPurchase(getD1(), vendorId, purchaseOrderId);
    if (!purchase) return Response.json({ error: "Purchase order not found" }, { status: 404 });
    return Response.json({ purchase }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { profile, vendorId } = await requireVendorPermission(request, "purchase.write");
    const purchaseOrderId = Number((await context.params).id);
    const body = await request.json() as Record<string, unknown>;
    const action = String(body.action ?? "");
    const db = getD1();
    if (action === "approve" || action === "cancel") {
      await transitionPurchaseOrder({
        db,
        vendorId,
        actorProfileId: profile.id,
        purchaseOrderId,
        action,
        reason: String(body.reason ?? ""),
        requestId: request.headers.get("cf-ray") ?? "",
      });
    } else if (action === "receive") {
      await receivePurchaseOrder({
        db,
        vendorId,
        actorProfileId: profile.id,
        purchaseOrderId,
        receivedOn: String(body.receivedOn ?? ""),
        notes: String(body.notes ?? ""),
        items: Array.isArray(body.items) ? body.items.map((item) => {
          const value = item as Record<string, unknown>;
          return {
            purchaseOrderItemId: Number(value.purchaseOrderItemId),
            quantity: Number(value.quantity),
            freeQuantity: Number(value.freeQuantity ?? 0),
          };
        }) : [],
        requestId: request.headers.get("cf-ray") ?? "",
      });
    } else {
      return Response.json({ error: "Purchase lifecycle action is invalid" }, { status: 400 });
    }
    const purchase = await loadPurchase(db, vendorId, purchaseOrderId);
    return Response.json({ updated: true, purchase });
  } catch (error) {
    if (error instanceof PurchaseTransitionError) return Response.json({ error: error.message }, { status: error.status });
    return errorResponse(error);
  }
}
