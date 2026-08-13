import { appendAuditEvent } from "./audit.ts";

export type SalesReturnSource = "online" | "offline";
export type SalesReturnCondition = "sealed" | "damaged" | "expired";

export class SalesReturnError extends Error {
  readonly status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.name = "SalesReturnError";
    this.status = status;
  }
}

type SourceLine = {
  sourceItemId: number;
  inventoryId: number;
  quantity: number;
  unitPricePaise: number;
  grossPaise: number;
  discountPaise: number;
  taxablePaise: number;
  taxPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
};

function number(value: unknown, label: string, minimum = 0) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new SalesReturnError(`${label} is invalid`, 400);
  return parsed;
}

function text(value: unknown, label: string, minimum = 1, maximum = 300) {
  const result = String(value ?? "").trim();
  if (result.length < minimum || result.length > maximum) throw new SalesReturnError(`${label} is invalid`, 400);
  return result;
}

export async function completeSalesReturn(input: {
  db: D1Database;
  vendorId: number;
  actorProfileId: number;
  sourceType: SalesReturnSource;
  sourceId: number;
  inventoryId: number;
  quantity: number;
  condition: SalesReturnCondition;
  reason: string;
  idempotencyKey: string;
  refundMethod?: "credit" | "cash" | "upi" | "card" | "razorpay";
  refundReference?: string;
  requestId?: string;
}) {
  const sourceId = number(input.sourceId, "Source sale");
  const inventoryId = number(input.inventoryId, "Inventory batch");
  const quantity = number(input.quantity, "Return quantity", 1);
  const reason = text(input.reason, "Return reason", 5);
  const idempotencyKey = text(input.idempotencyKey, "Idempotency key", 8, 160);
  const refundMethod = input.refundMethod ?? "credit";
  if (!["credit", "cash", "upi", "card", "razorpay"].includes(refundMethod)) throw new SalesReturnError("Refund method is invalid", 400);
  if (refundMethod === "razorpay") throw new SalesReturnError("Use the provider refund workflow for Razorpay refunds", 409);
  const refundReference = String(input.refundReference ?? "").trim().slice(0, 160);
  if (refundMethod !== "credit" && refundReference.length < 3) throw new SalesReturnError("A refund reference is required", 400);

  const existing = await input.db.prepare(`SELECT id,return_number AS returnNumber,credit_note_number AS creditNoteNumber,
      refund_paise AS refundPaise,status,refund_status AS refundStatus
    FROM sales_returns WHERE vendor_id=? AND idempotency_key=? LIMIT 1`).bind(input.vendorId, idempotencyKey)
    .first<{ id: number; returnNumber: string; creditNoteNumber: string; refundPaise: number; status: string; refundStatus: string }>();
  if (existing) return { ...existing, duplicate: true };

  const sourceOwnership = input.sourceType === "online"
    ? await input.db.prepare("SELECT vendor_id AS vendorId FROM orders WHERE id=? LIMIT 1").bind(sourceId).first<{ vendorId: number }>()
    : await input.db.prepare("SELECT vendor_id AS vendorId FROM offline_sales WHERE id=? LIMIT 1").bind(sourceId).first<{ vendorId: number }>();
  if (sourceOwnership && Number(sourceOwnership.vendorId) !== input.vendorId) throw new SalesReturnError("Sale not found", 404);
  const source = input.sourceType === "online"
    ? await input.db.prepare(`SELECT o.id,o.order_number AS sourceNumber
        FROM orders o WHERE o.id=? AND o.vendor_id=? AND o.order_status='completed'
          AND o.delivery_status='delivered' AND o.payment_status='paid' AND o.inventory_status='committed' LIMIT 1`)
      .bind(sourceId, input.vendorId).first<{ id: number; sourceNumber: string }>()
    : await input.db.prepare(`SELECT s.id,s.sale_number AS sourceNumber
        FROM offline_sales s JOIN offline_sale_events e ON e.offline_sale_id=s.id AND e.event_type='completed'
        JOIN tax_invoices invoice ON invoice.source_type='offline_sale' AND invoice.source_id=s.id
        WHERE s.id=? AND s.vendor_id=? LIMIT 1`)
      .bind(sourceId, input.vendorId).first<{ id: number; sourceNumber: string }>();
  if (!source) throw new SalesReturnError("Only a finalized paid sale can be returned", 409);

  const line = input.sourceType === "online"
    ? await input.db.prepare(`SELECT id AS sourceItemId,inventory_id AS inventoryId,quantity,unit_price_paise AS unitPricePaise,
        unit_price_paise*quantity AS grossPaise,discount_paise AS discountPaise,taxable_paise AS taxablePaise,
        (cgst_paise+sgst_paise+igst_paise) AS taxPaise,cgst_paise AS cgstPaise,sgst_paise AS sgstPaise,igst_paise AS igstPaise
      FROM order_items WHERE order_id=? AND inventory_id=? LIMIT 1`).bind(sourceId, inventoryId).first<SourceLine>()
    : await input.db.prepare(`SELECT id AS sourceItemId,inventory_id AS inventoryId,quantity,unit_price_paise AS unitPricePaise,
        unit_price_paise*quantity AS grossPaise,discount_paise AS discountPaise,taxable_paise AS taxablePaise,
        (cgst_paise+sgst_paise+igst_paise) AS taxPaise,cgst_paise AS cgstPaise,sgst_paise AS sgstPaise,igst_paise AS igstPaise
      FROM offline_sale_items WHERE offline_sale_id=? AND inventory_id=? LIMIT 1`).bind(sourceId, inventoryId).first<SourceLine>();
  if (!line) throw new SalesReturnError("The sold batch was not found", 404);
  const returned = await input.db.prepare(`SELECT COALESCE(SUM(item.quantity),0) AS quantity
    FROM sales_return_items item JOIN sales_returns record ON record.id=item.sales_return_id
    WHERE record.vendor_id=? AND record.source_type=? AND record.source_id=? AND item.inventory_id=? AND record.status<>'cancelled'`)
    .bind(input.vendorId, input.sourceType, sourceId, inventoryId).first<{ quantity: number }>();
  if (quantity > line.quantity - Number(returned?.quantity ?? 0)) throw new SalesReturnError("Return quantity exceeds the remaining sold quantity", 409);

  const factor = quantity / line.quantity;
  const amount = Math.round(line.grossPaise * factor);
  const discount = Math.round(line.discountPaise * factor);
  const taxable = Math.round(line.taxablePaise * factor);
  const tax = Math.round(line.taxPaise * factor);
  const cgst = Math.round(line.cgstPaise * factor);
  const sgst = Math.round(line.sgstPaise * factor);
  const igst = Math.round(line.igstPaise * factor);
  const nonce = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const returnNumber = `RET-${source.sourceNumber}-${nonce}`.slice(0, 120);
  const creditNoteNumber = `CN-${source.sourceNumber}-${nonce}`.slice(0, 120);
  const saleable = input.condition === "sealed";
  try {
    await input.db.batch([
      input.db.prepare(`INSERT INTO sales_returns (return_number,vendor_id,source_type,source_id,reason,credit_note_number,
        refund_paise,discount_paise,tax_paise,delivery_fee_paise,refund_method,refund_status,refund_reference,idempotency_key,status,created_by_profile_id)
        SELECT ?,?,?,?,?,?,?,?,?,0,?,?,?,?,'completed',? WHERE NOT EXISTS
          (SELECT 1 FROM sales_returns WHERE vendor_id=? AND idempotency_key=?)`)
        .bind(returnNumber,input.vendorId,input.sourceType,sourceId,reason,creditNoteNumber,amount,discount,tax,refundMethod,"recorded",refundReference,idempotencyKey,input.actorProfileId,input.vendorId,idempotencyKey),
      input.db.prepare(`INSERT INTO sales_return_items (sales_return_id,inventory_id,quantity,condition,disposition,amount_paise,
        source_item_id,gross_paise,discount_paise,taxable_paise,tax_paise,cgst_paise,sgst_paise,igst_paise)
        SELECT id,?,?,?,?,?,?,?,?,?,?,?,?,? FROM sales_returns WHERE return_number=?`)
        .bind(inventoryId,quantity,input.condition,saleable?"restocked":"quarantined",amount,line.sourceItemId,line.grossPaise,discount,taxable,tax,cgst,sgst,igst,returnNumber),
      input.db.prepare(`UPDATE pharmacy_inventory SET quantity=quantity+?,updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND vendor_id=? AND active=1 AND (quantity-reserved_quantity)>=0`)
        .bind(saleable ? quantity : 0,inventoryId,input.vendorId),
      input.db.prepare(`INSERT INTO return_quarantine_holds (vendor_id,sales_return_item_id,inventory_id,quantity,condition,reason,created_by_profile_id)
        SELECT r.vendor_id,i.id,?, ?,?, ?,? FROM sales_return_items i JOIN sales_returns r ON r.id=i.sales_return_id
        WHERE r.return_number=? AND ?`)
        .bind(inventoryId,quantity,input.condition,reason,input.actorProfileId,returnNumber,saleable ? 0 : 1),
      input.db.prepare(`INSERT INTO stock_ledger (vendor_id,inventory_id,movement_type,quantity_delta,balance_after,reference_type,reference_id,reason,actor_profile_id)
        SELECT inventory.vendor_id, inventory.id, CASE WHEN ? THEN 'sale_return_restock' ELSE 'sale_return_quarantine' END,
          CASE WHEN ? THEN item.quantity ELSE 0 END, inventory.quantity,'sales_return',record.id,?,?
        FROM pharmacy_inventory inventory JOIN sales_returns record ON record.return_number=?
        JOIN sales_return_items item ON item.sales_return_id=record.id AND item.inventory_id=inventory.id
        WHERE inventory.id=?`)
        .bind(saleable ? 1 : 0,saleable ? 1 : 0,reason,input.actorProfileId,returnNumber,inventoryId),
      input.db.prepare(`INSERT INTO ledger_entries (vendor_id,account_code,entry_date,description,debit_paise,credit_paise,reference_type,reference_id,created_by_profile_id)
        SELECT vendor_id,'SALES_RETURNS',date('now'),'Credit note '||credit_note_number,refund_paise,0,'sales_return',id,? FROM sales_returns WHERE return_number=?`)
        .bind(input.actorProfileId,returnNumber),
      input.db.prepare(`INSERT INTO ledger_entries (vendor_id,account_code,entry_date,description,debit_paise,credit_paise,reference_type,reference_id,created_by_profile_id)
        SELECT vendor_id,'CUSTOMER_REFUNDS',date('now'),'Refund '||credit_note_number,0,refund_paise,'sales_return',id,? FROM sales_returns WHERE return_number=?`)
        .bind(input.actorProfileId,returnNumber),
    ]);
  } catch (error) {
    if (/sales_return_quantity_invalid|UNIQUE constraint failed: sales_returns.vendor_id, sales_returns.idempotency_key/i.test(String(error))) {
      const raced = await input.db.prepare(`SELECT id,return_number AS returnNumber,credit_note_number AS creditNoteNumber,refund_paise AS refundPaise,status,refund_status AS refundStatus FROM sales_returns WHERE vendor_id=? AND idempotency_key=?`).bind(input.vendorId,idempotencyKey).first();
      if (raced) return { ...(raced as Record<string, unknown>), duplicate: true };
      throw new SalesReturnError("Return changed while it was being processed", 409);
    }
    throw error;
  }
  const saved = await input.db.prepare(`SELECT id,return_number AS returnNumber,credit_note_number AS creditNoteNumber,refund_paise AS refundPaise,status,refund_status AS refundStatus FROM sales_returns WHERE vendor_id=? AND idempotency_key=?`).bind(input.vendorId,idempotencyKey).first<{id:number;returnNumber:string;creditNoteNumber:string;refundPaise:number;status:string;refundStatus:string}>();
  if (!saved) throw new SalesReturnError("Credit note could not be recorded", 500);
  await appendAuditEvent({ vendorId: input.vendorId, actorProfileId: input.actorProfileId, action: "sales_return.completed", entityType: "sales_return", entityId: saved.id, after: { sourceType: input.sourceType, sourceId, inventoryId, quantity, amountPaise: amount, taxPaise: tax, disposition: saleable ? "restocked" : "quarantined" }, requestId: input.requestId ?? "" }, input.db);
  return { ...saved, duplicate: false, disposition: saleable ? "restocked" : "quarantined", amountPaise: amount, taxPaise: tax };
}
