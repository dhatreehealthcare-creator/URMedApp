"use client";

import { FormEvent, useEffect, useState } from "react";
import { Boxes, CheckCircle2, CreditCard, MapPin, PackageCheck, RefreshCw, RotateCcw, Search, Truck } from "lucide-react";
import { accessToken, authenticatedFetch, getRuntimeConfig, type RuntimeConfig } from "./marketplace-client";
import { PrescriptionCenter } from "./prescription-center";
import { RefillCenter, type RefillReminder } from "./refill-center";
import { workflowStatusLabels } from "../lib/order-workflow";
import { formatDistance, haversineKm, isValidGeoPoint } from "../lib/geo";
import { GeoLocationPicker } from "./geo-location-picker";

type Role = "customer" | "vendor";
type Inventory = {
  id: number; vendorId: number; legacyId: number; productName: string; manufacturer: string; businessName: string;
  batchNumber: string; expiryDate: string | null; purchasePricePaise?: number; salePricePaise: number;
  quantity: number; reservedQuantity: number; gstPercent: number; reorderLevel: number; prescriptionRequired: number;
  quarantineStatus: string; expiryStatus: "valid" | "near_expiry" | "expired" | "missing_expiry";
  vendorLatitude: string; vendorLongitude: string; deliveryRadiusKm: number; homeDelivery: number; distanceKm?: number;
};
type Order = {
  id: number; orderNumber: string; subtotalPaise: number; taxPaise: number; deliveryFeePaise: number; totalPaise: number; paymentMethod: string; paymentStatus: string;
  deliveryMethod: string; orderStatus: string; deliveryStatus: string; customerName: string;
  deliveryAddress: string; businessName: string; items: string; createdAt: string;
  prescriptionId: number | null; prescriptionStatus: string;
  nextStatuses: string[];
  trackingEvents: Array<{ status: string; note: string; createdAt: string; actorName: string; actorRole: string }>;
};

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open(): void };
  }
}

async function responsePayload<T>(response: Response): Promise<T & { error?: string }> {
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || "The request could not be completed");
  return payload;
}

async function loadRazorpay() {
  if (window.Razorpay) return;
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Razorpay Checkout could not be loaded"));
    document.head.appendChild(script);
  });
}

function IntegrationReadiness({ config }: { config: RuntimeConfig | null }) {
  const entries = [
    ["OTP & authentication", config?.integrations.otpAndAuth],
    ["Transactional email", config?.integrations.email],
    ["Online payments", config?.integrations.payments],
    ["Payment webhooks", config?.integrations.paymentWebhooks],
  ] as const;
  return <div className="integration-readiness"><div><span className="portal-kicker">PRIVATE TEST MODE</span><h3>Service readiness</h3></div>{entries.map(([label, ready]) => <span className={ready ? "ready" : "pending"} key={label}>{ready ? <CheckCircle2 size={14} /> : <span className="status-dot" />}{label}<b>{ready ? "Connected" : "Key needed"}</b></span>)}</div>;
}

export function LiveMarketplace({ role }: { role: Role }) {
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [inventory, setInventory] = useState<Inventory[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [query, setQuery] = useState("");
  const [selectedInventoryId, setSelectedInventoryId] = useState(0);
  const [quantity, setQuantity] = useState(1);
  const [address, setAddress] = useState("");
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [placeOfSupplyStateCode, setPlaceOfSupplyStateCode] = useState("36");
  const [paymentMethod, setPaymentMethod] = useState<"online" | "cod">("online");
  const [deliveryMethod, setDeliveryMethod] = useState<"pickup" | "pharmacy" | "urmed">("urmed");
  const [prescriptionId, setPrescriptionId] = useState(0);
  const [refillReminderId, setRefillReminderId] = useState(0);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [trackingNotes, setTrackingNotes] = useState<Record<number, string>>({});
  const [stockForm, setStockForm] = useState({ legacyId: "", batchNumber: "", expiryDate: "", purchasePrice: "", salePrice: "", quantity: "", gstPercent: "5", reorderLevel: "5" });

  const refresh = async (search = query): Promise<Inventory[]> => {
    setError("");
    const token = await accessToken();
    setSignedIn(Boolean(token));
    const inventoryUrl = role === "vendor" ? "/api/inventory?scope=mine" : `/api/inventory?q=${encodeURIComponent(search)}`;
    const inventoryResponse = role === "vendor" ? await authenticatedFetch(inventoryUrl, { cache: "no-store" }) : await fetch(inventoryUrl, { cache: "no-store" });
    if (inventoryResponse.ok) {
      const payload = await inventoryResponse.json() as { inventory: Inventory[] };
      setInventory(payload.inventory);
      setSelectedInventoryId((current) => payload.inventory.some((item) => item.id === current) ? current : (payload.inventory[0]?.id ?? 0));
      if (token) {
        const orderResponse = await authenticatedFetch("/api/orders", { cache: "no-store" });
        if (orderResponse.ok) setOrders(((await orderResponse.json()) as { orders: Order[] }).orders);
      } else setOrders([]);
      return payload.inventory;
    } else if (role === "vendor" && token) {
      const payload = await inventoryResponse.json() as { error?: string };
      setError(payload.error || "Inventory could not be loaded");
    }
    if (token) {
      const orderResponse = await authenticatedFetch("/api/orders", { cache: "no-store" });
      if (orderResponse.ok) setOrders(((await orderResponse.json()) as { orders: Order[] }).orders);
    } else setOrders([]);
    return [];
  };

  useEffect(() => {
    void getRuntimeConfig().then(setConfig);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh("");
    // The user can explicitly refresh after signing in; this avoids auth event coupling here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role]);

  const saveStock = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    try {
      const response = await authenticatedFetch("/api/inventory", { method: "POST", body: JSON.stringify(stockForm) });
      await responsePayload<{ saved: boolean }>(response);
      setMessage("Batch stock and customer sale price were saved.");
      await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Stock could not be saved"); }
    finally { setBusy(false); }
  };

  const openPayment = async (orderId: number) => {
    const response = await authenticatedFetch("/api/payments/razorpay/order", { method: "POST", body: JSON.stringify({ orderId }) });
    const payment = await responsePayload<{ id: string; amount: number; currency: string; keyId: string }>(response);
    await loadRazorpay();
    if (!window.Razorpay) throw new Error("Razorpay Checkout is unavailable");
    const instance = new window.Razorpay({
      key: payment.keyId, amount: payment.amount, currency: payment.currency, name: "URMED",
      description: "Pharmacy medicine order", order_id: payment.id,
      handler: async (confirmation: Record<string, string>) => {
        const verify = await authenticatedFetch("/api/payments/razorpay/verify", { method: "POST", body: JSON.stringify(confirmation) });
        await responsePayload<{ verified: boolean }>(verify);
        setMessage("Payment verified. The pharmacy has received your order.");
        await refresh();
      },
      theme: { color: "#087c6c" },
    });
    instance.open();
  };

  const placeOrder = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    try {
      if (!signedIn) throw new Error("Sign in as a customer before placing an order");
      if (!selectedInventoryId) throw new Error("Choose an in-stock medicine");
      const response = await authenticatedFetch("/api/orders", { method: "POST", body: JSON.stringify({
        items: [{ inventoryId: selectedInventoryId, quantity }], customerName, customerPhone, prescriptionId: prescriptionId || undefined,
        refillReminderId: refillReminderId || undefined, deliveryAddress: address, latitude, longitude, placeOfSupplyStateCode, paymentMethod, deliveryMethod,
      }) });
      const payload = await responsePayload<{ order: { id: number; orderNumber: string; totalPaise: number; requiresPrescriptionReview: boolean } }>(response);
      setMessage(payload.order.requiresPrescriptionReview ? `${payload.order.orderNumber} is awaiting pharmacist prescription review.` : `${payload.order.orderNumber} was created successfully.`);
      setPrescriptionId(0);
      setRefillReminderId(0);
      if (paymentMethod === "online" && !payload.order.requiresPrescriptionReview) await openPayment(payload.order.id);
      else await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Order could not be placed"); }
    finally { setBusy(false); }
  };

  const updateTracking = async (orderId: number, status: string) => {
    setBusy(true); setError("");
    try {
      const response = await authenticatedFetch(`/api/orders/${orderId}/tracking`, { method: "POST", body: JSON.stringify({ status, note: trackingNotes[orderId] || `Order ${workflowStatusLabels[status]?.toLowerCase() ?? status.replaceAll("_", " ")}` }) });
      await responsePayload<{ updated: boolean }>(response);
      setMessage("Delivery status updated and added to the customer timeline.");
      setTrackingNotes((current) => ({ ...current, [orderId]: "" }));
      await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Tracking could not be updated"); }
    finally { setBusy(false); }
  };

  const customerPoint = { latitude: Number(latitude), longitude: Number(longitude) };
  const hasCustomerLocation = latitude !== "" && longitude !== "" && isValidGeoPoint(customerPoint);
  const nearbyInventory = inventory.map((item) => {
    const pharmacyPoint = { latitude: Number(item.vendorLatitude), longitude: Number(item.vendorLongitude) };
    return { ...item, distanceKm: hasCustomerLocation && isValidGeoPoint(pharmacyPoint) ? haversineKm(customerPoint, pharmacyPoint) : undefined };
  }).sort((a, b) => (a.distanceKm ?? Number.POSITIVE_INFINITY) - (b.distanceKm ?? Number.POSITIVE_INFINITY));
  const selectedInventory = nearbyInventory.find((item) => item.id === selectedInventoryId);
  const selectedWithinRadius = deliveryMethod === "pickup" || selectedInventory?.distanceKm === undefined
    || selectedInventory.distanceKm <= selectedInventory.deliveryRadiusKm;

  const prepareRefill = async (reminder: RefillReminder) => {
    setBusy(true); setError(""); setMessage("");
    try {
      const stocked = await refresh(reminder.medicineName);
      const offer = stocked.find((item) => item.id === reminder.currentInventoryId);
      if (!offer) throw new Error("This medicine is no longer available. Refresh the reminder later.");
      setQuery(reminder.medicineName);
      setSelectedInventoryId(offer.id);
      setQuantity(Math.min(100, Math.max(1, reminder.originalQuantity)));
      setPrescriptionId(0);
      setRefillReminderId(reminder.id);
      setMessage("Repeat order prepared below. Review current price, stock, delivery, payment and prescription before submitting.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Repeat order could not be prepared"); }
    finally { setBusy(false); }
  };
  const previewSubtotalPaise = (selectedInventory?.salePricePaise ?? 0) * quantity;
  const previewTaxPaise = Math.round(previewSubtotalPaise * (selectedInventory?.gstPercent ?? 0) / 100);
  const previewDeliveryPaise = deliveryMethod === "pickup" ? 0 : deliveryMethod === "pharmacy" ? 2500 : 3900;

  return <div className="live-marketplace-stack">
    <IntegrationReadiness config={config} />
    <div className="live-toolbar"><div><span className="portal-kicker">DATABASE-BACKED WORKFLOW</span><h2>{role === "vendor" ? "Live stock, pricing and fulfilment" : "Live ordering and delivery tracking"}</h2><p>{signedIn ? "Authenticated session detected." : "Use Registration & login first, then refresh this panel."}</p></div><button onClick={() => void refresh()} type="button"><RefreshCw size={15} /> Refresh session & data</button></div>
    {message && <div className="auth-message success">{message}</div>}{error && <div className="auth-message error">{error}</div>}
    {role === "vendor" ? <div className="portal-split">
      <section className="portal-panel"><div className="portal-panel-heading"><div><Boxes size={20} /><h2>Stock entry and sale price</h2><p>Use the recovered product ID shown in catalogue search results.</p></div></div><form className="portal-form-grid" onSubmit={saveStock}>
        {Object.entries(stockForm).map(([key, value]) => <label className="portal-field" key={key}><span>{({ legacyId: "Recovered product ID", batchNumber: "Batch number", expiryDate: "Expiry date", purchasePrice: "Purchase price before GST ₹", salePrice: "Sale price before GST ₹", quantity: "Quantity", gstPercent: "GST %", reorderLevel: "Zero/low-stock alert level" } as Record<string,string>)[key]}</span>{key === "gstPercent" ? <select onChange={(event) => setStockForm({ ...stockForm, [key]: event.target.value })} value={value}>{[0,5,12,18,28].map((rate) => <option key={rate}>{rate}</option>)}</select> : <input min={key === "quantity" ? "0" : undefined} onChange={(event) => setStockForm({ ...stockForm, [key]: event.target.value })} required={["legacyId","batchNumber","expiryDate","salePrice","quantity"].includes(key)} step={["purchasePrice","salePrice"].includes(key) ? "0.01" : undefined} type={key === "expiryDate" ? "date" : ["legacyId","purchasePrice","salePrice","quantity","reorderLevel"].includes(key) ? "number" : "text"} value={value} />}</label>)}
        <button className="portal-primary wide" disabled={busy || !signedIn} type="submit">Save stock and activate customer price</button>
      </form></section>
      <section className="portal-panel"><div className="portal-panel-heading"><div><PackageCheck size={20} /><h2>Current pharmacy inventory</h2><p>{inventory.length} batch records · expired and near-expiry batches are flagged</p></div></div><div className="live-list">{inventory.length ? inventory.map((item) => <article key={item.id}><div><strong>{item.productName}</strong><small>Legacy #{item.legacyId} · Batch {item.batchNumber} · {item.expiryDate || "No expiry entered"}</small></div><span>₹{(item.salePricePaise / 100).toFixed(2)}<small>{item.quantity} units · {item.reservedQuantity} reserved</small><small className={`portal-status ${item.expiryStatus === "valid" ? "green" : "amber"}`}>{item.expiryStatus.replaceAll("_", " ")}</small></span></article>) : <p>No live stock yet.</p>}</div></section>
    </div> : <><RefillCenter onPrepare={prepareRefill} /><div className="portal-split">
      <section className="portal-panel"><div className="portal-panel-heading"><div><Search size={20} /><h2>Order from a verified pharmacy</h2><p>Search only shows stock with an active customer price.</p></div></div><form className="live-search" onSubmit={(event) => { event.preventDefault(); void refresh(query); }}><input onChange={(event) => setQuery(event.target.value)} placeholder="Search stocked medicine" value={query} /><button type="submit">Search stock</button></form>{selectedInventory?.prescriptionRequired ? <PrescriptionCenter onSelect={setPrescriptionId} role="customer" selectedId={prescriptionId} vendorId={selectedInventory.vendorId} /> : null}<form className="portal-form-grid one" onSubmit={placeOrder}>
        <label className="portal-field"><span>Medicine and pharmacy *</span><select onChange={(event) => { setSelectedInventoryId(Number(event.target.value)); setPrescriptionId(0); setRefillReminderId(0); }} required value={selectedInventoryId}>{!nearbyInventory.length && <option value="0">No stocked medicine found</option>}{nearbyInventory.map((item) => <option key={item.id} value={item.id}>{item.productName} — {item.businessName} — ₹{(item.salePricePaise / 100).toFixed(2)} ({item.quantity} available){item.distanceKm !== undefined ? ` · ${formatDistance(item.distanceKm)}` : ""}{item.prescriptionRequired ? " · Rx required" : ""}</option>)}</select></label>
        {refillReminderId > 0 && <div className="refill-checkout-note"><RotateCcw size={15} /><span><strong>Repeat order prepared from reminder</strong><small>Submitting this checkout will close reminder #{refillReminderId}.</small></span></div>}
        <label className="portal-field"><span>Quantity *</span><input max="100" min="1" onChange={(event) => setQuantity(Number(event.target.value))} required type="number" value={quantity} /></label>
        <label className="portal-field"><span>Customer name *</span><input onChange={(event) => setCustomerName(event.target.value)} required value={customerName} /></label>
        <label className="portal-field"><span>Phone *</span><input maxLength={10} onChange={(event) => setCustomerPhone(event.target.value.replace(/\D/g, ""))} required value={customerPhone} /></label>
        <label className="portal-field"><span>Delivery address *</span><textarea onChange={(event) => setAddress(event.target.value)} required rows={3} value={address} /></label>
        <label className="portal-field"><span>Place of supply · 2-digit GST state code *</span><input inputMode="numeric" maxLength={2} minLength={2} onChange={(event) => setPlaceOfSupplyStateCode(event.target.value.replace(/\D/g, "").slice(0, 2))} pattern="[0-9]{2}" required value={placeOfSupplyStateCode} /></label>
        <GeoLocationPicker label="Delivery location" latitude={latitude} longitude={longitude} onChange={(location) => { setLatitude(location.latitude); setLongitude(location.longitude); }} />
        {selectedInventory?.distanceKm !== undefined && <div className={`delivery-zone ${selectedWithinRadius ? "inside" : "outside"}`}><MapPin size={16} /><span><strong>{formatDistance(selectedInventory.distanceKm)}</strong><small>{selectedWithinRadius ? `Inside ${selectedInventory.deliveryRadiusKm} km delivery area` : `Outside this pharmacy's ${selectedInventory.deliveryRadiusKm} km delivery area — choose pickup or a closer pharmacy`}</small></span></div>}
        <div className="portal-split compact-fields"><label className="portal-field"><span>Payment</span><select onChange={(event) => setPaymentMethod(event.target.value as "online" | "cod")} value={paymentMethod}><option value="online">Online — Razorpay</option><option value="cod">Cash on delivery</option></select></label><label className="portal-field"><span>Delivery</span><select onChange={(event) => setDeliveryMethod(event.target.value as "pickup" | "pharmacy" | "urmed")} value={deliveryMethod}><option value="urmed">URMED delivery team</option><option value="pharmacy">Pharmacy self-delivery</option><option value="pickup">Customer pickup</option></select></label></div>
        <div className="bill-summary"><span>Taxable medicine value <strong>₹{(previewSubtotalPaise / 100).toFixed(2)}</strong></span><span>GST {selectedInventory?.gstPercent ?? 0}% <strong>₹{(previewTaxPaise / 100).toFixed(2)}</strong></span><span>Delivery <strong>₹{(previewDeliveryPaise / 100).toFixed(2)}</strong></span><span className="bill-total">Estimated payable <strong>₹{((previewSubtotalPaise + previewTaxPaise + previewDeliveryPaise) / 100).toFixed(2)}</strong></span></div>
        <button className="portal-primary wide" disabled={busy || !signedIn || !inventory.length || !selectedWithinRadius || Boolean(selectedInventory?.prescriptionRequired && !prescriptionId)} type="submit">{!selectedWithinRadius ? "Outside delivery area — choose pickup" : selectedInventory?.prescriptionRequired ? "Place order for pharmacist review" : paymentMethod === "online" ? <><CreditCard size={16} /> Create order and pay</> : "Place cash-on-delivery order"}</button>
      </form></section>
      <section className="portal-panel"><div className="portal-panel-heading"><div><Truck size={20} /><h2>My delivery timeline</h2><p>Every pharmacy or rider update appears here.</p></div></div><div className="live-list orders">{orders.length ? orders.map((order) => <article className="workflow-order" key={order.id}><span className="order-marker"><MapPin size={16} /></span><div><strong>{order.orderNumber} · {workflowStatusLabels[order.deliveryStatus] ?? order.deliveryStatus.replaceAll("_", " ")}</strong><small>{order.items} · {order.businessName}</small><em>₹{(order.totalPaise / 100).toFixed(2)} · GST ₹{(order.taxPaise / 100).toFixed(2)} · {order.paymentStatus} · {new Date(order.createdAt).toLocaleString("en-IN")}</em>{order.prescriptionId && <span className="order-rx-status">Rx: {order.prescriptionStatus.replaceAll("_", " ")}</span>}<div className="tracking-timeline">{order.trackingEvents.slice(-5).map((event, index) => <span className="tracking-step" key={`${event.status}-${event.createdAt}-${index}`}><i /><b>{workflowStatusLabels[event.status] ?? event.status.replaceAll("_", " ")}</b><small>{new Date(event.createdAt).toLocaleString("en-IN")} · {event.actorName}</small></span>)}</div></div>{order.paymentMethod === "online" && order.paymentStatus === "pending" && ["not_required", "approved"].includes(order.prescriptionStatus) && <button className="portal-secondary" disabled={busy} onClick={() => void openPayment(order.id)} type="button"><CreditCard size={14} /> Pay now</button>}</article>) : <p>No orders for this account yet.</p>}</div></section>
    </div></>}
    {role === "vendor" && <PrescriptionCenter role="vendor" />}
    {role === "vendor" && <section className="portal-panel"><div className="portal-panel-heading"><div><Truck size={20} /><h2>Controlled order fulfilment</h2><p>Only the valid next action is available. Every action is time-stamped and added to the customer timeline.</p></div></div><div className="live-list orders">{orders.length ? orders.map((order) => <article className="workflow-order vendor-workflow" key={order.id}><div><strong>{order.orderNumber} · {order.customerName}</strong><small>{order.items} · ₹{(order.totalPaise / 100).toFixed(2)} · {order.paymentStatus}</small><em>{order.deliveryAddress || order.deliveryMethod}</em><span className="workflow-current">{workflowStatusLabels[order.deliveryStatus] ?? order.deliveryStatus.replaceAll("_", " ")}</span>{order.prescriptionId && <span className="order-rx-status">Rx: {order.prescriptionStatus.replaceAll("_", " ")}</span>}<input className="workflow-note" onChange={(event) => setTrackingNotes((current) => ({ ...current, [order.id]: event.target.value }))} placeholder="Action note or cancellation reason" value={trackingNotes[order.id] ?? ""} /><div className="order-workflow-actions">{order.nextStatuses.map((nextStatus) => <button className={nextStatus === "cancelled" ? "workflow-cancel" : "portal-secondary"} disabled={busy || (nextStatus === "cancelled" && (trackingNotes[order.id]?.trim().length ?? 0) < 5)} key={nextStatus} onClick={() => void updateTracking(order.id, nextStatus)} type="button">{workflowStatusLabels[nextStatus] ?? nextStatus.replaceAll("_", " ")}</button>)}{!order.nextStatuses.length && <small>Waiting for payment, prescription approval, delivery team, or order is complete.</small>}</div></div></article>) : <p>No marketplace orders for this pharmacy yet.</p>}</div></section>}
  </div>;
}
