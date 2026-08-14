"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  BadgeIndianRupee,
  Baby,
  ChevronDown,
  Clock3,
  HeartPulse,
  MapPin,
  Navigation,
  Pill,
  Search,
  ShieldCheck,
  ShoppingCart,
  Sparkles,
  Stethoscope,
  Truck,
  UserRound,
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

export default function Home() {
  const [query, setQuery] = useState("");
  const [catalogResults, setCatalogResults] = useState<StorefrontProduct[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState("");

  useEffect(() => {
    const value = query.trim();
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setCatalogLoading(true);
      setCatalogError("");
      try {
        const response = await fetch(`/api/catalog?${value.length >= 2 ? `q=${encodeURIComponent(value)}&` : ""}limit=24`, { signal: controller.signal });
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
          discount: product.inventoryId ? "Live stock" : "Catalogue",
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
    }, value.length >= 2 ? 300 : 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query]);

  const searchingRecoveredCatalogue = query.trim().length >= 2;
  const displayedProducts = catalogResults;

  return (
    <main className="site-shell">
      <header className="topbar">
        <div className="nav-wrap">
          <a className="brand" href="#top" aria-label="URMED home">
            <span className="brand-mark"><Pill size={22} /></span>
            <span>ur<span>med</span></span>
          </a>

          <Link className="location-control" href="/customer" aria-label="Choose delivery location">
            <MapPin size={18} />
            <span><small>Delivery location</small>Choose your saved address at checkout</span>
            <ChevronDown size={16} />
          </Link>

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
            <Link className="cart-button" href="/customer">
              <ShoppingCart size={20} />
              <span>Live cart</span>
            </Link>
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
              {["Paracetamol", "Diabetes care", "BP monitors"].map((term) => <a href="#medicines" key={term} onClick={(event) => { event.preventDefault(); setQuery(term); document.querySelector("#medicines")?.scrollIntoView({ behavior: "smooth" }); }}>{term}</a>)}
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
                <div><small>Secure marketplace</small><strong>Live pharmacy inventory</strong></div>
                <span className="live-dot">Verified</span>
              </div>
              <div className="route-map">
                <div className="route-line" />
                <span className="route-start"><Pill size={17} /></span>
                <span className="route-rider"><Navigation size={18} /></span>
                <span className="route-end"><MapPin size={17} /></span>
              </div>
              <div className="delivery-meta">
                <div><Clock3 size={17} /><span><small>At checkout</small><strong>Stock revalidated</strong></span></div>
                <div className="rider-stack"><i>Rx</i><span><small>Prescription medicines</small><strong>Pharmacist review</strong></span></div>
              </div>
            </div>

            <div className="floating-card prescription-card">
              <ShieldCheck size={19} />
              <span><strong>Prescription verified</strong><small>Reviewed by pharmacist</small></span>
            </div>
            <div className="floating-card rating-card"><ShoppingCart size={18} /><span><strong>Separate pharmacy orders</strong><small>Price and delivery checked per pharmacy</small></span></div>
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
        {catalogLoading && <div className="catalogue-state"><span className="catalogue-loader" /> Searching the live medicine catalogue…</div>}
        {catalogError && <div className="catalogue-state error">{catalogError}</div>}
        {!catalogLoading && searchingRecoveredCatalogue && !catalogError && !displayedProducts.length && <div className="catalogue-state">No recovered medicine matched this search.</div>}
        <div className="product-grid">
          {displayedProducts.map((product) => (
            <article className="product-card" key={product.id}>
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
                  <button disabled={!product.inventoryId} onClick={() => product.inventoryId && window.location.assign(`/customer?section=orders&inventoryId=${product.inventoryId}&add=1`)} type="button">{product.inventoryId ? "Add in live cart" : "Stock unavailable"}</button>
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
        <div className="pharmacy-list"><article className="pharmacy-row"><span className="pharmacy-avatar"><ShieldCheck size={20} /></span><div><strong>Only approved live pharmacies are shown</strong><small><MapPin size={14} /> Search live stock to see the serving pharmacy and published customer location.</small></div><Link className="primary-link" href="/customer">Open live marketplace</Link></article></div>
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

    </main>
  );
}
