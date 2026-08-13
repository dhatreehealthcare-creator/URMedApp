import { prepareAuditEventStatement } from "./audit.ts";

export const COD_TENDER_MODES = ["cash", "upi", "card", "bank_transfer"] as const;
export type CodTenderMode = typeof COD_TENDER_MODES[number];

export class CodCollectionError extends Error {
  readonly status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.name = "CodCollectionError";
    this.status = status;
  }
}

function text(value: unknown, min: number, max: number, label: string) {
  const normalized = String(value ?? "").trim();
  if (normalized.length < min || normalized.length > max) throw new CodCollectionError(`${label} is invalid`, 400);
  return normalized;
}

function amount(value: unknown) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new CodCollectionError("Collection amount is invalid", 400);
  return parsed;
}

function tender(value: unknown): CodTenderMode {
  const normalized = String(value ?? "").trim();
  if (!COD_TENDER_MODES.includes(normalized as CodTenderMode)) throw new CodCollectionError("Tender mode is invalid", 400);
  return normalized as CodTenderMode;
}

export async function collectCodPayment(input: {
  db: D1Database;
  orderId: number;
  actorProfileId: number;
  amountPaise: unknown;
  tenderMode: unknown;
  receiptReference: unknown;
  idempotencyKey: unknown;
  notes?: unknown;
  requestId?: string;
}) {
  const amountPaise = amount(input.amountPaise);
  const tenderMode = tender(input.tenderMode);
  const receiptReference = text(input.receiptReference, 3, 120, "Receipt reference");
  const idempotencyKey = text(input.idempotencyKey, 8, 160, "Idempotency key");
  const notes = String(input.notes ?? "").trim().slice(0, 300);
  const order = await input.db.prepare(`SELECT id,order_number AS orderNumber,vendor_id AS vendorId,
    total_paise AS totalPaise,payment_method AS paymentMethod,payment_status AS paymentStatus,
    order_status AS orderStatus,delivery_status AS deliveryStatus FROM orders WHERE id=? LIMIT 1`)
    .bind(input.orderId).first<{ id: number; orderNumber: string; vendorId: number; totalPaise: number; paymentMethod: string; paymentStatus: string; orderStatus: string; deliveryStatus: string }>();
  if (!order) throw new CodCollectionError("Order not found", 404);
  if (order.paymentMethod !== "cod") throw new CodCollectionError("Only COD orders accept collection evidence", 409);
  if (!["ready_for_pickup", "picked_up", "out_for_delivery"].includes(order.deliveryStatus)) {
    throw new CodCollectionError("COD can be collected only at the fulfilment handoff", 409);
  }
  if (order.orderStatus === "cancelled" || order.deliveryStatus === "cancelled") throw new CodCollectionError("Cancelled orders cannot be collected", 409);
  if (amountPaise !== order.totalPaise) throw new CodCollectionError("Collection amount must equal the order total", 409);
  const existing = await input.db.prepare(`SELECT id,amount_paise AS amountPaise,tender_mode AS tenderMode,
    receipt_reference AS receiptReference,idempotency_key AS idempotencyKey,collection_status AS collectionStatus,
    custody_status AS custodyStatus FROM cod_collection_evidence WHERE order_id=? LIMIT 1`).bind(input.orderId)
    .first<{ id: number; amountPaise: number; tenderMode: string; receiptReference: string; idempotencyKey: string; collectionStatus: string; custodyStatus: string }>();
  if (existing) {
    if (existing.idempotencyKey === idempotencyKey && existing.amountPaise === amountPaise
      && existing.tenderMode === tenderMode && existing.receiptReference === receiptReference) return { ...existing, duplicate: true };
    throw new CodCollectionError("COD collection has already been recorded for this order", 409);
  }
  if (order.paymentStatus === "paid") throw new CodCollectionError("COD payment is marked paid without collection evidence and requires reconciliation", 409);
  const accountCode = tenderMode === "cash" ? "CASH_ON_HAND" : "BANK_CLEARING";
  const audit = await prepareAuditEventStatement({
    vendorId: order.vendorId, actorProfileId: input.actorProfileId, action: "cod.collection.recorded",
    entityType: "cod_collection", entityId: input.orderId,
    after: { amountPaise, tenderMode, receiptReference, idempotencyKey, custodyStatus: "on_hand" }, requestId: input.requestId ?? "",
  }, input.db);
  let results: D1Result<unknown>[];
  try {
    results = await input.db.batch([
      input.db.prepare(`INSERT INTO cod_collection_evidence
        (order_id,vendor_id,amount_paise,tender_mode,receipt_reference,idempotency_key,collector_profile_id,notes)
        SELECT ?,vendor_id,?,?,?,?,?,? FROM orders WHERE id=? AND payment_method='cod' AND payment_status<>'paid'`)
        .bind(input.orderId, amountPaise, tenderMode, receiptReference, idempotencyKey, input.actorProfileId, notes, input.orderId),
      input.db.prepare(`UPDATE orders SET payment_status='paid',updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND payment_method='cod' AND payment_status<>'paid'`).bind(input.orderId),
      input.db.prepare(`INSERT INTO ledger_entries
        (vendor_id,account_code,entry_date,description,debit_paise,credit_paise,reference_type,reference_id,created_by_profile_id)
        SELECT vendor_id,?,date('now'),'COD collection for '||order_number,total_paise,0,'cod_collection',id,?
        FROM orders WHERE id=? AND payment_method='cod' AND payment_status='paid'
        AND NOT EXISTS (SELECT 1 FROM ledger_entries WHERE reference_type='cod_collection' AND reference_id=orders.id)`)
        .bind(accountCode, input.actorProfileId, input.orderId),
      audit,
    ]);
  } catch (error) {
    if (/unique|cod_collection/i.test(error instanceof Error ? error.message : "")) {
      const raced = await input.db.prepare(`SELECT amount_paise AS amountPaise,tender_mode AS tenderMode,
        receipt_reference AS receiptReference,idempotency_key AS idempotencyKey,collection_status AS collectionStatus,
        custody_status AS custodyStatus FROM cod_collection_evidence WHERE order_id=? LIMIT 1`).bind(input.orderId)
        .first<{ amountPaise: number; tenderMode: string; receiptReference: string; idempotencyKey: string; collectionStatus: string; custodyStatus: string }>();
      if (raced && raced.amountPaise === amountPaise && raced.tenderMode === tenderMode && raced.receiptReference === receiptReference && raced.idempotencyKey === idempotencyKey) return { ...raced, duplicate: true };
      throw new CodCollectionError("COD collection has already been recorded for this order", 409);
    }
    throw error;
  }
  if (Number(results[0]?.meta.changes ?? 0) !== 1 || Number(results[1]?.meta.changes ?? 0) !== 1) {
    throw new CodCollectionError("COD order changed while recording collection", 409);
  }
  return { collected: true, duplicate: false, orderId: input.orderId, amountPaise, tenderMode, receiptReference, custodyStatus: "on_hand" };
}

export async function transitionCodCustody(input: {
  db: D1Database;
  orderId: number;
  actorProfileId: number;
  action: "deposit" | "reconcile";
  reference: unknown;
  requestId?: string;
}) {
  const reference = text(input.reference, 3, 120, input.action === "deposit" ? "Deposit reference" : "Reconciliation reference");
  const current = await input.db.prepare(`SELECT id,vendor_id AS vendorId,custody_status AS custodyStatus,
    amount_paise AS amountPaise FROM cod_collection_evidence WHERE order_id=? LIMIT 1`).bind(input.orderId)
    .first<{ id: number; vendorId: number; custodyStatus: string; amountPaise: number }>();
  if (!current) throw new CodCollectionError("COD collection evidence not found", 404);
  const next = input.action === "deposit" ? "deposited" : "reconciled";
  if ((input.action === "deposit" && current.custodyStatus !== "on_hand")
    || (input.action === "reconcile" && current.custodyStatus !== "deposited")) {
    throw new CodCollectionError("COD custody transition is not allowed", 409);
  }
  const audit = await prepareAuditEventStatement({
    vendorId: current.vendorId, actorProfileId: input.actorProfileId, action: `cod.collection.${input.action}`,
    entityType: "cod_collection", entityId: current.id,
    before: { custodyStatus: current.custodyStatus }, after: { custodyStatus: next, reference }, requestId: input.requestId ?? "",
  }, input.db);
  const update = input.action === "deposit"
    ? input.db.prepare(`UPDATE cod_collection_evidence SET custody_status='deposited',deposit_reference=?,deposited_at=CURRENT_TIMESTAMP,deposited_by_profile_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND custody_status='on_hand'`).bind(reference, input.actorProfileId, current.id)
    : input.db.prepare(`UPDATE cod_collection_evidence SET custody_status='reconciled',reconciliation_reference=?,reconciled_at=CURRENT_TIMESTAMP,reconciled_by_profile_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND custody_status='deposited'`).bind(reference, input.actorProfileId, current.id);
  const results = await input.db.batch([update, audit]);
  if (Number(results[0]?.meta.changes ?? 0) !== 1) throw new CodCollectionError("COD custody changed. Refresh before retrying", 409);
  return { updated: true, custodyStatus: next, amountPaise: current.amountPaise };
}
