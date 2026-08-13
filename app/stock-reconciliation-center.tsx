"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, ClipboardCheck, RefreshCw, Scale } from "lucide-react";
import { authenticatedFetch } from "./marketplace-client";

type InventoryRow = {
  id: number;
  productName: string;
  batchNumber: string;
  expiryDate: string | null;
  quantity: number;
  reservedQuantity: number;
  availableQuantity: number;
  lastCountedAt: string | null;
  ledgerBalance: number | null;
};

type ReconciliationData = {
  canAdjust: boolean;
  summary: { totalBatches: number; neverCounted: number; countedLast30Days: number; reservationConflicts: number; ledgerMismatches: number };
  inventory: InventoryRow[];
  reasons: Array<{ code: string; label: string; direction: string; requiresNotes: number }>;
  adjustments: Array<{ id: number; adjustmentNumber: string; productName: string; batchNumber: string; reasonLabel: string; quantityBefore: number; quantityDelta: number; balanceAfter: number; notes: string; actorName: string; createdAt: string }>;
  counts: Array<{ id: number; sessionNumber: string; scopeLabel: string; lineCount: number; varianceLineCount: number; netVarianceQuantity: number; actorName: string; completedAt: string }>;
};

async function parseResponse<T>(response: Response): Promise<T> {
  const value = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(value.error || "Inventory reconciliation failed"));
  return value as T;
}

export function StockReconciliationCenter() {
  const [data, setData] = useState<ReconciliationData | null>(null);
  const [selected, setSelected] = useState<Record<number, boolean>>({});
  const [counted, setCounted] = useState<Record<number, string>>({});
  const [manualKey, setManualKey] = useState(() => crypto.randomUUID());
  const [countKey, setCountKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    const response = await authenticatedFetch("/api/vendor/inventory-reconciliation", { cache: "no-store" });
    const value = await parseResponse<ReconciliationData>(response);
    setData(value);
    setCounted((current) => Object.fromEntries(value.inventory.map((item) => [item.id, current[item.id] ?? String(item.quantity)])));
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load().catch((reason) => setError(reason instanceof Error ? reason.message : "Inventory reconciliation is unavailable"));
  }, [load]);

  const selectedCount = useMemo(() => data?.inventory.filter((item) => selected[item.id]) ?? [], [data, selected]);

  const adjust = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!data) return;
    setBusy("adjust"); setError(""); setMessage("");
    try {
      const form = event.currentTarget;
      const values = Object.fromEntries(new FormData(form).entries());
      const inventory = data.inventory.find((item) => item.id === Number(values.inventoryId));
      if (!inventory) throw new Error("Choose an inventory batch");
      const result = await parseResponse<{ duplicate: boolean; adjustmentNumber: string }>(await authenticatedFetch("/api/vendor/inventory-reconciliation", {
        method: "POST",
        body: JSON.stringify({
          action: "adjust", idempotencyKey: manualKey, inventoryId: inventory.id,
          expectedQuantity: inventory.quantity, quantityDelta: Number(values.quantityDelta),
          reasonCode: values.reasonCode, notes: values.notes,
        }),
      }));
      setMessage(`${result.adjustmentNumber} ${result.duplicate ? "was already applied" : "was applied with stock-ledger evidence"}.`);
      setManualKey(crypto.randomUUID());
      form.reset();
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Inventory adjustment failed");
    } finally { setBusy(""); }
  };

  const completeCount = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!data || !selectedCount.length) { setError("Select at least one batch to count"); return; }
    setBusy("count"); setError(""); setMessage("");
    try {
      const form = event.currentTarget;
      const values = Object.fromEntries(new FormData(form).entries());
      const result = await parseResponse<{ duplicate: boolean; sessionNumber: string; varianceLineCount: number }>(await authenticatedFetch("/api/vendor/inventory-reconciliation", {
        method: "POST",
        body: JSON.stringify({
          action: "count", idempotencyKey: countKey, scopeLabel: values.scopeLabel, notes: values.notes,
          lines: selectedCount.map((item) => ({ inventoryId: item.id, expectedQuantity: item.quantity, countedQuantity: Number(counted[item.id]) })),
        }),
      }));
      setMessage(`${result.sessionNumber} completed with ${result.varianceLineCount} variance line${result.varianceLineCount === 1 ? "" : "s"}${result.duplicate ? " (duplicate request safely ignored)" : ""}.`);
      setCountKey(crypto.randomUUID()); setSelected({}); form.reset();
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Cycle count failed");
    } finally { setBusy(""); }
  };

  if (!data) return <section className="portal-panel"><div className="recovery-loading"><span className="catalogue-loader" /> Loading stock reconciliation…</div>{error && <p className="procurement-empty">{error}</p>}</section>;
  return <div className="portal-stack">
    <section className="portal-panel">
      <div className="portal-panel-heading"><div><span className="portal-kicker">STOCK RECONCILIATION</span><h2>Controlled adjustments and cycle counts</h2><p>Every variance records expected, counted, reserved and resulting balances. Existing quantities are never silently replaced.</p></div><button className="portal-outline" onClick={() => void load()} type="button"><RefreshCw size={15} /> Refresh</button></div>
      {error && <div className="recovery-error"><AlertTriangle size={18} /><span><strong>Action needed</strong><small>{error}</small></span></div>}
      {message && <div className="portal-success"><CheckCircle2 size={18} /><span>{message}</span></div>}
      <div className="portal-metrics"><article><span className="blue"><Scale size={19} /></span><div><small>Active batches</small><strong>{data.summary.totalBatches}</strong><em>{data.summary.neverCounted} never counted</em></div></article><article><span className="green"><ClipboardCheck size={19} /></span><div><small>Counted in 30 days</small><strong>{data.summary.countedLast30Days}</strong><em>Immutable count evidence</em></div></article><article><span className={data.summary.ledgerMismatches ? "red" : "green"}><AlertTriangle size={19} /></span><div><small>Ledger mismatches</small><strong>{data.summary.ledgerMismatches}</strong><em>Latest ledger vs physical balance</em></div></article><article><span className={data.summary.reservationConflicts ? "red" : "green"}><AlertTriangle size={19} /></span><div><small>Reservation conflicts</small><strong>{data.summary.reservationConflicts}</strong><em>Reserved above physical</em></div></article></div>
    </section>
    {data.canAdjust && <section className="portal-panel"><div className="portal-panel-heading compact"><div><span className="portal-kicker">MANUAL ADJUSTMENT</span><h2>Apply a reason-coded movement</h2><p>Use signed quantities: positive for found stock, negative for write-offs.</p></div></div><form className="portal-form-grid" onSubmit={adjust}><label className="portal-field wide"><span>Inventory batch *</span><select name="inventoryId" required>{data.inventory.map((item) => <option key={item.id} value={item.id}>{item.productName} · {item.batchNumber} · physical {item.quantity} · reserved {item.reservedQuantity}</option>)}</select></label><label className="portal-field"><span>Signed quantity *</span><input max="1000000" min="-1000000" name="quantityDelta" required type="number" /></label><label className="portal-field"><span>Reason code *</span><select name="reasonCode" required>{data.reasons.map((reason) => <option key={reason.code} value={reason.code}>{reason.label} · {reason.direction}</option>)}</select></label><label className="portal-field wide"><span>Notes</span><textarea maxLength={300} name="notes" placeholder="Operational evidence or incident reference" rows={2} /></label><button className="portal-primary" disabled={Boolean(busy)} type="submit">{busy === "adjust" ? "Applying guarded movement…" : "Apply audited adjustment"}</button></form></section>}
    <section className="portal-panel"><div className="portal-panel-heading compact"><div><span className="portal-kicker">CYCLE COUNT</span><h2>Count selected batches</h2><p>Submitting compares each physical count with the displayed expected balance and rolls back the whole session if any batch changed.</p></div></div>
      <form className="portal-stack" onSubmit={completeCount}><div className="portal-form-grid"><label className="portal-field"><span>Count scope *</span><input minLength={3} name="scopeLabel" placeholder="Aisle A / Cold room / Full store" required /></label><label className="portal-field"><span>Session notes</span><input maxLength={300} name="notes" placeholder="Shift, shelf or witness note" /></label></div><div className="portal-table-wrap"><table className="portal-table"><thead><tr><th>Select</th><th>Medicine / batch</th><th>Expected</th><th>Reserved</th><th>Latest ledger</th><th>Physical count</th></tr></thead><tbody>{data.inventory.map((item) => <tr key={item.id}><td><input aria-label={`Count ${item.productName} ${item.batchNumber}`} checked={Boolean(selected[item.id])} disabled={!data.canAdjust} onChange={(event) => setSelected((current) => ({ ...current, [item.id]: event.target.checked }))} type="checkbox" /></td><td><strong>{item.productName}</strong><small>{item.batchNumber} · {item.expiryDate || "No expiry"}</small></td><td>{item.quantity}</td><td>{item.reservedQuantity}</td><td><span className={`portal-status ${item.ledgerBalance === null || Number(item.ledgerBalance) === Number(item.quantity) ? "green" : "red"}`}>{item.ledgerBalance ?? "No movement"}</span></td><td><input aria-label={`${item.productName} physical count`} disabled={!selected[item.id] || !data.canAdjust} min={item.reservedQuantity} onChange={(event) => setCounted((current) => ({ ...current, [item.id]: event.target.value }))} type="number" value={counted[item.id] ?? String(item.quantity)} /></td></tr>)}</tbody></table></div>{data.canAdjust ? <button className="portal-primary" disabled={Boolean(busy) || !selectedCount.length} type="submit">{busy === "count" ? "Completing guarded count…" : `Complete count (${selectedCount.length})`}</button> : <div className="portal-note warning"><AlertTriangle size={18} /><span><strong>Read-only inventory access</strong><small>An owner or inventory manager must submit stock changes.</small></span></div>}</form>
    </section>
    <div className="portal-split"><section className="portal-panel"><h2>Recent adjustments</h2><div className="history-cards">{data.adjustments.map((item) => <article key={item.id}><span><Scale size={18} /></span><div><strong>{item.productName} · {item.quantityDelta > 0 ? "+" : ""}{item.quantityDelta}</strong><small>{item.adjustmentNumber} · {item.batchNumber} · {item.quantityBefore} → {item.balanceAfter}</small><em>{item.reasonLabel} · {item.actorName}{item.notes ? ` · ${item.notes}` : ""}</em></div></article>)}{!data.adjustments.length && <p className="procurement-empty">No stock adjustments recorded.</p>}</div></section><section className="portal-panel"><h2>Completed cycle counts</h2><div className="history-cards">{data.counts.map((item) => <article key={item.id}><span><ClipboardCheck size={18} /></span><div><strong>{item.scopeLabel} · {item.sessionNumber}</strong><small>{item.lineCount} batches · {item.varianceLineCount} variances · net {item.netVarianceQuantity > 0 ? "+" : ""}{item.netVarianceQuantity}</small><em>{item.actorName} · {new Date(item.completedAt).toLocaleString("en-IN")}</em></div></article>)}{!data.counts.length && <p className="procurement-empty">No completed counts recorded.</p>}</div></section></div>
  </div>;
}
