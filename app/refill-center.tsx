"use client";

import { useEffect, useState } from "react";
import { BellRing, CalendarClock, CheckCircle2, RefreshCw, RotateCcw, X } from "lucide-react";
import { accessToken, authenticatedFetch } from "./marketplace-client";

export type RefillReminder = {
  id: number; medicineName: string; originalQuantity: number; daysSupply: number; dueDate: string;
  scheduleSource: string; effectiveStatus: string; sourceOrderNumber: string; businessName: string;
  prescriptionRequired: number; currentInventoryId: number | null; currentPricePaise: number | null;
  availableQuantity: number | null; currentExpiryDate: string | null; repeatOrderId: number | null;
};

export function RefillCenter({ onPrepare }: { onPrepare?: (reminder: RefillReminder) => Promise<void> | void }) {
  const [reminders, setReminders] = useState<RefillReminder[]>([]);
  const [drafts, setDrafts] = useState<Record<number, { date: string; daysSupply: number }>>({});
  const [signedIn, setSignedIn] = useState(false);
  const [busyId, setBusyId] = useState(0);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const load = async () => {
    setError("");
    const token = await accessToken();
    setSignedIn(Boolean(token));
    if (!token) { setReminders([]); return; }
    const response = await authenticatedFetch("/api/refills", { cache: "no-store" });
    const payload = await response.json() as { reminders?: RefillReminder[]; error?: string };
    if (!response.ok) { setError(payload.error || "Refill reminders could not be loaded"); return; }
    const rows = payload.reminders ?? [];
    setReminders(rows);
    setDrafts(Object.fromEntries(rows.map((row) => [row.id, { date: row.dueDate, daysSupply: row.daysSupply }])));
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, []);

  const update = async (id: number, action: "confirm" | "snooze" | "cancel", date?: string) => {
    setBusyId(id); setMessage(""); setError("");
    try {
      const response = await authenticatedFetch("/api/refills", { method: "POST", body: JSON.stringify({ id, action, date: date ?? drafts[id]?.date, daysSupply: drafts[id]?.daysSupply }) });
      const payload = await response.json() as { updated?: boolean; error?: string };
      if (!response.ok) throw new Error(payload.error || "Reminder could not be updated");
      setMessage(action === "confirm" ? "Refill date confirmed." : action === "snooze" ? "Reminder snoozed for 7 days." : "Reminder cancelled.");
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Reminder could not be updated"); }
    finally { setBusyId(0); }
  };

  const snoozeDate = () => {
    const date = new Date(); date.setDate(date.getDate() + 7);
    return date.toISOString().slice(0, 10);
  };

  const open = reminders.filter((row) => !["completed", "cancelled"].includes(row.effectiveStatus));
  const closed = reminders.filter((row) => ["completed", "cancelled"].includes(row.effectiveStatus));

  return <section className="portal-panel refill-center">
    <div className="portal-panel-heading"><div><span className="portal-kicker">REFILL REMINDERS</span><h2>Review and repeat delivered medicines</h2><p>Delivery creates an estimated 30-day date. Confirm it yourself before preparing a repeat order.</p></div><button className="portal-outline" onClick={() => void load()} type="button"><RefreshCw size={15} /> Refresh</button></div>
    {!signedIn && <div className="refill-empty"><BellRing size={20} /><span><strong>Sign in to view refill reminders</strong><small>Reminders are created only after an order is marked delivered.</small></span></div>}
    {message && <div className="auth-message success">{message}</div>}{error && <div className="auth-message error">{error}</div>}
    {signedIn && !reminders.length && <div className="refill-empty"><CalendarClock size={20} /><span><strong>No refill reminders yet</strong><small>A reminder appears after delivery of your first medicine order.</small></span></div>}
    <div className="refill-grid">{open.map((row) => {
      const draft = drafts[row.id] ?? { date: row.dueDate, daysSupply: row.daysSupply };
      return <article className={`refill-card ${row.effectiveStatus}`} key={row.id}>
        <div className="refill-title"><span><BellRing size={17} /></span><div><strong>{row.medicineName}</strong><small>{row.businessName} · {row.sourceOrderNumber}</small></div><em>{row.effectiveStatus}</em></div>
        <p>{row.scheduleSource === "estimated" ? "Estimated — review date" : "Customer-confirmed date"}</p>
        <div className="refill-fields"><label><span>Refill date</span><input onChange={(event) => setDrafts({ ...drafts, [row.id]: { ...draft, date: event.target.value } })} type="date" value={draft.date} /></label><label><span>Days supply</span><input max="365" min="1" onChange={(event) => setDrafts({ ...drafts, [row.id]: { ...draft, daysSupply: Number(event.target.value) } })} type="number" value={draft.daysSupply} /></label></div>
        <div className="refill-stock"><span>{row.availableQuantity ? `${row.availableQuantity} currently available` : "Currently out of stock"}</span><strong>{row.currentPricePaise !== null ? `₹${(row.currentPricePaise / 100).toFixed(2)} current unit price` : "Price unavailable"}</strong>{row.prescriptionRequired ? <b>Fresh prescription review required</b> : <b>No prescription marked</b>}</div>
        <div className="refill-actions"><button disabled={busyId === row.id} onClick={() => void update(row.id, "confirm")} type="button"><CheckCircle2 size={14} /> Confirm date</button><button disabled={busyId === row.id} onClick={() => void update(row.id, "snooze", snoozeDate())} type="button"><CalendarClock size={14} /> Snooze 7 days</button><button aria-label="Cancel reminder" disabled={busyId === row.id} onClick={() => void update(row.id, "cancel")} type="button"><X size={14} /></button></div>
        {onPrepare && <button className="portal-primary refill-repeat" disabled={!row.currentInventoryId || busyId === row.id} onClick={() => void onPrepare(row)} type="button"><RotateCcw size={15} /> Prepare repeat order · review before payment</button>}
      </article>;
    })}</div>
    {closed.length > 0 && <details className="refill-closed"><summary>{closed.length} closed reminder{closed.length === 1 ? "" : "s"}</summary>{closed.map((row) => <span key={row.id}>{row.medicineName} · {row.effectiveStatus}</span>)}</details>}
  </section>;
}
