"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, MapPin, Pencil, Plus, Star } from "lucide-react";
import { authenticatedFetch } from "./marketplace-client";
import { GeoLocationPicker } from "./geo-location-picker";

export type CustomerCheckoutIdentity = { name: string; email: string; phone: string };
export type CustomerSavedAddress = {
  id: number;
  label: string;
  address: string;
  latitude: string;
  longitude: string;
  isDefault: boolean;
  createdAt: string;
};

type AddressPayload = {
  identity: CustomerCheckoutIdentity;
  addresses: CustomerSavedAddress[];
  selectedAddressId?: number;
  error?: string;
};

const emptyDraft = { label: "Home", address: "", latitude: "", longitude: "", isDefault: false };

export function CustomerAddressBook({
  onIdentity,
  onSelect,
}: {
  onIdentity: (identity: CustomerCheckoutIdentity) => void;
  onSelect: (address: CustomerSavedAddress | null) => void;
}) {
  const [addresses, setAddresses] = useState<CustomerSavedAddress[]>([]);
  const [selectedId, setSelectedId] = useState(0);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState(emptyDraft);
  const [formOpen, setFormOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const applyPayload = (payload: AddressPayload, requestedId?: number) => {
    setAddresses(payload.addresses);
    onIdentity(payload.identity);
    const nextId = requestedId || selectedId || payload.addresses.find((address) => address.isDefault)?.id || payload.addresses[0]?.id || 0;
    const selected = payload.addresses.find((address) => address.id === nextId) ?? payload.addresses[0] ?? null;
    setSelectedId(selected?.id ?? 0);
    onSelect(selected);
    if (!payload.addresses.length) setFormOpen(true);
  };

  const load = async () => {
    setError("");
    const response = await authenticatedFetch("/api/customer/addresses", { cache: "no-store" });
    const payload = await response.json() as AddressPayload;
    if (!response.ok) throw new Error(payload.error || "Saved addresses could not be loaded");
    applyPayload(payload);
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load().catch((reason) => setError(reason instanceof Error ? reason.message : "Saved addresses could not be loaded"));
    // The address book belongs to the already-authorized customer route and loads once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const choose = (address: CustomerSavedAddress) => {
    setSelectedId(address.id);
    onSelect(address);
  };

  const beginAdd = () => {
    setEditingId(null);
    setDraft({ ...emptyDraft, isDefault: addresses.length === 0 });
    setFormOpen(true);
    setError("");
  };

  const beginEdit = (address: CustomerSavedAddress) => {
    setEditingId(address.id);
    setDraft({ label: address.label, address: address.address, latitude: address.latitude, longitude: address.longitude, isDefault: address.isDefault });
    setFormOpen(true);
    setError("");
  };

  const save = async () => {
    setBusy(true); setError("");
    try {
      const response = await authenticatedFetch("/api/customer/addresses", {
        method: "POST",
        body: JSON.stringify({ action: "save", id: editingId, ...draft }),
      });
      const payload = await response.json() as AddressPayload;
      if (!response.ok) throw new Error(payload.error || "Address could not be saved");
      applyPayload(payload, payload.selectedAddressId);
      setFormOpen(false); setEditingId(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Address could not be saved");
    } finally { setBusy(false); }
  };

  const makeDefault = async (id: number) => {
    setBusy(true); setError("");
    try {
      const response = await authenticatedFetch("/api/customer/addresses", { method: "POST", body: JSON.stringify({ action: "set_default", id }) });
      const payload = await response.json() as AddressPayload;
      if (!response.ok) throw new Error(payload.error || "Default address could not be changed");
      applyPayload(payload, id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Default address could not be changed");
    } finally { setBusy(false); }
  };

  return <div className="customer-address-book wide">
    <div className="customer-address-heading"><div><MapPin size={18} /><span><strong>Saved delivery address *</strong><small>Select an address for this checkout or save a new map pin.</small></span></div><button className="portal-outline" disabled={busy} onClick={beginAdd} type="button"><Plus size={15} /> Add address</button></div>
    {error && <div className="auth-message error">{error}</div>}
    <div className="customer-address-list">{addresses.map((address) => <article className={selectedId === address.id ? "selected" : ""} key={address.id}>
      <button className="customer-address-select" onClick={() => choose(address)} type="button"><span>{selectedId === address.id ? <CheckCircle2 size={18} /> : <MapPin size={18} />}</span><div><strong>{address.label}{address.isDefault ? " · Default" : ""}</strong><small>{address.address}</small><em>{address.latitude}, {address.longitude}</em></div></button>
      <div className="customer-address-actions"><button disabled={busy} onClick={() => beginEdit(address)} type="button"><Pencil size={14} /> Edit</button>{!address.isDefault && <button disabled={busy} onClick={() => void makeDefault(address.id)} type="button"><Star size={14} /> Make default</button>}</div>
    </article>)}</div>
    {formOpen && <div className="portal-form-grid customer-address-form">
      <label className="portal-field"><span>Label *</span><input maxLength={60} onChange={(event) => setDraft((current) => ({ ...current, label: event.target.value }))} placeholder="Home, Work, Parent's home" required value={draft.label} /></label>
      <label className="portal-field wide"><span>Complete delivery address *</span><textarea maxLength={600} onChange={(event) => setDraft((current) => ({ ...current, address: event.target.value }))} required rows={3} value={draft.address} /></label>
      <GeoLocationPicker label="Delivery map pin" latitude={draft.latitude} longitude={draft.longitude} onChange={(location) => setDraft((current) => ({ ...current, latitude: location.latitude, longitude: location.longitude }))} />
      <label className="customer-default-toggle wide"><input checked={draft.isDefault} disabled={Boolean(editingId && addresses.find((address) => address.id === editingId)?.isDefault)} onChange={(event) => setDraft((current) => ({ ...current, isDefault: event.target.checked }))} type="checkbox" /> Use as my default delivery address</label>
      <div className="customer-address-form-actions wide"><button className="portal-outline" disabled={busy || addresses.length === 0} onClick={() => setFormOpen(false)} type="button">Cancel</button><button className="portal-primary" disabled={busy || !draft.label.trim() || draft.address.trim().length < 8 || !draft.latitude || !draft.longitude} onClick={() => void save()} type="button">{busy ? "Saving…" : editingId ? "Update address" : "Save address"}</button></div>
    </div>}
  </div>;
}
