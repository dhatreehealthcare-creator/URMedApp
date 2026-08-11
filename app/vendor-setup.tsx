"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, FileCheck2, Landmark, LockKeyhole, RefreshCw, ShieldCheck, Upload, UserRoundCheck } from "lucide-react";
import { authenticatedFetch, getAuthClient } from "./marketplace-client";
import { GeoLocationPicker } from "./geo-location-picker";

type Vendor = {
  id: number; businessName: string; ownerName: string; phone: string; landline: string; email: string;
  gstNumber: string; address: string; latitude: string; longitude: string; homeDelivery: number;
  approvalStatus: string; complianceStatus: string; deliveryRadiusKm: number; phoneVerified: number;
};
type Bank = { bankName: string; accountName: string; accountLast4: string; ifscCode: string; verificationStatus: string } | null;
type Licence = { id: number; licenceNumber: string; formType: string; issuingAuthority: string; issuedOn: string | null; validFrom: string; validUntil: string; documentName: string; verificationStatus: string };
type Pharmacist = { id: number; fullName: string; councilName: string; registrationNumber: string; validFrom: string | null; validUntil: string | null; documentName: string; verificationStatus: string; active: number };
type Setup = { vendor: Vendor; bank: Bank; licences: Licence[]; pharmacists: Pharmacist[] };

async function responsePayload(response: Response) {
  const raw = await response.text();
  let payload: Record<string, unknown> = {};
  try { payload = raw ? JSON.parse(raw) as Record<string, unknown> : {}; } catch { payload = { error: raw || "The server returned an unreadable response" }; }
  if (!response.ok) throw new Error(String(payload.error || (response.status === 401 ? "Sign in with the vendor account to continue" : "The vendor request could not be completed")));
  return payload;
}

function Status({ value }: { value: string }) {
  const tone = value === "verified" || value === "approved" ? "green" : value === "rejected" || value === "suspended" ? "red" : "amber";
  return <span className={`portal-status ${tone}`}>{value.replaceAll("_", " ")}</span>;
}

export function VendorSetup({ registrationMode = false }: { registrationMode?: boolean }) {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [licenceFile, setLicenceFile] = useState<File | null>(null);
  const [pharmacistFile, setPharmacistFile] = useState<File | null>(null);
  const [phoneDraft, setPhoneDraft] = useState("");
  const [phoneOtp, setPhoneOtp] = useState("");
  const [phoneOtpSent, setPhoneOtpSent] = useState(false);
  const [phoneVerified, setPhoneVerified] = useState(false);
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const response = await authenticatedFetch("/api/vendor/setup", { cache: "no-store" });
      const result = await responsePayload(response) as unknown as Setup;
      setSetup(result); setPhoneDraft(result.vendor.phone); setPhoneVerified(Boolean(result.vendor.phoneVerified));
      setLatitude(result.vendor.latitude || ""); setLongitude(result.vendor.longitude || "");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Vendor setup is unavailable");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const save = async (action: string, values: Record<string, unknown>) => {
    setBusy(action); setError(""); setMessage("");
    try {
      const response = await authenticatedFetch("/api/vendor/setup", { method: "POST", body: JSON.stringify({ action, ...values }) });
      const result = await responsePayload(response) as unknown as Setup & { saved: boolean };
      setSetup(result);
      setMessage(`${action === "profile" ? "Pharmacy profile" : action === "bank" ? "Bank details" : action === "licence" ? "Drug licence" : "Pharmacist registration"} saved successfully.`);
    } finally { setBusy(""); }
  };

  const upload = async (file: File | null, purpose: string) => {
    if (!file) throw new Error("Choose the supporting document first");
    const form = new FormData(); form.set("file", file); form.set("purpose", purpose);
    const response = await authenticatedFetch("/api/documents", { method: "POST", body: form });
    const result = await responsePayload(response) as { document: { id: number } };
    return result.document.id;
  };

  const sendPhoneOtp = async () => {
    setBusy("phone-otp"); setError(""); setMessage("");
    try {
      if (!/^\d{10}$/.test(phoneDraft)) throw new Error("Enter a valid 10-digit Indian mobile number");
      const client = await getAuthClient();
      if (!client) throw new Error("OTP service keys are not connected yet");
      const { error: authError } = await client.auth.updateUser({ phone: `+91${phoneDraft}` });
      if (authError) throw authError;
      setPhoneOtpSent(true); setMessage("OTP sent to the new phone number.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Phone OTP could not be sent"); }
    finally { setBusy(""); }
  };

  const verifyPhoneOtp = async () => {
    setBusy("phone-otp"); setError(""); setMessage("");
    try {
      if (!/^\d{6}$/.test(phoneOtp)) throw new Error("Enter the 6-digit OTP");
      const client = await getAuthClient();
      if (!client) throw new Error("OTP service keys are not connected yet");
      const { error: authError } = await client.auth.verifyOtp({ phone: `+91${phoneDraft}`, token: phoneOtp, type: "phone_change" });
      if (authError) throw authError;
      setPhoneVerified(true); setPhoneOtpSent(false); setPhoneOtp(""); setMessage("Phone number verified. You can save the pharmacy profile.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Phone OTP could not be verified"); }
    finally { setBusy(""); }
  };

  const submitPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const formElement = event.currentTarget; const form = new FormData(formElement);
    const password = String(form.get("password") || ""); const confirm = String(form.get("confirmPassword") || "");
    setBusy("password"); setError(""); setMessage("");
    try {
      if (password.length < 8) throw new Error("The new password must contain at least 8 characters");
      if (password !== confirm) throw new Error("The new password and confirmation do not match");
      const client = await getAuthClient();
      if (!client) throw new Error("Authentication keys are not connected yet");
      const { error: authError } = await client.auth.updateUser({ password });
      if (authError) throw authError;
      formElement.reset(); setMessage("Password changed securely.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Password could not be changed"); }
    finally { setBusy(""); }
  };

  const submitProfile = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    void save("profile", Object.fromEntries(form.entries())).catch((reason) => setError(reason instanceof Error ? reason.message : "Profile could not be saved"));
  };
  const submitBank = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    void save("bank", Object.fromEntries(form.entries())).catch((reason) => setError(reason instanceof Error ? reason.message : "Bank details could not be saved"));
  };
  const submitLicence = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    void (async () => { setBusy("licence"); setError(""); const documentId = await upload(licenceFile, "drug_licence"); await save("licence", { ...Object.fromEntries(form.entries()), documentId }); setLicenceFile(null); })().catch((reason) => { setBusy(""); setError(reason instanceof Error ? reason.message : "Licence could not be submitted"); });
  };
  const submitPharmacist = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    void (async () => { setBusy("pharmacist"); setError(""); const documentId = await upload(pharmacistFile, "pharmacist_registration"); await save("pharmacist", { ...Object.fromEntries(form.entries()), documentId }); setPharmacistFile(null); })().catch((reason) => { setBusy(""); setError(reason instanceof Error ? reason.message : "Pharmacist registration could not be submitted"); });
  };

  if (loading) return <section className="portal-panel"><div className="recovery-loading"><span className="catalogue-loader" /> Loading the secured pharmacy profile…</div></section>;
  if (!setup) return <section className="portal-panel vendor-setup-gate"><AlertTriangle size={23} /><div><h2>Vendor sign-in required</h2><p>{error || "Create or sign in to a vendor account above, then complete the pharmacy profile."}</p></div><button className="portal-outline" onClick={() => void load()} type="button"><RefreshCw size={15} /> Try again</button></section>;

  const { vendor, bank, licences, pharmacists } = setup;
  return <div className="portal-stack vendor-setup-live">
    <section className="portal-panel setup-progress"><div><span className="portal-kicker">LIVE VENDOR ONBOARDING</span><h2>{registrationMode ? "Complete pharmacy verification" : "Pharmacy profile and compliance"}</h2><p>Your email stays read-only. Private address, bank and compliance records are never shown to customers.</p></div><div className="setup-statuses"><Status value={vendor.approvalStatus} /><Status value={vendor.complianceStatus} /></div></section>
    {message && <div className="portal-success"><CheckCircle2 size={18} /><span>{message}</span></div>}
    {error && <div className="recovery-error"><AlertTriangle size={18} /><span><strong>Action needed</strong><small>{error}</small></span></div>}

    <section className="portal-panel"><div className="portal-panel-heading"><div><span className="portal-kicker">PHARMACY PROFILE</span><h2>Business and delivery details</h2><p>The registered email cannot be changed here. Phone numbers and GSTIN are checked before saving.</p></div><ShieldCheck size={22} /></div>
      <form className="portal-form-grid" onSubmit={submitProfile}>
        <label className="portal-field"><span>Shop / business name *</span><input defaultValue={vendor.businessName} name="businessName" required /></label>
        <label className="portal-field"><span>Owner name *</span><input defaultValue={vendor.ownerName} name="ownerName" required /></label>
        <label className="portal-field"><span>10-digit phone *</span><input inputMode="numeric" maxLength={10} name="phone" onChange={(event) => { setPhoneDraft(event.target.value.replace(/\D/g, "")); setPhoneVerified(false); setPhoneOtpSent(false); }} pattern="[0-9]{10}" required value={phoneDraft} /><small>{phoneVerified ? "OTP verified" : "OTP verification required before saving"}</small></label>
        <label className="portal-field"><span>10-digit landline</span><input defaultValue={vendor.landline} inputMode="numeric" maxLength={10} name="landline" pattern="[0-9]{10}" /></label>
        <label className="portal-field"><span>Verified email</span><input defaultValue={vendor.email} readOnly /></label>
        <label className="portal-field"><span>GSTIN</span><input defaultValue={vendor.gstNumber} maxLength={15} name="gstNumber" /></label>
        <label className="portal-field wide"><span>Registered address *</span><textarea defaultValue={vendor.address} name="address" required rows={3} /></label>
        <input name="latitude" type="hidden" value={latitude} /><input name="longitude" type="hidden" value={longitude} />
        <GeoLocationPicker label="Pharmacy entrance and dispatch location" latitude={latitude} longitude={longitude} onChange={(location) => { setLatitude(location.latitude); setLongitude(location.longitude); }} />
        <label className="portal-field"><span>Home delivery</span><select defaultValue={vendor.homeDelivery ? "1" : ""} name="homeDelivery"><option value="1">Yes</option><option value="">No</option></select></label>
        <label className="portal-field"><span>Delivery radius (km)</span><input defaultValue={vendor.deliveryRadiusKm || 5} max="50" min="1" name="deliveryRadiusKm" type="number" /></label>
        <div className="phone-verify-row wide"><button className="portal-outline" disabled={Boolean(busy) || phoneVerified} onClick={() => void sendPhoneOtp()} type="button">{phoneVerified ? "Phone verified" : busy === "phone-otp" ? "Sending…" : "Send phone OTP"}</button>{phoneOtpSent && <><input aria-label="Phone OTP" inputMode="numeric" maxLength={6} onChange={(event) => setPhoneOtp(event.target.value.replace(/\D/g, ""))} placeholder="6-digit OTP" value={phoneOtp} /><button className="portal-secondary" disabled={Boolean(busy) || phoneOtp.length !== 6} onClick={() => void verifyPhoneOtp()} type="button">Verify OTP</button></>}</div>
        <button className="portal-primary wide" disabled={Boolean(busy) || !phoneVerified} type="submit">{busy === "profile" ? "Saving…" : "Save pharmacy profile"}</button>
      </form>
    </section>

    <section className="portal-panel"><div className="portal-panel-heading"><div><span className="portal-kicker">SETTLEMENT ACCOUNT</span><h2>Bank details</h2><p>The account number is encrypted before storage; only its last four digits are returned.</p></div><Landmark size={22} /></div>
      {bank && <div className="saved-record"><Landmark size={18} /><div><strong>{bank.bankName} · •••• {bank.accountLast4}</strong><small>{bank.accountName} · {bank.ifscCode}</small></div><Status value={bank.verificationStatus} /></div>}
      <form className="portal-form-grid" onSubmit={submitBank}><label className="portal-field"><span>Bank name *</span><input defaultValue={bank?.bankName || ""} name="bankName" required /></label><label className="portal-field"><span>Account name *</span><input defaultValue={bank?.accountName || vendor.businessName} name="accountName" required /></label><label className="portal-field"><span>Account number *</span><input autoComplete="off" inputMode="numeric" maxLength={18} minLength={8} name="accountNumber" pattern="[0-9]{8,18}" required /></label><label className="portal-field"><span>IFSC code *</span><input defaultValue={bank?.ifscCode || ""} maxLength={11} name="ifscCode" pattern="[A-Za-z]{4}0[A-Za-z0-9]{6}" required /></label><button className="portal-secondary wide" disabled={Boolean(busy)} type="submit">{busy === "bank" ? "Encrypting and saving…" : "Save encrypted bank details"}</button></form>
    </section>

    <section className="portal-panel"><div className="portal-panel-heading compact"><div><span className="portal-kicker">ACCOUNT SECURITY</span><h2>Change password</h2><p>Use a strong password that is not used for another service.</p></div><LockKeyhole size={21} /></div><form className="portal-form-grid" onSubmit={submitPassword}><label className="portal-field"><span>New password *</span><input autoComplete="new-password" minLength={8} name="password" required type="password" /></label><label className="portal-field"><span>Confirm new password *</span><input autoComplete="new-password" minLength={8} name="confirmPassword" required type="password" /></label><button className="portal-secondary wide" disabled={Boolean(busy)} type="submit">{busy === "password" ? "Changing…" : "Change password securely"}</button></form></section>

    <div className="portal-split compliance-forms">
      <section className="portal-panel"><div className="portal-panel-heading compact"><div><span className="portal-kicker">DRUG LICENCE</span><h2>Licence verification</h2><p>Supported forms: 20, 21, 20B, 21B, 20F and 21F.</p></div><FileCheck2 size={21} /></div>
        <form className="portal-form-grid one" onSubmit={submitLicence}><label className="portal-field"><span>Licence number *</span><input name="licenceNumber" required /></label><label className="portal-field"><span>Form *</span><select name="formType" required>{["20", "21", "20B", "21B", "20F", "21F"].map((form) => <option key={form}>{form}</option>)}</select></label><label className="portal-field"><span>Issuing authority *</span><input defaultValue="Drugs Control Administration" name="issuingAuthority" required /></label><label className="portal-field"><span>Issue date</span><input name="issuedOn" type="date" /></label><label className="portal-field"><span>Valid from *</span><input name="validFrom" required type="date" /></label><label className="portal-field"><span>Valid until *</span><input name="validUntil" required type="date" /></label><label className="portal-field"><span>Licence document *</span><div className="file-control"><Upload size={17} /><span>{licenceFile?.name || "Choose JPG, PNG, PDF, DOC or DOCX"}</span><input accept=".jpg,.jpeg,.png,.pdf,.doc,.docx" onChange={(event) => setLicenceFile(event.target.files?.[0] || null)} required type="file" /></div></label><button className="portal-primary wide" disabled={Boolean(busy)} type="submit">{busy === "licence" ? "Validating and uploading…" : "Submit licence for review"}</button></form>
        <div className="saved-record-list">{licences.map((item) => <div className="saved-record" key={item.id}><FileCheck2 size={17} /><div><strong>{item.licenceNumber} · Form {item.formType}</strong><small>Valid until {item.validUntil} · {item.documentName}</small></div><Status value={item.verificationStatus} /></div>)}</div>
      </section>

      <section className="portal-panel"><div className="portal-panel-heading compact"><div><span className="portal-kicker">REGISTERED PHARMACIST</span><h2>Pharmacist verification</h2><p>Add the State Pharmacy Council registration used for dispensing.</p></div><UserRoundCheck size={21} /></div>
        <form className="portal-form-grid one" onSubmit={submitPharmacist}><label className="portal-field"><span>Pharmacist full name *</span><input name="fullName" required /></label><label className="portal-field"><span>State Pharmacy Council *</span><input defaultValue="Telangana State Pharmacy Council" name="councilName" required /></label><label className="portal-field"><span>Registration number *</span><input name="registrationNumber" required /></label><label className="portal-field"><span>Valid from</span><input name="validFrom" type="date" /></label><label className="portal-field"><span>Valid until</span><input name="validUntil" type="date" /></label><label className="portal-field"><span>Registration document *</span><div className="file-control"><Upload size={17} /><span>{pharmacistFile?.name || "Choose JPG, PNG, PDF, DOC or DOCX"}</span><input accept=".jpg,.jpeg,.png,.pdf,.doc,.docx" onChange={(event) => setPharmacistFile(event.target.files?.[0] || null)} required type="file" /></div></label><button className="portal-primary wide" disabled={Boolean(busy)} type="submit">{busy === "pharmacist" ? "Validating and uploading…" : "Submit pharmacist for review"}</button></form>
        <div className="saved-record-list">{pharmacists.map((item) => <div className="saved-record" key={item.id}><UserRoundCheck size={17} /><div><strong>{item.fullName}</strong><small>{item.registrationNumber} · {item.councilName}</small></div><Status value={item.verificationStatus} /></div>)}</div>
      </section>
    </div>
  </div>;
}
