import { appendAuditEvent } from "./audit.ts";
import { validateSupplierReturn } from "./operations-controls.ts";
import { RETURNABLE_PURCHASE_STATUSES } from "./purchase-status.ts";

export type ReturnablePurchase = {
  purchaseOrderItemId: number;
  purchaseOrderId: number;
  inventoryId: number;
  productId: number;
  productName: string;
  batchNumber: string;
  purchasedQuantity: number;
  purchasePricePaise: number;
  purchaseNumber: string;
  supplierId: number;
  supplierName: string;
  currentQuantity: number;
  returnedQuantity: number;
};

type SupplierReturnInput = {
  db: D1Database;
  vendorId: number;
  actorProfileId: number;
  purchaseOrderItemId: number;
  quantity: number;
  reason: string;
  requestId?: string;
};

type SupplierReturnItem = {
  id: number;
  purchaseOrderId: number;
  inventoryId: number;
  purchasePricePaise: number;
  purchasedQuantity: number;
  supplierId: number;
  currentQuantity: number;
  returnedQuantity: number;
};

export class PurchaseLifecycleError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "PurchaseLifecycleError";
    this.status = status;
  }
}

export async function listReturnablePurchases(db: D1Database, vendorId: number): Promise<ReturnablePurchase[]> {
  const result = await db.prepare(`SELECT item.id AS purchaseOrderItemId,item.purchase_order_id AS purchaseOrderId,
    item.inventory_id AS inventoryId,item.product_id AS productId,p.name AS productName,
    item.batch_number AS batchNumber,item.quantity + item.free_quantity AS purchasedQuantity,
    item.purchase_price_paise AS purchasePricePaise,po.purchase_number AS purchaseNumber,
    po.supplier_id AS supplierId,s.business_name AS supplierName,i.quantity AS currentQuantity,
    COALESCE((SELECT SUM(ri.quantity) FROM supplier_return_items ri JOIN supplier_returns r ON r.id=ri.supplier_return_id
      WHERE ri.purchase_order_item_id=item.id AND r.status<>'cancelled'),0) AS returnedQuantity
    FROM purchase_order_items item JOIN purchase_orders po ON po.id=item.purchase_order_id
    JOIN suppliers s ON s.id=po.supplier_id JOIN products p ON p.id=item.product_id
    JOIN pharmacy_inventory i ON i.id=item.inventory_id
    WHERE po.vendor_id=? AND po.status IN (?,?) AND i.quantity>0
    ORDER BY po.invoice_date DESC,item.id DESC LIMIT 250`)
    .bind(vendorId, ...RETURNABLE_PURCHASE_STATUSES).all<ReturnablePurchase>();
  return result.results;
}

export async function completeSupplierReturn(input: SupplierReturnInput) {
  const { db, vendorId, actorProfileId, purchaseOrderItemId, quantity, requestId = "" } = input;
  const reason = input.reason.trim().slice(0, 300);
  if (!Number.isInteger(purchaseOrderItemId) || !Number.isInteger(quantity) || quantity < 1 || reason.length < 5) {
    throw new PurchaseLifecycleError("Purchase item, quantity and a clear return reason are required", 400);
  }

  const item = await db.prepare(`SELECT item.id,item.purchase_order_id AS purchaseOrderId,item.inventory_id AS inventoryId,
    item.purchase_price_paise AS purchasePricePaise,item.quantity+item.free_quantity AS purchasedQuantity,
    po.supplier_id AS supplierId,i.quantity AS currentQuantity,
    COALESCE((SELECT SUM(ri.quantity) FROM supplier_return_items ri JOIN supplier_returns r ON r.id=ri.supplier_return_id
      WHERE ri.purchase_order_item_id=item.id AND r.status<>'cancelled'),0) AS returnedQuantity
    FROM purchase_order_items item JOIN purchase_orders po ON po.id=item.purchase_order_id
    JOIN pharmacy_inventory i ON i.id=item.inventory_id
    WHERE item.id=? AND po.vendor_id=? AND po.status IN (?,?)`)
    .bind(purchaseOrderItemId, vendorId, ...RETURNABLE_PURCHASE_STATUSES).first<SupplierReturnItem>();
  if (!item) throw new PurchaseLifecycleError("Received purchase item not found", 404);

  try {
    validateSupplierReturn({
      quantity,
      currentQuantity: item.currentQuantity,
      purchasedQuantity: item.purchasedQuantity,
      returnedQuantity: item.returnedQuantity,
    });
  } catch (error) {
    throw new PurchaseLifecycleError(error instanceof Error ? error.message : "Return quantity is invalid", 409);
  }

  const nonce = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const returnNumber = `SRET-${nonce}`;
  const debitNoteNumber = `DN-${nonce}`;
  const totalPaise = quantity * item.purchasePricePaise;
  try {
    const results = await db.batch([
      db.prepare(`INSERT INTO supplier_returns (return_number,vendor_id,supplier_id,purchase_order_id,debit_note_number,reason,total_paise,status,created_by_profile_id) VALUES (?,?,?,?,?,?,?,'completed',?)`).bind(returnNumber,vendorId,item.supplierId,item.purchaseOrderId,debitNoteNumber,reason,totalPaise,actorProfileId),
      db.prepare(`INSERT INTO supplier_return_items (supplier_return_id,purchase_order_item_id,inventory_id,quantity,amount_paise,disposition)
        SELECT id,?,?,?,?,'returned_to_supplier' FROM supplier_returns WHERE return_number=?`).bind(purchaseOrderItemId,item.inventoryId,quantity,totalPaise,returnNumber),
      db.prepare(`UPDATE pharmacy_inventory SET quantity=quantity-?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND vendor_id=? AND quantity>=?`).bind(quantity,item.inventoryId,vendorId,quantity),
      db.prepare(`INSERT INTO stock_ledger (vendor_id,inventory_id,movement_type,quantity_delta,balance_after,reference_type,reference_id,reason,actor_profile_id)
        SELECT ?,?,'supplier_return',-?,i.quantity,'supplier_return',r.id,?,? FROM pharmacy_inventory i JOIN supplier_returns r ON r.return_number=? WHERE i.id=?`).bind(vendorId,item.inventoryId,quantity,reason,actorProfileId,returnNumber,item.inventoryId),
      db.prepare(`INSERT INTO ledger_entries (vendor_id,account_code,entry_date,description,debit_paise,credit_paise,reference_type,reference_id,created_by_profile_id)
        SELECT vendor_id,'SUPPLIER_PAYABLE',date('now'),'Debit note '||debit_note_number,total_paise,0,'supplier_return',id,? FROM supplier_returns WHERE return_number=?`).bind(actorProfileId,returnNumber),
      db.prepare(`INSERT INTO ledger_entries (vendor_id,account_code,entry_date,description,debit_paise,credit_paise,reference_type,reference_id,created_by_profile_id)
        SELECT vendor_id,'PURCHASE_RETURNS',date('now'),'Purchase return '||return_number,0,total_paise,'supplier_return',id,? FROM supplier_returns WHERE return_number=?`).bind(actorProfileId,returnNumber),
    ]);
    if (!results[2]?.meta.changes) {
      throw new PurchaseLifecycleError("Stock changed during return processing. Refresh and retry", 409);
    }
  } catch (error) {
    if (error instanceof PurchaseLifecycleError) throw error;
    if (/supplier_return_quantity_invalid/i.test(error instanceof Error ? error.message : "")) {
      throw new PurchaseLifecycleError("Stock or returnable quantity changed. Refresh and retry", 409);
    }
    throw error;
  }

  const saved = await db.prepare(`SELECT id FROM supplier_returns WHERE return_number=?`).bind(returnNumber).first<{id:number}>();
  if (!saved) throw new Error("Completed supplier return could not be loaded");
  await appendAuditEvent({
    vendorId,
    actorProfileId,
    action: "supplier_return.completed",
    entityType: "supplier_return",
    entityId: saved.id,
    after: { returnNumber, debitNoteNumber, purchaseOrderItemId, quantity, totalPaise, reason },
    requestId,
  }, db);
  return { created: true as const, returnNumber, debitNoteNumber, totalPaise };
}
