"use client";

import { type SyntheticEvent, useEffect, useState } from "react";
import { CheckCircle2, Eye, EyeOff, MapPin, ShieldCheck } from "lucide-react";
import { GeoLocationPicker } from "./geo-location-picker";
import { authenticatedFetch } from "./marketplace-client";

type PublicLocation = {
  id: number;
  label: string;
  address: string;
  latitude: string;
  longitude: string;
  pickupEnabled: number;
  serviceEnabled: number;
  serviceRadiusKm: number;
  publicationStatus: "draft" | "published";
  publicationConsentAt: string | null;
  publishedAt: string | null;
  updatedAt: string;
};

type FormState = {
  label: string;
  address: string;
  latitude: string;
  longitude: string;
  pickupEnabled: boolean;
  serviceEnabled: boolean;
  serviceRadiusKm: string;
};

const emptyForm: FormState = {
  label: "Pharmacy pickup point",
  address: "",
  latitude: "",
  longitude: "",
  pickupEnabled: true,
  serviceEnabled: false,
  serviceRadiusKm: "5",
};

function formFromLocation(location: PublicLocation | null): FormState {
  if (!location) return emptyForm;
  return {
    label: location.label,
    address: location.address,
    latitude: location.latitude,
    longitude: location.longitude,
    pickupEnabled: Boolean(location.pickupEnabled),
    serviceEnabled: Boolean(location.serviceEnabled),
    serviceRadiusKm: String(location.serviceRadiusKm),
  };
}

export function VendorPublicLocation() {
  const [location, setLocation] = useState<PublicLocation | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [publicationConsent, setPublicationConsent] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const applyPayload = (next: PublicLocation | null) => {
    setLocation(next);
    setForm(formFromLocation(next));
    setPublicationConsent(false);
  };

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const response = await authenticatedFetch("/api/vendor/public-location", { cache: "no-store" });
      const payload = await response.json() as { publicLocation: PublicLocation | null; error?: string };
      if (!response.ok) throw new Error(payload.error || "Public location could not be loaded");
      applyPayload(payload.publicLocation);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Public location could not be loaded");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    // Public-location form state is intentionally hydrated once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async (event: SyntheticEvent, action: "save" | "publish") => {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await authenticatedFetch("/api/vendor/public-location", {
        method: "POST",
        body: JSON.stringify({ ...form, action, publicationConsent }),
      });
      const payload = await response.json() as { publicLocation: PublicLocation | null; error?: string };
      if (!response.ok) throw new Error(payload.error || "Public location could not be saved");
      applyPayload(payload.publicLocation);
      setMessage(action === "publish"
        ? "This approved pickup/service point is now visible to customers."
        : "Draft saved privately. Customers still cannot see this location.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Public location could not be saved");
    } finally {
      setBusy(false);
    }
  };

  const unpublish = async () => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await authenticatedFetch("/api/vendor/public-location", {
        method: "POST",
        body: JSON.stringify({ action: "unpublish" }),
      });
      const payload = await response.json() as { publicLocation: PublicLocation | null; error?: string };
      if (!response.ok) throw new Error(payload.error || "Public location could not be unpublished");
      applyPayload(payload.publicLocation);
      setMessage("The customer-facing location is no longer public. Its private draft is retained.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Public location could not be unpublished");
    } finally {
      setBusy(false);
    }
  };

  return <section className="portal-panel">
    <div className="portal-panel-heading"><div><span className="portal-kicker">PUBLIC PICKUP & SERVICE POINT</span><h2>Customer-facing location</h2><p>Create a separate public point only when customers may see its address and exact map pin. Your registered legal location is never copied here.</p></div>{location?.publicationStatus === "published" ? <span className="portal-status green"><Eye size={15} /> Published</span> : <span className="portal-status amber"><EyeOff size={15} /> Private draft</span>}</div>
    {loading && <div aria-live="polite" className="recovery-loading" role="status"><span className="catalogue-loader" /> Loading the public-location setting…</div>}
    {message && <div className="auth-message success" role="status"><CheckCircle2 size={17} /> {message}</div>}
    {error && <div className="auth-message error" role="alert">{error}</div>}
    {!loading && <form className="portal-form-grid" onSubmit={(event) => void submit(event, "save")}>
      <label className="portal-field"><span>Public label *</span><input maxLength={80} onChange={(event) => setForm({ ...form, label: event.target.value })} required value={form.label} /></label>
      <label className="portal-field wide"><span>Customer-facing address *</span><textarea maxLength={500} onChange={(event) => setForm({ ...form, address: event.target.value })} required rows={3} value={form.address} /><small>Enter only an address approved for public display. Do not paste the private legal address unless it is intentionally the same public entrance.</small></label>
      <GeoLocationPicker label="Customer-facing pickup/service pin" latitude={form.latitude} longitude={form.longitude} onChange={(point) => setForm({ ...form, latitude: point.latitude, longitude: point.longitude })} />
      <label className="portal-field"><span>Public service radius (km) *</span><input max="50" min="1" onChange={(event) => setForm({ ...form, serviceRadiusKm: event.target.value })} required step="1" type="number" value={form.serviceRadiusKm} /></label>
      <label className="portal-field"><span>Customer uses</span><span><input checked={form.pickupEnabled} onChange={(event) => setForm({ ...form, pickupEnabled: event.target.checked })} type="checkbox" /> Offer customer pickup</span><span><input checked={form.serviceEnabled} onChange={(event) => setForm({ ...form, serviceEnabled: event.target.checked })} type="checkbox" /> Use this public pin for distance/search</span></label>
      <div className="portal-note wide"><ShieldCheck size={18} /><span><strong>Explicit publication consent</strong><small>Saving keeps a private draft. Publishing makes this address, pin, label, uses and radius visible in customer catalogue and inventory responses.</small></span></div>
      <label className="portal-field wide"><span><input checked={publicationConsent} onChange={(event) => setPublicationConsent(event.target.checked)} type="checkbox" /> I confirm that customers may see this exact address and map pin.</span></label>
      <div className="panel-actions wide"><button className="portal-outline" disabled={busy} type="submit">Save private draft</button><button className="portal-primary" disabled={busy || !publicationConsent} onClick={(event) => void submit(event, "publish")} type="button"><MapPin size={16} /> Publish customer location</button>{location?.publicationStatus === "published" && <button className="portal-outline" disabled={busy} onClick={() => void unpublish()} type="button"><EyeOff size={15} /> Unpublish</button>}</div>
    </form>}
  </section>;
}
