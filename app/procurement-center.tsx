"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Building2, CheckCircle2, PackagePlus, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { authenticatedFetch } from "./marketplace-client";
import { PurchaseLifecycleCenter } from "./purchase-lifecycle-center";
import { SupplierDirectory, type SupplierRecord } from "./supplier-directory";

type Supplier = SupplierRecord;
type Manufacturer = { id: number; name: string; linkedProducts: number };
type Ledger = { id: number; accountCode: string; entryDate: string; description: string; debitPaise: number; creditPaise: number; referenceId: number };
type CatalogProduct = { legacyId: number; name: string; composition: string; manufacturer: string; gstPercent: number };
type PurchaseRow = { key: string; query: string; legacyId: number | null; batchNumber: string; expiryDate: string; manufacturingDate: string; dosage: string; purchasePrice: string; salePrice: string; mrp: string; quantity: string; freeQuantity: string; gstPercent: string };

const blankRow = (key = "row-1"): PurchaseRow => ({ key, query: "", legacyId: null, batchNumber: "", expiryDate: "", manufacturingDate: "", dosage: "", purchasePrice: "", salePrice: "", mrp: "", quantity: "1", freeQuantity: "0", gstPercent: "5" });

function money(paise: number) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(paise / 100);
}

async function payload<T>(response: Response): Promise<T> {
  const raw = await response.text();
  let data: Record<string, unknown> = {};
  try { data = raw ? JSON.parse(raw) as Record<string, unknown> : {}; } catch { data = { error: raw }; }
  if (!response.ok) throw new Error(String(data.error || (response.status === 401 ? "Sign in with an active vendor account to continue" : "The procurement request could not be completed")));
  return data as T;
}

function Notice({ error, message }: { error: string; message: string }) {
  if (error) return <div className="recovery-error"><AlertTriangle size={18} /><span><strong>Action needed</strong><small>{error}</small></span></div>;
  if (message) return <div className="portal-success"><CheckCircle2 size={18} /><span>{message}</span></div>;
  return null;
}

export function ProcurementCenter({ mode }: { mode: "purchase" | "masters" }) {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [manufacturers, setManufacturers] = useState<Manufacturer[]>([]);
  const [ledger, setLedger] = useState<Ledger[]>([]);
  const [rows, setRows] = useState<PurchaseRow[]>([blankRow()]);
  const [activeRow, setActiveRow] = useState<string>("");
  const [searchResults, setSearchResults] = useState<CatalogProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [editingSupplier, setEditingSupplier] = useState<Supplier | null>(null);
  const [supplierRefreshVersion, setSupplierRefreshVersion] = useState(0);
  const [purchaseRefreshVersion, setPurchaseRefreshVersion] = useState(0);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const masterResponse = await authenticatedFetch("/api/vendor/masters", { cache: "no-store" });
      const masters = await payload<{ suppliers: Supplier[]; manufacturers: Manufacturer[] }>(masterResponse);
      setSuppliers(masters.suppliers); setManufacturers(masters.manufacturers);
      if (mode === "purchase") {
        const purchaseResponse = await authenticatedFetch("/api/purchases", { cache: "no-store" });
        const purchaseData = await payload<{ ledger: Ledger[] }>(purchaseResponse);
        setLedger(purchaseData.ledger);
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Procurement data is unavailable"); }
    finally { setLoading(false); }
  }, [mode]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const activeQuery = rows.find((row) => row.key === activeRow)?.query.trim() ?? "";
  useEffect(() => {
    if (!activeRow || activeQuery.length < 2) return;
    const timer = window.setTimeout(() => {
      void fetch(`/api/catalog?q=${encodeURIComponent(activeQuery)}&limit=8`, { cache: "no-store" })
        .then((response) => payload<{ products: CatalogProduct[] }>(response))
        .then((data) => setSearchResults(data.products))
        .catch(() => setSearchResults([]));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [activeQuery, activeRow]);

  const updateRow = (key: string, patch: Partial<PurchaseRow>) => setRows((current) => current.map((row) => row.key === key ? { ...row, ...patch } : row));
  const totals = useMemo(() => rows.reduce((sum, row) => {
    const taxable = Math.round((Number(row.purchasePrice) || 0) * 100) * (Number(row.quantity) || 0);
    const tax = Math.round(taxable * (Number(row.gstPercent) || 0) / 100);
    return { subtotal: sum.subtotal + taxable, tax: sum.tax + tax, total: sum.total + taxable + tax };
  }, { subtotal: 0, tax: 0, total: 0 }), [rows]);

  const selectProduct = (product: CatalogProduct) => {
    updateRow(activeRow, { query: product.name, legacyId: product.legacyId, gstPercent: String(product.gstPercent) });
    setSearchResults([]);
  };

  const saveSupplier = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = event.currentTarget; setBusy("supplier"); setError(""); setMessage("");
    try {
      const values = Object.fromEntries(new FormData(form).entries());
      const response = await authenticatedFetch("/api/vendor/masters", { method: "POST", body: JSON.stringify({ action: "supplier", id: editingSupplier?.id, ...values }) });
      const data = await payload<{ suppliers: Supplier[]; manufacturers: Manufacturer[] }>(response);
      setSuppliers(data.suppliers); setManufacturers(data.manufacturers); setEditingSupplier(null); form.reset();
      setSupplierRefreshVersion((current) => current + 1);
      setMessage("Supplier saved to this pharmacy.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Supplier could not be saved"); }
    finally { setBusy(""); }
  };

  const saveManufacturer = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy("manufacturer"); setError(""); setMessage("");
    try {
      const form = event.currentTarget; const values = Object.fromEntries(new FormData(form).entries());
      const response = await authenticatedFetch("/api/vendor/masters", { method: "POST", body: JSON.stringify({ action: "manufacturer", ...values }) });
      const data = await payload<{ suppliers: Supplier[]; manufacturers: Manufacturer[] }>(response);
      setSuppliers(data.suppliers); setManufacturers(data.manufacturers); form.reset(); setMessage("Manufacturer submitted for administrator governance review.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Manufacturer could not be saved"); }
    finally { setBusy(""); }
  };

  const savePurchase = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = event.currentTarget; setBusy("purchase"); setError(""); setMessage("");
    try {
      if (rows.some((row) => !row.legacyId)) throw new Error("Select a recovered medicine from the search results for every row");
      const values = Object.fromEntries(new FormData(form).entries());
      const response = await authenticatedFetch("/api/purchases", { method: "POST", body: JSON.stringify({ ...values, workflow: "draft", items: rows }) });
      const data = await payload<{ purchaseNumber: string; ledger: Ledger[] }>(response);
      setLedger(data.ledger); setRows([blankRow()]); setActiveRow(""); form.reset();
      setPurchaseRefreshVersion((current) => current + 1);
      setMessage(`${data.purchaseNumber} created as a draft. Approve it before recording any goods receipt.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Purchase receipt could not be saved"); }
    finally { setBusy(""); }
  };

  if (loading) return <section className="portal-panel"><div className="recovery-loading"><span className="catalogue-loader" /> Loading live procurement records…</div></section>;
  if (error && suppliers.length === 0) return <section className="portal-panel vendor-setup-gate"><AlertTriangle size={23} /><div><h2>Vendor procurement access required</h2><p>{error}</p></div><button className="portal-outline" onClick={() => void load()} type="button"><RefreshCw size={15} /> Try again</button></section>;

  if (mode === "masters") return <div className="portal-stack procurement-live"><Notice error={error} message={message} /><div className="portal-split">
    <section className="portal-panel"><div className="portal-panel-heading compact"><div><span className="portal-kicker">STOCKIST MASTER</span><h2>Suppliers</h2><p>Suppliers are private to this pharmacy and validated before receiving purchases.</p></div><Building2 size={21} /></div>
      <form className="portal-form-grid" key={editingSupplier?.id ?? "new"} onSubmit={saveSupplier}>
        <label className="portal-field"><span>Business name *</span><input defaultValue={editingSupplier?.businessName} name="businessName" required /></label><label className="portal-field"><span>Contact name *</span><input defaultValue={editingSupplier?.contactName} name="contactName" required /></label>
        <label className="portal-field"><span>10-digit phone *</span><input defaultValue={editingSupplier?.phone} inputMode="numeric" maxLength={10} name="phone" pattern="[0-9]{10}" required /></label><label className="portal-field"><span>Email</span><input defaultValue={editingSupplier?.email} name="email" type="email" /></label>
        <label className="portal-field"><span>GSTIN</span><input defaultValue={editingSupplier?.gstNumber} maxLength={15} name="gstNumber" /></label><label className="portal-field"><span>Drug licence number</span><input defaultValue={editingSupplier?.drugLicenceNumber} name="drugLicenceNumber" /></label>
        <label className="portal-field wide"><span>Address</span><textarea defaultValue={editingSupplier?.address} name="address" rows={2} /></label><label className="portal-field"><span>Status</span><select defaultValue={editingSupplier?.status ?? "active"} name="status"><option value="active">Active</option><option value="inactive">Inactive</option></select></label>
        <div className="procurement-form-actions wide"><button className="portal-primary" disabled={Boolean(busy)} type="submit">{busy === "supplier" ? "Saving…" : editingSupplier ? "Update supplier" : "Add supplier"}</button>{editingSupplier && <button className="portal-outline" onClick={() => setEditingSupplier(null)} type="button">Cancel edit</button>}</div>
      </form>
    </section>
    <section className="portal-panel"><div className="portal-panel-heading compact"><div><span className="portal-kicker">MANUFACTURER MASTER</span><h2>Manufacturers</h2><p>Products use canonical manufacturer IDs. New names require administrator governance approval.</p></div><PackagePlus size={21} /></div>
      <form className="portal-form-grid one" onSubmit={saveManufacturer}><label className="portal-field"><span>Proposed business name *</span><input name="name" required /></label><button className="portal-secondary wide" disabled={Boolean(busy)} type="submit">{busy === "manufacturer" ? "Submitting…" : "Propose manufacturer"}</button></form>
      <div className="master-list live-master-list">{manufacturers.map((manufacturer) => <article key={manufacturer.id}><span>{manufacturer.name.slice(0, 2).toUpperCase()}</span><div><strong>{manufacturer.name}</strong><small>{Number(manufacturer.linkedProducts).toLocaleString("en-IN")} linked products</small></div></article>)}</div>
    </section>
  </div><SupplierDirectory onEdit={setEditingSupplier} refreshVersion={supplierRefreshVersion} /></div>;

  return <div className="portal-stack procurement-live"><Notice error={error} message={message} />
    <section className="portal-panel"><div className="portal-panel-heading"><div><span className="portal-kicker">PURCHASE ORDER ENTRY</span><h2>Create supplier purchase order</h2><p>A draft records the supplier invoice and ordered quantities without changing physical stock or the accounting ledger.</p></div><button className="portal-outline" onClick={() => setRows((current) => [...current, blankRow(crypto.randomUUID())])} type="button"><Plus size={15} /> Add product row</button></div>
      <form onSubmit={savePurchase}><div className="portal-form-grid three"><label className="portal-field"><span>Stockist name *</span><select name="supplierId" required><option value="">Choose active supplier</option>{suppliers.filter((supplier) => supplier.status === "active").map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.businessName}</option>)}</select></label><label className="portal-field"><span>Supplier invoice number *</span><input name="invoiceNumber" required /></label><label className="portal-field"><span>Invoice date *</span><input defaultValue={new Date().toISOString().slice(0, 10)} name="invoiceDate" required type="date" /></label></div>
        <div className="portal-table-wrap"><div className="purchase-entry-table"><div className="purchase-entry-head"><span>Product</span><span>Batch</span><span>Expiry</span><span>Mfg.</span><span>Dosage</span><span>Purchase</span><span>Sale</span><span>MRP</span><span>Qty</span><span>Free</span><span>GST</span><span>Amount</span><span /></div>{rows.map((row) => {
          const taxable = Math.round((Number(row.purchasePrice) || 0) * 100) * (Number(row.quantity) || 0); const amount = taxable + Math.round(taxable * Number(row.gstPercent) / 100);
          return <div className="purchase-entry-row" key={row.key}><label><Search size={13} /><input aria-label="Product search" onChange={(event) => { const query = event.target.value; setActiveRow(row.key); if (query.trim().length < 2) setSearchResults([]); updateRow(row.key, { query, legacyId: null }); }} onFocus={() => setActiveRow(row.key)} placeholder="Search medicine" value={row.query} />{row.legacyId && <small>ID {row.legacyId}</small>}</label><input aria-label="Batch number" onChange={(event) => updateRow(row.key, { batchNumber: event.target.value })} required value={row.batchNumber} /><input aria-label="Expiry date" onChange={(event) => updateRow(row.key, { expiryDate: event.target.value })} required type="date" value={row.expiryDate} /><input aria-label="Manufacturing date" onChange={(event) => updateRow(row.key, { manufacturingDate: event.target.value })} type="date" value={row.manufacturingDate} /><input aria-label="Dosage" onChange={(event) => updateRow(row.key, { dosage: event.target.value })} placeholder="50 mg" value={row.dosage} /><input aria-label="Purchase price" min="0.01" onChange={(event) => updateRow(row.key, { purchasePrice: event.target.value })} required step="0.01" type="number" value={row.purchasePrice} /><input aria-label="Sale price" min="0.01" onChange={(event) => updateRow(row.key, { salePrice: event.target.value })} required step="0.01" type="number" value={row.salePrice} /><input aria-label="MRP" min="0.01" onChange={(event) => updateRow(row.key, { mrp: event.target.value })} required step="0.01" type="number" value={row.mrp} /><input aria-label="Quantity" min="1" onChange={(event) => updateRow(row.key, { quantity: event.target.value })} required type="number" value={row.quantity} /><input aria-label="Free quantity" min="0" onChange={(event) => updateRow(row.key, { freeQuantity: event.target.value })} type="number" value={row.freeQuantity} /><select aria-label="GST" onChange={(event) => updateRow(row.key, { gstPercent: event.target.value })} value={row.gstPercent}>{[0, 5, 12, 18, 28].map((rate) => <option key={rate} value={rate}>{rate}%</option>)}</select><strong>{money(amount)}</strong><button aria-label="Remove row" disabled={rows.length === 1} onClick={() => setRows((current) => current.filter((candidate) => candidate.key !== row.key))} type="button"><Trash2 size={14} /></button></div>;
        })}</div></div>
        {activeQuery.length >= 2 && <div className="product-search-results"><span>Catalogue results</span>{searchResults.length ? searchResults.map((product) => <button key={product.legacyId} onClick={() => selectProduct(product)} type="button"><strong>{product.name}</strong><small>ID {product.legacyId} · {product.manufacturer || product.composition || "Manufacturer not recorded"}</small></button>) : <em>Searching the recovered catalogue…</em>}</div>}
        <div className="purchase-footer"><div className="invoice-total horizontal"><span>Amount <strong>{money(totals.subtotal)}</strong></span><span>Tax <strong>{money(totals.tax)}</strong></span><span>Total amount <strong>{money(totals.total)}</strong></span></div><button className="portal-primary" disabled={Boolean(busy) || suppliers.filter((supplier) => supplier.status === "active").length === 0} type="submit">{busy === "purchase" ? "Creating purchase order…" : "Create draft purchase order"}</button></div>
      </form>
    </section>
    <PurchaseLifecycleCenter refreshVersion={purchaseRefreshVersion} onChanged={() => void load()} />
    <section className="portal-panel"><div className="portal-panel-heading compact"><div><span className="portal-kicker">DOUBLE-ENTRY LEDGER</span><h2>Received purchase accounts</h2></div></div><div className="ledger-list live-ledger-list">{ledger.map((entry) => <article key={entry.id}><span>{entry.entryDate}</span><div><strong>{entry.accountCode.replaceAll("_", " ")}</strong><small>{entry.description}</small></div><em>{entry.debitPaise ? `Dr ${money(entry.debitPaise)}` : `Cr ${money(entry.creditPaise)}`}</em></article>)}{!ledger.length && <p className="procurement-empty">Ledger entries appear after the first goods receipt.</p>}</div></section>
  </div>;
}
