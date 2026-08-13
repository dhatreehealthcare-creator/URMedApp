"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, RefreshCw } from "lucide-react";
import { purchaseStatusLabel, type StoredPurchaseStatus } from "../lib/purchase-status";
import { authenticatedFetch } from "./marketplace-client";

type PurchaseSummary = {
  id: number;
  purchaseNumber: string;
  supplierName: string;
  invoiceNumber: string;
  invoiceDate: string;
  totalPaise: number;
  status: StoredPurchaseStatus;
  receivedUnitCount: number;
  orderedUnitCount: number;
};

type PurchaseLine = {
  id: number;
  productName: string;
  batchNumber: string;
  quantity: number;
  freeQuantity: number;
  receivedQuantity: number;
  receivedFreeQuantity: number;
};

type PurchaseDetail = PurchaseSummary & {
  items: PurchaseLine[];
  receipts: Array<{ id: number; receiptNumber: string; receivedOn: string; receivedBy: string; unitCount: number }>;
  nextStatuses: string[];
  cancellationReason: string;
};

function money(paise: number) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(paise / 100);
}

async function responsePayload<T>(response: Response): Promise<T> {
  const value = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(value.error || "The purchase action could not be completed"));
  return value as T;
}

export function PurchaseLifecycleCenter({ refreshVersion = 0, onChanged }: { refreshVersion?: number; onChanged?: () => void }) {
  const [purchases, setPurchases] = useState<PurchaseSummary[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<PurchaseDetail | null>(null);
  const [receiptQuantities, setReceiptQuantities] = useState<Record<number, { quantity: string; freeQuantity: string }>>({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const loadList = useCallback(async (preferredId?: number) => {
    const response = await authenticatedFetch("/api/purchases", { cache: "no-store" });
    const data = await responsePayload<{ purchases: PurchaseSummary[] }>(response);
    setPurchases(data.purchases);
    setSelectedId((current) => preferredId ?? current ?? data.purchases[0]?.id ?? null);
  }, []);

  const loadDetail = useCallback(async (purchaseId: number) => {
    const response = await authenticatedFetch(`/api/purchases/${purchaseId}`, { cache: "no-store" });
    const data = await responsePayload<{ purchase: PurchaseDetail }>(response);
    setDetail(data.purchase);
    setReceiptQuantities(Object.fromEntries(data.purchase.items.map((item) => [item.id, {
      quantity: String(Math.max(0, item.quantity - item.receivedQuantity)),
      freeQuantity: String(Math.max(0, item.freeQuantity - item.receivedFreeQuantity)),
    }])));
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadList().catch((reason) => setError(reason instanceof Error ? reason.message : "Purchases are unavailable"));
  }, [loadList, refreshVersion]);

  useEffect(() => {
    if (!selectedId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadDetail(selectedId).catch((reason) => setError(reason instanceof Error ? reason.message : "Purchase detail is unavailable"));
  }, [loadDetail, selectedId]);

  const runAction = async (action: "approve" | "cancel", reason = "") => {
    if (!detail) return;
    setBusy(action); setError(""); setMessage("");
    try {
      const response = await authenticatedFetch(`/api/purchases/${detail.id}`, {
        method: "POST",
        body: JSON.stringify({ action, reason }),
      });
      const data = await responsePayload<{ purchase: PurchaseDetail }>(response);
      setDetail(data.purchase);
      setMessage(action === "approve" ? "Purchase order approved. Stock remains unchanged until receipt." : "Purchase order cancelled without changing stock or accounts.");
      await loadList(detail.id);
      onChanged?.();
    } catch (reasonValue) {
      setError(reasonValue instanceof Error ? reasonValue.message : "Purchase action failed");
    } finally { setBusy(""); }
  };

  const receive = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!detail) return;
    setBusy("receive"); setError(""); setMessage("");
    try {
      const values = Object.fromEntries(new FormData(event.currentTarget).entries());
      const items = detail.items.map((item) => ({
        purchaseOrderItemId: item.id,
        quantity: Number(receiptQuantities[item.id]?.quantity ?? 0),
        freeQuantity: Number(receiptQuantities[item.id]?.freeQuantity ?? 0),
      })).filter((item) => item.quantity + item.freeQuantity > 0);
      const response = await authenticatedFetch(`/api/purchases/${detail.id}`, {
        method: "POST",
        body: JSON.stringify({ action: "receive", receivedOn: values.receivedOn, notes: values.notes, items }),
      });
      const data = await responsePayload<{ purchase: PurchaseDetail }>(response);
      setDetail(data.purchase);
      setMessage(data.purchase.status === "received" ? "Goods receipt completed. The purchase is fully received." : "Partial receipt saved. Remaining quantities stay open on the purchase order.");
      await loadList(detail.id);
      await loadDetail(detail.id);
      onChanged?.();
    } catch (reasonValue) {
      setError(reasonValue instanceof Error ? reasonValue.message : "Goods receipt failed");
    } finally { setBusy(""); }
  };

  return <section className="portal-panel">
    <div className="portal-panel-heading"><div><span className="portal-kicker">PURCHASE LIFECYCLE</span><h2>Approve and receive purchase orders</h2><p>Approval does not change stock. Each goods receipt records only the quantities physically received.</p></div><button className="portal-outline" onClick={() => void loadList(selectedId ?? undefined)} type="button"><RefreshCw size={15} /> Refresh</button></div>
    {error && <div className="recovery-error" role="alert"><AlertTriangle size={18} /><span><strong>Action needed</strong><small>{error}</small></span></div>}
    {message && <div className="portal-success" role="status"><CheckCircle2 size={18} /><span>{message}</span></div>}
    <div className="portal-split">
      <div className="portal-table-wrap"><table className="portal-table"><thead><tr><th>Purchase</th><th>Supplier</th><th>Received</th><th>Status</th></tr></thead><tbody>{purchases.map((purchase) => <tr key={purchase.id}><td><button aria-pressed={purchase.id === selectedId} className="purchase-select-button" onClick={() => setSelectedId(purchase.id)} type="button"><strong>{purchase.purchaseNumber}</strong><small>{purchase.invoiceNumber} · {purchase.invoiceDate}</small></button></td><td>{purchase.supplierName}<small>{money(purchase.totalPaise)}</small></td><td>{Number(purchase.receivedUnitCount)} / {Number(purchase.orderedUnitCount)}</td><td><span className={`portal-status ${purchase.id === selectedId ? "blue" : "green"}`}>{purchaseStatusLabel(purchase.status)}</span></td></tr>)}</tbody></table>{!purchases.length && <p className="procurement-empty">No purchase orders have been created yet.</p>}</div>
      {detail && <div className="portal-stack"><div><span className="portal-kicker">{detail.purchaseNumber}</span><h3>{detail.supplierName}</h3><p>Invoice {detail.invoiceNumber} · {purchaseStatusLabel(detail.status)}</p></div>
        {detail.status === "draft" && <div className="procurement-form-actions"><button className="portal-primary" disabled={Boolean(busy)} onClick={() => void runAction("approve")} type="button">{busy === "approve" ? "Approving…" : "Approve purchase order"}</button><form onSubmit={(event) => { event.preventDefault(); const reason = String(new FormData(event.currentTarget).get("reason") ?? ""); void runAction("cancel", reason); }}><input minLength={5} name="reason" placeholder="Cancellation reason" required /><button className="portal-outline" disabled={Boolean(busy)} type="submit">Cancel order</button></form></div>}
        {detail.status === "approved" && <form onSubmit={(event) => { event.preventDefault(); const reason = String(new FormData(event.currentTarget).get("reason") ?? ""); void runAction("cancel", reason); }}><div className="procurement-form-actions"><input minLength={5} name="reason" placeholder="Cancellation reason" required /><button className="portal-outline" disabled={Boolean(busy)} type="submit">Cancel before receipt</button></div></form>}
        {(detail.status === "approved" || detail.status === "partially_received") && <form className="portal-stack" onSubmit={receive}><div className="portal-form-grid"><label className="portal-field"><span>Receipt date *</span><input defaultValue={new Date().toISOString().slice(0, 10)} max={new Date().toISOString().slice(0, 10)} name="receivedOn" required type="date" /></label><label className="portal-field"><span>Receipt notes</span><input name="notes" placeholder="Delivery or GRN note" /></label></div><div className="portal-table-wrap"><table className="portal-table"><thead><tr><th>Product / batch</th><th>Ordered</th><th>Already received</th><th>Receive now</th><th>Free now</th></tr></thead><tbody>{detail.items.map((item) => <tr key={item.id}><td><strong>{item.productName}</strong><small>{item.batchNumber}</small></td><td>{item.quantity} + {item.freeQuantity} free</td><td>{item.receivedQuantity} + {item.receivedFreeQuantity} free</td><td><input aria-label={`${item.productName} receive quantity`} max={item.quantity - item.receivedQuantity} min="0" onChange={(event) => setReceiptQuantities((current) => ({ ...current, [item.id]: { ...current[item.id], quantity: event.target.value } }))} type="number" value={receiptQuantities[item.id]?.quantity ?? "0"} /></td><td><input aria-label={`${item.productName} receive free quantity`} max={item.freeQuantity - item.receivedFreeQuantity} min="0" onChange={(event) => setReceiptQuantities((current) => ({ ...current, [item.id]: { ...current[item.id], freeQuantity: event.target.value } }))} type="number" value={receiptQuantities[item.id]?.freeQuantity ?? "0"} /></td></tr>)}</tbody></table></div><button className="portal-primary" disabled={Boolean(busy)} type="submit">{busy === "receive" ? "Saving receipt…" : "Receive selected quantities"}</button></form>}
        {detail.receipts.length > 0 && <div><span className="portal-kicker">GOODS RECEIPTS</span><div className="ledger-list live-ledger-list">{detail.receipts.map((receipt) => <article key={receipt.id}><span>{receipt.receivedOn}</span><div><strong>{receipt.receiptNumber}</strong><small>{receipt.receivedBy}</small></div><em>{receipt.unitCount} units</em></article>)}</div></div>}
        {detail.status === "cancelled" && <p className="procurement-empty">Cancelled: {detail.cancellationReason}</p>}
      </div>}
    </div>
  </section>;
}
