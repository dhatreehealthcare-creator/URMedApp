"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Boxes, ChevronLeft, ChevronRight, Download, Landmark, ReceiptIndianRupee, RefreshCw, Search, Truck } from "lucide-react";
import { authenticatedFetch } from "./marketplace-client";
import styles from "./admin-operational-reports.module.css";

type ReportKind = "stock" | "sales" | "expenses" | "home-delivery";
type ReportResponse = {
  report: string;
  rows: Array<Record<string, string | number | null>>;
  summary: Record<string, string | number | null>;
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
  distanceBasis?: string;
  recognition?: string;
};

const reportTabs: Array<{ id: ReportKind; label: string; detail: string; icon: typeof Boxes }> = [
  { id: "stock", label: "Stock", detail: "Medicine and manufacturer availability", icon: Boxes },
  { id: "sales", label: "Sales", detail: "Online, offline, returns and net", icon: ReceiptIndianRupee },
  { id: "expenses", label: "Expenses", detail: "Date, head and store spending", icon: Landmark },
  { id: "home-delivery", label: "Home delivery", detail: "Method, rider, fees and SLA", icon: Truck },
];

const today = new Date().toISOString().slice(0, 10);
const monthAgo = (() => { const date = new Date(); date.setUTCDate(date.getUTCDate() - 29); return date.toISOString().slice(0, 10); })();

function money(paise: number) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format((paise || 0) / 100);
}

function number(value: unknown) {
  return Number(value ?? 0).toLocaleString("en-IN");
}

async function payload(response: Response) {
  const result = await response.json() as ReportResponse & { error?: string };
  if (!response.ok) throw new Error(result.error || "The administrator report could not be loaded");
  return result;
}

function columnValue(row: Record<string, string | number | null>, key: string) {
  const value = row[key];
  if (key.endsWith("Paise")) return money(Number(value ?? 0));
  if (key === "estimatedDistanceKm") return value === null ? "Unavailable" : `${value} km`;
  if (key === "elapsedMinutes") return `${value} min`;
  if (typeof value === "number") return number(value);
  return String(value ?? "—").replaceAll("_", " ");
}

const columns: Record<ReportKind, Array<[string, string]>> = {
  stock: [["medicineName", "Medicine"], ["manufacturerName", "Manufacturer"], ["medicineCount", "Medicines"], ["storeCount", "Stores"], ["physicalQuantity", "Physical"], ["reservedQuantity", "Reserved"], ["availableQuantity", "Available"], ["quarantinedQuantity", "Quarantined"], ["retailValuePaise", "Retail value"], ["nearestExpiry", "Nearest expiry"]],
  sales: [["activityDate", "Date"], ["channel", "Channel"], ["medicineName", "Medicine"], ["manufacturerName", "Manufacturer"], ["transactions", "Sales"], ["soldQuantity", "Sold qty"], ["returnedQuantity", "Returned qty"], ["grossSalesPaise", "Gross"], ["returnedPaise", "Returns"], ["netSalesPaise", "Net"]],
  expenses: [["label", "Group"], ["expenseDate", "Date"], ["expenseHead", "Head"], ["businessName", "Store"], ["purpose", "Purpose"], ["paymentMode", "Payment"], ["entryCount", "Entries"], ["amountPaise", "Amount"]],
  "home-delivery": [["orderNumber", "Order"], ["businessName", "Store"], ["deliveryMethod", "Method"], ["deliveryStatus", "Status"], ["riderName", "Rider"], ["paymentMethod", "Payment"], ["deliveryFeePaise", "Fee"], ["estimatedDistanceKm", "Distance estimate"], ["elapsedMinutes", "Elapsed"], ["slaStatus", "SLA"]],
};

export function AdminOperationalReports() {
  const [report, setReport] = useState<ReportKind>("stock");
  const [data, setData] = useState<ReportResponse | null>(null);
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [dateFrom, setDateFrom] = useState(monthAgo);
  const [dateTo, setDateTo] = useState(today);
  const [groupBy, setGroupBy] = useState("medicine");
  const [channel, setChannel] = useState("all");
  const [status, setStatus] = useState("all");
  const [secondaryFilter, setSecondaryFilter] = useState("all");
  const [vendorId, setVendorId] = useState("");
  const [branchId, setBranchId] = useState("");
  const [rider, setRider] = useState("all");
  const [sla, setSla] = useState("all");
  const [slaTargetMinutes, setSlaTargetMinutes] = useState("120");
  const [minDistanceKm, setMinDistanceKm] = useState("");
  const [maxDistanceKm, setMaxDistanceKm] = useState("");
  const [minFeeRupees, setMinFeeRupees] = useState("");
  const [maxFeeRupees, setMaxFeeRupees] = useState("");
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const selectReport = (next: ReportKind) => {
    setReport(next); setPage(1); setData(null); setError("");
    setGroupBy(next === "expenses" ? "date" : next === "stock" || next === "sales" ? "medicine" : "date");
    setChannel("all"); setStatus("all"); setSecondaryFilter("all");
    setBranchId("");
    setRider("all"); setSla("all"); setMinDistanceKm(""); setMaxDistanceKm(""); setMinFeeRupees(""); setMaxFeeRupees("");
  };

  const parameters = useMemo(() => {
    const next = new URLSearchParams({ q: query, page: String(page), pageSize: "25" });
    if (vendorId) next.set("vendorId", vendorId);
    if (branchId && report !== "expenses") next.set("branchId", branchId);
    if (report !== "stock") { next.set("dateFrom", dateFrom); next.set("dateTo", dateTo); }
    if (["stock", "sales", "expenses"].includes(report)) next.set("groupBy", groupBy);
    if (report === "stock") next.set("stockState", status);
    if (report === "sales") next.set("channel", channel);
    if (report === "expenses") { next.set("scope", status); next.set("payment", secondaryFilter); }
    if (report === "home-delivery") {
      next.set("method", channel); next.set("status", status); next.set("cod", secondaryFilter);
      next.set("rider", rider); next.set("sla", sla); next.set("slaTargetMinutes", slaTargetMinutes);
      if (minDistanceKm) next.set("minDistanceKm", minDistanceKm);
      if (maxDistanceKm) next.set("maxDistanceKm", maxDistanceKm);
      if (minFeeRupees) next.set("minFeePaise", String(Math.round(Number(minFeeRupees) * 100)));
      if (maxFeeRupees) next.set("maxFeePaise", String(Math.round(Number(maxFeeRupees) * 100)));
    }
    return next;
  }, [branchId, channel, dateFrom, dateTo, groupBy, maxDistanceKm, maxFeeRupees, minDistanceKm, minFeeRupees, page, query, report, rider, secondaryFilter, sla, slaTargetMinutes, status, vendorId]);

  const load = useCallback(async (signal?: AbortSignal) => {
    await Promise.resolve();
    setLoading(true); setError("");
    try {
      const response = await authenticatedFetch(`/api/admin/reports/${report}?${parameters}`, { cache: "no-store", signal });
      setData(await payload(response));
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "AbortError") return;
      setError(reason instanceof Error ? reason.message : "The administrator report could not be loaded");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [parameters, report]);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => {
      if (!controller.signal.aborted) void load(controller.signal);
    });
    return () => controller.abort();
  }, [load, refresh]);

  const search = (event: FormEvent) => { event.preventDefault(); setQuery(queryInput.trim()); setPage(1); };
  const exportCsv = async () => {
    setError("");
    try {
      const exportParameters = new URLSearchParams(parameters); exportParameters.set("format", "csv"); exportParameters.set("pageSize", "100"); exportParameters.set("page", "1");
      const response = await authenticatedFetch(`/api/admin/reports/${report}?${exportParameters}`, { cache: "no-store" });
      if (!response.ok) { const result = await response.json() as { error?: string }; throw new Error(result.error || "CSV export failed"); }
      const blob = await response.blob();
      const href = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = href;
      anchor.download = response.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] ?? `urmed-${report}.csv`;
      anchor.click(); URL.revokeObjectURL(href);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "CSV export failed"); }
  };

  return <div className={styles.stack}>
    <section className={styles.panel}>
      <header className={styles.heading}><div><span>ADMINISTRATOR REPORTING</span><h2>Operational reports</h2><p>Live stock, sales, returns, expenses, and home-delivery performance. This surface does not represent a balance sheet.</p></div><div className={styles.actions}><button onClick={() => setRefresh((value) => value + 1)} type="button"><RefreshCw size={15}/> Refresh</button><button onClick={() => void exportCsv()} type="button"><Download size={15}/> Export current page</button></div></header>
      {error && <div className={styles.error}><AlertTriangle size={16}/>{error}</div>}
      <nav className={styles.tabs}>{reportTabs.map(({ id, label, detail, icon: Icon }) => <button className={report === id ? styles.active : ""} key={id} onClick={() => selectReport(id)} type="button"><Icon size={17}/><span><strong>{label}</strong><small>{detail}</small></span></button>)}</nav>
      <div className={styles.filters}>
        <form onSubmit={search}><label><Search size={15}/><input onChange={(event) => setQueryInput(event.target.value)} placeholder="Medicine, manufacturer, store, rider or order" value={queryInput}/></label><button type="submit">Search</button></form>
        <label><span>Store ID</span><input min="1" onChange={(event) => setVendorId(event.target.value)} placeholder="All stores" type="number" value={vendorId}/></label>
        {report !== "expenses" && <label><span>Branch ID</span><input min="1" onChange={(event) => setBranchId(event.target.value)} placeholder="All branches" type="number" value={branchId}/></label>}
        {report !== "stock" && <><label><span>From</span><input onChange={(event) => setDateFrom(event.target.value)} type="date" value={dateFrom}/></label><label><span>To</span><input onChange={(event) => setDateTo(event.target.value)} type="date" value={dateTo}/></label></>}
        {(report === "stock" || report === "sales") && <label><span>Group by</span><select onChange={(event) => setGroupBy(event.target.value)} value={groupBy}><option value="medicine">Medicine</option>{report === "stock" ? <option value="manufacturer">Manufacturer</option> : <option value="date">Date</option>}</select></label>}
        {report === "expenses" && <label><span>Group by</span><select onChange={(event) => setGroupBy(event.target.value)} value={groupBy}><option value="date">Date</option><option value="head">Expense head</option><option value="store">Store</option><option value="entry">Entry</option></select></label>}
        {report === "sales" && <label><span>Channel</span><select onChange={(event) => setChannel(event.target.value)} value={channel}><option value="all">All channels</option><option value="online">Online</option><option value="offline">Offline</option></select></label>}
        {report === "home-delivery" && <label><span>Method</span><select onChange={(event) => setChannel(event.target.value)} value={channel}><option value="all">All methods</option><option value="pharmacy">Pharmacy delivery</option><option value="urmed">URMED delivery</option></select></label>}
        <label><span>{report === "expenses" ? "Scope" : report === "stock" ? "Stock state" : "Status"}</span><select onChange={(event) => setStatus(event.target.value)} value={status}>
          {report === "stock" ? <><option value="all">All stock</option><option value="available">Available</option><option value="low">Low</option><option value="zero">Zero</option><option value="reserved">Reserved</option><option value="quarantined">Quarantined</option><option value="expired">Expired</option></> : report === "expenses" ? <><option value="all">All expenses</option><option value="store">Store expenses</option><option value="platform">Platform / unallocated</option></> : <><option value="all">All statuses</option><option value="awaiting_confirmation">Awaiting confirmation</option><option value="pharmacist_review">Pharmacist review</option><option value="confirmed">Confirmed</option><option value="packed">Packed</option><option value="ready_for_pickup">Ready for pickup</option><option value="assigned">Assigned</option><option value="picked_up">Picked up</option><option value="out_for_delivery">Out for delivery</option><option value="delivered">Delivered</option><option value="cancelled">Cancelled</option></>}
        </select></label>
        {report === "expenses" && <label><span>Payment</span><select onChange={(event) => setSecondaryFilter(event.target.value)} value={secondaryFilter}><option value="all">All payments</option><option value="cash">Cash</option><option value="upi">UPI</option><option value="bank">Bank</option><option value="card">Card</option><option value="other">Other</option></select></label>}
        {report === "home-delivery" && <>
          <label><span>Rider</span><select onChange={(event) => setRider(event.target.value)} value={rider}><option value="all">All riders</option><option value="assigned">Assigned</option><option value="unassigned">Unassigned</option></select></label>
          <label><span>COD</span><select onChange={(event) => setSecondaryFilter(event.target.value)} value={secondaryFilter}><option value="all">All payments</option><option value="cod">COD</option><option value="prepaid">Prepaid</option><option value="due">COD due</option><option value="paid">COD paid</option></select></label>
          <label><span>SLA status</span><select onChange={(event) => setSla(event.target.value)} value={sla}><option value="all">All SLA states</option><option value="met">Met</option><option value="missed">Missed</option><option value="pending">Pending</option></select></label>
          <label><span>SLA target (minutes)</span><input max="1440" min="15" onChange={(event) => setSlaTargetMinutes(event.target.value)} type="number" value={slaTargetMinutes}/></label>
          <label><span>Min distance (km)</span><input max="1000" min="0" onChange={(event) => setMinDistanceKm(event.target.value)} type="number" value={minDistanceKm}/></label>
          <label><span>Max distance (km)</span><input max="1000" min="0" onChange={(event) => setMaxDistanceKm(event.target.value)} type="number" value={maxDistanceKm}/></label>
          <label><span>Min fee (₹)</span><input max="1000000" min="0" onChange={(event) => setMinFeeRupees(event.target.value)} step="0.01" type="number" value={minFeeRupees}/></label>
          <label><span>Max fee (₹)</span><input max="1000000" min="0" onChange={(event) => setMaxFeeRupees(event.target.value)} step="0.01" type="number" value={maxFeeRupees}/></label>
        </>}
      </div>
      {data && <div className={styles.metrics}>{Object.entries(data.summary).slice(0, 6).map(([key, value]) => <article key={key}><small>{key.replaceAll(/([A-Z])/g, " $1")}</small><strong>{key.endsWith("Paise") ? money(Number(value ?? 0)) : number(value)}</strong></article>)}</div>}
      {data?.distanceBasis === "straight_line_estimate" && <div className={styles.note}>Distance is an approximate straight-line distance between stored origin and destination points. SLA uses the selected target and is not a contractual routing metric.</div>}
      <div className={styles.tableWrap}><table><thead><tr>{columns[report].map(([, label]) => <th key={label}>{label}</th>)}</tr></thead><tbody>
        {!loading && !data?.rows.length && <tr><td colSpan={columns[report].length}>No records matched these filters.</td></tr>}
        {data?.rows.map((row, index) => <tr key={String(row.groupKey ?? row.orderId ?? row.expenseId ?? index)}>{columns[report].map(([key]) => <td key={key}>{columnValue(row, key)}</td>)}</tr>)}
      </tbody></table>{loading && <div className={styles.loading}>Loading secured report…</div>}</div>
      <footer className={styles.pagination}><span>{data?.pagination.total ?? 0} report rows</span><div><button disabled={page <= 1 || loading} onClick={() => setPage((value) => value - 1)} type="button"><ChevronLeft size={15}/></button><strong>{page} / {data?.pagination.totalPages ?? 1}</strong><button disabled={loading || page >= (data?.pagination.totalPages ?? 1)} onClick={() => setPage((value) => value + 1)} type="button"><ChevronRight size={15}/></button></div></footer>
    </section>
  </div>;
}
