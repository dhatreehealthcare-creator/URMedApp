"use client";

import { useCallback, useEffect, useState } from "react";
import { BellRing, RefreshCw } from "lucide-react";
import { authenticatedFetch } from "./marketplace-client";
import styles from "./notification-preferences.module.css";

type Category = "transactional" | "safety" | "reminder" | "marketing";
type Preference = {
  category: Category;
  inAppEnabled: boolean;
  emailEnabled: boolean;
  smsEnabled: false;
  timeZone: string;
  version: number;
  requiredConsentGranted: boolean;
  rules: { inAppRequired: boolean; emailConsentPurpose: string | null; smsAvailable: false };
};
type Settings = { policyVersion: string; emailVerified: boolean; smsAvailable: false; preferences: Preference[] };

const commonTimeZones = ["Asia/Kolkata", "Asia/Dubai", "Europe/London", "America/New_York", "America/Los_Angeles", "UTC"];

export function NotificationPreferences() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [drafts, setDrafts] = useState<Record<string, { inAppEnabled: boolean; emailEnabled: boolean; timeZone: string }>>({});
  const [busy, setBusy] = useState<Category | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      const response = await authenticatedFetch("/api/notification-preferences", { cache: "no-store" });
      const payload = await response.json() as Settings & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Notification preferences are unavailable");
      setSettings(payload);
      setDrafts(Object.fromEntries(payload.preferences.map((preference) => [preference.category, {
        inAppEnabled: preference.inAppEnabled,
        emailEnabled: preference.emailEnabled,
        timeZone: preference.timeZone,
      }])));
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Notification preferences are unavailable");
    }
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  const save = async (preference: Preference) => {
    const draft = drafts[preference.category];
    if (!draft) return;
    setBusy(preference.category);
    setError("");
    try {
      const response = await authenticatedFetch("/api/notification-preferences", { method: "POST", body: JSON.stringify({
        category: preference.category, inAppEnabled: draft.inAppEnabled,
        emailEnabled: draft.emailEnabled, smsEnabled: false,
        timeZone: draft.timeZone, version: preference.version,
      }) });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Preference could not be saved");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Preference could not be saved");
    } finally {
      setBusy(null);
    }
  };
  return <section className={`portal-panel ${styles.panel}`}><div className="portal-panel-heading"><div><span className="portal-kicker">CHANNEL CONTROL</span><h2>Notification preferences</h2><p>Essential account and safety notices stay available in-app. Reminder and marketing channels remain your choice and require their purpose consent.</p></div><button className="portal-outline" onClick={() => void load()} type="button"><RefreshCw size={15} /> Refresh</button></div>
    <p className={styles.intro}><BellRing size={14} /> Policy {settings?.policyVersion ?? "URMED-NOTIFICATIONS-2026.1"}. SMS is unavailable until URMED configures a provider and a separate consent flow.</p>
    {!settings?.emailVerified && <p className={styles.notice}>Verify your account email before enabling any email channel.</p>}{error && <p className={styles.error}>{error}</p>}
    <div className={styles.grid}>{settings?.preferences.map((preference) => {
      const draft = drafts[preference.category] ?? { inAppEnabled: preference.inAppEnabled, emailEnabled: false, timeZone: preference.timeZone };
      const optionalChannelAllowed = preference.requiredConsentGranted;
      const emailAllowed = settings.emailVerified && optionalChannelAllowed;
      return <article className={styles.row} key={preference.category}><div><strong>{preference.category}</strong><small>{preference.rules.emailConsentPurpose ? `${preference.rules.emailConsentPurpose.replaceAll("_", " ")} consent required` : "Preference is explicit email consent"}</small></div><label className={styles.channel}><input checked={draft.inAppEnabled} disabled={preference.rules.inAppRequired || !optionalChannelAllowed} onChange={(event) => setDrafts((current) => ({ ...current, [preference.category]: { ...draft, inAppEnabled: event.target.checked } }))} type="checkbox" /> In-app</label><label className={styles.channel}><input checked={draft.emailEnabled} disabled={!emailAllowed} onChange={(event) => setDrafts((current) => ({ ...current, [preference.category]: { ...draft, emailEnabled: event.target.checked } }))} type="checkbox" /> Email</label><label className={styles.channel}><input checked={false} disabled type="checkbox" /> SMS</label><select aria-label={`${preference.category} time zone`} className={styles.zone} onChange={(event) => setDrafts((current) => ({ ...current, [preference.category]: { ...draft, timeZone: event.target.value } }))} value={draft.timeZone}>{!commonTimeZones.includes(draft.timeZone) && <option value={draft.timeZone}>{draft.timeZone}</option>}{commonTimeZones.map((zone) => <option key={zone} value={zone}>{zone}</option>)}</select><button className={styles.save} disabled={busy === preference.category} onClick={() => void save(preference)} type="button">{busy === preference.category ? "Saving…" : "Save"}</button></article>;
    })}</div>
  </section>;
}
