"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { BellRing, ExternalLink, X } from "lucide-react";
import { authenticatedFetch } from "./marketplace-client";
import styles from "./vendor-notification-inbox.module.css";

type VendorSection = "reports" | "purchase";
type Notification = {
  id: number;
  severity: string;
  title: string;
  message: string;
  lifecycleStatus: "unread" | "read" | "acknowledged" | "snoozed" | "resolved";
  snoozedUntil: string | null;
  resolutionReason: string;
  version: number;
  createdAt: string;
  action: null | { kind: string; label: string; targetSection: VendorSection; referenceId: number };
};

type Inbox = {
  notifications: Notification[];
  summary: { unreadCount: number; activeCount: number; snoozedCount: number };
  canManage: boolean;
};

export function VendorNotificationInbox({ onNavigate }: { onNavigate: (section: VendorSection) => void }) {
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<number | null>(null);
  const [includeResolved, setIncludeResolved] = useState(false);
  const popoverId = useId();
  const popoverTitleId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const focusOnOpenRef = useRef(false);

  const closePopover = useCallback(() => {
    setOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  const load = useCallback(async (revealNew = false) => {
    try {
      const response = await authenticatedFetch(`/api/vendor/notifications?includeResolved=${includeResolved}`, { cache: "no-store" });
      const payload = await response.json() as Inbox & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Notification inbox is unavailable");
      setInbox(payload);
      setError("");
      if (revealNew && payload.summary.unreadCount > 0) setOpen(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Notification inbox is unavailable");
    }
  }, [includeResolved]);

  useEffect(() => {
    // Loading is asynchronous; the server remains the lifecycle source of truth.
    const timer = window.setTimeout(() => void load(true), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    if (!open) return;
    if (focusOnOpenRef.current) {
      focusOnOpenRef.current = false;
      closeButtonRef.current?.focus();
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closePopover();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [closePopover, open]);

  const transition = async (notification: Notification, action: "read" | "acknowledge" | "snooze" | "resolve") => {
    let reason: string | undefined;
    let snoozedUntil: string | undefined;
    if (action === "resolve") {
      reason = window.prompt("How was this alert resolved? Enter at least 5 characters.")?.trim();
      if (!reason) return;
    }
    if (action === "snooze") snoozedUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    setBusy(notification.id);
    setError("");
    try {
      const response = await authenticatedFetch("/api/vendor/notifications", {
        method: "POST",
        body: JSON.stringify({ id: notification.id, version: notification.version, action, reason, snoozedUntil }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Notification could not be updated");
      await load();
    } catch (reasonValue) {
      setError(reasonValue instanceof Error ? reasonValue.message : "Notification could not be updated");
    } finally {
      setBusy(null);
    }
  };

  const notifications = inbox?.notifications ?? [];
  return <div className={styles.shell}>
    <button aria-controls={popoverId} aria-expanded={open} aria-haspopup="dialog" className={styles.trigger} onClick={() => {
      if (open) closePopover();
      else { focusOnOpenRef.current = true; setOpen(true); }
    }} ref={triggerRef} type="button">
      <BellRing size={17} /> Inventory alerts
      {Boolean(inbox?.summary.unreadCount) && <span className={styles.badge}>{inbox?.summary.unreadCount}</span>}
    </button>
    {open && <section aria-labelledby={popoverTitleId} className={styles.popover} id={popoverId} role="dialog">
      <div className={styles.heading}><div><h3 id={popoverTitleId}>Stock and expiry inbox</h3><p>{inbox?.summary.activeCount ?? 0} active · {inbox?.summary.snoozedCount ?? 0} snoozed</p></div><div className={styles.actions}><button onClick={() => setIncludeResolved((value) => !value)} type="button">{includeResolved ? "Active only" : "Show resolved"}</button><button aria-label="Close notifications" className={styles.close} onClick={closePopover} ref={closeButtonRef} type="button"><X size={17} /></button></div></div>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {!notifications.length && !error && <p className={styles.empty}>No active inventory alerts.</p>}
      <div className={styles.list}>{notifications.map((notification) => {
        const snoozed = notification.lifecycleStatus === "snoozed" && Boolean(notification.snoozedUntil && new Date(notification.snoozedUntil) > new Date());
        return <article className={`${styles.alert} ${notification.severity === "critical" ? styles.critical : ""} ${snoozed ? styles.muted : ""}`} key={notification.id}>
          <header><strong>{notification.title}</strong><span className={styles.status}>{notification.lifecycleStatus}</span></header>
          <p>{notification.message}</p>{notification.lifecycleStatus === "resolved" && <p><strong>Resolution:</strong> {notification.resolutionReason}</p>}<span className={styles.meta}>{new Date(notification.createdAt).toLocaleString("en-IN")}{snoozed ? ` · Snoozed until ${new Date(notification.snoozedUntil!).toLocaleString("en-IN")}` : ""}</span>
          <div className={styles.actions}>
            {notification.action && <button onClick={() => { onNavigate(notification.action!.targetSection); closePopover(); }} type="button"><ExternalLink size={12} /> {notification.action.label}</button>}
            {notification.lifecycleStatus === "unread" && <button disabled={busy === notification.id} onClick={() => void transition(notification, "read")} type="button">Mark read</button>}
            {inbox?.canManage && <><button disabled={busy === notification.id} onClick={() => void transition(notification, "acknowledge")} type="button">Acknowledge</button><button disabled={busy === notification.id} onClick={() => void transition(notification, "snooze")} type="button">Snooze 24h</button><button disabled={busy === notification.id} onClick={() => void transition(notification, "resolve")} type="button">Resolve</button></>}
          </div>
        </article>;
      })}</div>
    </section>}
  </div>;
}
