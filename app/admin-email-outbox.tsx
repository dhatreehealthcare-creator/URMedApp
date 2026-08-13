"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, MailCheck, RefreshCw, RotateCcw } from "lucide-react";
import { authenticatedFetch } from "./marketplace-client";

type OutboxItem = {
  id: number; category: string; eventType: string; status: string; attemptCount: number;
  maxAttempts: number; nextAttemptAt: string; lastErrorCode: string; lastErrorReason: string;
  providerMessageId: string; createdAt: string; updatedAt: string; recipient: string;
};

type OutboxPayload = { counts: Record<string, number>; items: OutboxItem[] };

export function AdminEmailOutbox() {
  const [data, setData] = useState<OutboxPayload | null>(null);
  const [status, setStatus] = useState("all");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    const query = status === "all" ? "" : `?status=${encodeURIComponent(status)}`;
    const response = await authenticatedFetch(`/api/admin/email-outbox${query}`, { cache: "no-store" });
    const payload = await response.json() as OutboxPayload & { error?: string };
    if (!response.ok) throw new Error(payload.error || "Email outbox is unavailable");
    setData(payload);
  }, [status]);

  useEffect(() => {
    queueMicrotask(() => {
      void load().catch((reason) => setError(reason instanceof Error ? reason.message : "Email outbox is unavailable"));
    });
  }, [load]);

  const retry = async (id: number) => {
    setBusy(String(id)); setError("");
    try {
      const response = await authenticatedFetch("/api/admin/email-outbox", {
        method: "POST", body: JSON.stringify({ action: "retry", id }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Email retry failed");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Email retry failed");
    } finally { setBusy(""); }
  };

  return <section className="portal-panel"><div className="portal-panel-heading compact"><div><span className="portal-kicker">TRANSACTIONAL EMAIL</span><h2>Delivery outbox</h2><p>Provider delivery is retried by the scheduled Worker. Recipient addresses are masked here.</p></div><button className="portal-outline" onClick={() => void load()} type="button"><RefreshCw size={15} /> Refresh</button></div>
    {error && <div className="recovery-error"><AlertTriangle size={17} /><span>{error}</span></div>}
    <div className="recovery-counts">{["queued", "processing", "retry_wait", "sent", "dead_letter", "cancelled"].map((key) => <article key={key}><MailCheck size={18} /><span><small>{key.replaceAll("_", " ")}</small><strong>{data?.counts[key] ?? 0}</strong></span></article>)}</div>
    <label className="portal-field"><span>Filter status</span><select onChange={(event) => setStatus(event.target.value)} value={status}><option value="all">All messages</option><option value="queued">Queued</option><option value="processing">Processing</option><option value="retry_wait">Retry waiting</option><option value="sent">Sent</option><option value="dead_letter">Dead letter</option><option value="cancelled">Cancelled</option></select></label>
    <div className="portal-table-wrap"><table className="portal-table"><thead><tr><th>Recipient</th><th>Event</th><th>Status</th><th>Attempts</th><th>Last error</th><th>Action</th></tr></thead><tbody>{data?.items.map((item) => <tr key={item.id}><td>{item.recipient}</td><td>{item.eventType.replaceAll("_", " ")}</td><td>{item.status.replaceAll("_", " ")}</td><td>{item.attemptCount}/{item.maxAttempts}</td><td>{item.lastErrorReason || "—"}</td><td>{item.status === "dead_letter" ? <button className="portal-outline" disabled={busy === String(item.id)} onClick={() => void retry(item.id)} type="button"><RotateCcw size={14} /> Retry</button> : "—"}</td></tr>)}</tbody></table></div>
  </section>;
}
