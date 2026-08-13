"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import {
  Building2,
  ChevronLeft,
  ChevronRight,
  FileText,
  Landmark,
  Mail,
  MapPin,
  PackageSearch,
  Pencil,
  Phone,
  RefreshCw,
  Search,
} from "lucide-react";
import { purchaseStatusLabel, type StoredPurchaseStatus } from "../lib/purchase-status";
import type { VendorSupplierSort, VendorSupplierStatus } from "../lib/vendor-supplier-query";
import { authenticatedFetch } from "./marketplace-client";
import styles from "./supplier-directory.module.css";

export type SupplierRecord = {
  id: number;
  businessName: string;
  contactName: string;
  phone: string;
  email: string;
  address: string;
  gstNumber: string;
  drugLicenceNumber: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
};

type SupplierSummary = SupplierRecord & {
  createdAt: string;
  updatedAt: string;
  purchaseCount: number;
  grossPurchasePaise: number;
  returnPaise: number;
  payablePaise: number;
  lastPurchaseDate: string | null;
};

type SupplierListResponse = {
  suppliers: SupplierSummary[];
  totals: { total: number; active: number; inactive: number };
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
};

type SupplierDetailResponse = {
  supplier: SupplierRecord & { createdAt: string; updatedAt: string };
  summary: {
    purchaseCount: number;
    grossPurchasePaise: number;
    returnCount: number;
    returnPaise: number;
    payablePaise: number;
    unpaidPurchaseCount: number;
    lastPurchaseDate: string | null;
  };
  purchases: Array<{
    id: number;
    purchaseNumber: string;
    invoiceNumber: string;
    invoiceDate: string;
    subtotalPaise: number;
    taxPaise: number;
    totalPaise: number;
    paymentStatus: string;
    status: StoredPurchaseStatus;
    lineCount: number;
    unitCount: number;
    itemPreview: string;
  }>;
  ledger: Array<{
    id: number;
    accountCode: string;
    entryDate: string;
    description: string;
    debitPaise: number;
    creditPaise: number;
    referenceNumber: string;
  }>;
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
};

const initialList: SupplierListResponse = {
  suppliers: [],
  totals: { total: 0, active: 0, inactive: 0 },
  pagination: { page: 1, pageSize: 12, total: 0, totalPages: 1 },
};

const statuses: Array<[VendorSupplierStatus, string]> = [["all", "All suppliers"], ["active", "Active"], ["inactive", "Inactive"]];
const sorts: Array<[VendorSupplierSort, string]> = [
  ["name", "Business name"],
  ["recent_purchase", "Most recent purchase"],
  ["payable_high", "Highest recorded payable"],
  ["purchase_value_high", "Highest purchase value"],
];

function money(paise: number) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(paise / 100);
}

async function responsePayload<T>(response: Response): Promise<T> {
  const raw = await response.text();
  let result: Record<string, unknown> = {};
  try { result = raw ? JSON.parse(raw) as Record<string, unknown> : {}; } catch { result = { error: raw }; }
  if (!response.ok) throw new Error(String(result.error || "Supplier records could not be loaded"));
  return result as T;
}

export function SupplierDirectory({ refreshVersion, onEdit }: { refreshVersion: number; onEdit: (supplier: SupplierRecord) => void }) {
  const [list, setList] = useState<SupplierListResponse>(initialList);
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<VendorSupplierStatus>("all");
  const [sort, setSort] = useState<VendorSupplierSort>("name");
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detailPage, setDetailPage] = useState(1);
  const [detail, setDetail] = useState<SupplierDetailResponse | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");

  const clearDetail = () => { setSelectedId(null); setDetail(null); setDetailPage(1); };

  useEffect(() => {
    const controller = new AbortController();
    const parameters = new URLSearchParams({ q: query, status, sort, page: String(page), pageSize: "12" });
    const load = async () => {
      setLoading(true); setError("");
      try {
        const response = await authenticatedFetch(`/api/vendor/suppliers?${parameters}`, { cache: "no-store", signal: controller.signal });
        setList(await responsePayload<SupplierListResponse>(response));
      } catch (reason) {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setError(reason instanceof Error ? reason.message : "Supplier records could not be loaded");
      } finally { if (!controller.signal.aborted) setLoading(false); }
    };
    void load();
    return () => controller.abort();
  }, [page, query, refreshVersion, reloadVersion, sort, status]);

  const loadDetail = useCallback(async (supplierId: number, historyPage: number, signal?: AbortSignal) => {
    setDetailLoading(true); setError("");
    try {
      const response = await authenticatedFetch(`/api/vendor/suppliers/${supplierId}?page=${historyPage}&pageSize=10`, { cache: "no-store", signal });
      setDetail(await responsePayload<SupplierDetailResponse>(response));
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "AbortError") return;
      setError(reason instanceof Error ? reason.message : "Supplier details could not be loaded");
    } finally { if (!signal?.aborted) setDetailLoading(false); }
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadDetail(selectedId, detailPage, controller.signal);
    return () => controller.abort();
  }, [detailPage, loadDetail, refreshVersion, selectedId]);

  const search = (event: FormEvent) => {
    event.preventDefault();
    setQuery(queryInput.trim());
    setPage(1);
    clearDetail();
  };

  const selectSupplier = (supplierId: number) => {
    setSelectedId(supplierId);
    setDetailPage(1);
    setDetail(null);
  };

  return <div className={styles.stack}>
    <section className={styles.panel}>
      <div className={styles.heading}><div><span className={styles.kicker}>SUPPLIER DIRECTORY</span><h2>Search suppliers and recorded balances</h2><p>Every result is scoped to this pharmacy. Recorded payable uses purchase and supplier-return ledger entries.</p></div><button className={styles.button} disabled={loading} onClick={() => { setPage(1); setQuery(queryInput.trim()); setReloadVersion((current) => current + 1); }} type="button"><RefreshCw size={15} /> Refresh</button></div>
      <div className={styles.summary}><article><small>All suppliers</small><strong>{list.totals.total.toLocaleString("en-IN")}</strong></article><article><small>Active</small><strong>{list.totals.active.toLocaleString("en-IN")}</strong></article><article><small>Inactive</small><strong>{list.totals.inactive.toLocaleString("en-IN")}</strong></article></div>
      <div className={styles.toolbar}><form className={styles.search} onSubmit={search}><label><Search size={15} /><input aria-label="Search suppliers" onChange={(event) => setQueryInput(event.target.value)} placeholder="Business, contact, phone, email or GSTIN" value={queryInput} /></label><button className={styles.button} type="submit">Search</button></form><select aria-label="Supplier status" onChange={(event) => { setStatus(event.target.value as VendorSupplierStatus); setPage(1); clearDetail(); }} value={status}>{statuses.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><select aria-label="Sort suppliers" onChange={(event) => { setSort(event.target.value as VendorSupplierSort); setPage(1); clearDetail(); }} value={sort}>{sorts.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
      {error && <div className={styles.notice}>{error}</div>}
      {loading ? <div className={styles.loading}><RefreshCw size={18} /> Loading supplier directory…</div> : list.suppliers.length ? <div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>Supplier</th><th>Contact</th><th>Purchases</th><th>Returns</th><th>Recorded payable</th><th>Last purchase</th><th /></tr></thead><tbody>{list.suppliers.map((supplier) => <tr className={selectedId === supplier.id ? styles.selected : ""} key={supplier.id}><td><span className={styles.cell}><strong>{supplier.businessName}</strong><small>{supplier.gstNumber || "GSTIN not recorded"}</small><span className={`${styles.status} ${supplier.status === "inactive" ? styles.inactive : ""}`}>{supplier.status}</span></span></td><td><span className={styles.cell}><strong>{supplier.contactName}</strong><small>{supplier.phone}{supplier.email ? ` · ${supplier.email}` : ""}</small></span></td><td><span className={styles.cell}><strong>{money(supplier.grossPurchasePaise)}</strong><small>{supplier.purchaseCount} received invoices</small></span></td><td><strong>{money(supplier.returnPaise)}</strong></td><td><strong>{money(supplier.payablePaise)}</strong></td><td>{supplier.lastPurchaseDate || "—"}</td><td><button className={styles.openButton} onClick={() => selectSupplier(supplier.id)} type="button">View details</button></td></tr>)}</tbody></table></div> : <div className={styles.empty}><PackageSearch size={24} /><strong>No suppliers match this search</strong><span>Add a supplier above or change the filters.</span></div>}
      <div className={styles.pagination}><span>Page {list.pagination.page} of {list.pagination.totalPages} · {list.pagination.total.toLocaleString("en-IN")} matching suppliers</span><div><button className={styles.pageButton} disabled={loading || page <= 1} onClick={() => { setPage((current) => Math.max(1, current - 1)); clearDetail(); }} type="button"><ChevronLeft size={14} /> Previous</button><button className={styles.pageButton} disabled={loading || page >= list.pagination.totalPages} onClick={() => { setPage((current) => current + 1); clearDetail(); }} type="button">Next <ChevronRight size={14} /></button></div></div>
    </section>

    {selectedId && <section className={styles.panel}>{detailLoading || !detail ? <div className={styles.loading}><RefreshCw size={18} /> Loading supplier details…</div> : <>
      <div className={styles.detailHeading}><div><span className={styles.kicker}>SUPPLIER DETAIL</span><h2>{detail.supplier.businessName}</h2><p>Supplier since {detail.supplier.createdAt.slice(0, 10)} · Updated {detail.supplier.updatedAt.slice(0, 10)}</p></div><div className={styles.detailActions}><button className={styles.button} onClick={() => onEdit(detail.supplier)} type="button"><Pencil size={14} /> Edit supplier</button></div></div>
      <div className={styles.metrics}><article><small>Recorded payable</small><strong>{money(detail.summary.payablePaise)}</strong><em>Liability credits less supplier-return debits</em></article><article><small>Received purchases</small><strong>{money(detail.summary.grossPurchasePaise)}</strong><em>{detail.summary.purchaseCount} invoices</em></article><article><small>Completed returns</small><strong>{money(detail.summary.returnPaise)}</strong><em>{detail.summary.returnCount} debit notes</em></article><article><small>Last purchase</small><strong>{detail.summary.lastPurchaseDate || "No purchases"}</strong><em>{detail.summary.unpaidPurchaseCount} invoices marked unpaid</em></article></div>
      <div className={styles.contact}><article><span><Building2 size={13} /> Contact</span><strong>{detail.supplier.contactName}</strong><strong><Phone size={11} /> {detail.supplier.phone}</strong></article><article><span><Mail size={13} /> Email</span><strong>{detail.supplier.email || "Not recorded"}</strong></article><article><span><FileText size={13} /> Compliance</span><strong>GSTIN: {detail.supplier.gstNumber || "Not recorded"}</strong><strong>Drug licence: {detail.supplier.drugLicenceNumber || "Not recorded"}</strong></article><article><span><MapPin size={13} /> Address</span><address>{detail.supplier.address || "Not recorded"}</address></article></div>
      <div className={styles.section}><h3>Purchase history</h3><div className={styles.tableWrap}><table className={styles.purchaseTable}><thead><tr><th>Purchase</th><th>Invoice</th><th>Medicines</th><th>Value</th><th>Status</th></tr></thead><tbody>{detail.purchases.map((purchase) => <tr key={purchase.id}><td><strong>{purchase.purchaseNumber}</strong><small>{purchase.invoiceDate}</small></td><td>{purchase.invoiceNumber}</td><td>{purchase.lineCount} lines · {purchase.unitCount} units<small title={purchase.itemPreview}>{purchase.itemPreview}</small></td><td><strong>{money(purchase.totalPaise)}</strong><small>Tax {money(purchase.taxPaise)}</small></td><td><span className={styles.status}>{purchaseStatusLabel(purchase.status)}</span><small>{purchase.paymentStatus}</small></td></tr>)}</tbody></table></div>{!detail.purchases.length && <div className={styles.empty}>No received purchase history for this supplier.</div>}<div className={styles.pagination}><span>Purchase page {detail.pagination.page} of {detail.pagination.totalPages}</span><div><button className={styles.pageButton} disabled={detailLoading || detailPage <= 1} onClick={() => setDetailPage((current) => Math.max(1, current - 1))} type="button"><ChevronLeft size={14} /> Previous</button><button className={styles.pageButton} disabled={detailLoading || detailPage >= detail.pagination.totalPages} onClick={() => setDetailPage((current) => current + 1)} type="button">Next <ChevronRight size={14} /></button></div></div></div>
      <div className={styles.section}><h3><Landmark size={14} /> Supplier-linked ledger activity</h3><div className={styles.ledger}>{detail.ledger.map((entry) => <article key={entry.id}><span>{entry.entryDate}</span><div><strong>{entry.accountCode.replaceAll("_", " ")} · {entry.referenceNumber}</strong><small>{entry.description}</small></div><em>{entry.debitPaise ? `Dr ${money(entry.debitPaise)}` : `Cr ${money(entry.creditPaise)}`}</em></article>)}{!detail.ledger.length && <div className={styles.empty}>No supplier-linked ledger entries yet.</div>}</div></div>
      <p className={styles.balanceNote}>This balance reflects recorded purchase payables and completed supplier returns. Supplier payment posting is not yet implemented, so it is not a bank-settlement statement.</p>
    </>}</section>}
  </div>;
}
