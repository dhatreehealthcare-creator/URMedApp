"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Search, UsersRound } from "lucide-react";
import { authenticatedFetch } from "./marketplace-client";

type Registration = {
  profileId: number; role: string; name: string; email: string; phone: string; accountStatus: string;
  registeredAt: string; businessName: string; registrationStatus: string; approvalStatus: string;
  complianceStatus: string; verificationStatus: string;
};

type Payload = {
  categoryDefinition: string;
  registrations: Registration[];
  counts: { total: number; vendors: number; customers: number; delivery: number; administrators: number; active: number; inactive: number; suspended: number };
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
  error?: string;
};

export function AdminRegistrationList() {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [query, setQuery] = useState("");
  const [role, setRole] = useState("all");
  const [status, setStatus] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setLoading(true); setError("");
    const parameters = new URLSearchParams({ role, status, page: String(page), pageSize: "25" });
    if (query.trim()) parameters.set("q", query.trim());
    if (dateFrom) parameters.set("dateFrom", dateFrom);
    if (dateTo) parameters.set("dateTo", dateTo);
    try {
      const response = await authenticatedFetch(`/api/admin/registrations?${parameters}`, { cache: "no-store" });
      const next = await response.json() as Payload;
      if (!response.ok) throw new Error(next.error || "Registration list is unavailable");
      setPayload(next);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Registration list is unavailable"); }
    finally { setLoading(false); }
  }, [dateFrom, dateTo, page, query, role, status]);
  useEffect(() => { // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);
  const apply = (event: React.FormEvent<HTMLFormElement>) => { event.preventDefault(); setPage(1); void load(); };
  return <section className="portal-panel">
    <div className="portal-panel-heading"><div><span className="portal-kicker">LIVE ACCOUNT REGISTRATIONS</span><h2>Registration directory</h2><p>{payload?.categoryDefinition || "Account category is the live account role; product categories are managed separately."}</p></div><button className="portal-outline" onClick={() => void load()} type="button"><RefreshCw size={15} /> Refresh</button></div>
    <form className="portal-form-grid" onSubmit={apply}>
      <label className="portal-field"><span>Name, email, phone or store</span><input onChange={(event) => setQuery(event.target.value)} placeholder="Search live registrations" value={query} /></label>
      <label className="portal-field"><span>Account category / role</span><select onChange={(event) => { setRole(event.target.value); setPage(1); }} value={role}><option value="all">All roles</option><option value="vendor">Vendor</option><option value="customer">Customer</option><option value="delivery">Delivery</option><option value="admin">Administrator</option></select></label>
      <label className="portal-field"><span>Account status</span><select onChange={(event) => { setStatus(event.target.value); setPage(1); }} value={status}><option value="all">All statuses</option><option value="active">Active</option><option value="inactive">Inactive</option><option value="suspended">Suspended vendor</option></select></label>
      <label className="portal-field"><span>Registered from</span><input onChange={(event) => setDateFrom(event.target.value)} type="date" value={dateFrom} /></label>
      <label className="portal-field"><span>Registered to</span><input onChange={(event) => setDateTo(event.target.value)} type="date" value={dateTo} /></label>
      <button className="portal-primary" type="submit"><Search size={15} /> Apply filters</button>
    </form>
    {error && <div className="recovery-error"><UsersRound size={18} /><span><strong>Registration list unavailable</strong><small>{error}</small></span></div>}
    {payload && <div className="recovery-counts"><article><UsersRound size={19} /><span><small>Filtered registrations</small><strong>{payload.counts.total}</strong></span></article><article><UsersRound size={19} /><span><small>Vendors / customers</small><strong>{payload.counts.vendors} / {payload.counts.customers}</strong></span></article><article><UsersRound size={19} /><span><small>Delivery / admin</small><strong>{payload.counts.delivery} / {payload.counts.administrators}</strong></span></article><article><UsersRound size={19} /><span><small>Active / restricted</small><strong>{payload.counts.active} / {payload.counts.inactive + payload.counts.suspended}</strong></span></article></div>}
    {loading ? <div className="recovery-loading"><span className="catalogue-loader" /> Loading registrations…</div> : payload && <div className="portal-table-wrap"><table className="portal-table"><thead><tr><th>Name / store</th><th>Account category</th><th>Contact</th><th>Verification / onboarding</th><th>Status</th><th>Registered</th></tr></thead><tbody>{payload.registrations.map((item) => <tr key={item.profileId}><td><strong>{item.name || "Name pending"}</strong><small>{item.businessName || "Individual account"}</small></td><td>{item.role}</td><td><strong>{item.email || "Email pending"}</strong><small>{item.phone || "Phone pending"}</small></td><td><strong>{item.verificationStatus.replaceAll("_", " ")}</strong><small>{item.role === "vendor" ? `${item.registrationStatus || "not linked"} · ${item.approvalStatus || "not reviewed"} · ${item.complianceStatus || "not reviewed"}` : "Live account profile"}</small></td><td><span className={`portal-status ${item.accountStatus === "active" ? "green" : "red"}`}>{item.accountStatus}</span></td><td>{item.registeredAt.slice(0, 10)}</td></tr>)}</tbody></table></div>}
    {payload && <div className="panel-actions"><button className="portal-outline" disabled={page <= 1} onClick={() => setPage((current) => current - 1)} type="button">Previous</button><span>Page {payload.pagination.page} of {payload.pagination.totalPages} · {payload.pagination.total} records</span><button className="portal-outline" disabled={page >= payload.pagination.totalPages} onClick={() => setPage((current) => current + 1)} type="button">Next</button></div>}
  </section>;
}
