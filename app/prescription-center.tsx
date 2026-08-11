"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Eye, FileCheck2, RefreshCw, Upload, XCircle } from "lucide-react";
import { authenticatedFetch } from "./marketplace-client";

type Prescription = {
  id: number; prescriptionNumber: string; vendorId: number; businessName: string; documentId: number;
  documentName: string; patientName: string; patientAddress: string; prescriberName: string;
  prescriberAddress: string; prescribedOn: string; serialNumber: string; status: string;
  rejectionReason: string; reviewNotes: string | null; orderNumbers: string | null; createdAt: string;
  customerName?: string; customerPhone?: string;
};

async function payload<T>(response: Response): Promise<T & { error?: string }> {
  const raw = await response.text(); let result: Record<string, unknown> = {};
  try { result = raw ? JSON.parse(raw) as Record<string, unknown> : {}; } catch { result = { error: raw }; }
  if (!response.ok) throw new Error(String(result.error || "The prescription request could not be completed"));
  return result as T & { error?: string };
}

function RxStatus({ value }: { value: string }) {
  const tone = value === "approved" ? "green" : value === "rejected" ? "red" : "amber";
  return <span className={`portal-status ${tone}`}>{value.replaceAll("_", " ")}</span>;
}

export function PrescriptionCenter({ role, vendorId = 0, selectedId = 0, onSelect }: {
  role: "customer" | "vendor"; vendorId?: number; selectedId?: number; onSelect?: (id: number) => void;
}) {
  const [records, setRecords] = useState<Prescription[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [replacementId, setReplacementId] = useState(0);
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [medicines, setMedicines] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const response = await authenticatedFetch("/api/prescriptions", { cache: "no-store" });
      setRecords((await payload<{ prescriptions: Prescription[] }>(response)).prescriptions);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Prescriptions are unavailable"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const openDocument = async (documentId: number) => {
    setBusy(`open-${documentId}`); setError("");
    try {
      const response = await authenticatedFetch(`/api/documents/${documentId}`, { cache: "no-store" });
      if (!response.ok) throw new Error((await response.text()) || "Document could not be opened");
      const objectUrl = URL.createObjectURL(await response.blob());
      window.open(objectUrl, "_blank", "noopener,noreferrer");
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Document could not be opened"); }
    finally { setBusy(""); }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const formElement = event.currentTarget; const form = new FormData(formElement);
    const targetVendorId = replacementId ? records.find((record) => record.id === replacementId)?.vendorId || 0 : vendorId;
    setBusy("upload"); setError(""); setMessage("");
    try {
      if (!targetVendorId) throw new Error("Choose an available medicine and pharmacy before uploading a prescription");
      if (!file) throw new Error("Choose the prescription image or PDF first");
      const uploadForm = new FormData(); uploadForm.set("file", file); uploadForm.set("purpose", "prescription");
      const uploaded = await payload<{ document: { id: number } }>(await authenticatedFetch("/api/documents", { method: "POST", body: uploadForm }));
      const response = await authenticatedFetch("/api/prescriptions", { method: "POST", body: JSON.stringify({
        ...Object.fromEntries(form.entries()), vendorId: targetVendorId, documentId: uploaded.document.id,
        replacePrescriptionId: replacementId || undefined,
      }) });
      const result = await payload<{ prescription: { id: number }; prescriptions: Prescription[] }>(response);
      setRecords(result.prescriptions); onSelect?.(result.prescription.id); setReplacementId(0); setFile(null); formElement.reset();
      setMessage("Prescription submitted securely for pharmacist review.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Prescription could not be submitted"); }
    finally { setBusy(""); }
  };

  const review = async (id: number, decision: "approved" | "rejected" | "clarification_required") => {
    setBusy(`review-${id}`); setError(""); setMessage("");
    try {
      const items = (medicines[id] || "").split(";").map((medicineText) => medicineText.trim()).filter(Boolean).map((medicineText) => ({ medicineText }));
      const response = await authenticatedFetch(`/api/prescriptions/${id}/review`, { method: "POST", body: JSON.stringify({ decision, notes: notes[id] || "", items }) });
      const result = await payload<{ pharmacist: string }>(response);
      setMessage(`Review saved by ${result.pharmacist}.`); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Prescription review could not be saved"); }
    finally { setBusy(""); }
  };

  const eligible = records.filter((record) => record.vendorId === vendorId && !record.orderNumbers && ["uploaded", "approved"].includes(record.status));
  if (loading) return <section className="portal-panel"><div className="recovery-loading"><span className="catalogue-loader" /> Loading secured prescriptions…</div></section>;

  return <section className="portal-panel prescription-centre"><div className="portal-panel-heading"><div><span className="portal-kicker">{role === "customer" ? "SECURE PRESCRIPTION" : "PHARMACIST REVIEW QUEUE"}</span><h2>{role === "customer" ? "Upload and track prescriptions" : "Review prescription orders"}</h2><p>{role === "customer" ? "Only the selected pharmacy and its verified pharmacist can open this document." : "Only a verified pharmacist linked to this pharmacy can approve or reject a prescription."}</p></div><button className="portal-outline" onClick={() => void load()} type="button"><RefreshCw size={15} /> Refresh</button></div>
    {message && <div className="portal-success"><CheckCircle2 size={18} /><span>{message}</span></div>}
    {error && <div className="recovery-error"><AlertTriangle size={18} /><span><strong>Prescription action needed</strong><small>{error}</small></span></div>}

    {role === "customer" && <>
      <form className="portal-form-grid" onSubmit={submit}>
        {replacementId > 0 && <div className="prescription-replacement wide"><AlertTriangle size={17} /><span>Replacing {records.find((record) => record.id === replacementId)?.prescriptionNumber}</span><button onClick={() => setReplacementId(0)} type="button">Cancel</button></div>}
        <label className="portal-field"><span>Patient name *</span><input name="patientName" required /></label><label className="portal-field"><span>Prescription date *</span><input max={new Date().toISOString().slice(0, 10)} name="prescribedOn" required type="date" /></label>
        <label className="portal-field wide"><span>Patient address *</span><textarea name="patientAddress" required rows={2} /></label><label className="portal-field"><span>Doctor / prescriber name *</span><input name="prescriberName" required /></label><label className="portal-field"><span>Prescription serial number</span><input name="serialNumber" /></label><label className="portal-field wide"><span>Prescriber address</span><textarea name="prescriberAddress" rows={2} /></label>
        <label className="portal-field wide"><span>Prescription document *</span><div className="file-control"><Upload size={17} /><span>{file?.name || "Choose JPG, PNG or PDF up to 8 MB"}</span><input accept=".jpg,.jpeg,.png,.pdf" onChange={(event) => setFile(event.target.files?.[0] || null)} required type="file" /></div></label>
        <button className="portal-primary wide" disabled={Boolean(busy) || (!replacementId && !vendorId)} type="submit">{busy === "upload" ? "Validating and uploading…" : replacementId ? "Resubmit prescription" : "Upload for pharmacist review"}</button>
      </form>
      {vendorId > 0 && <div className="available-prescriptions"><strong>Available for this order</strong>{eligible.length ? eligible.map((record) => <button className={selectedId === record.id ? "selected" : ""} key={record.id} onClick={() => onSelect?.(record.id)} type="button"><FileCheck2 size={17} /><span>{record.prescriptionNumber}<small>{record.prescriberName} · {record.prescribedOn}</small></span><RxStatus value={record.status} /></button>) : <small>No unused prescription has been submitted to this pharmacy.</small>}</div>}
    </>}

    <div className="prescription-records">{records.length ? records.map((record) => <article key={record.id}><div className="prescription-record-head"><span><FileCheck2 size={18} /></span><div><strong>{record.prescriptionNumber}{record.customerName ? ` · ${record.customerName}` : ""}</strong><small>{record.businessName} · {record.documentName} · {new Date(record.createdAt).toLocaleString("en-IN")}</small></div><RxStatus value={record.status} /></div><div className="prescription-meta"><span>Patient <b>{record.patientName}</b></span><span>Prescriber <b>{record.prescriberName}</b></span><span>Date <b>{record.prescribedOn}</b></span>{record.orderNumbers && <span>Order <b>{record.orderNumbers}</b></span>}</div>{(record.reviewNotes || record.rejectionReason) && <p className="review-note">{record.reviewNotes || record.rejectionReason}</p>}<button className="document-open" disabled={busy === `open-${record.documentId}`} onClick={() => void openDocument(record.documentId)} type="button"><Eye size={15} /> Open protected document</button>
        {role === "customer" && record.status === "clarification_required" && <button className="resubmit-button" onClick={() => setReplacementId(record.id)} type="button"><Upload size={15} /> Replace requested document</button>}
        {role === "vendor" && record.status === "uploaded" && <div className="review-form"><textarea onChange={(event) => setNotes((current) => ({ ...current, [record.id]: event.target.value }))} placeholder="Review notes; required for rejection or clarification" rows={2} value={notes[record.id] || ""} /><input onChange={(event) => setMedicines((current) => ({ ...current, [record.id]: event.target.value }))} placeholder="Approved medicines, separated by semicolons (optional)" value={medicines[record.id] || ""} /><div><button disabled={busy === `review-${record.id}`} onClick={() => void review(record.id, "approved")} type="button"><CheckCircle2 size={15} /> Approve</button><button className="clarify" disabled={busy === `review-${record.id}`} onClick={() => void review(record.id, "clarification_required")} type="button"><AlertTriangle size={15} /> Clarification</button><button className="reject" disabled={busy === `review-${record.id}`} onClick={() => void review(record.id, "rejected")} type="button"><XCircle size={15} /> Reject</button></div></div>}
      </article>) : <div className="empty-review"><FileCheck2 size={24} /><strong>No prescriptions yet</strong><small>{role === "customer" ? "Upload one after selecting an Rx medicine." : "New prescription orders will appear here."}</small></div>}</div>
  </section>;
}
