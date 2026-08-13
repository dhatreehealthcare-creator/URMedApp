"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { CheckCircle2, Factory, RefreshCw, Search, XCircle } from "lucide-react";
import { authenticatedFetch } from "./marketplace-client";

type Manufacturer = { id: number; name: string; linkedProducts: number; aliases: string | null };
type ManufacturerRequest = {
  id: number; requestType: "new" | "rename" | "merge"; submittedVendorName: string | null;
  manufacturerId: number | null; manufacturerName: string | null;
  targetManufacturerId: number | null; targetManufacturerName: string | null;
  proposedName: string; status: "pending" | "approved" | "rejected" | "withdrawn";
  reviewReason: string; version: number;
};
type ManufacturerData = { manufacturers: Manufacturer[]; requests: ManufacturerRequest[] };

export function ManufacturerMaster({ role }: { role: "vendor" | "admin" }) {
  const endpoint = role === "admin" ? "/api/admin/manufacturers" : "/api/vendor/manufacturers";
  const [data, setData] = useState<ManufacturerData>({ manufacturers: [], requests: [] });
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState(role === "admin" ? "pending" : "all");
  const [requestType, setRequestType] = useState<"new" | "rename" | "merge">("new");
  const [sourceId, setSourceId] = useState("");
  const [targetId, setTargetId] = useState("");
  const [proposedName, setProposedName] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    const parameters = new URLSearchParams({ q: query, status, page: "1", pageSize: "50" });
    try {
      const response = await authenticatedFetch(`${endpoint}?${parameters}`, { cache: "no-store" });
      const payload = await response.json() as ManufacturerData & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Manufacturer master could not be loaded");
      setData(payload);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Manufacturer master could not be loaded");
    } finally { setLoading(false); }
  }, [endpoint, query, status]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const propose = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setError(""); setMessage("");
    const response = await authenticatedFetch(endpoint, { method: "POST", body: JSON.stringify({ requestType, manufacturerId: sourceId, targetManufacturerId: targetId, proposedName }) });
    const payload = await response.json() as { error?: string; message?: string };
    if (!response.ok) { setError(payload.error ?? "Manufacturer proposal failed"); return; }
    setMessage(payload.message ?? "Manufacturer proposal submitted."); setProposedName(""); setSourceId(""); setTargetId(""); await load();
  };

  const withdraw = async (id: number) => {
    const response = await authenticatedFetch(`${endpoint}?id=${id}`, { method: "DELETE" });
    const payload = await response.json() as { error?: string };
    if (!response.ok) { setError(payload.error ?? "Request could not be withdrawn"); return; }
    setMessage("Manufacturer request withdrawn."); await load();
  };

  const review = async (item: ManufacturerRequest, action: "approve" | "reject") => {
    const reason = window.prompt(`${action === "approve" ? "Approval" : "Rejection"} reason:`)?.trim() ?? "";
    if (!reason) return;
    const response = await authenticatedFetch(endpoint, { method: "PATCH", body: JSON.stringify({ id: item.id, action, reason }) });
    const payload = await response.json() as { error?: string };
    if (!response.ok) { setError(payload.error ?? "Manufacturer review failed"); return; }
    setMessage(`Manufacturer request ${action === "approve" ? "approved" : "rejected"}.`); await load();
  };

  const describe = (item: ManufacturerRequest) => item.requestType === "new"
    ? `Create ${item.proposedName}`
    : item.requestType === "rename"
      ? `Rename ${item.manufacturerName} to ${item.proposedName}`
      : `Merge ${item.manufacturerName} into ${item.targetManufacturerName}`;

  return <section className="portal-panel manufacturer-master-panel">
    <div className="portal-panel-heading"><div><span className="portal-kicker">CANONICAL MANUFACTURERS</span><h2>{role === "admin" ? "Manufacturer governance" : "Manufacturer proposals"}</h2><p>Products link by canonical manufacturer ID. Renames and merges retain recovered aliases and provenance; only an active administrator changes the global master.</p></div><button className="portal-outline" type="button" onClick={() => void load()}><RefreshCw size={15}/> Refresh</button></div>
    {message && <div className="auth-message success"><CheckCircle2 size={16}/>{message}</div>}
    {error && <div className="auth-message error"><XCircle size={16}/>{error}</div>}
    {role === "vendor" && <form className="portal-form-grid" onSubmit={propose}>
      <label className="portal-field"><span>Change type *</span><select value={requestType} onChange={(event) => setRequestType(event.target.value as typeof requestType)}><option value="new">New manufacturer</option><option value="rename">Rename canonical manufacturer</option><option value="merge">Merge duplicate manufacturer</option></select></label>
      {requestType !== "new" && <label className="portal-field"><span>{requestType === "merge" ? "Duplicate/source manufacturer" : "Manufacturer"} *</span><select value={sourceId} onChange={(event) => setSourceId(event.target.value)} required><option value="">Choose source</option>{data.manufacturers.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>}
      {requestType === "merge" && <label className="portal-field"><span>Canonical target *</span><select value={targetId} onChange={(event) => setTargetId(event.target.value)} required><option value="">Choose target</option>{data.manufacturers.filter((item) => String(item.id) !== sourceId).map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>}
      {requestType !== "merge" && <label className="portal-field"><span>{requestType === "new" ? "Proposed name" : "New canonical name"} *</span><input value={proposedName} onChange={(event) => setProposedName(event.target.value)} maxLength={180} required /></label>}
      <div className="wide"><button className="portal-primary" type="submit">Submit for governance</button></div>
    </form>}
    <form className="product-master-filters" onSubmit={(event) => { event.preventDefault(); void load(); }}><label><Search size={15}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Canonical name, alias or vendor" /></label><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">All requests</option><option value="pending">Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option><option value="withdrawn">Withdrawn</option></select><button className="portal-outline" type="submit">Search</button></form>
    {loading && <div className="recovery-loading"><span className="catalogue-loader"/> Loading manufacturer governance…</div>}
    <div className="manufacturer-master-layout"><div><h3>Active canonical records</h3><div className="manufacturer-master-list">{data.manufacturers.map((item) => <div key={item.id}><Factory size={16}/><span><strong>{item.name}</strong><small>{item.linkedProducts} linked products{item.aliases ? ` · aliases: ${item.aliases}` : ""}</small></span></div>)}</div></div><div><h3>{role === "admin" ? "Governance queue" : "Your requests"}</h3><div className="product-master-list">{data.requests.map((item) => <article key={item.id}><div><span className={`portal-status ${item.status === "approved" ? "green" : item.status === "pending" ? "amber" : "red"}`}>{item.status}</span></div><div><strong>{describe(item)}</strong><small>{item.submittedVendorName ? `Submitted by ${item.submittedVendorName}` : "Tenant proposal"}{item.reviewReason ? ` · ${item.reviewReason}` : ""}</small></div><div className="product-master-actions">{role === "admin" && item.status === "pending" ? <><button className="portal-primary" type="button" onClick={() => void review(item, "approve")}>Approve</button><button className="portal-secondary" type="button" onClick={() => void review(item, "reject")}>Reject</button></> : null}{role === "vendor" && item.status === "pending" ? <button className="portal-secondary" type="button" onClick={() => void withdraw(item.id)}>Withdraw</button> : null}</div></article>)}</div></div></div>
  </section>;
}
