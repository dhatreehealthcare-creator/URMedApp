"use client";

import { useCallback, useEffect, useState } from "react";
import { LocateFixed, MapPin, RefreshCw, Search } from "lucide-react";
import { authenticatedFetch } from "./marketplace-client";

type Point = { latitude: number; longitude: number };
type Store = {
  vendorId: number; businessName: string; ownerName: string; registrationStatus: string;
  approvalStatus: string; complianceStatus: string; effectiveStatus: string; homeDelivery: boolean;
  privatePoint: Point | null;
  publicLocation: (Point & { label: string; address: string; pickupEnabled: boolean; serviceEnabled: boolean }) | null;
};
type Payload = {
  privacy: string; stores: Store[]; truncated: boolean;
  counts: { total: number; published: number; privateLocated: number; approved: number; suspended: number };
  error?: string;
};

function plot(point: Point) {
  const left = Math.max(1, Math.min(99, ((point.longitude - 68) / 30) * 100));
  const top = Math.max(1, Math.min(99, ((37 - point.latitude) / 31) * 100));
  return { left: `${left}%`, top: `${top}%` };
}

export function AdminStoreMap() {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [location, setLocation] = useState("all");
  const [homeDelivery, setHomeDelivery] = useState("all");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true); setError("");
    const parameters = new URLSearchParams({ status, location, homeDelivery });
    if (query.trim()) parameters.set("q", query.trim());
    try {
      const response = await authenticatedFetch(`/api/admin/stores/map?${parameters}`, { cache: "no-store" });
      const next = await response.json() as Payload;
      if (!response.ok) throw new Error(next.error || "Store locations are unavailable");
      setPayload(next);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Store locations are unavailable"); }
    finally { setLoading(false); }
  }, [homeDelivery, location, query, status]);
  useEffect(() => { // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);
  return <section className="portal-panel">
    <div className="portal-panel-heading"><div><span className="portal-kicker">ADMIN-ONLY STORE LOCATIONS</span><h2>Registered-store location plot</h2><p>{payload?.privacy || "Private legal coordinates stay within the authenticated administration workspace."}</p></div><button className="portal-outline" onClick={() => void load()} type="button"><RefreshCw size={15} /> Refresh</button></div>
    <form className="portal-form-grid" onSubmit={(event) => { event.preventDefault(); void load(); }}>
      <label className="portal-field"><span>Store or owner</span><input onChange={(event) => setQuery(event.target.value)} placeholder="Search locations" value={query} /></label>
      <label className="portal-field"><span>Status</span><select onChange={(event) => setStatus(event.target.value)} value={status}><option value="all">All statuses</option><option value="approved">Approved</option><option value="pending">Pending</option><option value="testing">Testing</option><option value="rejected">Rejected</option><option value="suspended">Suspended</option></select></label>
      <label className="portal-field"><span>Location state</span><select onChange={(event) => setLocation(event.target.value)} value={location}><option value="all">All locations</option><option value="published">Public point published</option><option value="unpublished">Public point unpublished</option><option value="private_missing">Private location missing</option></select></label>
      <label className="portal-field"><span>Home delivery</span><select onChange={(event) => setHomeDelivery(event.target.value)} value={homeDelivery}><option value="all">All</option><option value="yes">Enabled</option><option value="no">Disabled</option></select></label>
      <button className="portal-primary" type="submit"><Search size={15} /> Apply filters</button>
    </form>
    {error && <div className="recovery-error"><MapPin size={18} /><span><strong>Store map unavailable</strong><small>{error}</small></span></div>}
    {payload && <div className="recovery-counts"><article><MapPin size={19} /><span><small>Filtered stores</small><strong>{payload.counts.total}</strong></span></article><article><MapPin size={19} /><span><small>Published points</small><strong>{payload.counts.published}</strong></span></article><article><LocateFixed size={19} /><span><small>Private legal points</small><strong>{payload.counts.privateLocated}</strong></span></article><article><MapPin size={19} /><span><small>Approved / suspended</small><strong>{payload.counts.approved} / {payload.counts.suspended}</strong></span></article></div>}
    {loading ? <div className="recovery-loading"><span className="catalogue-loader" /> Loading store locations…</div> : payload && <div className="portal-split">
      <div className="admin-location-plot" aria-label="Privacy-safe coordinate plot of registered pharmacies"><span className="plot-north">North</span><span className="plot-caption">India coordinate extent · no external map tiles</span>{payload.stores.flatMap((store) => { const point = store.publicLocation || store.privatePoint; return point ? [<button aria-label={`${store.businessName}, ${store.publicLocation ? "published public point" : "private legal point"}`} className={`admin-location-marker ${store.publicLocation ? "public" : "private"}`} key={store.vendorId} style={plot(point)} title={`${store.businessName} · ${store.publicLocation ? "published" : "private legal"}`} type="button"><MapPin size={15} /></button>] : []; })}</div>
      <div className="history-cards">{payload.stores.map((store) => <article key={store.vendorId}><span><MapPin size={18} /></span><div><strong>{store.businessName}</strong><small>{store.ownerName} · {store.effectiveStatus} · {store.complianceStatus}</small><em>{store.publicLocation ? `${store.publicLocation.label}: ${store.publicLocation.address}` : store.privatePoint ? `Private legal point ${store.privatePoint.latitude.toFixed(4)}, ${store.privatePoint.longitude.toFixed(4)}` : "Location missing"}</em></div></article>)}</div>
    </div>}
    {payload?.truncated && <p className="secure-recovery-note">The plot is limited to 500 records. Narrow the filters to inspect the remaining stores.</p>}
  </section>;
}
