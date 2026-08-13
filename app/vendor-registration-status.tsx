"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, BadgeCheck, CheckCircle2, Clock3, FileCheck2, RefreshCw, ShieldCheck, Store, UserRoundCheck } from "lucide-react";
import { authenticatedFetch } from "./marketplace-client";

type StatusPayload = {
  identity: { email: string; phone: string; emailVerified: boolean; phoneVerified: boolean; verificationStatus: string };
  registration: {
    businessName: string; ownerName: string; registrationStatus: string; registrationSubmittedAt: string | null;
    approvalStatus: string; complianceStatus: string; reviewNote: string; currentLicenceCount: number;
    verifiedLicenceCount: number; pharmacistCount: number; verifiedPharmacistCount: number; nextAction: string;
  };
  licences: Array<{ id: number; licenceNumber: string; formType: string; validUntil: string; verificationStatus: string; documentName: string }>;
  pharmacists: Array<{ id: number; fullName: string; councilName: string; registrationNumber: string; validUntil: string | null; verificationStatus: string; active: number }>;
};

const actionCopy: Record<string, { title: string; detail: string }> = {
  verify_email: { title: "Verify your account email", detail: "Open the verification message, then return to URMED and sign in again." },
  verify_phone: { title: "Verify your mobile number", detail: "Return to vendor onboarding and complete the phone OTP step." },
  complete_registration: { title: "Complete vendor registration", detail: "Add the business, private location, and current drug-licence package." },
  resolve_rejection: { title: "Registration needs correction", detail: "Review the administrator note and update the rejected compliance record." },
  add_pharmacist: { title: "Add the registered pharmacist", detail: "Administrator approval requires a verified current licence and pharmacist registration." },
  awaiting_review: { title: "Administrator review is in progress", detail: "Your submitted records remain visible here while compliance review is completed." },
  operational: { title: "Pharmacy is approved", detail: "Verification and compliance review are complete. Operational vendor access is available." },
};

function StatePill({ complete, children }: { complete: boolean; children: React.ReactNode }) {
  return <span className={`milestone-state ${complete ? "complete" : "pending"}`}>{complete ? <CheckCircle2 size={15} /> : <Clock3 size={15} />}{children}</span>;
}

export function VendorRegistrationStatus() {
  const [data, setData] = useState<StatusPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const response = await authenticatedFetch("/api/vendor/registration/status", { cache: "no-store" });
      const payload = await response.json() as StatusPayload & { error?: string };
      if (!response.ok) throw new Error(payload.error || (response.status === 401 ? "Sign in with your vendor account to view registration status." : "Registration status is unavailable."));
      setData(payload);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Registration status is unavailable."); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const next = data ? actionCopy[data.registration.nextAction] ?? actionCopy.awaiting_review : actionCopy.awaiting_review;
  return <main className="vendor-milestone-page">
    <section className="vendor-milestone-shell status-shell">
      <div className="milestone-topline"><Link className="milestone-back" href="/vendor"><ArrowLeft size={16} /> Vendor account</Link><button className="portal-outline" disabled={loading} onClick={() => void load()} type="button"><RefreshCw size={15} /> Refresh status</button></div>
      {loading && <div className="milestone-loading"><span className="catalogue-loader" /> Loading secured registration status…</div>}
      {error && <div className="milestone-error"><AlertTriangle size={23} /><div><strong>Registration status needs sign-in</strong><p>{error}</p><Link className="portal-primary" href="/vendor">Go to vendor sign-in</Link></div></div>}
      {data && <>
        <header className={`status-milestone-hero ${data.registration.nextAction}`}><span><Store size={27} /></span><div><small>VENDOR REGISTRATION STATUS</small><h1>{data.registration.businessName}</h1><p>{next.title}. {next.detail}</p><div className="setup-statuses"><StatePill complete={data.registration.registrationStatus === "submitted"}>Registration {data.registration.registrationStatus}</StatePill><StatePill complete={data.registration.approvalStatus === "approved"}>Administrator {data.registration.approvalStatus}</StatePill></div></div></header>
        <div className="status-milestone-grid">
          <article><span><ShieldCheck size={21} /></span><div><small>IDENTITY</small><h2>Verified contact</h2><StatePill complete={data.identity.emailVerified}>Email {data.identity.emailVerified ? "verified" : "pending"}</StatePill><StatePill complete={data.identity.phoneVerified}>Phone {data.identity.phoneVerified ? "verified" : "pending"}</StatePill><p>{data.identity.email}<br />{data.identity.phone ? `+91 ${data.identity.phone}` : "Phone pending"}</p></div></article>
          <article><span><FileCheck2 size={21} /></span><div><small>DRUG LICENCE</small><h2>{data.registration.verifiedLicenceCount}/{data.registration.currentLicenceCount} verified</h2>{data.licences.length ? data.licences.map((row) => <div className="milestone-record" key={row.id}><strong>{row.licenceNumber} · Form {row.formType}</strong><small>Valid until {row.validUntil} · {row.verificationStatus.replaceAll("_", " ")}</small></div>) : <p>No current licence submitted.</p>}</div></article>
          <article><span><UserRoundCheck size={21} /></span><div><small>PHARMACIST</small><h2>{data.registration.verifiedPharmacistCount}/{data.registration.pharmacistCount} verified</h2>{data.pharmacists.length ? data.pharmacists.map((row) => <div className="milestone-record" key={row.id}><strong>{row.fullName}</strong><small>{row.registrationNumber} · {row.verificationStatus.replaceAll("_", " ")}</small></div>) : <p>Add the registered pharmacist after the vendor registration package is submitted.</p>}</div></article>
          <article><span><BadgeCheck size={21} /></span><div><small>ADMINISTRATOR REVIEW</small><h2>{data.registration.approvalStatus.replaceAll("_", " ")}</h2><StatePill complete={data.registration.complianceStatus === "verified"}>Compliance {data.registration.complianceStatus}</StatePill>{data.registration.reviewNote && <p className="review-note">{data.registration.reviewNote}</p>}<p>{data.registration.registrationSubmittedAt ? `Submitted ${new Date(data.registration.registrationSubmittedAt).toLocaleString("en-IN")}` : "The registration package has not been submitted."}</p></div></article>
        </div>
        <footer className="status-milestone-actions"><div><strong>{next.title}</strong><p>{next.detail}</p></div><Link className="portal-primary" href="/vendor">{data.registration.nextAction === "operational" ? "Open vendor workspace" : "Continue vendor onboarding"}</Link></footer>
      </>}
    </section>
  </main>;
}

