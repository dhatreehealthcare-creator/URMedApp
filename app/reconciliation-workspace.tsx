"use client";
import { useState } from "react";
import { authenticatedFetch } from "./marketplace-client";

type Item = { id: number; externalReference: string; externalDate: string; amountPaise: number; status: string; matchedPaise: number };
const money = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;

export function ReconciliationWorkspace() {
  const [accountCode, setAccountCode] = useState("BANK_CLEARING");
  const [items, setItems] = useState<Item[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [fileName, setFileName] = useState("");
  const load = async () => {
    setBusy(true); setMessage("");
    try {
      const response = await authenticatedFetch("/api/admin/accounting", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "list_reconciliation", accountCode }) });
      const payload = await response.json() as { items?: Item[]; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Reconciliation could not be loaded");
      setItems(payload.items ?? []);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Reconciliation could not be loaded"); } finally { setBusy(false); }
  };
  const importFile = async (file: File) => {
    const text = await file.text();
    const lines = text.split(/\r?\n/).filter(Boolean); const header = lines.shift()?.split(",").map((value) => value.trim().toLowerCase()) ?? [];
    const dateIndex = header.findIndex((value) => ["date", "externaldate"].includes(value)); const amountIndex = header.findIndex((value) => ["amount", "amountpaise"].includes(value)); const refIndex = header.findIndex((value) => ["reference", "externalreference"].includes(value));
    if (dateIndex < 0 || amountIndex < 0) { setMessage("CSV must contain date and amount columns"); return; }
    const rows = lines.map((line) => { const cells = line.split(","); return { externalDate: cells[dateIndex], amount: cells[amountIndex], externalReference: refIndex >= 0 ? cells[refIndex] : undefined }; });
    const checksum = `${file.name}:${file.size}:${file.lastModified}:${text.length}`;
    setBusy(true); setMessage("");
    try {
      const response = await authenticatedFetch("/api/admin/accounting", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "import_statement", accountCode, sourceName: file.name, sourceChecksum: checksum, periodStart: rows[0]?.externalDate, periodEnd: rows.at(-1)?.externalDate, rows }) });
      const payload = await response.json() as { error?: string; rowCount?: number };
      if (!response.ok) throw new Error(payload.error ?? "Statement import failed");
      setMessage(`Imported ${payload.rowCount ?? rows.length} rows for review`); await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Statement import failed"); } finally { setBusy(false); }
  };
  return <section className="portal-panel"><div className="portal-panel-heading"><div><span className="portal-kicker">CONTROLLED RECONCILIATION</span><h2>Bank statement review</h2><p>Imports remain staged until an accountant reviews and approves each match. No journal entry is rewritten.</p></div></div><div className="portal-form-grid"><label className="portal-field"><span>Ledger account</span><input value={accountCode} onChange={(event) => setAccountCode(event.target.value.toUpperCase())} /></label><label className="portal-field"><span>Statement CSV</span><input accept=".csv,text/csv" type="file" onChange={(event) => { const file = event.target.files?.[0]; if (file) { setFileName(file.name); void importFile(file); } }} /></label><button className="portal-outline" disabled={busy} onClick={() => void load()} type="button">{busy ? "Working…" : "Refresh"}</button></div>{fileName && <small>Selected: {fileName}</small>}{message && <p className="portal-note">{message}</p>}<div className="portal-table-wrap"><table className="portal-table"><thead><tr><th>Reference</th><th>Date</th><th>Amount</th><th>Matched</th><th>Status</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td>{item.externalReference}</td><td>{item.externalDate}</td><td>{money(item.amountPaise)}</td><td>{money(item.matchedPaise)}</td><td>{item.status}</td></tr>)}{!items.length && <tr><td colSpan={5}>No staged statement items.</td></tr>}</tbody></table></div></section>;
}
