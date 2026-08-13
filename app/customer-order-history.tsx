"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight, Download, Eye, PackageSearch, Printer, RefreshCw, RotateCcw, Search, Truck, XCircle } from "lucide-react";
import type { CustomerReorderRequest } from "../lib/customer-order-history";
import { workflowStatusLabels } from "../lib/order-workflow";
import { authenticatedFetch } from "./marketplace-client";
import { downloadInvoice, printInvoice } from "./invoice-client";
import styles from "./customer-order-history.module.css";

type HistoryOrder = {
  id: number; orderNumber: string; businessName: string; totalPaise: number; paymentMethod: string;
  paymentStatus: string; deliveryMethod: string; orderStatus: string; deliveryStatus: string;
  prescriptionStatus: string; inventoryStatus: string; invoiceAvailable: boolean; createdAt: string;
  itemCount: number; unitCount: number; itemPreview: string; canCancel: boolean;
};

type HistoryResponse = {
  orders: HistoryOrder[];
  summary: { total: number; active: number; completed: number; cancelled: number };
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
};

type DetailItem = {
  id: number; productName: string; batchNumber: string; quantity: number; unitPricePaise: number;
  gstPercent: number; taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number;
  lineTotalPaise: number; prescriptionRequired: boolean; reorderInventoryId: number | null;
  reorderAvailableQuantity: number | null;
};

type OrderDetail = HistoryOrder & {
  subtotalPaise: number; taxPaise: number; deliveryFeePaise: number; deliveryAddress: string;
  placeOfSupplyStateCode: string; reservationExpiresAt: string | null;
  invoice: { id: number | null; available: boolean; number: string | null; downloadImplemented: true };
  canRefund: boolean; paymentReceiptAvailable: boolean;
  refund: null | { id: number; providerRefundId: string | null; amountPaise: number; status: "pending" | "processed" | "failed"; reason: string; failureReason: string; refundReceipt: string; creditNoteNumber: string | null; initiatedAt: string; processedAt: string | null };
  items: DetailItem[];
  trackingEvents: Array<{ id: number; status: string; note: string; createdAt: string; actorName: string; actorRole: string }>;
};

const initialHistory: HistoryResponse = {
  orders: [], summary: { total: 0, active: 0, completed: 0, cancelled: 0 },
  pagination: { page: 1, pageSize: 10, total: 0, totalPages: 1 },
};

function money(paise: number) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(paise / 100);
}

function dateTime(value: string) {
  return new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function label(value: string) {
  return workflowStatusLabels[value] ?? value.replaceAll("_", " ");
}

async function payload<T>(response: Response): Promise<T> {
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error || "The order request could not be completed");
  return result;
}

export function CustomerOrderHistory({ onReorder }: { onReorder: (request: CustomerReorderRequest) => void }) {
  const [history, setHistory] = useState(initialHistory);
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [payment, setPayment] = useState("all");
  const [delivery, setDelivery] = useState("all");
  const [sort, setSort] = useState("newest");
  const [page, setPage] = useState(1);
  const [version, setVersion] = useState(0);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const loadDetail = useCallback(async (id: number) => {
    setDetailLoading(true); setError("");
    try {
      const response = await authenticatedFetch(`/api/customer/orders/${id}`, { cache: "no-store" });
      setDetail((await payload<{ order: OrderDetail }>(response)).order);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Order details could not be loaded");
    } finally { setDetailLoading(false); }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const parameters = new URLSearchParams({ query, q: query, status, payment, delivery, sort, page: String(page), pageSize: "10" });
    const load = async () => {
      setLoading(true); setError("");
      try {
        const response = await authenticatedFetch(`/api/customer/orders?${parameters}`, { cache: "no-store", signal: controller.signal });
        setHistory(await payload<HistoryResponse>(response));
      } catch (reason) {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setError(reason instanceof Error ? reason.message : "Order history could not be loaded");
      } finally { if (!controller.signal.aborted) setLoading(false); }
    };
    void load();
    return () => controller.abort();
  }, [delivery, page, payment, query, sort, status, version]);

  const search = (event: FormEvent) => {
    event.preventDefault(); setPage(1); setQuery(queryInput.trim()); setSelectedId(null); setDetail(null);
  };

  const cancel = async () => {
    if (!detail || reason.trim().length < 5) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await authenticatedFetch(`/api/orders/${detail.id}/tracking`, {
        method: "POST", body: JSON.stringify({ status: "cancelled", note: reason.trim() }),
      });
      await payload<{ updated: boolean }>(response);
      setMessage("Order cancelled. Any active stock reservation was released safely.");
      setReason(""); setVersion((current) => current + 1);
      await loadDetail(detail.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Order could not be cancelled");
    } finally { setBusy(false); }
  };

  const requestRefund = async (retry = false) => {
    if (!detail) return;
    const refundReason = retry ? detail.refund?.reason ?? "Retry the payment refund" : reason.trim();
    if (refundReason.length < 5) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await authenticatedFetch("/api/payments/razorpay/refund", {
        method: "POST", body: JSON.stringify({ orderId: detail.id, reason: refundReason }),
      });
      const result = await response.json() as { error?: string; refund?: { status: string } };
      if (!response.ok) throw new Error(result.error || "Refund could not be initiated");
      setMessage(result.refund?.status === "processed"
        ? "Razorpay processed the refund. Your reconciled payment receipt is ready."
        : "The order is cancelled and stock is restored. Razorpay is processing the refund.");
      setReason(""); setVersion((current) => current + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Refund could not be initiated");
    } finally {
      await loadDetail(detail.id);
      setBusy(false);
    }
  };

  const downloadReceipt = async () => {
    if (!detail) return;
    setBusy(true); setError("");
    try {
      const response = await authenticatedFetch(`/api/customer/orders/${detail.id}/receipt`, { cache: "no-store" });
      if (!response.ok) {
        const result = await response.json() as { error?: string };
        throw new Error(result.error || "Payment receipt is unavailable");
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url; link.download = `URMED-payment-${detail.orderNumber}.html`; link.click();
      URL.revokeObjectURL(url);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Payment receipt is unavailable");
    } finally { setBusy(false); }
  };

  const openInvoice = async (format: "pdf" | "html") => {
    if (!detail?.invoice.id) return;
    setBusy(true); setError("");
    try {
      const endpoint = `/api/customer/invoices/${detail.invoice.id}`;
      if (format === "pdf") await downloadInvoice(endpoint);
      else await printInvoice(endpoint);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The GST invoice is unavailable");
    } finally { setBusy(false); }
  };

  const prepareReorder = (item: DetailItem) => {
    if (!detail || !item.reorderInventoryId || !item.reorderAvailableQuantity) return;
    onReorder({
      orderId: detail.id,
      inventoryId: item.reorderInventoryId,
      productName: item.productName,
      quantity: Math.max(1, Math.min(item.quantity, item.reorderAvailableQuantity, 100)),
      prescriptionRequired: item.prescriptionRequired,
    });
  };

  return <div className={styles.stack}>
    <section className={`portal-panel ${styles.hero}`}><div><span className="portal-kicker">PURCHASE HISTORY</span><h2>Your orders</h2><p>Search past purchases, inspect fulfilment events, cancel eligible unpaid orders, or prepare an item for a fully revalidated checkout.</p></div><button className="portal-outline" onClick={() => setVersion((current) => current + 1)} type="button"><RefreshCw size={15} /> Refresh</button></section>
    <div className={styles.metrics}><article><small>All orders</small><strong>{history.summary.total}</strong></article><article><small>Active</small><strong>{history.summary.active}</strong></article><article><small>Completed</small><strong>{history.summary.completed}</strong></article><article><small>Cancelled</small><strong>{history.summary.cancelled}</strong></article></div>
    {message && <div className="auth-message success" role="status">{message}</div>}{error && <div className="auth-message error" role="alert">{error}</div>}
    <section className="portal-panel">
      <form className={styles.filters} onSubmit={search}><label><span>Search orders or medicines</span><div><Search size={15} /><input onChange={(event) => setQueryInput(event.target.value)} placeholder="Order number, pharmacy, medicine" value={queryInput} /></div></label><label><span>Status</span><select onChange={(event) => { setStatus(event.target.value); setPage(1); }} value={status}><option value="all">All statuses</option><option value="active">Active</option><option value="awaiting_payment">Awaiting payment</option><option value="prescription_review">Prescription review</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option></select></label><label><span>Payment</span><select onChange={(event) => { setPayment(event.target.value); setPage(1); }} value={payment}><option value="all">All payments</option><option value="pending">Pending</option><option value="paid">Paid</option><option value="cod_due">COD due</option><option value="failed">Failed</option><option value="refund_pending">Refund pending</option><option value="refunded">Refunded</option></select></label><label><span>Fulfilment</span><select onChange={(event) => { setDelivery(event.target.value); setPage(1); }} value={delivery}><option value="all">All methods</option><option value="pickup">Pickup</option><option value="pharmacy">Pharmacy delivery</option><option value="urmed">URMED delivery</option></select></label><label><span>Sort</span><select onChange={(event) => { setSort(event.target.value); setPage(1); }} value={sort}><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select></label><button className="portal-secondary" type="submit">Search</button></form>
      {loading ? <div aria-live="polite" className="recovery-loading" role="status"><span className="catalogue-loader" /> Loading order history…</div> : <div className={styles.list}>{history.orders.length ? history.orders.map((order) => <article key={order.id}><span className={styles.orderIcon}><PackageSearch size={18} /></span><div><strong>{order.orderNumber}</strong><small>{order.itemPreview || "Order items unavailable"}</small><em>{order.businessName} · {dateTime(order.createdAt)}</em><div className={styles.badges}><span>{label(order.deliveryStatus)}</span><span>{order.paymentStatus.replaceAll("_", " ")}</span>{order.invoiceAvailable && <span>Invoice recorded</span>}</div></div><aside><strong>{money(order.totalPaise)}</strong><small>{order.unitCount} units</small><button onClick={() => { setSelectedId(order.id); setReason(""); void loadDetail(order.id); }} type="button"><Eye size={14} /> View details</button></aside></article>) : <div className={styles.empty}><PackageSearch size={24} /><strong>No matching orders</strong><small>Adjust the search or filters.</small></div>}</div>}
      <footer className={styles.pagination}><span>Page {history.pagination.page} of {history.pagination.totalPages} · {history.pagination.total} orders</span><div><button disabled={page <= 1} onClick={() => setPage((current) => current - 1)} type="button"><ChevronLeft size={15} /> Previous</button><button disabled={page >= history.pagination.totalPages} onClick={() => setPage((current) => current + 1)} type="button">Next <ChevronRight size={15} /></button></div></footer>
    </section>
    {selectedId && <section className={`portal-panel ${styles.detail}`}>
      {detailLoading || !detail ? <div aria-live="polite" className="recovery-loading" role="status"><span className="catalogue-loader" /> Loading secured order details…</div> : <>
        <header><div><span className="portal-kicker">ORDER DETAIL</span><h2>{detail.orderNumber}</h2><p>{detail.businessName} · {dateTime(detail.createdAt)}</p></div><button className="portal-outline" onClick={() => { setSelectedId(null); setDetail(null); }} type="button">Close</button></header>
        <div className={styles.detailGrid}><article><small>Order</small><strong>{label(detail.deliveryStatus)}</strong><span>{detail.orderStatus.replaceAll("_", " ")}</span></article><article><small>Payment</small><strong>{detail.paymentStatus.replaceAll("_", " ")}</strong><span>{detail.paymentMethod.toUpperCase()}</span></article><article><small>Fulfilment</small><strong>{detail.deliveryMethod === "pickup" ? "Customer pickup" : detail.deliveryMethod === "pharmacy" ? "Pharmacy delivery" : "URMED delivery"}</strong><span>{detail.inventoryStatus} inventory</span></article><article><small>Invoice</small><strong>{detail.invoice.available ? detail.invoice.number || "Invoice recorded" : "Not available yet"}</strong><span>{detail.invoice.available ? "Immutable GST snapshot ready" : "Issued only after paid fulfilment"}</span></article></div>
        <div className={styles.address}><Truck size={17} /><span><strong>Delivery address</strong><small>{detail.deliveryAddress}</small></span></div>
        <div className={styles.items}>{detail.items.map((item) => <article key={item.id}><div><strong>{item.productName}</strong><small>Batch {item.batchNumber} · {item.quantity} × {money(item.unitPricePaise)} · GST {item.gstPercent}%</small><em>Line total {money(item.lineTotalPaise)}</em></div><button className="portal-secondary" disabled={!item.reorderInventoryId || !item.reorderAvailableQuantity} onClick={() => prepareReorder(item)} type="button"><RotateCcw size={14} /> {item.reorderInventoryId ? "Prepare reorder" : "Currently unavailable"}</button></article>)}</div>
        <div className={styles.reorderNote}><RotateCcw size={16} /><span><strong>Reorder does not purchase automatically</strong><small>Each medicine is handed to checkout separately. Current stock, batch allocation, price, GST, serviceability, address, and prescription requirements are checked again.</small></span></div>
        {detail.paymentReceiptAvailable && <div className={styles.receipt}><Download size={17} /><span><strong>Payment receipt available</strong><small>This is payment evidence from the reconciled Razorpay record, not a GST tax invoice.</small></span><button disabled={busy} onClick={() => void downloadReceipt()} type="button">Download receipt</button></div>}
        {detail.invoice.available && detail.invoice.id && <div className={styles.receipt}><Download size={17} /><span><strong>GST invoice available</strong><small>Download the stable PDF or open the authenticated print view. Payment receipts remain separate.</small></span><button disabled={busy} onClick={() => void openInvoice("pdf")} type="button"><Download size={14} /> PDF</button><button disabled={busy} onClick={() => void openInvoice("html")} type="button"><Printer size={14} /> Print</button></div>}
        {detail.refund && <div className={`${styles.refundStatus} ${styles[detail.refund.status]}`}><RotateCcw size={18} /><span><strong>Refund {detail.refund.status}</strong><small>{detail.refund.status === "processed" ? `${money(detail.refund.amountPaise)} was reconciled. Credit note ${detail.refund.creditNoteNumber ?? "recorded"}.` : detail.refund.status === "failed" ? `${detail.refund.failureReason || "Razorpay could not initiate the refund."} Stock remains restored and the owed refund remains visible.` : `${money(detail.refund.amountPaise)} is awaiting Razorpay's final signed webhook.`}</small></span>{detail.refund.status === "failed" && <button disabled={busy} onClick={() => void requestRefund(true)} type="button">{busy ? "Retrying…" : "Retry refund"}</button>}</div>}
        <div className={styles.timeline}><h3>Delivery timeline</h3>{detail.trackingEvents.map((event) => <article key={event.id}><span /><div><strong>{label(event.status)}</strong><small>{event.note || "Status updated"}</small><em>{dateTime(event.createdAt)} · {event.actorName}</em></div></article>)}</div>
        {detail.canCancel ? <div className={styles.cancel}><XCircle size={19} /><div><strong>Cancel this unpaid order</strong><small>Cancellation is available only before pharmacy acceptance. Active reservations or committed COD stock are released through the controlled order transition.</small><input maxLength={300} onChange={(event) => setReason(event.target.value)} placeholder="Cancellation reason (at least 5 characters)" value={reason} /></div><button disabled={busy || reason.trim().length < 5} onClick={() => void cancel()} type="button">{busy ? "Cancelling…" : "Cancel order"}</button></div> : detail.canRefund ? <div className={styles.cancel}><RotateCcw size={19} /><div><strong>Cancel and refund this paid order</strong><small>This is available before pharmacy acceptance. The order is cancelled and committed stock is restored once; the signed Razorpay webhook finalizes the refund.</small><input maxLength={300} onChange={(event) => setReason(event.target.value)} placeholder="Refund reason (at least 5 characters)" value={reason} /></div><button disabled={busy || reason.trim().length < 5} onClick={() => void requestRefund()} type="button">{busy ? "Submitting…" : "Cancel & refund"}</button></div> : detail.paymentStatus === "failed" ? <div className={styles.warning}><AlertTriangle size={17} /><span>Payment failed and the stock reservation was released. Prepare a reorder to create a newly revalidated checkout; this released order cannot be resurrected.</span></div> : null}
      </>}
    </section>}
  </div>;
}
