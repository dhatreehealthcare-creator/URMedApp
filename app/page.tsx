"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  BadgeIndianRupee,
  Baby,
  Banknote,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock3,
  CreditCard,
  HeartPulse,
  MapPin,
  Minus,
  Navigation,
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

const pharmacies = [
  { name: "Sri Balaji Pharmacy", distance: "1.2 km", eta: "24–35 min", rating: "4.8" },
  { name: "LifeCare Medicals", distance: "2.4 km", eta: "35–45 min", rating: "4.7" },
  { name: "Apollo Partner Pharmacy", distance: "3.1 km", eta: "45–55 min", rating: "4.9" },
];

export default function Home() {
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
            <Link className="workspace-link" href="/vendor">Partner console</Link>
          </nav>

          <div className="nav-actions">
            <Link className="icon-button" href="/customer" aria-label="Customer account">
              <UserRound size={20} />
            </Link>
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
                  <button disabled={Boolean(product.migrated && !product.inventoryId)} onClick={() => product.inventoryId ? window.location.assign("/customer") : !product.migrated && addProduct(product.id)} type="button">{product.inventoryId ? "Order" : product.migrated ? "Stock check" : "Add"}</button>
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
                {cartProducts.some((product) => product.rx) && <button className="prescription-upload" onClick={() => window.location.assign("/customer")} type="button"><span><Upload size={20} /></span><div><strong>Upload prescription securely</strong><small>Continue to the authenticated customer order screen</small></div><ArrowRight size={17} /></button>}
                <div className="checkout-block"><h3>Delivery by</h3><div className="option-grid"><button className={delivery === "urmed" ? "selected" : ""} onClick={() => setDelivery("urmed")} type="button"><Truck size={19} /><span><strong>URMED delivery</strong><small>₹39 · 35–45 min</small></span>{delivery === "urmed" && <Check size={15} />}</button><button className={delivery === "pharmacy" ? "selected" : ""} onClick={() => setDelivery("pharmacy")} type="button"><Store size={19} /><span><strong>Pharmacy delivery</strong><small>₹25 · 45–60 min</small></span>{delivery === "pharmacy" && <Check size={15} />}</button></div></div>
                <div className="checkout-block"><h3>Payment method</h3><div className="option-grid"><button className={payment === "online" ? "selected" : ""} onClick={() => setPayment("online")} type="button"><CreditCard size={19} /><span><strong>Pay online</strong><small>UPI, cards & net banking</small></span>{payment === "online" && <Check size={15} />}</button><button className={payment === "cod" ? "selected" : ""} onClick={() => setPayment("cod")} type="button"><Banknote size={19} /><span><strong>Cash on delivery</strong><small>Pay at your doorstep</small></span>{payment === "cod" && <Check size={15} />}</button></div></div>
                <div className="bill-summary"><span>Medicine total <strong>₹{cartTotal.toFixed(2)}</strong></span><span>Delivery <strong>₹{delivery === "urmed" ? "39.00" : "25.00"}</strong></span><span className="bill-total">Amount payable <strong>₹{(cartTotal + (delivery === "urmed" ? 39 : 25)).toFixed(2)}</strong></span></div>
                <button className="place-order" disabled={!cart.length} onClick={() => window.location.assign("/customer")} type="button">Continue to secure ordering <ShieldCheck size={18} /></button>
                <p className="checkout-note">Prescription medicines are fulfilled only after pharmacist verification.</p>
              </>
            )}
          </aside>
        </div>
      )}
    </main>
  );
}
