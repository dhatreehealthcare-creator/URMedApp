"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { CheckCircle2, Pencil, RefreshCw, Search, ShieldCheck, XCircle } from "lucide-react";
import { authenticatedFetch } from "./marketplace-client";
import { ProductAlternates } from "./product-alternates";
import { ManufacturerMaster } from "./manufacturer-master";

type ProductRole = "vendor" | "admin";

type ProductRow = {
  id: number;
  compatibilityId: number;
  genericName: string;
  tradeName: string;
  dosageFormId: number;
  dosageFormName: string;
  manufacturerId: number;
  manufacturerName: string;
  strengthValue: string;
  strengthUnit: string;
  packType: string;
  packSizeValue: string;
  packSizeUnit: string;
  dispensingUom: string;
  prescriptionRequired: number;
  gstPercent: number;
  hsnCode: string;
  drugSchedule: string;
  productInformation: string;
  coldChainRequired: number;
  governanceStatus: "pending" | "approved" | "rejected" | "inactive";
  active: number;
  ownedSubmission: number;
  submittedVendorName: string | null;
};

type MasterData = {
  products: ProductRow[];
  dosageForms: Array<{ id: number; code: string; name: string }>;
  manufacturers: Array<{ id: number; name: string; linkedProducts: number }>;
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
  filters: { query: string; status: string; manufacturerQuery: string };
};

const emptyForm = {
  id: 0,
  genericName: "",
  tradeName: "",
  dosageFormId: "",
  manufacturerId: "",
  strengthValue: "",
  strengthUnit: "mg",
  packType: "strip",
  packSizeValue: "",
  packSizeUnit: "tablet",
  dispensingUom: "tablet",
  prescriptionRequired: "false",
  gstPercent: "0",
  hsnCode: "",
  drugSchedule: "UNCLASSIFIED",
  productInformation: "",
  coldChainRequired: "false",
};

function toForm(product: ProductRow) {
  return {
    id: product.id,
    genericName: product.genericName ?? "",
    tradeName: product.tradeName ?? "",
    dosageFormId: String(product.dosageFormId ?? ""),
    manufacturerId: String(product.manufacturerId ?? ""),
    strengthValue: product.strengthValue ?? "",
    strengthUnit: product.strengthUnit ?? "mg",
    packType: product.packType ?? "strip",
    packSizeValue: product.packSizeValue ?? "",
    packSizeUnit: product.packSizeUnit ?? "tablet",
    dispensingUom: product.dispensingUom ?? "tablet",
    prescriptionRequired: String(Boolean(product.prescriptionRequired)),
    gstPercent: String(product.gstPercent ?? 0),
    hsnCode: product.hsnCode ?? "",
    drugSchedule: product.drugSchedule ?? "UNCLASSIFIED",
    productInformation: product.productInformation ?? "",
    coldChainRequired: String(Boolean(product.coldChainRequired)),
  };
}

export function ProductMaster({ role }: { role: ProductRole }) {
  const endpoint = role === "admin" ? "/api/admin/products" : "/api/vendor/products";
  const [data, setData] = useState<MasterData | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState(role === "admin" ? "pending" : "all");
  const [manufacturerQuery, setManufacturerQuery] = useState("");
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [alternateBase, setAlternateBase] = useState<ProductRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const parameters = new URLSearchParams({ q: query, status, manufacturerQ: manufacturerQuery, page: String(page), pageSize: "12" });
    try {
      const response = await authenticatedFetch(`${endpoint}?${parameters}`, { cache: "no-store" });
      const payload = await response.json() as MasterData & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Product master could not be loaded");
      setData(payload);
    } catch (reason) {
      setData(null);
      setError(reason instanceof Error ? reason.message : "Product master could not be loaded");
    } finally {
      setLoading(false);
    }
  }, [endpoint, manufacturerQuery, page, query, status]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const field = (name: keyof typeof emptyForm, value: string | number) => setForm((current) => ({ ...current, [name]: value }));

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setMessage("");
    const method = form.id ? "PATCH" : "POST";
    const response = await authenticatedFetch(endpoint, { method, body: JSON.stringify({ ...form, ...(role === "admin" ? { action: "save" } : {}) }) });
    const payload = await response.json() as { error?: string; message?: string };
    if (!response.ok) {
      setError(payload.error ?? "Product could not be saved");
      return;
    }
    setMessage(role === "vendor" ? payload.message ?? "Submission is pending governance review." : "Global product changes saved and audit logged.");
    setForm(emptyForm);
    await load();
  };

  const edit = (product: ProductRow) => {
    setManufacturerQuery(product.manufacturerName ?? "");
    setForm(toForm(product));
  };

  const decide = async (product: ProductRow, action: "approve" | "reject" | "deactivate" | "withdraw") => {
    const reason = action === "approve" || action === "withdraw" ? "" : window.prompt(`Reason to ${action} this product:`)?.trim() ?? "";
    if ((action === "reject" || action === "deactivate") && !reason) return;
    setError("");
    setMessage("");
    const response = await authenticatedFetch(endpoint, { method: "PATCH", body: JSON.stringify({ id: product.id, action, reason }) });
    const payload = await response.json() as { error?: string };
    if (!response.ok) {
      setError(payload.error ?? "Governance action failed");
      return;
    }
    setMessage(`Product ${action === "approve" ? "approved" : action === "withdraw" ? "withdrawn" : `${action}ed`}.`);
    if (form.id === product.id) setForm(emptyForm);
    await load();
  };

  return <div className="portal-stack">
    <section className="portal-panel">
      <div className="portal-panel-heading"><div><span className="portal-kicker">GOVERNED PRODUCT MASTER</span><h2>{role === "admin" ? "Review global medicines" : "Submit a medicine"}</h2><p>{role === "admin" ? "Only active administrators may approve, reject, edit, or deactivate global records." : "Your submission remains inactive until an active administrator approves it."}</p></div><button className="portal-outline" onClick={() => void load()} type="button"><RefreshCw size={15} /> Refresh</button></div>
      {message && <div className="auth-message success"><CheckCircle2 size={16} /> {message}</div>}
      {error && <div className="auth-message error"><XCircle size={16} /> {error}</div>}
      <form className="portal-form-grid" onSubmit={submit}>
        {role === "admin" && !form.id && <div className="portal-note wide"><ShieldCheck size={18} /><span><strong>Select a record below</strong><small>Administrators edit governed records; vendors originate new submissions.</small></span></div>}
        <label className="portal-field"><span>Drug / generic name *</span><input disabled={role === "admin" && !form.id} maxLength={180} onChange={(event) => field("genericName", event.target.value)} required value={form.genericName} /></label>
        <label className="portal-field"><span>Trade name *</span><input disabled={role === "admin" && !form.id} maxLength={240} onChange={(event) => field("tradeName", event.target.value)} required value={form.tradeName} /></label>
        <label className="portal-field"><span>Dosage form *</span><select disabled={role === "admin" && !form.id} onChange={(event) => field("dosageFormId", event.target.value)} required value={form.dosageFormId}><option value="">Choose form</option>{data?.dosageForms.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label className="portal-field"><span>Find manufacturer</span><input disabled={role === "admin" && !form.id} onChange={(event) => setManufacturerQuery(event.target.value)} placeholder="Type manufacturer name" value={manufacturerQuery} /></label>
        <label className="portal-field"><span>Manufacturer *</span><select disabled={role === "admin" && !form.id} onChange={(event) => field("manufacturerId", event.target.value)} required value={form.manufacturerId}><option value="">Choose manufacturer</option>{data?.manufacturers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label className="portal-field"><span>Strength value *</span><input disabled={role === "admin" && !form.id} inputMode="decimal" onChange={(event) => field("strengthValue", event.target.value)} placeholder="650" required value={form.strengthValue} /></label>
        <label className="portal-field"><span>Strength unit *</span><input disabled={role === "admin" && !form.id} onChange={(event) => field("strengthUnit", event.target.value)} placeholder="mg or mg/5ml" required value={form.strengthUnit} /></label>
        <label className="portal-field"><span>Pack type *</span><input disabled={role === "admin" && !form.id} onChange={(event) => field("packType", event.target.value)} placeholder="strip, bottle, vial" required value={form.packType} /></label>
        <label className="portal-field"><span>Pack size *</span><input disabled={role === "admin" && !form.id} inputMode="decimal" onChange={(event) => field("packSizeValue", event.target.value)} placeholder="10" required value={form.packSizeValue} /></label>
        <label className="portal-field"><span>Pack-size unit *</span><input disabled={role === "admin" && !form.id} onChange={(event) => field("packSizeUnit", event.target.value)} placeholder="tablet, capsule, ml" required value={form.packSizeUnit} /></label>
        <label className="portal-field"><span>Dispensing UOM *</span><input disabled={role === "admin" && !form.id} onChange={(event) => field("dispensingUom", event.target.value)} placeholder="tablet, bottle, vial" required value={form.dispensingUom} /></label>
        <label className="portal-field"><span>Prescription required?</span><select disabled={role === "admin" && !form.id} onChange={(event) => field("prescriptionRequired", event.target.value)} value={form.prescriptionRequired}><option value="false">No</option><option value="true">Yes</option></select></label>
        <label className="portal-field"><span>GST default *</span><select disabled={role === "admin" && !form.id} onChange={(event) => field("gstPercent", event.target.value)} value={form.gstPercent}>{[0, 5, 12, 18, 28].map((value) => <option key={value} value={value}>{value}%</option>)}</select></label>
        <label className="portal-field"><span>HSN</span><input disabled={role === "admin" && !form.id} inputMode="numeric" maxLength={8} onChange={(event) => field("hsnCode", event.target.value)} value={form.hsnCode} /></label>
        <label className="portal-field"><span>Drug schedule</span><select disabled={role === "admin" && !form.id} onChange={(event) => field("drugSchedule", event.target.value)} value={form.drugSchedule}>{["UNCLASSIFIED", "OTC", "G", "H", "H1", "X", "NDPS"].map((value) => <option key={value}>{value}</option>)}</select></label>
        <label className="portal-field"><span>Cold-chain required?</span><select disabled={role === "admin" && !form.id} onChange={(event) => field("coldChainRequired", event.target.value)} value={form.coldChainRequired}><option value="false">No</option><option value="true">Yes</option></select></label>
        <label className="portal-field wide"><span>Product information</span><textarea disabled={role === "admin" && !form.id} maxLength={2000} onChange={(event) => field("productInformation", event.target.value)} rows={3} value={form.productInformation} /></label>
        {!(role === "admin" && !form.id) && <div className="wide portal-button-row"><button className="portal-primary" type="submit">{form.id ? "Save structured fields" : "Submit for governance"}</button>{form.id > 0 && <button className="portal-outline" onClick={() => setForm(emptyForm)} type="button">Cancel edit</button>}</div>}
      </form>
    </section>

    <section className="portal-panel">
      <div className="portal-panel-heading"><div><h2>{role === "admin" ? "Governance queue" : "Catalogue and your submissions"}</h2><p>Search and status filters are server-paginated. Internal compatibility IDs are not recovered provenance.</p></div></div>
      <form className="product-master-filters" onSubmit={(event) => { event.preventDefault(); setPage(1); void load(); }}><label><Search size={15} /><input onChange={(event) => setQuery(event.target.value)} placeholder="Drug, trade name, or manufacturer" value={query} /></label><select onChange={(event) => { setStatus(event.target.value); setPage(1); }} value={status}><option value="all">All states</option><option value="pending">Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option><option value="inactive">Inactive</option></select><button className="portal-outline" type="submit">Search</button></form>
      {loading && <div className="recovery-loading"><span className="catalogue-loader" /> Loading governed catalogue…</div>}
      {!loading && data?.products.length === 0 && <div className="refill-empty"><ShieldCheck size={19} /><span><strong>No matching products</strong><small>Change the search or governance filter.</small></span></div>}
      <div className="product-master-list">{data?.products.map((product) => <article key={product.id}><div><span className={`portal-status ${product.governanceStatus === "approved" ? "green" : product.governanceStatus === "pending" ? "amber" : "red"}`}>{product.governanceStatus}</span><small>Compatibility #{product.compatibilityId}</small></div><div><strong>{product.tradeName || product.genericName}</strong><p>{product.genericName} · {product.strengthValue}{product.strengthUnit} · {product.dosageFormName}</p><small>{product.manufacturerName} · {product.packType} {product.packSizeValue}{product.packSizeUnit}{product.submittedVendorName ? ` · submitted by ${product.submittedVendorName}` : ""}</small></div><div className="product-master-actions">{role === "vendor" && product.governanceStatus === "approved" && product.active ? <button className="portal-outline" onClick={() => setAlternateBase(product)} type="button">Alternates</button> : null}{(role === "admin" || (product.ownedSubmission && ["pending", "rejected"].includes(product.governanceStatus))) && <button className="portal-outline" onClick={() => edit(product)} type="button"><Pencil size={14} /> Edit</button>}{role === "admin" && product.governanceStatus !== "approved" && <button className="portal-primary" onClick={() => void decide(product, "approve")} type="button">Approve</button>}{role === "admin" && product.governanceStatus === "pending" && <button className="portal-secondary" onClick={() => void decide(product, "reject")} type="button">Reject</button>}{role === "admin" && product.governanceStatus === "approved" && <button className="portal-secondary" onClick={() => void decide(product, "deactivate")} type="button">Deactivate</button>}{role === "vendor" && product.ownedSubmission && ["pending", "rejected"].includes(product.governanceStatus) && <button className="portal-secondary" onClick={() => void decide(product, "withdraw")} type="button">Withdraw</button>}</div></article>)}</div>
      {data && <div className="pagination-controls"><button className="portal-outline" disabled={data.pagination.page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))} type="button">Previous</button><span>Page {data.pagination.page} of {data.pagination.totalPages} · {data.pagination.total} products</span><button className="portal-outline" disabled={data.pagination.page >= data.pagination.totalPages} onClick={() => setPage((value) => value + 1)} type="button">Next</button></div>}
    </section>
    <ManufacturerMaster role={role} />
    {role === "vendor" ? <ProductAlternates role="vendor" baseProduct={alternateBase} /> : <ProductAlternates role="admin" />}
  </div>;
}
