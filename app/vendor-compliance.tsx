"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, ExternalLink, RefreshCw, ShieldCheck, XCircle } from "lucide-react";

type Application = { vendorId: number; businessName: string; ownerName: string; phone: string; email: string; address: string; approvalStatus: string; complianceStatus: string; registeredAt: string; licenceCount: number; validLicenceCount: number; pharmacistCount: number; validPharmacistCount: number };
type Licence = { id: number; vendorId: number; licenceNumber: string; formType: string; issuingAuthority: string; validFrom: string; validUntil: string; verificationStatus: string; documentId: number; documentName: string };
type Pharmacist = { id: number; vendorId: number; fullName: string; councilName: string; registrationNumber: string; validFrom: string | null; validUntil: string | null; verificationStatus: string; documentId: number; documentName: string };
type Payload = { applications: Application[]; licences: Licence[]; pharmacists: Pharmacist[]; error?: string };

function ReviewStatus({ value }: { value: string }) {
  const tone = value === "verified" || value === "approved" ? "green" : value === "rejected" ? "red" : "amber";
  return <span className={`portal-status ${tone}`}>{value.replaceAll("_", " ")}</span>;
}

export function VendorCompliance() {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [reasons, setReasons] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/admin/vendor-compliance", { cache: "no-store" });
      const payload = await response.json() as Payload;
      if (!response.ok) throw new Error(payload.error || "Vendor applications are unavailable");
      setData(payload);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Vendor applications are unavailable"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const decide = async (entity: "licence" | "pharmacist", id: number, decision: "verified" | "rejected") => {
    const key = `${entity}-${id}`; setBusy(key); setError("");
    try {
      const response = await fetch("/api/admin/vendor-compliance", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ entity, id, decision, reason: reasons[key] || "" }) });
      const payload = await response.json() as Payload;
      if (!response.ok) throw new Error(payload.error || "The decision could not be saved");
      setData(payload);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The decision could not be saved"); }
    finally { setBusy(""); }
  };

  return <div className="portal-stack">
    <section className="portal-panel"><div className="portal-panel-heading"><div><span className="portal-kicker">LIVE COMPLIANCE QUEUE</span><h2>Registered pharmacy review</h2><p>A pharmacy becomes approved only after both a current drug licence and a registered pharmacist are verified.</p></div><button className="portal-outline" onClick={() => void load()} type="button"><RefreshCw size={15} /> Refresh</button></div>
      {loading && <div className="recovery-loading"><span className="catalogue-loader" /> Loading vendor applications…</div>}
      {error && <div className="recovery-error"><AlertTriangle size={18} /><span><strong>Compliance queue unavailable</strong><small>{error}</small></span></div>}
      {data && data.applications.length === 0 && <div className="empty-review"><ShieldCheck size={24} /><strong>No vendor applications yet</strong><small>New registrations will appear here after a vendor submits a profile.</small></div>}
      {data && data.applications.length > 0 && <div className="portal-table-wrap"><table className="portal-table"><thead><tr><th>Pharmacy</th><th>Contact</th><th>Licence</th><th>Pharmacist</th><th>Approval</th></tr></thead><tbody>{data.applications.map((application) => <tr key={application.vendorId}><td><strong>{application.businessName}</strong><small>{application.ownerName} · {application.address || "Address pending"}</small></td><td><strong>{application.phone || "Phone pending"}</strong><small>{application.email}</small></td><td><strong>{application.validLicenceCount}/{application.licenceCount} verified</strong></td><td><strong>{application.validPharmacistCount}/{application.pharmacistCount} verified</strong></td><td><ReviewStatus value={application.approvalStatus} /></td></tr>)}</tbody></table></div>}
    </section>

    {data && <div className="portal-split compliance-review-columns">
      <section className="portal-panel"><div className="portal-panel-heading compact"><div><h2>Drug licences</h2><p>Open the source document and verify dates and authority.</p></div></div><div className="compliance-review-list">{data.licences.map((item) => <article key={item.id}><div className="review-heading"><div><strong>{item.licenceNumber} · Form {item.formType}</strong><small>{item.issuingAuthority} · {item.validFrom} to {item.validUntil}</small></div><ReviewStatus value={item.verificationStatus} /></div><a href={`/api/documents/${item.documentId}`} rel="noreferrer" target="_blank"><ExternalLink size={14} /> {item.documentName || "Open licence document"}</a><textarea onChange={(event) => setReasons((current) => ({ ...current, [`licence-${item.id}`]: event.target.value }))} placeholder="Reason required only when rejecting" rows={2} value={reasons[`licence-${item.id}`] || ""} /><div className="review-actions"><button disabled={busy === `licence-${item.id}`} onClick={() => void decide("licence", item.id, "verified")} type="button"><CheckCircle2 size={15} /> Verify</button><button className="reject" disabled={busy === `licence-${item.id}`} onClick={() => void decide("licence", item.id, "rejected")} type="button"><XCircle size={15} /> Reject</button></div></article>)}</div></section>
      <section className="portal-panel"><div className="portal-panel-heading compact"><div><h2>Pharmacists</h2><p>Verify the State Pharmacy Council registration.</p></div></div><div className="compliance-review-list">{data.pharmacists.map((item) => <article key={item.id}><div className="review-heading"><div><strong>{item.fullName}</strong><small>{item.registrationNumber} · {item.councilName}</small></div><ReviewStatus value={item.verificationStatus} /></div><a href={`/api/documents/${item.documentId}`} rel="noreferrer" target="_blank"><ExternalLink size={14} /> {item.documentName || "Open registration document"}</a><textarea onChange={(event) => setReasons((current) => ({ ...current, [`pharmacist-${item.id}`]: event.target.value }))} placeholder="Reason required only when rejecting" rows={2} value={reasons[`pharmacist-${item.id}`] || ""} /><div className="review-actions"><button disabled={busy === `pharmacist-${item.id}`} onClick={() => void decide("pharmacist", item.id, "verified")} type="button"><CheckCircle2 size={15} /> Verify</button><button className="reject" disabled={busy === `pharmacist-${item.id}`} onClick={() => void decide("pharmacist", item.id, "rejected")} type="button"><XCircle size={15} /> Reject</button></div></article>)}</div></section>
    </div>}
  </div>;
}
