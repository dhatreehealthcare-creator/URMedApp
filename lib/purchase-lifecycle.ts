import { appendAuditEvent } from "./audit.ts";
import { hasConflictingPurchaseBatch } from "./purchase-conflicts.ts";
import { PURCHASE_STATUS, nextPurchaseStatuses, type StoredPurchaseStatus } from "./purchase-status.ts";

export class PurchaseTransitionError extends Error {
  readonly status: number;

  constructor(message: string, status = 409) {
    super(message);
    this.name = "PurchaseTransitionError";
    this.status = status;
  }
}

type PurchaseTransitionInput = {
  db: D1Database;
  vendorId: number;
  actorProfileId: number;
  purchaseOrderId: number;
  action: "approve" | "cancel";
  reason?: string;
  requestId?: string;
};

type PurchaseReceiveLine = {
  purchaseOrderItemId: number;
  quantity: number;
  freeQuantity?: number;
};

type PurchaseReceiptInput = {
  db: D1Database;
  vendorId: number;
  actorProfileId: number;
  purchaseOrderId: number;
  receivedOn: string;
  notes?: string;
  items: PurchaseReceiveLine[];
  requestId?: string;
};

type PurchaseRow = {
  id: number;
  branchId: number | null;
  purchaseNumber: string;
  supplierId: number;
  supplierName: string;
  invoiceNumber: string;
  invoiceDate: string;
  status: StoredPurchaseStatus;
};

type PurchaseItemRow = {
  id: number;
  inventoryId: number | null;
  productId: number;
  productName: string;
  batchNumber: string;
  expiryDate: string;
  manufacturingDate: string | null;
  dosage: string;
  orderedQuantity: number;
  orderedFreeQuantity: number;
  receivedQuantity: number;
  receivedFreeQuantity: number;
  purchasePricePaise: number;
  salePricePaise: number;
  mrpPaise: number;
  gstPercent: number;
  existingBatchId: number | null;
  existingBatchExpiryDate: string | null;
  existingBatchManufacturingDate: string | null;
};

function isoDate(value: string, label: string) {
  const date = value.trim();
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new PurchaseTransitionError(`${label} is invalid`, 400);
  }
  return date;
}

async function purchaseForVendor(db: D1Database, vendorId: number, purchaseOrderId: number) {
  let purchase = await db.prepare(`
    SELECT purchase.id, purchase.branch_id AS branchId, purchase.purchase_number AS purchaseNumber,
      purchase.supplier_id AS supplierId, supplier.business_name AS supplierName,
      purchase.invoice_number AS invoiceNumber, purchase.invoice_date AS invoiceDate,
      purchase.status
    FROM purchase_orders purchase
    JOIN suppliers supplier ON supplier.id = purchase.supplier_id
    WHERE purchase.id = ? AND purchase.vendor_id = ? AND supplier.vendor_id = ?
    LIMIT 1
  `).bind(purchaseOrderId, vendorId, vendorId).first<PurchaseRow>().catch(() => null);
  // Lightweight lifecycle unit fixtures predating the branch migration remain
  // vendor-scoped; keep them valid while production D1 uses branch columns.
  if (!purchase) {
    purchase = await db.prepare(`
      SELECT purchase.id, purchase.purchase_number AS purchaseNumber,
        purchase.supplier_id AS supplierId, supplier.business_name AS supplierName,
        purchase.invoice_number AS invoiceNumber, purchase.invoice_date AS invoiceDate,
        purchase.status
      FROM purchase_orders purchase JOIN suppliers supplier ON supplier.id = purchase.supplier_id
      WHERE purchase.id = ? AND purchase.vendor_id = ? AND supplier.vendor_id = ? LIMIT 1
    `).bind(purchaseOrderId, vendorId, vendorId).first<PurchaseRow>();
  }
  if (!purchase) throw new PurchaseTransitionError("Purchase order not found", 404);
  return purchase;
}

export async function transitionPurchaseOrder(input: PurchaseTransitionInput) {
  const { db, vendorId, actorProfileId, purchaseOrderId, action, requestId = "" } = input;
  if (!Number.isInteger(purchaseOrderId) || purchaseOrderId < 1) throw new PurchaseTransitionError("Purchase order is invalid", 400);
  const purchase = await purchaseForVendor(db, vendorId, purchaseOrderId);
  const nextStatus = action === "approve" ? PURCHASE_STATUS.APPROVED : PURCHASE_STATUS.CANCELLED;
  if (purchase.status === nextStatus) return { updated: false as const, unchanged: true as const, status: nextStatus };
  if (!nextPurchaseStatuses(purchase.status).includes(nextStatus)) {
    throw new PurchaseTransitionError(`A ${purchase.status.replaceAll("_", " ")} purchase cannot be ${action === "approve" ? "approved" : "cancelled"}`);
  }
  const reason = (input.reason ?? "").trim().slice(0, 300);
  if (action === "cancel" && reason.length < 5) throw new PurchaseTransitionError("Enter a clear cancellation reason", 400);
  const result = action === "approve"
    ? await db.prepare(`UPDATE purchase_orders SET status = 'approved', approved_by_profile_id = ?,
        approved_at = CURRENT_TIMESTAMP WHERE id = ? AND vendor_id = ? AND status = 'draft'`)
      .bind(actorProfileId, purchaseOrderId, vendorId).run()
    : await db.prepare(`UPDATE purchase_orders SET status = 'cancelled', cancelled_by_profile_id = ?,
        cancelled_at = CURRENT_TIMESTAMP, cancellation_reason = ?
        WHERE id = ? AND vendor_id = ? AND status IN ('draft', 'approved')`)
      .bind(actorProfileId, reason, purchaseOrderId, vendorId).run();
  if (!result.meta.changes) throw new PurchaseTransitionError("Purchase order changed. Refresh before retrying");
  await appendAuditEvent({
    vendorId,
    actorProfileId,
    action: `purchase.${nextStatus}`,
    entityType: "purchase_order",
    entityId: purchaseOrderId,
    before: { status: purchase.status },
    after: { status: nextStatus, reason },
    requestId,
  }, db);
  return { updated: true as const, status: nextStatus };
}

export async function receivePurchaseOrder(input: PurchaseReceiptInput) {
  const { db, vendorId, actorProfileId, purchaseOrderId, requestId = "" } = input;
  if (!Number.isInteger(purchaseOrderId) || purchaseOrderId < 1) throw new PurchaseTransitionError("Purchase order is invalid", 400);
  const receivedOn = isoDate(input.receivedOn, "Receipt date");
  if (receivedOn > new Date().toISOString().slice(0, 10)) throw new PurchaseTransitionError("Receipt date cannot be in the future", 400);
  const purchase = await purchaseForVendor(db, vendorId, purchaseOrderId);
  let branchId = purchase.branchId ?? null;
  if (branchId === null) {
    branchId = await db.prepare("SELECT branch_id AS branchId FROM purchase_orders WHERE id = ? LIMIT 1").bind(purchaseOrderId).first<{ branchId: number }>().then((row) => row?.branchId ?? null).catch(() => null);
  }
  if (purchase.status !== PURCHASE_STATUS.APPROVED && purchase.status !== PURCHASE_STATUS.PARTIALLY_RECEIVED) {
    throw new PurchaseTransitionError("Only an approved or partially received purchase can receive stock");
  }
  if (receivedOn < purchase.invoiceDate) throw new PurchaseTransitionError("Receipt date cannot be before the supplier invoice date", 400);
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > 30) {
    throw new PurchaseTransitionError("Choose between 1 and 30 purchase lines to receive", 400);
  }
  const lines = new Map<number, { quantity: number; freeQuantity: number }>();
  for (const raw of input.items) {
    const purchaseOrderItemId = Number(raw.purchaseOrderItemId);
    const quantity = Number(raw.quantity);
    const freeQuantity = Number(raw.freeQuantity ?? 0);
    if (!Number.isInteger(purchaseOrderItemId) || purchaseOrderItemId < 1
      || !Number.isInteger(quantity) || quantity < 0
      || !Number.isInteger(freeQuantity) || freeQuantity < 0
      || quantity + freeQuantity < 1) {
      throw new PurchaseTransitionError("Receipt quantities are invalid", 400);
    }
    if (lines.has(purchaseOrderItemId)) throw new PurchaseTransitionError("A purchase line appears twice in the receipt", 400);
    lines.set(purchaseOrderItemId, { quantity, freeQuantity });
  }

  const placeholders = [...lines].map(() => "?").join(",");
  const itemResult = await db.prepare(`
    SELECT item.id, item.inventory_id AS inventoryId, item.product_id AS productId,
      product.name AS productName, item.batch_number AS batchNumber,
      item.expiry_date AS expiryDate, item.manufacturing_date AS manufacturingDate,
      item.dosage, item.quantity AS orderedQuantity,
      item.free_quantity AS orderedFreeQuantity,
      item.received_quantity AS receivedQuantity,
      item.received_free_quantity AS receivedFreeQuantity,
      item.purchase_price_paise AS purchasePricePaise,
      item.sale_price_paise AS salePricePaise, item.mrp_paise AS mrpPaise,
      item.gst_percent AS gstPercent,
      existing_inventory.id AS existingBatchId,
      existing_inventory.expiry_date AS existingBatchExpiryDate,
      existing_inventory.manufacturing_date AS existingBatchManufacturingDate
    FROM purchase_order_items item
    JOIN purchase_orders purchase ON purchase.id = item.purchase_order_id
    JOIN products product ON product.id = item.product_id
    LEFT JOIN pharmacy_inventory existing_inventory
      ON existing_inventory.vendor_id = purchase.vendor_id
      ${branchId === null ? "" : "AND existing_inventory.branch_id = purchase.branch_id"}
      AND existing_inventory.product_id = item.product_id
      AND existing_inventory.batch_number = item.batch_number
    WHERE item.purchase_order_id = ? AND purchase.vendor_id = ?
      AND item.id IN (${placeholders})
    ORDER BY item.id
  `).bind(purchaseOrderId, vendorId, ...lines.keys()).all<PurchaseItemRow>();
  if (itemResult.results.length !== lines.size) throw new PurchaseTransitionError("A selected purchase line was not found", 404);
  for (const item of itemResult.results) {
    const receipt = lines.get(item.id)!;
    if (item.receivedQuantity + receipt.quantity > item.orderedQuantity
      || item.receivedFreeQuantity + receipt.freeQuantity > item.orderedFreeQuantity) {
      throw new PurchaseTransitionError(`${item.productName}: receipt exceeds the remaining ordered quantity`);
    }
    if (item.expiryDate <= receivedOn) throw new PurchaseTransitionError(`${item.productName}: expired stock cannot be received`);
    if (item.existingBatchId && hasConflictingPurchaseBatch(
      { expiryDate: item.existingBatchExpiryDate, manufacturingDate: item.existingBatchManufacturingDate },
      { expiryDate: item.expiryDate, manufacturingDate: item.manufacturingDate },
    )) {
      throw new PurchaseTransitionError(`${item.productName}: this batch has conflicting manufacturing or expiry dates`);
    }
  }

  const receiptNumber = `GRN-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`;
  const notes = (input.notes ?? "").trim().slice(0, 300);
  const guardedConditions: string[] = [];
  const guardedBindings: Array<number> = [];
  for (const item of itemResult.results) {
    const receipt = lines.get(item.id)!;
    guardedConditions.push("(item.id = ? AND item.received_quantity + ? <= item.quantity AND item.received_free_quantity + ? <= item.free_quantity)");
    guardedBindings.push(item.id, receipt.quantity, receipt.freeQuantity);
  }
  const preflightResult = await db.prepare(`
    SELECT COUNT(*) AS selectedCount
    FROM purchase_order_items item JOIN purchase_orders purchase ON purchase.id = item.purchase_order_id
    WHERE item.purchase_order_id = ? AND purchase.vendor_id = ?
      AND purchase.status IN ('approved', 'partially_received')
      AND (${guardedConditions.join(" OR ")})
  `).bind(purchaseOrderId, vendorId, ...guardedBindings).first<{ selectedCount: number }>();
  if (!preflightResult || Number(preflightResult.selectedCount) !== lines.size) {
    throw new PurchaseTransitionError("Purchase quantities changed. Refresh before receiving again");
  }

  const statements: D1PreparedStatement[] = [
    db.prepare(`INSERT INTO purchase_receipts
      (receipt_number, vendor_id, purchase_order_id, received_on, notes, received_by_profile_id)
      VALUES (?, ?, ?, ?, ?, ?)`).bind(receiptNumber, vendorId, purchaseOrderId, receivedOn, notes, actorProfileId),
  ];
  // Keep exact batch result positions for item guards. The batch also contains
  // inventory, receipt-item, status and ledger statements, so pattern-based
  // result slicing can silently inspect the wrong result as the batch evolves.
  const guardedUpdateResultIndexes: number[] = [];
  for (const item of itemResult.results) {
    const receipt = lines.get(item.id)!;
    const totalQuantity = receipt.quantity + receipt.freeQuantity;
    const inventoryInsert = branchId === null
      ? `INSERT INTO pharmacy_inventory (vendor_id, product_id, batch_number, expiry_date, manufacturing_date,
        dosage, purchase_price_paise, sale_price_paise, mrp_paise, quantity, gst_percent, quarantine_status, active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'available', 1)
        ON CONFLICT(vendor_id, product_id, batch_number) DO UPDATE SET
          quantity = pharmacy_inventory.quantity + excluded.quantity,
          manufacturing_date = COALESCE(pharmacy_inventory.manufacturing_date, excluded.manufacturing_date),
          purchase_price_paise = excluded.purchase_price_paise, sale_price_paise = excluded.sale_price_paise,
          mrp_paise = excluded.mrp_paise, gst_percent = excluded.gst_percent, updated_at = CURRENT_TIMESTAMP
        WHERE COALESCE(pharmacy_inventory.expiry_date, '') = COALESCE(excluded.expiry_date, '')
          AND (pharmacy_inventory.manufacturing_date IS NULL OR excluded.manufacturing_date IS NULL OR pharmacy_inventory.manufacturing_date = excluded.manufacturing_date)`
      : `INSERT INTO pharmacy_inventory (vendor_id, branch_id, product_id, batch_number, expiry_date, manufacturing_date,
        dosage, purchase_price_paise, sale_price_paise, mrp_paise, quantity, gst_percent, quarantine_status, active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'available', 1)
        ON CONFLICT(branch_id, product_id, batch_number) DO UPDATE SET
          quantity = pharmacy_inventory.quantity + excluded.quantity,
          manufacturing_date = COALESCE(pharmacy_inventory.manufacturing_date, excluded.manufacturing_date),
          purchase_price_paise = excluded.purchase_price_paise,
          sale_price_paise = excluded.sale_price_paise, mrp_paise = excluded.mrp_paise,
          gst_percent = excluded.gst_percent, updated_at = CURRENT_TIMESTAMP
        WHERE COALESCE(pharmacy_inventory.expiry_date, '') = COALESCE(excluded.expiry_date, '')
          AND (pharmacy_inventory.manufacturing_date IS NULL OR excluded.manufacturing_date IS NULL
            OR pharmacy_inventory.manufacturing_date = excluded.manufacturing_date)`;
    const inventoryBindings = branchId === null
      ? [vendorId, item.productId, item.batchNumber, item.expiryDate, item.manufacturingDate,
        item.dosage, item.purchasePricePaise, item.salePricePaise, item.mrpPaise, totalQuantity, item.gstPercent]
      : [vendorId, branchId, item.productId, item.batchNumber, item.expiryDate, item.manufacturingDate,
        item.dosage, item.purchasePricePaise, item.salePricePaise, item.mrpPaise, totalQuantity, item.gstPercent];
    statements.push(db.prepare(inventoryInsert)
        .bind(...inventoryBindings));
    guardedUpdateResultIndexes.push(statements.length);
    const updateInventorySelect = branchId === null ? "SELECT id FROM pharmacy_inventory WHERE vendor_id = ? AND product_id = ? AND batch_number = ?" : "SELECT id FROM pharmacy_inventory WHERE vendor_id = ? AND branch_id = ? AND product_id = ? AND batch_number = ?";
    const updateInventoryGuard = branchId === null ? "inventory.vendor_id = ? AND inventory.product_id = ? AND inventory.batch_number = ?" : "inventory.vendor_id = ? AND inventory.branch_id = ? AND inventory.product_id = ? AND inventory.batch_number = ?";
    statements.push(db.prepare(`UPDATE purchase_order_items SET
        inventory_id = (${updateInventorySelect}),
        received_quantity = received_quantity + ?, received_free_quantity = received_free_quantity + ?
        WHERE id = ? AND purchase_order_id = ?
          AND EXISTS (SELECT 1 FROM pharmacy_inventory inventory
            WHERE ${updateInventoryGuard}
              AND COALESCE(inventory.expiry_date, '') = COALESCE(purchase_order_items.expiry_date, '')
              AND (inventory.manufacturing_date IS NULL OR purchase_order_items.manufacturing_date IS NULL
                OR inventory.manufacturing_date = purchase_order_items.manufacturing_date))`)
        .bind(...(branchId === null ? [vendorId, item.productId, item.batchNumber] : [vendorId, branchId, item.productId, item.batchNumber]), receipt.quantity, receipt.freeQuantity,
          item.id, purchaseOrderId, ...(branchId === null ? [vendorId, item.productId, item.batchNumber] : [vendorId, branchId, item.productId, item.batchNumber])));
    statements.push(
      db.prepare(`INSERT INTO purchase_receipt_items
        (purchase_receipt_id, purchase_order_item_id, inventory_id, quantity, free_quantity)
        SELECT receipt.id, item.id,
          CASE WHEN EXISTS (SELECT 1 FROM pharmacy_inventory inventory
            WHERE inventory.id = item.inventory_id
              AND inventory.vendor_id = ? AND inventory.product_id = item.product_id
              ${branchId === null ? "" : "AND inventory.branch_id = (SELECT branch_id FROM purchase_orders WHERE id = item.purchase_order_id)"}
              AND inventory.batch_number = item.batch_number
              AND COALESCE(inventory.expiry_date, '') = COALESCE(item.expiry_date, '')
              AND (inventory.manufacturing_date IS NULL OR item.manufacturing_date IS NULL
                OR inventory.manufacturing_date = item.manufacturing_date))
            THEN item.inventory_id ELSE NULL END,
          ?, ?
        FROM purchase_receipts receipt JOIN purchase_order_items item ON item.id = ?
        WHERE receipt.receipt_number = ? AND item.purchase_order_id = ?`)
        .bind(vendorId, receipt.quantity, receipt.freeQuantity, item.id, receiptNumber, purchaseOrderId),
      db.prepare(`INSERT INTO stock_ledger (vendor_id, inventory_id, movement_type, quantity_delta,
        balance_after, reference_type, reference_id, reason, actor_profile_id)
        SELECT ?, item.inventory_id, 'purchase_received', ?, inventory.quantity,
          'purchase_receipt', receipt.id, ?, ?
        FROM purchase_order_items item
        JOIN pharmacy_inventory inventory ON inventory.id = item.inventory_id
        JOIN purchase_receipts receipt ON receipt.receipt_number = ?
        WHERE item.id = ? AND item.purchase_order_id = ?`)
        .bind(vendorId, totalQuantity, `Goods receipt for ${purchase.purchaseNumber}`, actorProfileId,
          receiptNumber, item.id, purchaseOrderId),
    );
  }
  statements.push(
    db.prepare(`UPDATE purchase_orders SET status = CASE
        WHEN NOT EXISTS (SELECT 1 FROM purchase_order_items item
          WHERE item.purchase_order_id = purchase_orders.id
            AND (item.received_quantity < item.quantity OR item.received_free_quantity < item.free_quantity))
        THEN 'received' ELSE 'partially_received' END,
      posted_at = CASE WHEN NOT EXISTS (SELECT 1 FROM purchase_order_items item
          WHERE item.purchase_order_id = purchase_orders.id
            AND (item.received_quantity < item.quantity OR item.received_free_quantity < item.free_quantity))
        THEN CURRENT_TIMESTAMP ELSE posted_at END
      WHERE id = ? AND vendor_id = ? AND status IN ('approved', 'partially_received')`)
      .bind(purchaseOrderId, vendorId),
    db.prepare(`INSERT INTO ledger_entries (vendor_id, account_code, entry_date, description,
      debit_paise, credit_paise, reference_type, reference_id, created_by_profile_id)
      SELECT ?, 'PURCHASES', ?, 'Goods receipt ' || receipt.receipt_number || ' · ' || ?,
        COALESCE(SUM(item.purchase_price_paise * receipt_item.quantity
          + ROUND(item.purchase_price_paise * receipt_item.quantity * item.gst_percent / 100.0)), 0),
        0, 'purchase_receipt', receipt.id, ?
      FROM purchase_receipts receipt
      JOIN purchase_receipt_items receipt_item ON receipt_item.purchase_receipt_id = receipt.id
      JOIN purchase_order_items item ON item.id = receipt_item.purchase_order_item_id
      WHERE receipt.receipt_number = ? GROUP BY receipt.id`)
      .bind(vendorId, receivedOn, purchase.supplierName, actorProfileId, receiptNumber),
    db.prepare(`INSERT INTO ledger_entries (vendor_id, account_code, entry_date, description,
      debit_paise, credit_paise, reference_type, reference_id, created_by_profile_id)
      SELECT ?, 'ACCOUNTS_PAYABLE', ?, 'Payable for goods receipt ' || receipt.receipt_number || ' · ' || ?,
        0, COALESCE(SUM(item.purchase_price_paise * receipt_item.quantity
          + ROUND(item.purchase_price_paise * receipt_item.quantity * item.gst_percent / 100.0)), 0),
        'purchase_receipt', receipt.id, ?
      FROM purchase_receipts receipt
      JOIN purchase_receipt_items receipt_item ON receipt_item.purchase_receipt_id = receipt.id
      JOIN purchase_order_items item ON item.id = receipt_item.purchase_order_item_id
      WHERE receipt.receipt_number = ? GROUP BY receipt.id`)
      .bind(vendorId, receivedOn, purchase.supplierName, actorProfileId, receiptNumber),
  );
  let batchResults: D1Result<unknown>[];
  try {
    batchResults = await db.batch(statements);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/purchase receipt (quantity|scope)|purchase receipt item scope|purchase_receipt_items\.inventory_id/i.test(message)) {
      throw new PurchaseTransitionError("Purchase quantities changed. Refresh before receiving again");
    }
    throw error;
  }
  if (guardedUpdateResultIndexes.some((index) => Number(batchResults[index]?.meta.changes ?? 0) !== 1)) {
    throw new PurchaseTransitionError("A purchase line changed while the receipt was being saved");
  }
  const saved = await db.prepare(`SELECT receipt.id, purchase.status FROM purchase_receipts receipt
    JOIN purchase_orders purchase ON purchase.id = receipt.purchase_order_id
    WHERE receipt.receipt_number = ? AND receipt.vendor_id = ? LIMIT 1`)
    .bind(receiptNumber, vendorId).first<{ id: number; status: string }>();
  if (!saved) throw new Error("Goods receipt could not be loaded");
  await appendAuditEvent({
    vendorId,
    actorProfileId,
    action: "purchase.receipt.completed",
    entityType: "purchase_receipt",
    entityId: saved.id,
    before: { purchaseStatus: purchase.status },
    after: { purchaseOrderId, purchaseStatus: saved.status, receiptNumber, receivedOn, notes, items: [...lines].map(([purchaseOrderItemId, quantities]) => ({ purchaseOrderItemId, ...quantities })) },
    requestId,
  }, db);
  return { received: true as const, receiptNumber, status: saved.status };
}
