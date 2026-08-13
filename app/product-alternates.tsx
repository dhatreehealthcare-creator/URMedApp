"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Link2, RefreshCw, Search, Unlink, XCircle } from "lucide-react";
import { authenticatedFetch } from "./marketplace-client";

type BaseProduct = { id: number; tradeName: string; genericName: string; dosageFormName: string; strengthValue: string; strengthUnit: string };
type Candidate = { id: number; tradeName: string; genericName: string; dosageFormName: string; strengthValue: string; strengthUnit: string; manufacturerName: string; linkId: number | null; linkStatus: string | null; ownedProposal: number };
type QueueItem = { id: number; productName: string; alternateProductName: string; genericName: string; dosageFormName: string; strengthValue: string; strengthUnit: string; submittedVendorName: string | null; governanceStatus: string; reviewReason: string; currentlyCompatible: number };

export function ProductAlternates({ role, baseProduct }: { role: "vendor" | "admin"; baseProduct?: BaseProduct | null }) {
  const endpoint = role === "admin" ? "/api/admin/product-alternates" : "/api/vendor/product-alternates";
  const [items, setItems] = useState<Array<Candidate | QueueItem>>([]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState(role === "admin" ? "pending" : "all");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (role === "vendor" && !baseProduct) { setItems([]); return; }
    setLoading(true); setError("");
    const parameters = new URLSearchParams({ q: query, status, page: "1", pageSize: "50" });
    if (baseProduct) parameters.set("productId", String(baseProduct.id));
    try {
      const response = await authenticatedFetch(`${endpoint}?${parameters}`, { cache: "no-store" });
      const payload = await response.json() as { candidates?: Candidate[]; alternates?: QueueItem[]; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Alternates could not be loaded");
      setItems(payload.candidates ?? payload.alternates ?? []);
    } catch (reason) {
      setItems([]); setError(reason instanceof Error ? reason.message : "Alternates could not be loaded");
    } finally { setLoading(false); }
  }, [baseProduct, endpoint, query, role, status]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const propose = async (candidate: Candidate) => {
    if (!baseProduct) return;
    setError(""); setMessage("");
    const response = await authenticatedFetch(endpoint, { method: "POST", body: JSON.stringify({ productId: baseProduct.id, alternateProductId: candidate.id }) });
    const payload = await response.json() as { error?: string; message?: string };
    if (!response.ok) { setError(payload.error ?? "Proposal failed"); return; }
    setMessage(payload.message ?? "Proposal submitted for administrator review."); await load();
  };

  const withdraw = async (candidate: Candidate) => {
    if (!candidate.linkId) return;
    const response = await authenticatedFetch(`${endpoint}?id=${candidate.linkId}`, { method: "DELETE" });
    const payload = await response.json() as { error?: string };
    if (!response.ok) { setError(payload.error ?? "Withdrawal failed"); return; }
    setMessage("Pending proposal withdrawn."); await load();
  };

  const review = async (item: QueueItem, action: "approve" | "reject" | "deactivate") => {
    const reason = action === "approve" ? "" : window.prompt(`Clinical-governance reason to ${action}:`)?.trim() ?? "";
    if (action !== "approve" && !reason) return;
    const response = await authenticatedFetch(endpoint, { method: "PATCH", body: JSON.stringify({ id: item.id, action, reason }) });
    const payload = await response.json() as { error?: string };
    if (!response.ok) { setError(payload.error ?? "Review failed"); return; }
    setMessage(`Alternate ${action === "approve" ? "approved" : action === "reject" ? "rejected" : "deactivated"}.`); await load();
  };

  const search = (event: FormEvent) => { event.preventDefault(); void load(); };
  return <section className="portal-panel product-alternate-panel">
    <div className="portal-panel-heading"><div><span className="portal-kicker">GOVERNED ALTERNATES</span><h2>{role === "admin" ? "Clinical alternate review" : baseProduct ? `Alternates for ${baseProduct.tradeName}` : "Choose an approved product"}</h2><p>Matches require the exact normalized generic, dosage form, strength value and unit. A link needs clinical review and never enables automatic substitution.</p></div><button className="portal-outline" onClick={() => void load()} type="button"><RefreshCw size={15} /> Refresh</button></div>
    <div className="portal-note wide"><AlertTriangle size={18} /><span><strong>Clinical decision required</strong><small>Prescribers and pharmacists remain responsible for patient-specific substitution. The system does not replace products automatically.</small></span></div>
    {message && <div className="auth-message success"><CheckCircle2 size={16} />{message}</div>}
    {error && <div className="auth-message error"><XCircle size={16} />{error}</div>}
    {(role === "admin" || baseProduct) && <form className="product-master-filters" onSubmit={search}><label><Search size={15}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Trade, generic, manufacturer or vendor" /></label>{role === "admin" && <select value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">All states</option><option value="pending">Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option><option value="inactive">Inactive</option><option value="withdrawn">Withdrawn</option></select>}<button className="portal-outline" type="submit">Search</button></form>}
    {loading && <div className="recovery-loading"><span className="catalogue-loader"/> Loading governed alternates…</div>}
    <div className="product-master-list">
      {role === "vendor" && (items as Candidate[]).map((item) => <article key={item.id}><div><span className={`portal-status ${item.linkStatus === "approved" ? "green" : item.linkStatus === "pending" ? "amber" : item.linkStatus ? "red" : ""}`}>{item.linkStatus ?? "eligible"}</span></div><div><strong>{item.tradeName}</strong><p>{item.genericName} · {item.strengthValue}{item.strengthUnit} · {item.dosageFormName}</p><small>{item.manufacturerName}</small></div><div className="product-master-actions">{!item.linkStatus || ["rejected", "inactive", "withdrawn"].includes(item.linkStatus) ? <button className="portal-primary" onClick={() => void propose(item)} type="button"><Link2 size={14}/> Propose</button> : null}{item.ownedProposal && item.linkStatus === "pending" ? <button className="portal-secondary" onClick={() => void withdraw(item)} type="button"><Unlink size={14}/> Withdraw</button> : null}</div></article>)}
      {role === "admin" && (items as QueueItem[]).map((item) => <article key={item.id}><div><span className={`portal-status ${item.governanceStatus === "approved" ? "green" : item.governanceStatus === "pending" ? "amber" : "red"}`}>{item.governanceStatus}</span>{!item.currentlyCompatible && <small>Compatibility changed</small>}</div><div><strong>{item.productName} ↔ {item.alternateProductName}</strong><p>{item.genericName} · {item.strengthValue}{item.strengthUnit} · {item.dosageFormName}</p><small>{item.submittedVendorName ? `Proposed by ${item.submittedVendorName}` : "Legacy proposal"}{item.reviewReason ? ` · ${item.reviewReason}` : ""}</small></div><div className="product-master-actions">{item.governanceStatus === "pending" && item.currentlyCompatible ? <button className="portal-primary" onClick={() => void review(item, "approve")} type="button">Approve</button> : null}{item.governanceStatus === "pending" ? <button className="portal-secondary" onClick={() => void review(item, "reject")} type="button">Reject</button> : null}{item.governanceStatus === "approved" ? <button className="portal-secondary" onClick={() => void review(item, "deactivate")} type="button">Deactivate</button> : null}</div></article>)}
    </div>
    {!loading && items.length === 0 && <div className="refill-empty"><Link2 size={19}/><span><strong>No governed alternates found</strong><small>{role === "vendor" && !baseProduct ? "Select Alternates beside an approved product." : "Change the search or governance filter."}</small></span></div>}
  </section>;
}
