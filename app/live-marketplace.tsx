"use client";

import { FormEvent, useEffect, useState } from "react";
import { Boxes, CheckCircle2, CreditCard, MapPin, Minus, PackageCheck, Plus, RefreshCw, RotateCcw, Search, ShoppingCart, Trash2, Truck } from "lucide-react";
import { accessToken, authenticatedFetch, getRuntimeConfig, type RuntimeConfig } from "./marketplace-client";
import { PrescriptionCenter } from "./prescription-center";
import { RefillCenter, type RefillReminder } from "./refill-center";
import { workflowStatusLabels } from "../lib/order-workflow";
import { formatDistance, haversineKm, isValidGeoPoint } from "../lib/geo";
import { CustomerAddressBook, type CustomerCheckoutIdentity, type CustomerSavedAddress } from "./customer-address-book";
import type { CustomerReorderRequest } from "../lib/customer-order-history";
import {
  addCustomerCartLine,
  customerCartCheckoutItems,
  groupCustomerCart,
  updateCustomerCartQuantity,
  type CustomerCartLine,
} from "../lib/customer-cart";
import cartStyles from "./customer-cart.module.css";

type Role = "customer" | "vendor";
type Inventory = {
  id: number; vendorId: number; productId: number; legacyId: number; productName: string; manufacturer: string; businessName: string;
  batchNumber: string; expiryDate: string | null; purchasePricePaise?: number; salePricePaise: number;
  quantity: number; reservedQuantity: number; gstPercent: number; reorderLevel: number; prescriptionRequired: number;
  quarantineStatus: string; expiryStatus: "valid" | "near_expiry" | "expired" | "missing_expiry";
  homeDelivery: number;
  publicLocation: null | {
    label: string; address: string; latitude: string; longitude: string;
    pickupEnabled: boolean; serviceEnabled: boolean; serviceRadiusKm: number;
  };
  publicDistanceKm?: number;
};
type Order = {
  id: number; orderNumber: string; subtotalPaise: number; taxPaise: number; deliveryFeePaise: number; totalPaise: number; paymentMethod: string; paymentStatus: string;
  deliveryMethod: string; orderStatus: string; deliveryStatus: string; customerName: string;
  deliveryAddress: string; businessName: string; items: string; createdAt: string;
  inventoryStatus: "reserved" | "committed" | "released"; reservationExpiresAt: string | null;
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

export function LiveMarketplace({ role, reorderRequest = null, onReorderPrepared }: {
  role: Role;
  reorderRequest?: CustomerReorderRequest | null;
  onReorderPrepared?: () => void;
}) {
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [inventory, setInventory] = useState<Inventory[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [query, setQuery] = useState(reorderRequest?.productName ?? "");
  const [selectedInventoryId, setSelectedInventoryId] = useState(reorderRequest?.inventoryId ?? 0);
  const [quantity, setQuantity] = useState(reorderRequest?.quantity ?? 1);
  const [address, setAddress] = useState("");
  const [customerAddressId, setCustomerAddressId] = useState(0);
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [placeOfSupplyStateCode, setPlaceOfSupplyStateCode] = useState("36");
  const [paymentMethod, setPaymentMethod] = useState<"online" | "cod">("online");
  const [deliveryMethod, setDeliveryMethod] = useState<"pickup" | "pharmacy" | "urmed">("urmed");
  const [prescriptionByVendor, setPrescriptionByVendor] = useState<Record<number, number>>({});
  const [refillReminderId, setRefillReminderId] = useState(0);
  const [cart, setCart] = useState<CustomerCartLine[]>([]);
  const [checkoutVendorId, setCheckoutVendorId] = useState(0);
  const [message, setMessage] = useState(reorderRequest
    ? `${reorderRequest.productName} was prepared from order history. Review current price, stock, delivery, address${reorderRequest.prescriptionRequired ? ", and choose a fresh eligible prescription" : ""} before submitting.`
    : "");
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
      if (role === "customer" && typeof window !== "undefined") {
        const url = new URL(window.location.href);
        if (url.searchParams.get("add") === "1") {
          const requestedInventoryId = Number(url.searchParams.get("inventoryId"));
          const selected = payload.inventory.find((item) => item.id === requestedInventoryId);
          if (selected) {
            setSelectedInventoryId(selected.id);
            setCheckoutVendorId(selected.vendorId);
            setCart((current) => addCustomerCartLine(current, {
              inventoryId: selected.id,
              vendorId: selected.vendorId,
              productId: selected.productId,
              businessName: selected.businessName,
              productName: selected.productName,
              salePricePaise: selected.salePricePaise,
              gstPercent: selected.gstPercent,
              availableQuantity: selected.quantity,
              prescriptionRequired: Boolean(selected.prescriptionRequired),
              homeDelivery: Boolean(selected.homeDelivery),
              publicLocation: selected.publicLocation,
            }, 1));
            setMessage(`${selected.productName} was added to your live pharmacy cart.`);
          } else {
            setError("That medicine is no longer available. Search the current pharmacy stock instead.");
          }
          url.searchParams.delete("inventoryId");
          url.searchParams.delete("add");
          window.history.replaceState({}, "", url);
        }
      }
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
    void refresh(reorderRequest?.productName ?? "");
    // The user can explicitly refresh after signing in; this avoids auth event coupling here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role]);

  useEffect(() => {
    if (role === "customer" && reorderRequest) onReorderPrepared?.();
  }, [onReorderPrepared, reorderRequest, role]);

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
      prefill: { name: customerName, contact: customerPhone ? `+91${customerPhone}` : "" },
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

  const cartGroups = groupCustomerCart(cart);
  const checkoutGroup = cartGroups.find((group) => group.vendorId === checkoutVendorId) ?? cartGroups[0];

  const addSelectedToCart = () => {
    setError(""); setMessage("");
    const selected = inventory.find((item) => item.id === selectedInventoryId);
    if (!selected) { setError("Choose an in-stock medicine before adding it to the cart"); return; }
    setCart((current) => addCustomerCartLine(current, {
      inventoryId: selected.id,
      vendorId: selected.vendorId,
      productId: selected.productId,
      businessName: selected.businessName,
      productName: selected.productName,
      salePricePaise: selected.salePricePaise,
      gstPercent: selected.gstPercent,
      availableQuantity: selected.quantity,
      prescriptionRequired: Boolean(selected.prescriptionRequired),
      refillReminderId: refillReminderId || undefined,
      homeDelivery: Boolean(selected.homeDelivery),
      publicLocation: selected.publicLocation,
    }, quantity));
    setCheckoutVendorId((current) => current || selected.vendorId);
    setMessage(`${selected.productName} was added. Prices, tax, FEFO stock and serviceability are rechecked when this pharmacy order is submitted.`);
    setRefillReminderId(0);
  };

  const placeOrder = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    try {
      if (!signedIn) throw new Error("Sign in as a customer before placing an order");
      if (!checkoutGroup?.lines.length) throw new Error("Add at least one live stocked medicine to the cart");
      if (!customerAddressId) throw new Error("Select or save a delivery address before placing the order");
      const selectedPrescriptionId = prescriptionByVendor[checkoutGroup.vendorId] ?? 0;
      if (checkoutGroup.requiresPrescription && !selectedPrescriptionId) throw new Error("Select an unused prescription for this pharmacy order");
      const checkoutRefillReminderId = checkoutGroup.lines.find((line) => line.refillReminderId)?.refillReminderId;
      const response = await authenticatedFetch("/api/orders", { method: "POST", body: JSON.stringify({
        items: customerCartCheckoutItems(checkoutGroup), customerAddressId,
        prescriptionId: selectedPrescriptionId || undefined,
        refillReminderId: checkoutRefillReminderId, placeOfSupplyStateCode, paymentMethod, deliveryMethod,
      }) });
      const payload = await responsePayload<{ order: { id: number; orderNumber: string; totalPaise: number; requiresPrescriptionReview: boolean; reservationExpiresAt: string | null } }>(response);
      const reservationMessage = payload.order.reservationExpiresAt ? ` Stock is reserved until ${new Date(payload.order.reservationExpiresAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}.` : "";
      setMessage(payload.order.requiresPrescriptionReview ? `${payload.order.orderNumber} is awaiting pharmacist prescription review.${reservationMessage}` : `${payload.order.orderNumber} was created successfully.${reservationMessage}`);
      const remaining = cart.filter((line) => line.vendorId !== checkoutGroup.vendorId);
      setCart(remaining);
      setPrescriptionByVendor((current) => { const next = { ...current }; delete next[checkoutGroup.vendorId]; return next; });
      setCheckoutVendorId(groupCustomerCart(remaining)[0]?.vendorId ?? 0);
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

  const applyCheckoutIdentity = (identity: CustomerCheckoutIdentity) => {
    setCustomerName(identity.name);
    setCustomerPhone(identity.phone);
  };

  const selectCheckoutAddress = (selected: CustomerSavedAddress | null) => {
    setCustomerAddressId(selected?.id ?? 0);
    setAddress(selected?.address ?? "");
    setLatitude(selected?.latitude ?? "");
    setLongitude(selected?.longitude ?? "");
  };

  const customerPoint = { latitude: Number(latitude), longitude: Number(longitude) };
  const customerPointValid = latitude !== "" && longitude !== "" && isValidGeoPoint(customerPoint);
  const publicInventory = inventory.map((item) => {
    const publicPoint = item.publicLocation
      ? { latitude: Number(item.publicLocation.latitude), longitude: Number(item.publicLocation.longitude) }
      : null;
    const publicDistanceKm = customerPointValid && item.publicLocation?.serviceEnabled && publicPoint && isValidGeoPoint(publicPoint)
      ? haversineKm(customerPoint, publicPoint)
      : undefined;
    return { ...item, publicDistanceKm };
  }).sort((left, right) => (left.publicDistanceKm ?? Number.POSITIVE_INFINITY) - (right.publicDistanceKm ?? Number.POSITIVE_INFINITY));
  const selectedInventory = publicInventory.find((item) => item.id === selectedInventoryId);
  const checkoutOffer = checkoutGroup?.lines[0];
  const checkoutPublicPoint = checkoutOffer?.publicLocation
    ? { latitude: Number(checkoutOffer.publicLocation.latitude), longitude: Number(checkoutOffer.publicLocation.longitude) }
    : null;
  const checkoutDistanceKm = customerPointValid && checkoutOffer?.publicLocation?.serviceEnabled
    && checkoutPublicPoint && isValidGeoPoint(checkoutPublicPoint)
    ? haversineKm(customerPoint, checkoutPublicPoint)
    : undefined;
  const withinPublishedServiceRadius = checkoutDistanceKm === undefined
    || !checkoutOffer?.publicLocation?.serviceEnabled
    || checkoutDistanceKm <= checkoutOffer.publicLocation.serviceRadiusKm;
  const selectedDeliveryOptionAvailable = deliveryMethod === "pickup"
    ? Boolean(checkoutOffer?.publicLocation?.pickupEnabled)
    : (deliveryMethod !== "pharmacy" || Boolean(checkoutOffer?.homeDelivery)) && withinPublishedServiceRadius;

  const prepareRefill = async (reminder: RefillReminder) => {
    setBusy(true); setError(""); setMessage("");
    try {
      const stocked = await refresh(reminder.medicineName);
      const offer = stocked.find((item) => item.id === reminder.currentInventoryId);
      if (!offer) throw new Error("This medicine is no longer available. Refresh the reminder later.");
      setQuery(reminder.medicineName);
      setSelectedInventoryId(offer.id);
      setQuantity(Math.min(100, Math.max(1, reminder.originalQuantity)));
      setRefillReminderId(reminder.id);
      setMessage("Repeat order prepared below. Add it to the cart, then review current price, stock, delivery, payment and prescription before submitting.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Repeat order could not be prepared"); }
    finally { setBusy(false); }
  };
  const previewSubtotalPaise = checkoutGroup?.estimatedSubtotalPaise ?? 0;
  const previewTaxPaise = checkoutGroup?.estimatedTaxPaise ?? 0;
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
      <section className="portal-panel"><div className="portal-panel-heading"><div><Search size={20} /><h2>Live pharmacy cart</h2><p>Build a multi-line cart from current inventory. Pharmacy groups are checked out as separate orders.</p></div><span className={cartStyles.cartCount}><ShoppingCart size={15} />{cart.reduce((total, line) => total + line.quantity, 0)} units</span></div>
        <form className="live-search" onSubmit={(event) => { event.preventDefault(); void refresh(query); }}><input onChange={(event) => setQuery(event.target.value)} placeholder="Search stocked medicine" value={query} /><button type="submit">Search stock</button></form>
        <div className="portal-form-grid one">
          <label className="portal-field"><span>Medicine and pharmacy *</span><select onChange={(event) => { setSelectedInventoryId(Number(event.target.value)); setRefillReminderId(0); }} required value={selectedInventoryId}>{!publicInventory.length && <option value="0">No stocked medicine found</option>}{publicInventory.map((item) => <option key={item.id} value={item.id}>{item.productName} — {item.businessName} — ₹{(item.salePricePaise / 100).toFixed(2)} ({item.quantity} available){item.publicDistanceKm !== undefined ? ` · ${formatDistance(item.publicDistanceKm)}` : ""}{item.prescriptionRequired ? " · Rx required" : ""}</option>)}</select></label>
          {refillReminderId > 0 && <div className="refill-checkout-note"><RotateCcw size={15} /><span><strong>Repeat order prepared from reminder</strong><small>Adding this item keeps reminder #{refillReminderId} with its pharmacy checkout.</small></span></div>}
          <label className="portal-field"><span>Quantity to add *</span><input max={Math.min(100, selectedInventory?.quantity ?? 100)} min="1" onChange={(event) => setQuantity(Number(event.target.value))} required type="number" value={quantity} /></label>
          <button className="portal-secondary wide" disabled={!selectedInventoryId} onClick={addSelectedToCart} type="button"><Plus size={15} /> Add to pharmacy cart</button>
        </div>
        {selectedInventory && <section className="portal-note medicine-detail-card" aria-labelledby="medicine-detail-title">
          <div><span className="portal-kicker">LIVE MEDICINE DETAILS</span><h3 id="medicine-detail-title">{selectedInventory.productName}</h3><p>{selectedInventory.manufacturer || "Manufacturer information is not available"} · {selectedInventory.businessName}</p></div>
          <div className="portal-split compact-fields"><span><small>Current price</small><strong>₹{(selectedInventory.salePricePaise / 100).toFixed(2)}</strong></span><span><small>Available stock</small><strong>{selectedInventory.quantity} units</strong></span><span><small>Prescription</small><strong>{selectedInventory.prescriptionRequired ? "Required" : "Not required"}</strong></span><span><small>Expiry status</small><strong>{selectedInventory.expiryStatus.replaceAll("_", " ")}</strong></span></div>
          <small>Prices, tax, stock and FEFO batch allocation are revalidated by the pharmacy API before checkout.</small>
        </section>}
        <div className={cartStyles.groups}>{cartGroups.length ? cartGroups.map((group) => <article className={`${cartStyles.group} ${checkoutGroup?.vendorId === group.vendorId ? cartStyles.selected : ""}`} key={group.vendorId}><header><span><strong>{group.businessName}</strong><small>{group.lines.length} medicine lines · {group.unitCount} units</small></span><button onClick={() => setCheckoutVendorId(group.vendorId)} type="button">{checkoutGroup?.vendorId === group.vendorId ? "Checking out" : "Checkout this pharmacy"}</button></header><div>{group.lines.map((line) => <div className={cartStyles.line} key={line.inventoryId}><span><strong>{line.productName}{line.prescriptionRequired ? " · Rx" : ""}</strong><small>Current preview ₹{(line.salePricePaise / 100).toFixed(2)} + {line.gstPercent}% GST</small></span><div className={cartStyles.quantity}><button aria-label={`Reduce ${line.productName}`} onClick={() => setCart((current) => updateCustomerCartQuantity(current, line.inventoryId, line.quantity - 1))} type="button"><Minus size={13} /></button><input aria-label={`${line.productName} quantity`} max={Math.min(100, line.availableQuantity)} min="1" onChange={(event) => setCart((current) => updateCustomerCartQuantity(current, line.inventoryId, Number(event.target.value)))} type="number" value={line.quantity} /><button aria-label={`Increase ${line.productName}`} onClick={() => setCart((current) => updateCustomerCartQuantity(current, line.inventoryId, line.quantity + 1))} type="button"><Plus size={13} /></button><button aria-label={`Remove ${line.productName}`} className={cartStyles.remove} onClick={() => setCart((current) => current.filter((item) => item.inventoryId !== line.inventoryId))} type="button"><Trash2 size={14} /></button></div></div>)}</div><footer><span>Estimated medicines + GST</span><strong>₹{((group.estimatedSubtotalPaise + group.estimatedTaxPaise) / 100).toFixed(2)}</strong></footer></article>) : <div className={cartStyles.empty}><ShoppingCart size={21} /><span><strong>Your cart is empty</strong><small>Add live inventory above. No demo products are placed in the cart.</small></span></div>}</div>
        {checkoutGroup?.requiresPrescription && <PrescriptionCenter onSelect={(id) => setPrescriptionByVendor((current) => ({ ...current, [checkoutGroup.vendorId]: id }))} role="customer" selectedId={prescriptionByVendor[checkoutGroup.vendorId] ?? 0} vendorId={checkoutGroup.vendorId} />}
        <CustomerAddressBook onIdentity={applyCheckoutIdentity} onSelect={selectCheckoutAddress} />
        <form className="portal-form-grid one" onSubmit={placeOrder}>
        <div className={cartStyles.checkoutNotice}><PackageCheck size={16} /><span><strong>{checkoutGroup ? `Checkout: ${checkoutGroup.businessName}` : "Add a medicine to begin checkout"}</strong><small>Each pharmacy becomes its own order. Final FEFO batches, prices, GST, prescription eligibility, stock and delivery serviceability are validated by the server.</small></span></div>
        <label className="portal-field"><span>Verified customer name</span><input readOnly value={customerName} /><small>Loaded from your live customer profile.</small></label>
        <label className="portal-field"><span>Verified mobile number</span><input readOnly value={customerPhone} /><small>Change and re-verify this number in account settings, not during checkout.</small></label>
        <label className="portal-field wide"><span>Selected delivery address</span><textarea readOnly rows={2} value={address} /></label>
        <label className="portal-field"><span>Place of supply · 2-digit GST state code *</span><input inputMode="numeric" maxLength={2} minLength={2} onChange={(event) => setPlaceOfSupplyStateCode(event.target.value.replace(/\D/g, "").slice(0, 2))} pattern="[0-9]{2}" required value={placeOfSupplyStateCode} /></label>
        {deliveryMethod === "pickup" && <div className={`delivery-zone ${selectedDeliveryOptionAvailable ? "inside" : "outside"}`}><MapPin size={16} /><span><strong>{selectedDeliveryOptionAvailable ? checkoutOffer?.publicLocation?.label : "Public pickup point unavailable"}</strong><small>{selectedDeliveryOptionAvailable ? checkoutOffer?.publicLocation?.address : "Choose delivery. The pharmacy's private registered location is not shown."}</small></span></div>}
        {deliveryMethod !== "pickup" && <div className={`delivery-zone ${selectedDeliveryOptionAvailable ? "inside" : "outside"}`}><MapPin size={16} /><span><strong>{checkoutDistanceKm !== undefined ? formatDistance(checkoutDistanceKm) : selectedDeliveryOptionAvailable ? "Serviceability checked securely" : "Delivery option unavailable"}</strong><small>{checkoutDistanceKm !== undefined ? withinPublishedServiceRadius ? `Inside the published ${checkoutOffer?.publicLocation?.serviceRadiusKm} km service area` : "Outside the published service area — choose pickup or another pharmacy" : selectedDeliveryOptionAvailable ? "No public service pin is shared; final range is checked securely when the order is submitted." : "Choose another delivery option for this pharmacy."}</small></span></div>}
        <div className="portal-split compact-fields"><label className="portal-field"><span>Payment</span><select onChange={(event) => setPaymentMethod(event.target.value as "online" | "cod")} value={paymentMethod}><option value="online">Online — Razorpay</option><option value="cod">Cash on delivery</option></select></label><label className="portal-field"><span>Delivery</span><select onChange={(event) => setDeliveryMethod(event.target.value as "pickup" | "pharmacy" | "urmed")} value={deliveryMethod}><option value="urmed">URMED delivery team</option><option value="pharmacy">Pharmacy self-delivery</option><option value="pickup">Customer pickup</option></select></label></div>
        <div className="bill-summary"><span>Taxable medicine value <strong>₹{(previewSubtotalPaise / 100).toFixed(2)}</strong></span><span>Estimated GST <strong>₹{(previewTaxPaise / 100).toFixed(2)}</strong></span><span>Delivery <strong>₹{(previewDeliveryPaise / 100).toFixed(2)}</strong></span><span className="bill-total">Estimated payable <strong>₹{((previewSubtotalPaise + previewTaxPaise + previewDeliveryPaise) / 100).toFixed(2)}</strong></span></div>
        <button className="portal-primary wide" disabled={busy || !signedIn || !checkoutGroup || !customerAddressId || !selectedDeliveryOptionAvailable || Boolean(checkoutGroup.requiresPrescription && !prescriptionByVendor[checkoutGroup.vendorId])} type="submit">{!checkoutGroup ? "Add live medicines to the cart" : !customerAddressId ? "Select a saved delivery address" : !selectedDeliveryOptionAvailable ? "Choose another delivery option" : checkoutGroup.requiresPrescription ? "Place pharmacy order for Rx review" : paymentMethod === "online" ? <><CreditCard size={16} /> Create pharmacy order and pay</> : "Place pharmacy cash-on-delivery order"}</button>
      </form></section>
      <section className="portal-panel"><div className="portal-panel-heading"><div><Truck size={20} /><h2>My delivery timeline</h2><p>Every pharmacy or rider update appears here.</p></div></div><div className="live-list orders">{orders.length ? orders.map((order) => <article className="workflow-order" key={order.id}><span className="order-marker"><MapPin size={16} /></span><div><strong>{order.orderNumber} · {workflowStatusLabels[order.deliveryStatus] ?? order.deliveryStatus.replaceAll("_", " ")}</strong><small>{order.items} · {order.businessName}</small><em>₹{(order.totalPaise / 100).toFixed(2)} · GST ₹{(order.taxPaise / 100).toFixed(2)} · {order.paymentStatus} · {new Date(order.createdAt).toLocaleString("en-IN")}</em>{order.inventoryStatus === "reserved" && order.reservationExpiresAt && <span className="order-rx-status">Stock reserved until {new Date(order.reservationExpiresAt).toLocaleString("en-IN")}</span>}{order.inventoryStatus === "released" && <span className="order-rx-status">Stock reservation released — place a new order to continue</span>}{order.prescriptionId && <span className="order-rx-status">Rx: {order.prescriptionStatus.replaceAll("_", " ")}</span>}<div className="tracking-timeline">{order.trackingEvents.slice(-5).map((event, index) => <span className="tracking-step" key={`${event.status}-${event.createdAt}-${index}`}><i /><b>{workflowStatusLabels[event.status] ?? event.status.replaceAll("_", " ")}</b><small>{new Date(event.createdAt).toLocaleString("en-IN")} · {event.actorName}</small></span>)}</div></div>{order.paymentMethod === "online" && order.paymentStatus === "pending" && order.inventoryStatus !== "released" && ["not_required", "approved"].includes(order.prescriptionStatus) && <button className="portal-secondary" disabled={busy} onClick={() => void openPayment(order.id)} type="button"><CreditCard size={14} /> Pay now</button>}</article>) : <p>No orders for this account yet.</p>}</div></section>
    </div></>}
    {role === "vendor" && <PrescriptionCenter role="vendor" />}
    {role === "vendor" && <section className="portal-panel"><div className="portal-panel-heading"><div><Truck size={20} /><h2>Controlled order fulfilment</h2><p>Only the valid next action is available. Every action is time-stamped and added to the customer timeline.</p></div></div><div className="live-list orders">{orders.length ? orders.map((order) => <article className="workflow-order vendor-workflow" key={order.id}><div><strong>{order.orderNumber} · {order.customerName}</strong><small>{order.items} · ₹{(order.totalPaise / 100).toFixed(2)} · {order.paymentStatus}</small><em>{order.deliveryAddress || order.deliveryMethod}</em><span className="workflow-current">{workflowStatusLabels[order.deliveryStatus] ?? order.deliveryStatus.replaceAll("_", " ")}</span>{order.prescriptionId && <span className="order-rx-status">Rx: {order.prescriptionStatus.replaceAll("_", " ")}</span>}<input className="workflow-note" onChange={(event) => setTrackingNotes((current) => ({ ...current, [order.id]: event.target.value }))} placeholder="Action note or cancellation reason" value={trackingNotes[order.id] ?? ""} /><div className="order-workflow-actions">{order.nextStatuses.map((nextStatus) => <button className={nextStatus === "cancelled" ? "workflow-cancel" : "portal-secondary"} disabled={busy || (nextStatus === "cancelled" && (trackingNotes[order.id]?.trim().length ?? 0) < 5)} key={nextStatus} onClick={() => void updateTracking(order.id, nextStatus)} type="button">{workflowStatusLabels[nextStatus] ?? nextStatus.replaceAll("_", " ")}</button>)}{!order.nextStatuses.length && <small>Waiting for payment, prescription approval, delivery team, or order is complete.</small>}</div></div></article>) : <p>No marketplace orders for this pharmacy yet.</p>}</div></section>}
  </div>;
}
