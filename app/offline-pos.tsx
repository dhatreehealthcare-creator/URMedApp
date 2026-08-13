"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  BadgeIndianRupee,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Download,
  Minus,
  Pill,
  Plus,
  Printer,
  FileUp,
  ReceiptIndianRupee,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  UserRound,
} from "lucide-react";
import { authenticatedFetch } from "./marketplace-client";
import { downloadInvoice, printInvoice } from "./invoice-client";
import styles from "./offline-pos.module.css";

type CatalogProduct = {
  productId: number;
  productName: string;
  genericName: string;
  tradeName: string;
  manufacturer: string;
  strengthValue: string | null;
  strengthUnit: string | null;
  packType: string | null;
  packSizeValue: string | null;
  packSizeUnit: string | null;
  dispensingUom: string | null;
  prescriptionRequired: number;
  drugSchedule: string;
  hsnCode: string;
  availableQuantity: number;
  minimumPricePaise: number;
  maximumPricePaise: number;
  nextExpiryDate: string;
  batchCount: number;
  gstRates: number[];
  requiresPrescription: boolean;
  classificationRequired: boolean;
};

type CatalogResponse = {
  products: CatalogProduct[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
};

type LiveCustomer = { id: number; name: string; email: string; phone: string };
type CartLine = CatalogProduct & { quantity: number };
type PosReceipt = {
  id: number;
  saleNumber: string;
  invoiceId: number;
  invoiceNumber: string;
  customerName: string;
  paymentMode: string;
  grossPaise: number;
  discountPaise: number;
  subtotalPaise: number;
  taxPaise: number;
  totalPaise: number;
  createdAt: string;
  lines: Array<{ productName: string; batchNumber: string; quantity: number; lineTotalPaise: number }>;
};
type PosPrescription = {
  id: number;
  captureNumber: string;
  documentId: number;
  documentName: string;
  patientName: string;
  prescriberName: string;
  prescribedOn: string;
  status: string;
  rejectionReason: string;
  items: Array<{ productId: number; medicineText: string; quantityRequested: number }>;
};
type PosSaleSummary = Pick<PosReceipt, "id" | "saleNumber" | "invoiceNumber" | "customerName" | "paymentMode" | "totalPaise" | "createdAt">;

const emptyCatalog: CatalogResponse = {
  products: [],
  pagination: { page: 1, pageSize: 20, total: 0, totalPages: 1 },
};

function money(paise: number) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(paise / 100);
}

function nextKey() {
  return `pos:${crypto.randomUUID()}`;
}

async function responsePayload<T>(response: Response) {
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error || "The POS request could not be completed");
  return result;
}

export function OfflinePos({ postingEnabled = true }: { postingEnabled?: boolean }) {
  const [catalog, setCatalog] = useState<CatalogResponse>(emptyCatalog);
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [customerQuery, setCustomerQuery] = useState("");
  const [customer, setCustomer] = useState<LiveCustomer | null>(null);
  const [walkInName, setWalkInName] = useState("Walk-in customer");
  const [walkInPhone, setWalkInPhone] = useState("");
  const [paymentMode, setPaymentMode] = useState("cash");
  const [discountType, setDiscountType] = useState("none");
  const [discountValue, setDiscountValue] = useState("0");
  const [placeOfSupplyStateCode, setPlaceOfSupplyStateCode] = useState("36");
  const [buyerGstin, setBuyerGstin] = useState("");
  const [prescriptionCaptureId, setPrescriptionCaptureId] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [receipt, setReceipt] = useState<PosReceipt | null>(null);
  const [prescriptions, setPrescriptions] = useState<PosPrescription[]>([]);
  const [sales, setSales] = useState<PosSaleSummary[]>([]);
  const [rxFile, setRxFile] = useState<File | null>(null);
  const [patientAddress, setPatientAddress] = useState("");
  const [prescriberName, setPrescriberName] = useState("");
  const [prescriberAddress, setPrescriberAddress] = useState("");
  const [prescribedOn, setPrescribedOn] = useState("");
  const [serialNumber, setSerialNumber] = useState("");
  const [reviewNotes, setReviewNotes] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      setLoading(true);
      setError("");
      try {
        const parameters = new URLSearchParams({ q: query, page: String(page), pageSize: "20" });
        const response = await authenticatedFetch(`/api/vendor/pos/catalog?${parameters}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        setCatalog(await responsePayload<CatalogResponse>(response));
      } catch (reason) {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setError(reason instanceof Error ? reason.message : "The counter catalogue could not be loaded");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    return () => controller.abort();
  }, [page, query, refreshVersion]);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const [prescriptionResponse, salesResponse] = await Promise.all([
          authenticatedFetch("/api/vendor/pos/prescriptions", { cache: "no-store", signal: controller.signal }),
          authenticatedFetch("/api/vendor/pos/sales?page=1&pageSize=20", { cache: "no-store", signal: controller.signal }),
        ]);
        const prescriptionPayload = await responsePayload<{ prescriptions: PosPrescription[] }>(prescriptionResponse);
        const salesPayload = await responsePayload<{ sales: PosSaleSummary[] }>(salesResponse);
        setPrescriptions(prescriptionPayload.prescriptions);
        setSales(salesPayload.sales);
      } catch (reason) {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setError(reason instanceof Error ? reason.message : "Counter history could not be loaded");
      }
    };
    void load();
    return () => controller.abort();
  }, [refreshVersion]);

  const changeCart = useCallback((update: (current: CartLine[]) => CartLine[]) => {
    setCart(update);
    setReceipt(null);
    setIdempotencyKey(nextKey());
  }, []);

  const addProduct = (product: CatalogProduct) => {
    if (product.classificationRequired) {
      setError(`${product.productName} must be classified before it can be sold.`);
      return;
    }
    setError("");
    changeCart((current) => {
      const existing = current.find((line) => line.productId === product.productId);
      if (existing) return current.map((line) => line.productId === product.productId
        ? { ...line, quantity: Math.min(line.availableQuantity, line.quantity + 1) }
        : line);
      return [...current, { ...product, quantity: 1 }];
    });
  };

  const setQuantity = (productId: number, quantity: number) => {
    changeCart((current) => current.map((line) => line.productId === productId
      ? { ...line, quantity: Math.max(1, Math.min(line.availableQuantity, quantity)) }
      : line));
  };

  const removeProduct = (productId: number) => {
    changeCart((current) => current.filter((line) => line.productId !== productId));
  };

  const estimate = useMemo(() => {
    const grossPaise = cart.reduce((total, line) => total + line.minimumPricePaise * line.quantity, 0);
    const rawDiscount = discountType === "fixed"
      ? Math.round(Number(discountValue || 0) * 100)
      : discountType === "percent"
        ? Math.round(grossPaise * Number(discountValue || 0) / 100)
        : 0;
    const discountPaise = Math.max(0, Math.min(Math.max(0, grossPaise - 1), Number.isFinite(rawDiscount) ? rawDiscount : 0));
    const taxablePaise = grossPaise - discountPaise;
    const weightedTaxPaise = grossPaise
      ? Math.round(cart.reduce((total, line) => total + line.minimumPricePaise * line.quantity * (line.gstRates[0] ?? 0), 0)
        * taxablePaise / grossPaise / 100)
      : 0;
    return { grossPaise, discountPaise, taxablePaise, taxPaise: weightedTaxPaise, totalPaise: taxablePaise + weightedTaxPaise };
  }, [cart, discountType, discountValue]);

  const requiresPrescription = cart.some((line) => line.requiresPrescription);

  const searchProducts = (event: FormEvent) => {
    event.preventDefault();
    setQuery(queryInput.trim());
    setPage(1);
  };

  const findCustomer = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await authenticatedFetch(`/api/vendor/pos/customers?q=${encodeURIComponent(customerQuery.trim())}`, { cache: "no-store" });
      const result = await responsePayload<{ customer: LiveCustomer | null }>(response);
      setCustomer(result.customer);
      if (!result.customer) setMessage("No verified live customer matched that exact mobile number or email. Continue as walk-in or verify the details.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Customer lookup failed");
    } finally {
      setBusy(false);
    }
  };

  const capturePrescription = async (event: FormEvent) => {
    event.preventDefault();
    const regulated = cart.filter((line) => line.requiresPrescription);
    if (!regulated.length) {
      setError("Add regulated medicine to the cart before capturing its prescription.");
      return;
    }
    if (!rxFile) {
      setError("Choose the counter prescription document.");
      return;
    }
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const form = new FormData();
      form.set("purpose", "offline_prescription");
      form.set("file", rxFile);
      const upload = await authenticatedFetch("/api/documents", { method: "POST", body: form });
      const uploaded = await responsePayload<{ document: { id: number } }>(upload);
      const response = await authenticatedFetch("/api/vendor/pos/prescriptions", {
        method: "POST",
        body: JSON.stringify({
          documentId: uploaded.document.id,
          customerProfileId: customer?.id ?? null,
          patientName: customer?.name ?? walkInName,
          patientAddress,
          prescriberName,
          prescriberAddress,
          prescribedOn,
          serialNumber,
          items: regulated.map((line) => ({ productId: line.productId, medicineText: line.productName, quantityRequested: line.quantity })),
        }),
      });
      const result = await responsePayload<{ prescription: { id: number; captureNumber: string }; prescriptions: PosPrescription[] }>(response);
      setPrescriptions(result.prescriptions);
      setPrescriptionCaptureId(String(result.prescription.id));
      setRxFile(null);
      setMessage(`${result.prescription.captureNumber} captured for pharmacist review.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The counter prescription could not be captured");
    } finally {
      setBusy(false);
    }
  };

  const reviewPrescription = async (prescription: PosPrescription, decision: "approved" | "rejected" | "clarification_required") => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await authenticatedFetch(`/api/vendor/pos/prescriptions/${prescription.id}/review`, {
        method: "POST",
        body: JSON.stringify({
          decision,
          notes: reviewNotes,
          items: decision === "approved"
            ? prescription.items.map((item) => ({ productId: item.productId, quantityApproved: item.quantityRequested }))
            : [],
        }),
      });
      await responsePayload<{ prescription: { id: number; status: string } }>(response);
      if (decision === "approved") setPrescriptionCaptureId(String(prescription.id));
      setReviewNotes("");
      setMessage(`${prescription.captureNumber} marked ${decision.replaceAll("_", " ")}.`);
      setRefreshVersion((current) => current + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Prescription review failed");
    } finally {
      setBusy(false);
    }
  };

  const openReceipt = async (saleId: number) => {
    setBusy(true);
    setError("");
    try {
      const response = await authenticatedFetch(`/api/vendor/pos/sales/${saleId}`, { cache: "no-store" });
      const result = await responsePayload<{ receipt: PosReceipt }>(response);
      setReceipt(result.receipt);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Counter receipt could not be loaded");
    } finally {
      setBusy(false);
    }
  };

  const submitSale = async () => {
    if (!postingEnabled) {
      setError("Counter posting will activate after the transactional POS migration is installed.");
      return;
    }
    if (!cart.length) {
      setError("Add at least one medicine to the cart.");
      return;
    }
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await authenticatedFetch("/api/vendor/pos/sales", {
        method: "POST",
        body: JSON.stringify({
          idempotencyKey,
          customerProfileId: customer?.id ?? null,
          customerName: customer?.name ?? walkInName,
          customerPhone: customer?.phone ?? walkInPhone,
          paymentMode,
          discountType,
          discountValue,
          buyerGstin,
          placeOfSupplyStateCode,
          prescriptionCaptureId: prescriptionCaptureId || null,
          items: cart.map((line) => ({ productId: line.productId, quantity: line.quantity })),
        }),
      });
      const result = await responsePayload<{ receipt: PosReceipt }>(response);
      setReceipt(result.receipt);
      setMessage(`${result.receipt.saleNumber} completed exactly once.`);
      setCart([]);
      setIdempotencyKey(nextKey());
      setRefreshVersion((current) => current + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The counter sale could not be completed");
    } finally {
      setBusy(false);
    }
  };

  const openInvoice = async (format: "pdf" | "html") => {
    if (!receipt?.invoiceId) return;
    setBusy(true); setError("");
    try {
      const endpoint = `/api/vendor/invoices/${receipt.invoiceId}`;
      if (format === "pdf") await downloadInvoice(endpoint);
      else await printInvoice(endpoint);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The GST invoice is unavailable");
    } finally { setBusy(false); }
  };

  return <div className={styles.workspace}>
    {(error || message) && <div className={`${styles.notice} ${error ? styles.error : styles.success}`}>
      {error ? <AlertTriangle size={17} /> : <CheckCircle2 size={17} />}
      <span>{error || message}</span>
    </div>}

    <section className={styles.catalogPanel}>
      <header className={styles.heading}>
        <div><span>OFFLINE POS</span><h2>Counter catalogue</h2><p>Search governed stock. Exact price, batch and tax allocation remain server-controlled.</p></div>
        <button className={styles.secondaryButton} onClick={() => setRefreshVersion((current) => current + 1)} type="button"><RefreshCw size={15} /> Refresh</button>
      </header>
      <form className={styles.search} onSubmit={searchProducts}>
        <label><Search size={16} /><input onChange={(event) => setQueryInput(event.target.value)} placeholder="Medicine, generic, trade name or manufacturer" value={queryInput} /></label>
        <button type="submit">Search</button>
      </form>
      <div className={styles.catalogGrid}>
        {loading && <div className={styles.empty}>Loading tenant stock…</div>}
        {!loading && !catalog.products.length && <div className={styles.empty}>No eligible stock matched this search.</div>}
        {catalog.products.map((product) => <article className={styles.product} key={product.productId}>
          <div className={styles.productTop}><span className={styles.pillIcon}><Pill size={17} /></span><div><strong>{product.productName}</strong><small>{[product.strengthValue, product.strengthUnit, product.packType].filter(Boolean).join(" ") || product.genericName || "Structured product"}</small></div></div>
          <p>{product.manufacturer || "Manufacturer pending"} · HSN {product.hsnCode || "—"}</p>
          <div className={styles.tags}>
            <span>{product.availableQuantity} available</span><span>{product.batchCount} batch{product.batchCount === 1 ? "" : "es"}</span>
            {product.requiresPrescription && <span className={styles.rx}>Rx review</span>}
            {product.classificationRequired && <span className={styles.blocked}>Classification required</span>}
          </div>
          <div className={styles.productBottom}><strong>{money(product.minimumPricePaise)}{product.minimumPricePaise !== product.maximumPricePaise ? `–${money(product.maximumPricePaise)}` : ""}</strong><button disabled={product.classificationRequired} onClick={() => addProduct(product)} type="button"><Plus size={14} /> Add</button></div>
        </article>)}
      </div>
      <footer className={styles.pagination}><small>{catalog.pagination.total} products</small><div><button aria-label="Previous product page" disabled={page <= 1} onClick={() => setPage((current) => current - 1)} type="button"><ChevronLeft size={15} /></button><span>{page} / {catalog.pagination.totalPages}</span><button aria-label="Next product page" disabled={page >= catalog.pagination.totalPages} onClick={() => setPage((current) => current + 1)} type="button"><ChevronRight size={15} /></button></div></footer>
    </section>

    <aside className={styles.checkout}>
      <header className={styles.heading}><div><span>LIVE CART</span><h2>Counter sale</h2><p>{cart.length} medicine{cart.length === 1 ? "" : "s"} · {cart.reduce((sum, line) => sum + line.quantity, 0)} units</p></div><ReceiptIndianRupee size={23} /></header>
      <div className={styles.cartLines}>
        {!cart.length && <div className={styles.empty}>Add governed stock from the counter catalogue.</div>}
        {cart.map((line) => <article className={styles.cartLine} key={line.productId}>
          <div><strong>{line.productName}</strong><small>{money(line.minimumPricePaise)} each · {line.requiresPrescription ? "Rx" : "OTC"}</small></div>
          <div className={styles.quantity}><button aria-label={`Reduce ${line.productName} quantity`} onClick={() => setQuantity(line.productId, line.quantity - 1)} type="button"><Minus size={13} /></button><input aria-label={`${line.productName} quantity`} max={line.availableQuantity} min="1" onChange={(event) => setQuantity(line.productId, Number(event.target.value))} type="number" value={line.quantity} /><button aria-label={`Increase ${line.productName} quantity`} onClick={() => setQuantity(line.productId, line.quantity + 1)} type="button"><Plus size={13} /></button><button aria-label={`Remove ${line.productName} from cart`} className={styles.trash} onClick={() => removeProduct(line.productId)} type="button"><Trash2 size={14} /></button></div>
        </article>)}
      </div>

      <section className={styles.formSection}><h3><UserRound size={15} /> Customer</h3><form className={styles.inlineForm} onSubmit={(event) => void findCustomer(event)}><input onChange={(event) => setCustomerQuery(event.target.value)} placeholder="Exact mobile or email" value={customerQuery} /><button disabled={busy} type="submit">Find</button></form>
        {customer ? <div className={styles.customer}><span><strong>{customer.name}</strong><small>{customer.phone} · {customer.email}</small></span><button onClick={() => setCustomer(null)} type="button">Clear</button></div> : <div className={styles.twoFields}><label><span>Walk-in name</span><input onChange={(event) => setWalkInName(event.target.value)} value={walkInName} /></label><label><span>Mobile (optional)</span><input inputMode="numeric" maxLength={10} onChange={(event) => setWalkInPhone(event.target.value.replace(/\D/g, "").slice(0, 10))} value={walkInPhone} /></label></div>}
      </section>

      <section className={styles.formSection}><h3><BadgeIndianRupee size={15} /> Billing</h3><div className={styles.twoFields}><label><span>Payment mode</span><select onChange={(event) => setPaymentMode(event.target.value)} value={paymentMode}><option value="cash">Cash</option><option value="upi">UPI</option><option value="card">Card</option><option value="credit">Credit</option></select></label><label><span>Place-of-supply code</span><input inputMode="numeric" maxLength={2} onChange={(event) => setPlaceOfSupplyStateCode(event.target.value.replace(/\D/g, "").slice(0, 2))} value={placeOfSupplyStateCode} /></label><label><span>Discount</span><select onChange={(event) => setDiscountType(event.target.value)} value={discountType}><option value="none">No discount</option><option value="fixed">Fixed ₹</option><option value="percent">Percentage</option></select></label><label><span>Discount value</span><input disabled={discountType === "none"} min="0" onChange={(event) => setDiscountValue(event.target.value)} step="0.01" type="number" value={discountValue} /></label></div><label className={styles.fullField}><span>Buyer GSTIN (optional)</span><input maxLength={15} onChange={(event) => setBuyerGstin(event.target.value.toUpperCase())} value={buyerGstin} /></label></section>

      {requiresPrescription && <section className={`${styles.formSection} ${styles.rxPanel}`}><h3><ShieldCheck size={15} /> Pharmacist approval required</h3><p>The cart includes regulated medicine. Stock cannot post until a same-pharmacy verified pharmacist approves a captured prescription covering the requested quantities.</p><label className={styles.fullField}><span>Approved capture ID</span><input min="1" onChange={(event) => setPrescriptionCaptureId(event.target.value)} placeholder="Created by offline prescription workflow" type="number" value={prescriptionCaptureId} /></label></section>}

      <div className={styles.totals}><div><span>Estimated gross</span><strong>{money(estimate.grossPaise)}</strong></div><div><span>Discount</span><strong>− {money(estimate.discountPaise)}</strong></div><div><span>Taxable</span><strong>{money(estimate.taxablePaise)}</strong></div><div><span>Estimated GST</span><strong>{money(estimate.taxPaise)}</strong></div><div className={styles.grandTotal}><span>Estimated total</span><strong>{money(estimate.totalPaise)}</strong></div><small>Final totals use server-selected FEFO batches and stored prices.</small></div>
      <button className={styles.checkoutButton} disabled={busy || !cart.length || !postingEnabled} onClick={() => void submitSale()} type="button">{busy ? "Posting…" : postingEnabled ? "Complete sale" : "Posting activates with migration 0044"}</button>
    </aside>

    <section className={`${styles.receipt} ${styles.rxWorkspace}`}>
      <header><div><span>COUNTER PRESCRIPTIONS</span><h2>Capture and pharmacist review</h2><p>Documents stay tenant-scoped. Approval is accepted only from a currently verified pharmacist linked to this pharmacy.</p></div><FileUp size={24} /></header>
      <div className={styles.rxColumns}>
        <form className={styles.rxForm} onSubmit={(event) => void capturePrescription(event)}>
          <strong>Capture from current cart</strong>
          <label className={styles.fullField}><span>Prescription file *</span><input accept=".jpg,.jpeg,.png,.pdf,.doc,.docx" onChange={(event) => setRxFile(event.target.files?.[0] ?? null)} type="file" /></label>
          <div className={styles.twoFields}>
            <label><span>Patient address *</span><input onChange={(event) => setPatientAddress(event.target.value)} value={patientAddress} /></label>
            <label><span>Prescriber *</span><input onChange={(event) => setPrescriberName(event.target.value)} value={prescriberName} /></label>
            <label><span>Prescriber address *</span><input onChange={(event) => setPrescriberAddress(event.target.value)} value={prescriberAddress} /></label>
            <label><span>Prescription date *</span><input max={new Date().toISOString().slice(0, 10)} onChange={(event) => setPrescribedOn(event.target.value)} type="date" value={prescribedOn} /></label>
          </div>
          <label className={styles.fullField}><span>Prescription serial (optional)</span><input onChange={(event) => setSerialNumber(event.target.value)} value={serialNumber} /></label>
          <button className={styles.checkoutButton} disabled={busy || !cart.some((line) => line.requiresPrescription)} type="submit">Upload and capture for review</button>
        </form>
        <div className={styles.reviewQueue}>
          <strong>Review queue</strong>
          <label className={styles.fullField}><span>Review notes / rejection reason</span><input onChange={(event) => setReviewNotes(event.target.value)} value={reviewNotes} /></label>
          {!prescriptions.length && <p>No counter prescriptions captured.</p>}
          {prescriptions.slice(0, 8).map((prescription) => <article key={prescription.id}>
            <div><strong>{prescription.captureNumber}</strong><small>{prescription.patientName} · {prescription.prescriberName} · {prescription.prescribedOn}</small><em>{prescription.items.map((item) => `${item.medicineText} × ${item.quantityRequested}`).join(", ")}</em></div>
            <span className={styles.status}>{prescription.status.replaceAll("_", " ")}</span>
            {prescription.status === "uploaded" && <div className={styles.reviewActions}><button disabled={busy} onClick={() => void reviewPrescription(prescription, "approved")} type="button">Approve quantities</button><button disabled={busy || reviewNotes.trim().length < 5} onClick={() => void reviewPrescription(prescription, "rejected")} type="button">Reject</button><button disabled={busy || reviewNotes.trim().length < 5} onClick={() => void reviewPrescription(prescription, "clarification_required")} type="button">Clarify</button></div>}
          </article>)}
        </div>
      </div>
    </section>

    <section className={`${styles.receipt} ${styles.saleHistory}`}>
      <header><div><span>LIVE COUNTER HISTORY</span><h2>Completed receipts</h2><p>Tenant-scoped immutable sales with server-issued GST invoice references.</p></div><ReceiptIndianRupee size={24} /></header>
      <div>{sales.length ? sales.map((sale) => <p key={sale.id}><span>{sale.saleNumber} · {sale.customerName} · {sale.paymentMode.toUpperCase()}</span><strong>{money(sale.totalPaise)} <button disabled={busy} onClick={() => void openReceipt(sale.id)} type="button">View</button></strong></p>) : <p><span>No completed counter sales yet.</span></p>}</div>
    </section>

    {receipt && <section className={styles.receipt}><header><div><span>COUNTER RECEIPT</span><h2>{receipt.saleNumber}</h2><p>{receipt.customerName} · {receipt.paymentMode.toUpperCase()} · {new Date(receipt.createdAt).toLocaleString("en-IN")}</p></div><CheckCircle2 size={25} /></header><div>{receipt.lines.map((line) => <p key={`${line.productName}-${line.batchNumber}`}><span>{line.productName} · {line.batchNumber} × {line.quantity}</span><strong>{money(line.lineTotalPaise)}</strong></p>)}</div><footer><span>Invoice {receipt.invoiceNumber} <button disabled={busy} onClick={() => void openInvoice("pdf")} type="button"><Download size={13} /> PDF</button> <button disabled={busy} onClick={() => void openInvoice("html")} type="button"><Printer size={13} /> Print</button></span><strong>{money(receipt.totalPaise)}</strong></footer></section>}
  </div>;
}
