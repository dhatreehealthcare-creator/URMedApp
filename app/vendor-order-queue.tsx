"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Download,
  Eye,
  FileCheck2,
  MapPin,
  PackageSearch,
  Phone,
  Printer,
  ReceiptIndianRupee,
  RefreshCw,
  Search,
  Truck,
  UserRound,
  XCircle,
} from "lucide-react";
import { workflowStatusLabels } from "../lib/order-workflow";
import type {
  VendorOrderDeliveryMethod,
  VendorOrderPaymentStatus,
  VendorOrderQueueStatus,
  VendorOrderSort,
} from "../lib/vendor-order-query";
import { authenticatedFetch } from "./marketplace-client";
import { downloadInvoice, printInvoice } from "./invoice-client";
import styles from "./vendor-order-queue.module.css";

type QueueOrder = {
  id: number;
  orderNumber: string;
  customerName: string;
  customerPhone: string;
  totalPaise: number;
  paymentMethod: string;
  paymentStatus: string;
  deliveryMethod: string;
  orderStatus: string;
  deliveryStatus: string;
  prescriptionId: number | null;
  prescriptionStatus: string;
  inventoryStatus: string;
  reservationExpiresAt: string | null;
  itemCount: number;
  unitCount: number;
  itemPreview: string;
  createdAt: string;
  nextStatuses: string[];
  slaDueAt: string | null;
  slaOverdue?: boolean;
};

type QueueResponse = {
  orders: QueueOrder[];
  summary: {
    total: number;
    actionRequired: number;
    prescriptionReview: number;
    awaitingConfirmation: number;
    inProgress: number;
    completed: number;
    cancelled: number;
  };
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
};

type OrderItem = {
  id: number;
  productName: string;
  batchNumber: string;
  expiryDate: string | null;
  quantity: number;
  unitPricePaise: number;
  gstPercent: number;
  hsnCode: string;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  discountPaise: number;
  lineTotalPaise: number;
};

type OrderDetail = {
  id: number;
  orderNumber: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  deliveryAddress: string;
  latitude: string;
  longitude: string;
  subtotalPaise: number;
  taxPaise: number;
  deliveryFeePaise: number;
  totalPaise: number;
  paymentMethod: string;
  paymentStatus: string;
  deliveryMethod: string;
  orderStatus: string;
  deliveryStatus: string;
  prescriptionId: number | null;
  prescriptionStatus: string;
  inventoryStatus: string;
  reservationExpiresAt: string | null;
  placeOfSupplyStateCode: string;
  invoiceId: number | null;
  invoiceNumber: string | null;
  createdAt: string;
  updatedAt: string;
  items: OrderItem[];
  trackingEvents: Array<{
    id: number;
    status: string;
    note: string;
    createdAt: string;
    actorName: string;
    actorRole: string;
  }>;
  prescription: null | {
    prescriptionNumber: string;
    documentId: number;
    documentName: string;
    patientName: string;
    patientAddress: string;
    prescriberName: string;
    prescriberAddress: string;
    prescribedOn: string | null;
    status: string;
    rejectionReason: string;
    reviewDecision: string | null;
    reviewNotes: string | null;
    pharmacistName: string | null;
  };
  nextStatuses: string[];
};

const initialQueue: QueueResponse = {
  orders: [],
  summary: {
    total: 0,
    actionRequired: 0,
    prescriptionReview: 0,
    awaitingConfirmation: 0,
    inProgress: 0,
    completed: 0,
    cancelled: 0,
  },
  pagination: { page: 1, pageSize: 20, total: 0, totalPages: 1 },
};

const statusOptions: Array<[VendorOrderQueueStatus, string]> = [
  ["all", "All statuses"],
  ["action_required", "Action required"],
  ["awaiting_confirmation", "Awaiting confirmation"],
  ["prescription_review", "Prescription review"],
  ["in_progress", "In progress"],
  ["completed", "Completed"],
  ["cancelled", "Cancelled"],
];

const paymentOptions: Array<[VendorOrderPaymentStatus, string]> = [
  ["all", "All payments"],
  ["pending", "Payment pending"],
  ["paid", "Paid"],
  ["cod_due", "COD due"],
  ["failed", "Failed"],
  ["refunded", "Refunded"],
];

const deliveryOptions: Array<[VendorOrderDeliveryMethod, string]> = [
  ["all", "All fulfilment"],
  ["pickup", "Customer pickup"],
  ["pharmacy", "Pharmacy delivery"],
  ["urmed", "URMED delivery"],
];

const sortOptions: Array<[VendorOrderSort, string]> = [
  ["newest", "Newest first"],
  ["oldest", "Oldest first"],
  ["amount_high", "Highest value"],
  ["amount_low", "Lowest value"],
];

function money(paise: number) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(paise / 100);
}

function dateTime(value: string) {
  return new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function words(value: string) {
  return value.replaceAll("_", " ");
}

function statusLabel(value: string) {
  return workflowStatusLabels[value] ?? words(value);
}

function statusTone(value: string) {
  if (["completed", "delivered", "paid", "approved"].includes(value)) return styles.green;
  if (["cancelled", "failed", "rejected", "released"].includes(value)) return styles.red;
  if (["pending", "cod_due", "pending_review", "pharmacist_review", "awaiting_confirmation"].includes(value)) return styles.amber;
  return styles.blue;
}

function deliveryLabel(value: string) {
  return value === "pickup" ? "Customer pickup" : value === "pharmacy" ? "Pharmacy delivery" : "URMED delivery";
}

async function payload<T>(response: Response): Promise<T> {
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error || "The order request could not be completed");
  return result;
}

export function VendorOrderQueue() {
  const [queue, setQueue] = useState<QueueResponse>(initialQueue);
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<VendorOrderQueueStatus>("action_required");
  const [payment, setPayment] = useState<VendorOrderPaymentStatus>("all");
  const [delivery, setDelivery] = useState<VendorOrderDeliveryMethod>("all");
  const [sort, setSort] = useState<VendorOrderSort>("newest");
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const loadDetail = useCallback(async (orderId: number, signal?: AbortSignal) => {
    setDetailLoading(true);
    try {
      const response = await authenticatedFetch(`/api/vendor/orders/${orderId}`, { cache: "no-store", signal });
      const result = await payload<{ order: OrderDetail }>(response);
      setDetail(result.order);
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "AbortError") return;
      setError(reason instanceof Error ? reason.message : "Order details could not be loaded");
    } finally {
      if (!signal?.aborted) setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const parameters = new URLSearchParams({
      q: query,
      status,
      payment,
      delivery,
      sort,
      page: String(page),
      pageSize: String(pageSize),
    });
    const load = async () => {
      setLoading(true);
      setError("");
      try {
        const response = await authenticatedFetch(`/api/vendor/orders?${parameters}`, { cache: "no-store", signal: controller.signal });
        setQueue(await payload<QueueResponse>(response));
      } catch (reason) {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setError(reason instanceof Error ? reason.message : "The online order queue could not be loaded");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    return () => controller.abort();
  }, [delivery, page, pageSize, payment, query, refreshVersion, sort, status]);

  const clearDetail = () => {
    setSelectedId(null);
    setDetail(null);
    setNote("");
  };

  const applyStatus = (next: VendorOrderQueueStatus) => {
    setStatus(next);
    setPage(1);
    clearDetail();
  };

  const openOrder = async (orderId: number) => {
    setSelectedId(orderId);
    setNote("");
    setMessage("");
    setError("");
    await loadDetail(orderId);
  };

  const searchOrders = (event: FormEvent) => {
    event.preventDefault();
    setQuery(queryInput.trim());
    setPage(1);
    clearDetail();
  };

  const updateOrder = async (nextStatus: string) => {
    if (!detail) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await authenticatedFetch(`/api/orders/${detail.id}/tracking`, {
        method: "POST",
        body: JSON.stringify({ status: nextStatus, note: note.trim() || `Order ${statusLabel(nextStatus).toLowerCase()}` }),
      });
      await payload<{ updated: boolean }>(response);
      setMessage(`${detail.orderNumber} updated to ${statusLabel(nextStatus).toLowerCase()}.`);
      setNote("");
      setRefreshVersion((current) => current + 1);
      await loadDetail(detail.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The order could not be updated");
    } finally {
      setBusy(false);
    }
  };

  const openPrescription = async () => {
    if (!detail?.prescription) return;
    setBusy(true);
    setError("");
    try {
      const response = await authenticatedFetch(`/api/documents/${detail.prescription.documentId}`, { cache: "no-store" });
      if (!response.ok) throw new Error((await response.text()) || "The prescription document could not be opened");
      const objectUrl = URL.createObjectURL(await response.blob());
      window.open(objectUrl, "_blank", "noopener,noreferrer");
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The prescription document could not be opened");
    } finally {
      setBusy(false);
    }
  };

  const reviewPrescription = async (decision: "approved" | "rejected" | "clarification_required") => {
    if (!detail?.prescriptionId) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await authenticatedFetch(`/api/prescriptions/${detail.prescriptionId}/review`, {
        method: "POST",
        body: JSON.stringify({ decision, notes: note.trim(), items: [] }),
      });
      await payload<{ reviewed: boolean }>(response);
      setMessage(`${detail.orderNumber} prescription ${decision === "clarification_required" ? "sent for clarification" : decision}.`);
      setNote("");
      setRefreshVersion((current) => current + 1);
      await loadDetail(detail.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The prescription review could not be completed");
    } finally {
      setBusy(false);
    }
  };

  const openInvoice = async (format: "pdf" | "html") => {
    if (!detail?.invoiceId) return;
    setBusy(true); setError("");
    try {
      const endpoint = `/api/vendor/invoices/${detail.invoiceId}`;
      if (format === "pdf") await downloadInvoice(endpoint);
      else await printInvoice(endpoint);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The GST invoice is unavailable");
    } finally { setBusy(false); }
  };

  const summaryButtons: Array<[VendorOrderQueueStatus, string, number]> = [
    ["all", "All online orders", queue.summary.total],
    ["action_required", "Action required", queue.summary.actionRequired],
    ["prescription_review", "Prescription review", queue.summary.prescriptionReview],
    ["in_progress", "In progress", queue.summary.inProgress],
    ["completed", "Completed", queue.summary.completed],
  ];

  return <div className={styles.stack}>
    <section className={styles.panel}>
      <div className={styles.heading}>
        <div><span className={styles.kicker}>LIVE ONLINE ORDERS</span><h2>Order queue</h2><p>Search, prioritize and process only the orders assigned to this pharmacy.</p></div>
        <button className={styles.refresh} disabled={loading} onClick={() => setRefreshVersion((current) => current + 1)} type="button"><RefreshCw size={15} /> Refresh orders</button>
      </div>
      <div className={styles.summary}>{summaryButtons.map(([key, label, count]) => <button className={status === key ? styles.active : ""} key={key} onClick={() => applyStatus(key)} type="button"><small>{label}</small><strong>{count.toLocaleString("en-IN")}</strong></button>)}</div>
      <div className={styles.filters}>
        <form className={styles.search} onSubmit={searchOrders}><label><Search size={15} /><input aria-label="Search orders" onChange={(event) => setQueryInput(event.target.value)} placeholder="Order, customer, phone or medicine" value={queryInput} /></label><button className={styles.button} type="submit">Search</button></form>
        <select aria-label="Order status" onChange={(event) => applyStatus(event.target.value as VendorOrderQueueStatus)} value={status}>{statusOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        <select aria-label="Payment status" onChange={(event) => { setPayment(event.target.value as VendorOrderPaymentStatus); setPage(1); clearDetail(); }} value={payment}>{paymentOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        <select aria-label="Fulfilment method" onChange={(event) => { setDelivery(event.target.value as VendorOrderDeliveryMethod); setPage(1); clearDetail(); }} value={delivery}>{deliveryOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        <select aria-label="Sort orders" onChange={(event) => { setSort(event.target.value as VendorOrderSort); setPage(1); clearDetail(); }} value={sort}>{sortOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      </div>
      {message && <div aria-live="polite" className={styles.notice}>{message}</div>}
      {error && <div aria-live="assertive" className={`${styles.notice} ${styles.error}`}>{error}</div>}
      {loading ? <div className={styles.loading}><RefreshCw size={18} /> Loading the pharmacy order queue…</div> : queue.orders.length ? <div className={styles.tableWrap}><table className={styles.table}>
        <thead><tr><th>Order</th><th>Customer</th><th>Medicines</th><th>Payment</th><th>Fulfilment</th><th>Status</th><th /></tr></thead>
        <tbody>{queue.orders.map((order) => <tr className={selectedId === order.id ? styles.selected : ""} key={order.id}>
          <td><span className={styles.cell}><strong>{order.orderNumber}</strong><small>{dateTime(order.createdAt)}</small>{order.slaOverdue && <small className={styles.warning}>SLA overdue · due {order.slaDueAt ? dateTime(order.slaDueAt) : "now"}</small>}</span></td>
          <td><span className={styles.cell}><strong>{order.customerName}</strong><small>{order.customerPhone}</small></span></td>
          <td><span className={styles.cell}><strong>{order.itemCount} line{order.itemCount === 1 ? "" : "s"} · {order.unitCount} units</strong><small title={order.itemPreview}>{order.itemPreview}</small></span></td>
          <td><span className={styles.cell}><strong>{money(order.totalPaise)}</strong><small>{words(order.paymentMethod)} · {words(order.paymentStatus)}</small></span></td>
          <td><span className={styles.cell}><strong>{deliveryLabel(order.deliveryMethod)}</strong><small>{order.inventoryStatus === "reserved" ? "Stock reserved" : words(order.inventoryStatus)}</small></span></td>
          <td><span className={`${styles.badge} ${statusTone(order.deliveryStatus)}`}>{statusLabel(order.deliveryStatus)}</span></td>
          <td><button className={styles.reviewButton} onClick={() => void openOrder(order.id)} type="button">Review</button></td>
        </tr>)}</tbody>
      </table></div> : <div className={styles.empty}><PackageSearch size={24} /><strong>No orders match these filters</strong><span>Clear the search or choose another queue status.</span></div>}
      <div className={styles.pagination}><span>Page {queue.pagination.page} of {queue.pagination.totalPages} · {queue.pagination.total.toLocaleString("en-IN")} matching orders</span><div><button className={styles.pageButton} disabled={loading || page <= 1} onClick={() => { setPage((current) => Math.max(1, current - 1)); clearDetail(); }} type="button"><ChevronLeft size={14} /> Previous</button><button className={styles.pageButton} disabled={loading || page >= queue.pagination.totalPages} onClick={() => { setPage((current) => current + 1); clearDetail(); }} type="button">Next <ChevronRight size={14} /></button></div></div>
    </section>

    {selectedId && <section className={styles.panel}>
      {detailLoading || !detail ? <div className={styles.loading}><RefreshCw size={18} /> Loading complete order details…</div> : <>
        <div className={styles.detailHeading}><div><span className={styles.kicker}>ORDER DETAIL</span><h2>{detail.orderNumber}</h2><p>Placed {dateTime(detail.createdAt)} · Last updated {dateTime(detail.updatedAt)}</p></div><span className={`${styles.badge} ${statusTone(detail.deliveryStatus)}`}>{statusLabel(detail.deliveryStatus)}</span></div>
        <div className={styles.detailGrid}>
          <article className={styles.detailCard}><span><UserRound size={14} /> Customer</span><strong>{detail.customerName}</strong><small>{detail.customerEmail}</small><small><Phone size={11} /> {detail.customerPhone}</small></article>
          <article className={styles.detailCard}><span><MapPin size={14} /> Delivery address</span><address>{detail.deliveryAddress || "Customer pickup"}</address>{detail.latitude && detail.longitude && <small>Coordinates: {detail.latitude}, {detail.longitude}</small>}</article>
          <article className={styles.detailCard}><span><ReceiptIndianRupee size={14} /> Payment</span><strong>{money(detail.totalPaise)}</strong><small>{words(detail.paymentMethod)} · {words(detail.paymentStatus)}</small><span className={`${styles.badge} ${statusTone(detail.paymentStatus)}`}>{words(detail.paymentStatus)}</span></article>
          <article className={styles.detailCard}><span><Truck size={14} /> Fulfilment</span><strong>{deliveryLabel(detail.deliveryMethod)}</strong><small>{statusLabel(detail.deliveryStatus)}</small><small>Inventory: {words(detail.inventoryStatus)}</small></article>
        </div>

        <div className={styles.section}><h3>Medicine and tax lines</h3><div className={styles.tableWrap}><table className={styles.items}><thead><tr><th>Medicine</th><th>Batch / expiry</th><th>HSN</th><th>Qty</th><th>Unit price</th><th>GST</th><th>Line total</th></tr></thead><tbody>{detail.items.map((item) => <tr key={item.id}><td><strong>{item.productName}</strong></td><td>{item.batchNumber}<br />{item.expiryDate || "No expiry"}</td><td>{item.hsnCode || "—"}</td><td>{item.quantity}</td><td>{money(item.unitPricePaise)}</td><td>{item.gstPercent}%<br /><small>{money(item.cgstPaise + item.sgstPaise + item.igstPaise)}</small></td><td>{money(item.lineTotalPaise)}</td></tr>)}</tbody></table></div><div className={styles.totals}><span>Taxable subtotal <strong>{money(detail.subtotalPaise)}</strong></span><span>GST <strong>{money(detail.taxPaise)}</strong></span><span>Delivery fee <strong>{money(detail.deliveryFeePaise)}</strong></span><span>Total <strong>{money(detail.totalPaise)}</strong></span></div></div>

        <div className={styles.split}>
          <section className={styles.subpanel}><h3><FileCheck2 size={15} /> Prescription</h3>{detail.prescription ? <><p><strong>{detail.prescription.prescriptionNumber}</strong> · {words(detail.prescription.status)}</p><p>Patient: {detail.prescription.patientName}<br />Prescriber: {detail.prescription.prescriberName}<br />Document: {detail.prescription.documentName}</p>{detail.prescription.reviewNotes && <p>Review: {detail.prescription.reviewNotes}{detail.prescription.pharmacistName ? ` · ${detail.prescription.pharmacistName}` : ""}</p>}<div className={styles.actionButtons}><button className={styles.button} disabled={busy} onClick={() => void openPrescription()} type="button"><Eye size={14} /> Open document</button>{detail.prescription.status === "uploaded" && <><button className={`${styles.button} ${styles.primaryAction}`} disabled={busy} onClick={() => void reviewPrescription("approved")} type="button"><CheckCircle2 size={14} /> Approve</button><button className={styles.button} disabled={busy || note.trim().length < 5} onClick={() => void reviewPrescription("clarification_required")} type="button"><AlertTriangle size={14} /> Clarify</button><button className={`${styles.button} ${styles.cancelAction}`} disabled={busy || note.trim().length < 5} onClick={() => void reviewPrescription("rejected")} type="button"><XCircle size={14} /> Reject</button></>}</div></> : <p>No prescription is required for this order.</p>}</section>
          <section className={styles.subpanel}><h3><Clock3 size={15} /> Fulfilment timeline</h3><div className={styles.timeline}>{detail.trackingEvents.length ? detail.trackingEvents.map((event) => <article key={event.id}><strong>{statusLabel(event.status)}</strong><small>{dateTime(event.createdAt)} · {event.actorName}</small>{event.note && <small>{event.note}</small>}</article>) : <p>No fulfilment events have been recorded.</p>}</div></section>
        </div>

        <div className={styles.actions}><input aria-label="Order action note" className={styles.note} maxLength={300} onChange={(event) => setNote(event.target.value)} placeholder="Action note; a cancellation reason requires at least 5 characters" value={note} /><div className={styles.actionButtons}>{detail.nextStatuses.map((nextStatus) => <button className={`${styles.button} ${nextStatus === "cancelled" ? styles.cancelAction : styles.primaryAction}`} disabled={busy || (nextStatus === "cancelled" && note.trim().length < 5)} key={nextStatus} onClick={() => void updateOrder(nextStatus)} type="button">{statusLabel(nextStatus)}</button>)}{!detail.nextStatuses.length && <span className={styles.badge}>No vendor action is currently available</span>}</div></div>
        {detail.invoiceId && <div className={styles.notice}>Immutable GST invoice {detail.invoiceNumber || detail.invoiceId} is ready. <button disabled={busy} onClick={() => void openInvoice("pdf")} type="button"><Download size={14} /> Download PDF</button> <button disabled={busy} onClick={() => void openInvoice("html")} type="button"><Printer size={14} /> Print</button></div>}
      </>}
    </section>}
  </div>;
}
