"use client";

import { useEffect, useMemo, useState } from "react";
import { RequirementsPortal } from "./requirements-portal";
import { DeliveryOperationsCenter } from "./operations-centers";
import {
  AlertTriangle,
  ArrowRight,
  BadgeIndianRupee,
  Baby,
  Banknote,
  Bike,
  Boxes,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock3,
  CreditCard,
  HeartPulse,
  LayoutDashboard,
  MapPin,
  Minus,
  Navigation,
  PackageCheck,
  PackageSearch,
  Pill,
  Plus,
  Search,
  ShieldCheck,
  ShoppingCart,
  Sparkles,
  Star,
  Stethoscope,
  Store,
  Truck,
  Upload,
  UserRound,
  X,
} from "lucide-react";

const categories = [
  { name: "Medicines", note: "Prescription & OTC", icon: Pill, tone: "teal" },
  { name: "Wellness", note: "Everyday health", icon: HeartPulse, tone: "blue" },
  { name: "Baby care", note: "Gentle essentials", icon: Baby, tone: "amber" },
  { name: "Devices", note: "Health monitoring", icon: Stethoscope, tone: "violet" },
];

type StorefrontProduct = {
  id: number;
  name: string;
  composition: string;
  pack: string;
  price: string;
  mrp: string;
  discount: string;
  pharmacy: string;
  tone: string;
  rx: boolean;
  migrated?: boolean;
  manufacturer?: string;
  inventoryId?: number;
};

type CatalogApiProduct = {
  legacyId: number;
  name: string;
  composition: string;
  manufacturer: string;
  prescriptionRequired: number;
  packaging: string;
  inventoryId: number | null;
  salePricePaise: number | null;
  availableQuantity: number | null;
  pharmacyName: string | null;
};

const products: StorefrontProduct[] = [
  {
    id: 1,
    name: "Dolo 650 Tablet",
    composition: "Paracetamol 650 mg",
    pack: "15 tablets",
    price: "₹31.20",
    mrp: "₹34.70",
    discount: "10% off",
    pharmacy: "3 pharmacies",
    tone: "mint",
    rx: false,
  },
  {
    id: 2,
    name: "Telma 40 Tablet",
    composition: "Telmisartan 40 mg",
    pack: "30 tablets",
    price: "₹198.40",
    mrp: "₹248.00",
    discount: "20% off",
    pharmacy: "2 pharmacies",
    tone: "peach",
    rx: true,
  },
  {
    id: 3,
    name: "Shelcal 500",
    composition: "Calcium + Vitamin D3",
    pack: "15 tablets",
    price: "₹118.10",
    mrp: "₹131.20",
    discount: "10% off",
    pharmacy: "5 pharmacies",
    tone: "sky",
    rx: false,
  },
  {
    id: 4,
    name: "Accu-Chek Active",
    composition: "Blood glucose test strips",
    pack: "50 strips",
    price: "₹899.00",
    mrp: "₹1,049.00",
    discount: "14% off",
    pharmacy: "2 pharmacies",
    tone: "lilac",
    rx: false,
  },
];

const activeOrders = [
  { id: "UR1048", customer: "Ananya Reddy", items: "Dolo 650, Shelcal 500", value: "₹187.30", payment: "Online", status: "Ready to dispatch", delivery: "URMED partner" },
  { id: "UR1047", customer: "Rohan Mehta", items: "Telma 40", value: "₹198.40", payment: "COD", status: "Pharmacist review", delivery: "Pharmacy delivery" },
  { id: "UR1046", customer: "Meera Rao", items: "Accu-Chek Active", value: "₹899.00", payment: "Online", status: "Packed", delivery: "URMED partner" },
];

type AppMode = "customer" | "pharmacy" | "delivery" | "vendor" | "admin" | "customer-account";

function ConsoleShell({ mode, setMode }: { mode: AppMode; setMode: (mode: AppMode) => void }) {
  const deliveryMode = mode === "delivery";
  return (
    <main className="console-shell">
      <aside className="console-sidebar">
        <button className="brand sidebar-brand" onClick={() => setMode("customer")} type="button">
          <span className="brand-mark"><Pill size={21} /></span>
          <span>ur<span>med</span></span>
        </button>
        <div className="workspace-label"><span>SB</span><div><small>Pharmacy workspace</small><strong>Sri Balaji Pharmacy</strong></div></div>
        <nav className="console-nav">
          <button className={!deliveryMode ? "active" : ""} onClick={() => setMode("pharmacy")} type="button"><LayoutDashboard size={18} /> Pharmacy operations</button>
          <button className={deliveryMode ? "active" : ""} onClick={() => setMode("delivery")} type="button"><Bike size={18} /> Delivery control</button>
          <button type="button"><PackageSearch size={18} /> Medicine catalogue</button>
          <button type="button"><Boxes size={18} /> Stock & batches</button>
          <button onClick={() => setMode("vendor")} type="button"><Store size={18} /> Vendor module</button>
          <button onClick={() => setMode("admin")} type="button"><ShieldCheck size={18} /> Admin panel</button>
        </nav>
        <div className="console-help"><ShieldCheck size={19} /><span><strong>Tenant protected</strong><small>Only your pharmacy records are visible.</small></span></div>
        <button className="back-marketplace" onClick={() => setMode("customer")} type="button"><ArrowRight size={17} /> Back to marketplace</button>
      </aside>

      <section className="console-main">
        <header className="console-header">
          <div><span className="section-kicker">{deliveryMode ? "DELIVERY NETWORK" : "PHARMACY OPERATIONS"}</span><h1>{deliveryMode ? "Delivery control centre" : "Good evening, Dr. Sharma"}</h1></div>
          <div className="console-header-actions"><button type="button"><Search size={18} /></button><button type="button"><UserRound size={18} /> AS</button></div>
        </header>

        {!deliveryMode ? (
          <>
            <div className="metric-grid">
              <article><span className="metric-icon green"><BadgeIndianRupee size={20} /></span><div><small>Today’s sales</small><strong>₹24,860</strong><em>+12.4% from yesterday</em></div></article>
              <article><span className="metric-icon blue"><PackageCheck size={20} /></span><div><small>New orders</small><strong>18</strong><em>6 need confirmation</em></div></article>
              <article><span className="metric-icon amber"><Boxes size={20} /></span><div><small>Low stock items</small><strong>23</strong><em>Review reorder levels</em></div></article>
              <article><span className="metric-icon red"><AlertTriangle size={20} /></span><div><small>Near expiry</small><strong>11</strong><em>Within 90 days</em></div></article>
            </div>

            <section className="order-panel">
              <div className="panel-heading"><div><h2>Active marketplace orders</h2><p>Confirm, pack and hand over orders from one queue.</p></div><button type="button">View all orders <ArrowRight size={16} /></button></div>
              <div className="order-table-wrap">
                <table>
                  <thead><tr><th>Order</th><th>Customer & items</th><th>Payment</th><th>Delivery</th><th>Status</th><th /></tr></thead>
                  <tbody>
                    {activeOrders.map((order) => (
                      <tr key={order.id}>
                        <td><strong>#{order.id}</strong><small>Today, 6:42 PM</small></td>
                        <td><strong>{order.customer}</strong><small>{order.items}</small></td>
                        <td><strong>{order.value}</strong><small>{order.payment}</small></td>
                        <td><span className="delivery-label">{order.delivery}</span></td>
                        <td><span className={`status-pill ${order.status.toLowerCase().replaceAll(" ", "-")}`}>{order.status}</span></td>
                        <td><button className="table-action" type="button">Review</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <div className="operations-grid">
              <section><div className="panel-heading compact"><div><h2>Stock attention</h2><p>Batch-level alerts requiring action.</p></div></div><div className="alert-list"><div><span>Dolo 650</span><strong>8 packs left</strong><em>Reorder</em></div><div><span>Azithral 500</span><strong>Expires in 42 days</strong><em>Review</em></div><div><span>Telma 40</span><strong>12 packs left</strong><em>Reorder</em></div></div></section>
              <section className="fulfilment-card"><span><Truck size={23} /></span><h2>94% fulfilment rate</h2><p>17 of 18 marketplace orders were fulfilled today within the promised time.</p><div><i style={{ width: "94%" }} /></div></section>
            </div>
          </>
        ) : (
          <>
            <DeliveryOperationsCenter />
            <div className="delivery-overview">
              <article><Bike size={22} /><span><small>Riders online</small><strong>14</strong></span></article>
              <article><Clock3 size={22} /><span><small>Average delivery</small><strong>31 min</strong></span></article>
              <article><PackageCheck size={22} /><span><small>Delivered today</small><strong>86</strong></span></article>
            </div>
            <section className="dispatch-board">
              <div className="dispatch-map">
                <div className="map-grid" />
                <span className="map-pin pharmacy-pin"><Store size={17} /></span>
                <span className="map-pin rider-pin one"><Bike size={17} /></span>
                <span className="map-pin rider-pin two"><Bike size={17} /></span>
                <span className="map-pin destination-pin"><MapPin size={17} /></span>
                <div className="dispatch-summary"><span><Navigation size={17} /></span><div><small>Fastest assignment</small><strong>Ravi is 1.4 km from pickup</strong></div></div>
              </div>
              <div className="dispatch-queue">
                <div className="panel-heading compact"><div><h2>Ready for assignment</h2><p>Matched by distance and workload.</p></div></div>
                {activeOrders.slice(0, 2).map((order, index) => (
                  <article key={order.id}><span className="queue-number">0{index + 1}</span><div><strong>#{order.id} · {order.customer}</strong><small>Sri Balaji Pharmacy → {index ? "Banjara Hills" : "Jubilee Hills"}</small><em>{index ? "3.8 km" : "2.2 km"} · {order.value}</em></div><button type="button">Assign rider</button></article>
                ))}
              </div>
            </section>
          </>
        )}
      </section>
    </main>
  );
}

const pharmacies = [
  { name: "Sri Balaji Pharmacy", distance: "1.2 km", eta: "24–35 min", rating: "4.8" },
  { name: "LifeCare Medicals", distance: "2.4 km", eta: "35–45 min", rating: "4.7" },
  { name: "Apollo Partner Pharmacy", distance: "3.1 km", eta: "45–55 min", rating: "4.9" },
];

export default function Home() {
  const [mode, setMode] = useState<AppMode>("customer");
  const [query, setQuery] = useState("");
  const [cart, setCart] = useState<number[]>([1, 3]);
  const [cartOpen, setCartOpen] = useState(false);
  const [payment, setPayment] = useState<"online" | "cod">("online");
  const [delivery, setDelivery] = useState<"pharmacy" | "urmed">("urmed");
  const [orderPlaced, setOrderPlaced] = useState(false);
  const [catalogResults, setCatalogResults] = useState<StorefrontProduct[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState("");

  const filteredProducts = useMemo(() => {
    const value = query.trim().toLowerCase();
    if (!value) return products;
    return products.filter((product) => `${product.name} ${product.composition}`.toLowerCase().includes(value));
  }, [query]);

  useEffect(() => {
    const value = query.trim();
    if (value.length < 2) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCatalogResults([]);
      setCatalogError("");
      setCatalogLoading(false);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setCatalogLoading(true);
      setCatalogError("");
      try {
        const response = await fetch(`/api/catalog?q=${encodeURIComponent(value)}&limit=24`, { signal: controller.signal });
        if (!response.ok) throw new Error("Recovered catalogue is temporarily unavailable");
        const payload = await response.json() as { products: CatalogApiProduct[] };
        const tones = ["mint", "peach", "sky", "lilac"];
        setCatalogResults(payload.products.map((product, index) => ({
          id: product.inventoryId ? 1_000_000_000 + product.inventoryId : product.legacyId,
          name: product.name,
          composition: product.composition || product.manufacturer || "Recovered medicine record",
          pack: product.packaging || product.manufacturer || "Pack information unavailable",
          price: product.salePricePaise ? `₹${(product.salePricePaise / 100).toFixed(2)}` : "Price on stock check",
          mrp: "",
          discount: "Recovered",
          pharmacy: product.pharmacyName ? `${product.pharmacyName} · ${product.availableQuantity} available` : `shared catalogue · Product ID ${product.legacyId}`,
          tone: tones[index % tones.length],
          rx: Boolean(product.prescriptionRequired),
          migrated: true,
          manufacturer: product.manufacturer,
          inventoryId: product.inventoryId ?? undefined,
        })));
      } catch (error) {
        if ((error as Error).name !== "AbortError") setCatalogError(error instanceof Error ? error.message : "Catalogue search failed");
      } finally {
        if (!controller.signal.aborted) setCatalogLoading(false);
      }
    }, 300);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query]);

  const searchingRecoveredCatalogue = query.trim().length >= 2;
  const displayedProducts = searchingRecoveredCatalogue ? catalogResults : filteredProducts;

  const cartProducts = cart.map((id) => products.find((product) => product.id === id)).filter(Boolean) as typeof products;
  const cartTotal = cartProducts.reduce((total, product) => total + Number(product.price.replace(/[₹,]/g, "")), 0);

  const addProduct = (id: number) => {
    setCart((current) => [...current, id]);
    setCartOpen(true);
  };

  if (mode === "vendor" || mode === "admin" || mode === "customer-account") {
    return <RequirementsPortal initialRole={mode === "customer-account" ? "customer" : mode} onBack={() => setMode("customer")} />;
  }
  if (mode !== "customer") return <ConsoleShell mode={mode} setMode={setMode} />;

  return (
    <main className="site-shell">
      <header className="topbar">
        <div className="nav-wrap">
          <a className="brand" href="#top" aria-label="URMED home">
            <span className="brand-mark"><Pill size={22} /></span>
            <span>ur<span>med</span></span>
          </a>

          <button className="location-control" type="button">
            <MapPin size={18} />
            <span><small>Delivering to</small>Hyderabad, Telangana</span>
            <ChevronDown size={16} />
          </button>

          <nav className="main-nav" aria-label="Primary navigation">
            <a href="#medicines">Medicines</a>
            <a href="#pharmacies">Pharmacies</a>
            <a href="#how-it-works">How it works</a>
            <button onClick={() => setMode("pharmacy")} type="button">Partner console</button>
          </nav>

          <div className="nav-actions">
            <button className="icon-button" onClick={() => setMode("customer-account")} type="button" aria-label="Customer account">
              <UserRound size={20} />
            </button>
            <button className="cart-button" onClick={() => setCartOpen(true)} type="button">
              <ShoppingCart size={20} />
              <span>Cart</span>
              <b>{cart.length}</b>
            </button>
          </div>
        </div>
      </header>

      <section className="hero" id="top">
        <div className="hero-content">
          <div className="hero-copy">
            <div className="eyebrow"><Sparkles size={15} /> Trusted neighbourhood pharmacies, one marketplace</div>
            <h1>Your medicines,<br /><span>closer than ever.</span></h1>
            <p>Compare verified pharmacies, upload your prescription and get medicines delivered safely to your doorstep.</p>

            <div className="search-panel" role="search">
              <Search size={22} />
              <input aria-label="Search medicines" onChange={(event) => setQuery(event.target.value)} placeholder="Search medicines, health products or brands" value={query} />
              <button onClick={() => document.querySelector("#medicines")?.scrollIntoView()} type="button">Search</button>
            </div>

            <div className="quick-links">
              <span>Popular:</span>
              <a href="#medicines">Paracetamol</a>
              <a href="#medicines">Diabetes care</a>
              <a href="#medicines">BP monitors</a>
            </div>

            <div className="trust-row">
              <div><ShieldCheck size={20} /><span><strong>Verified</strong> pharmacies</span></div>
              <div><Truck size={20} /><span><strong>Fast</strong> local delivery</span></div>
              <div><BadgeIndianRupee size={20} /><span><strong>COD & online</strong> payments</span></div>
            </div>
          </div>

          <div className="hero-visual" aria-label="URMED medicine delivery service">
            <div className="orb orb-one" />
            <div className="orb orb-two" />
            <div className="delivery-card">
              <div className="delivery-head">
                <span className="delivery-icon"><Truck size={25} /></span>
                <div><small>Order #UR1048</small><strong>Out for delivery</strong></div>
                <span className="live-dot">Live</span>
              </div>
              <div className="route-map">
                <div className="route-line" />
                <span className="route-start"><Pill size={17} /></span>
                <span className="route-rider"><Navigation size={18} /></span>
                <span className="route-end"><MapPin size={17} /></span>
              </div>
              <div className="delivery-meta">
                <div><Clock3 size={17} /><span><small>Arriving in</small><strong>18 minutes</strong></span></div>
                <div className="rider-stack"><i>RK</i><span><small>Delivery partner</small><strong>Ravi Kumar</strong></span></div>
              </div>
            </div>

            <div className="floating-card prescription-card">
              <ShieldCheck size={19} />
              <span><strong>Prescription verified</strong><small>Reviewed by pharmacist</small></span>
            </div>
            <div className="floating-card rating-card">
              <Star size={18} fill="currentColor" />
              <span><strong>4.8 average rating</strong><small>Across partner pharmacies</small></span>
            </div>
          </div>
        </div>
      </section>

      <section className="content-section categories-section" aria-labelledby="category-title">
        <div className="section-heading">
          <div><span className="section-kicker">EXPLORE</span><h2 id="category-title">Shop by category</h2></div>
          <a href="#medicines">View all categories <ArrowRight size={17} /></a>
        </div>
        <div className="category-grid">
          {categories.map(({ name, note, icon: Icon, tone }) => (
            <a className="category-card" href="#medicines" key={name}>
              <span className={`category-icon ${tone}`}><Icon size={26} /></span>
              <span><strong>{name}</strong><small>{note}</small></span>
              <ArrowRight size={18} />
            </a>
          ))}
        </div>
      </section>

      <section className="content-section product-section" id="medicines" aria-labelledby="product-title">
        <div className="section-heading">
          <div><span className="section-kicker">{searchingRecoveredCatalogue ? "RECOVERED MEDICINE DATABASE" : "POPULAR NEAR YOU"}</span><h2 id="product-title">{searchingRecoveredCatalogue ? `Catalogue results for “${query.trim()}”` : "Everyday health essentials"}</h2></div>
          <a href="#medicines">Browse all medicines <ArrowRight size={17} /></a>
        </div>
        {catalogLoading && <div className="catalogue-state"><span className="catalogue-loader" /> Searching 100,041 recovered medicines…</div>}
        {catalogError && <div className="catalogue-state error">{catalogError}</div>}
        {!catalogLoading && searchingRecoveredCatalogue && !catalogError && !displayedProducts.length && <div className="catalogue-state">No recovered medicine matched this search.</div>}
        <div className="product-grid">
          {displayedProducts.map((product) => (
            <article className="product-card" key={product.name}>
              <div className={`product-art ${product.tone}`}>
                <Pill size={44} strokeWidth={1.5} />
                <span>{product.discount}</span>
                {product.rx && <b>Rx</b>}
              </div>
              <div className="product-body">
                <h3>{product.name}</h3>
                <p>{product.composition}</p>
                <small>{product.pack}</small>
                <div className="availability"><span /> Available at {product.pharmacy}</div>
                <div className="product-footer">
                  <div><strong className={product.migrated ? "catalogue-price" : ""}>{product.price}</strong>{product.mrp && <del>{product.mrp}</del>}</div>
                  <button disabled={Boolean(product.migrated && !product.inventoryId)} onClick={() => product.inventoryId ? setMode("customer-account") : !product.migrated && addProduct(product.id)} type="button">{product.inventoryId ? "Order" : product.migrated ? "Stock check" : "Add"}</button>
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="content-section pharmacy-section" id="pharmacies" aria-labelledby="pharmacy-title">
        <div className="pharmacy-copy">
          <span className="section-kicker">LOCAL & RELIABLE</span>
          <h2 id="pharmacy-title">Your neighbourhood pharmacy, now online.</h2>
          <p>URMED connects customers with licensed local pharmacies while giving every partner the tools to manage stock, orders, payments and delivery.</p>
          <a className="primary-link" href="#how-it-works">See how URMED works <ArrowRight size={18} /></a>
        </div>
        <div className="pharmacy-list">
          {pharmacies.map((pharmacy, index) => (
            <article className="pharmacy-row" key={pharmacy.name}>
              <span className="pharmacy-avatar">{pharmacy.name.split(" ").slice(0, 2).map((part) => part[0]).join("")}</span>
              <div><strong>{pharmacy.name}</strong><small><MapPin size={14} /> {pharmacy.distance} away · {pharmacy.eta}</small></div>
              <span className="rating"><Star size={14} fill="currentColor" /> {pharmacy.rating}</span>
              {index === 0 && <b className="best-match">Best match</b>}
            </article>
          ))}
        </div>
      </section>

      <section className="how-section" id="how-it-works">
        <div className="content-section">
          <span className="section-kicker">SIMPLE. SAFE. TRACKED.</span>
          <h2>From search to doorstep</h2>
          <div className="steps-grid">
            <div><span>01</span><Search size={23} /><strong>Find your medicine</strong><p>Search the shared catalogue and compare availability nearby.</p></div>
            <div><span>02</span><ShieldCheck size={23} /><strong>Pharmacist confirms</strong><p>Prescription medicines are reviewed before fulfilment.</p></div>
            <div><span>03</span><Truck size={23} /><strong>Choose delivery</strong><p>Pharmacy delivery or an URMED partner—tracked end to end.</p></div>
          </div>
        </div>
      </section>

      <footer>
        <div className="footer-inner">
          <a className="brand footer-brand" href="#top"><span className="brand-mark"><Pill size={20} /></span><span>ur<span>med</span></span></a>
          <p>One trusted marketplace for pharmacies, medicines and local delivery.</p>
          <div><a href="#medicines">Medicines</a><a href="#pharmacies">Partner pharmacies</a><a href="#how-it-works">Support</a></div>
        </div>
      </footer>

      {cartOpen && (
        <div className="cart-overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setCartOpen(false)}>
          <aside className="cart-drawer" aria-label="Shopping cart">
            <div className="drawer-header"><div><span className="section-kicker">YOUR ORDER</span><h2>Cart · {cart.length} items</h2></div><button onClick={() => setCartOpen(false)} type="button" aria-label="Close cart"><X size={20} /></button></div>
            {orderPlaced ? (
              <div className="order-success"><span><CheckCircle2 size={34} /></span><h3>Order placed successfully</h3><p>Order <strong>#UR1049</strong> has been sent to Sri Balaji Pharmacy for confirmation.</p><div><small>Estimated delivery</small><strong>35–45 minutes</strong></div><button onClick={() => { setOrderPlaced(false); setCartOpen(false); }} type="button">Track my order</button></div>
            ) : (
              <>
                <div className="cart-items">
                  {cartProducts.map((product, index) => (
                    <article key={`${product.id}-${index}`}><span className={`cart-art ${product.tone}`}><Pill size={24} /></span><div><strong>{product.name}</strong><small>{product.pack}</small><span>{product.price}</span></div><div className="quantity-control"><button onClick={() => setCart((current) => { const copy = [...current]; copy.splice(index, 1); return copy; })} type="button"><Minus size={13} /></button><b>1</b><button onClick={() => setCart((current) => [...current, product.id])} type="button"><Plus size={13} /></button></div></article>
                  ))}
                </div>
                {cartProducts.some((product) => product.rx) && <button className="prescription-upload" onClick={() => { setCartOpen(false); setMode("customer-account"); }} type="button"><span><Upload size={20} /></span><div><strong>Upload prescription securely</strong><small>Continue to the authenticated customer order screen</small></div><ArrowRight size={17} /></button>}
                <div className="checkout-block"><h3>Delivery by</h3><div className="option-grid"><button className={delivery === "urmed" ? "selected" : ""} onClick={() => setDelivery("urmed")} type="button"><Truck size={19} /><span><strong>URMED delivery</strong><small>₹39 · 35–45 min</small></span>{delivery === "urmed" && <Check size={15} />}</button><button className={delivery === "pharmacy" ? "selected" : ""} onClick={() => setDelivery("pharmacy")} type="button"><Store size={19} /><span><strong>Pharmacy delivery</strong><small>₹25 · 45–60 min</small></span>{delivery === "pharmacy" && <Check size={15} />}</button></div></div>
                <div className="checkout-block"><h3>Payment method</h3><div className="option-grid"><button className={payment === "online" ? "selected" : ""} onClick={() => setPayment("online")} type="button"><CreditCard size={19} /><span><strong>Pay online</strong><small>UPI, cards & net banking</small></span>{payment === "online" && <Check size={15} />}</button><button className={payment === "cod" ? "selected" : ""} onClick={() => setPayment("cod")} type="button"><Banknote size={19} /><span><strong>Cash on delivery</strong><small>Pay at your doorstep</small></span>{payment === "cod" && <Check size={15} />}</button></div></div>
                <div className="bill-summary"><span>Medicine total <strong>₹{cartTotal.toFixed(2)}</strong></span><span>Delivery <strong>₹{delivery === "urmed" ? "39.00" : "25.00"}</strong></span><span className="bill-total">Amount payable <strong>₹{(cartTotal + (delivery === "urmed" ? 39 : 25)).toFixed(2)}</strong></span></div>
                <button className="place-order" disabled={!cart.length} onClick={() => { setCartOpen(false); setMode("customer-account"); }} type="button">Continue to secure ordering <ShieldCheck size={18} /></button>
                <p className="checkout-note">Prescription medicines are fulfilled only after pharmacist verification.</p>
              </>
            )}
          </aside>
        </div>
      )}
    </main>
  );
}
