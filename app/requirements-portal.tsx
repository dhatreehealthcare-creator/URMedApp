"use client";

import { FormEvent, useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  BadgeIndianRupee,
  BellRing,
  Boxes,
  Building2,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronRight,
  Database,
  FileText,
  Filter,
  History,
  Landmark,
  LayoutDashboard,
  LockKeyhole,
  MailCheck,
  PackageCheck,
  PackagePlus,
  Pill,
  Plus,
  ReceiptIndianRupee,
  RefreshCw,
  Search,
  ShieldCheck,
  ShoppingBag,
  Store,
  Upload,
  UserRound,
} from "lucide-react";
import { AuthPanel } from "./auth-panel";
import { LiveMarketplace } from "./live-marketplace";
import { VendorSetup } from "./vendor-setup";
import { VendorCompliance } from "./vendor-compliance";
import { ProcurementCenter } from "./procurement-center";
import { RefillCenter } from "./refill-center";
import { AdminOperationsCenter, CustomerSafetyCenter, VendorOperationsCenter } from "./operations-centers";

type PortalRole = "vendor" | "customer" | "admin";
type VendorSection = "overview" | "registration" | "profile" | "orders" | "sales" | "purchase" | "products" | "masters" | "reports";
type CustomerSection = "account" | "orders" | "history" | "reminders";
type AdminSection = "overview" | "architecture" | "registrations" | "categories" | "accounts" | "reports";

const portalNavigation = {
  vendor: [
    ["overview", "Overview", LayoutDashboard], ["registration", "Registration & login", MailCheck], ["profile", "Profile & bank", UserRound],
    ["orders", "Online orders", ShoppingBag], ["sales", "Offline sales", ReceiptIndianRupee], ["purchase", "Purchase order", PackagePlus],
    ["products", "Product master", Pill], ["masters", "Suppliers & manufacturers", Building2], ["reports", "Reports & reminders", FileText],
  ],
  customer: [
    ["account", "Registration & login", UserRound], ["orders", "Place an order", ShoppingBag], ["history", "Purchase history", History], ["reminders", "Refill reminders", BellRing],
  ],
  admin: [
    ["overview", "Admin overview", LayoutDashboard], ["architecture", "Database foundation", Database], ["registrations", "Store registrations", Store], ["categories", "Product categories", Pill],
    ["accounts", "Ledgers & expenses", Landmark], ["reports", "Reports & balance sheet", FileText],
  ],
} as const;

function Field({ label, required, hint, children, wide }: { label: string; required?: boolean; hint?: string; children: React.ReactNode; wide?: boolean }) {
  return <label className={`portal-field ${wide ? "wide" : ""}`}><span>{label}{required && <b> *</b>}</span>{children}{hint && <small>{hint}</small>}</label>;
}

function FormSuccess({ text }: { text: string }) {
  return <div className="portal-success"><CheckCircle2 size={18} /><span>{text}</span></div>;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function VendorRegistration() {
  const [otpSent, setOtpSent] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const submit = (event: FormEvent) => { event.preventDefault(); setSubmitted(true); };
  return <div className="portal-two-column">
    <section className="portal-panel">
      <div className="portal-panel-heading"><div><span className="portal-kicker">NEW VENDOR</span><h2>Register your pharmacy</h2><p>Fields marked * are mandatory. Contact and licence details are checked before activation.</p></div><span className="portal-step">Step 1 of 2</span></div>
      {submitted && <FormSuccess text="Registration received. A verification link has been sent to the vendor’s email." />}
      <form className="portal-form-grid" onSubmit={submit}>
        <Field label="Shop / business name" required><input required placeholder="e.g. Sri Balaji Pharmacy" /></Field>
        <Field label="Owner name" required><input required placeholder="Full legal name" /></Field>
        <Field label="Phone" required hint="Exactly 10 digits; duplicate number validation enabled"><div className="field-action"><input inputMode="numeric" maxLength={10} minLength={10} pattern="[0-9]{10}" required placeholder="10-digit mobile" /><button onClick={() => setOtpSent(true)} type="button">{otpSent ? "OTP sent" : "Send OTP"}</button></div></Field>
        <Field label="Landline" hint="10 digits including STD code"><input inputMode="numeric" maxLength={10} pattern="[0-9]{10}" placeholder="Landline number" /></Field>
        <Field label="Email" required hint="Checked against existing registrations"><input required type="email" placeholder="owner@pharmacy.com" /></Field>
        <Field label="Password" required><input minLength={8} required type="password" placeholder="Minimum 8 characters" /></Field>
        <Field label="GST number"><input maxLength={15} placeholder="15-character GSTIN" /></Field>
        <Field label="Drug licence" required hint="JPG, JPEG, PNG, PDF, DOC or DOCX"><div className="file-control"><Upload size={17} /><span>Choose licence file</span><input accept=".jpg,.jpeg,.png,.pdf,.doc,.docx" required type="file" /></div></Field>
        <Field label="Registered address" required wide hint="Stored privately; not displayed to customers"><textarea required rows={3} placeholder="Complete shop address" /></Field>
        <Field label="Latitude" required><input required type="number" step="any" defaultValue="17.4318" /></Field>
        <Field label="Longitude" required><input required type="number" step="any" defaultValue="78.4073" /></Field>
        <button className="portal-primary wide" type="submit">Register pharmacy <ChevronRight size={17} /></button>
      </form>
    </section>
    <aside className="verification-journey">
      <span className="journey-icon"><ShieldCheck size={26} /></span><h3>Secure verification journey</h3>
      <ol><li className="done"><b>1</b><span><strong>Phone OTP</strong><small>Mobile ownership and duplicate check</small></span></li><li><b>2</b><span><strong>Email verification</strong><small>Secure link sent after registration</small></span></li><li><b>3</b><span><strong>Licence review</strong><small>Admin verifies uploaded drug licence</small></span></li><li><b>4</b><span><strong>Automatic sign-in</strong><small>Vendor enters the approved workspace</small></span></li></ol>
      <div className="portal-note"><MailCheck size={18} /><span><strong>Already registered?</strong><small>Use vendor login. Unverified accounts receive a fresh verification link.</small></span></div>
      <form className="compact-login" onSubmit={(event) => event.preventDefault()}><h4>Vendor login</h4><input required type="email" placeholder="Registered email" /><input required type="password" placeholder="Password" /><button type="submit">Sign in securely</button></form>
    </aside>
  </div>;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function VendorProfile() {
  const [saved, setSaved] = useState(false);
  return <div className="portal-stack">
    {saved && <FormSuccess text="Vendor profile and banking information updated." />}
    <section className="portal-panel"><div className="portal-panel-heading"><div><span className="portal-kicker">VENDOR PROFILE</span><h2>Pharmacy details</h2><p>The registered email remains read-only. Address coordinates are private.</p></div><span className="verification-badge"><Check size={14} /> Email verified</span></div>
      <form className="portal-form-grid" onSubmit={(event) => { event.preventDefault(); setSaved(true); }}>
        <Field label="Shop / business name" required><input defaultValue="Sri Balaji Pharmacy" required /></Field><Field label="Owner name" required><input defaultValue="Arun Sharma" required /></Field>
        <Field label="Phone" required><div className="field-action"><input defaultValue="9848012312" maxLength={10} pattern="[0-9]{10}" required /><button type="button">Verify OTP</button></div></Field><Field label="Landline" hint="Exactly 10 digits"><input defaultValue="0404012345" maxLength={10} minLength={10} pattern="[0-9]{10}" /></Field>
        <Field label="Email"><input defaultValue="owner@sribalaji.in" readOnly /></Field><Field label="GST number"><input defaultValue="36ABCDE1234F1Z5" /></Field>
        <Field label="Drug licence" required><div className="file-control"><FileText size={17} /><span>DL-TS-HYD-2025.pdf</span><input accept=".jpg,.jpeg,.png,.pdf,.doc,.docx" type="file" /></div></Field>
        <Field label="Home delivery"><select defaultValue="yes"><option value="yes">Yes</option><option value="no">No</option></select></Field>
        <Field label="Registered address" wide required><textarea defaultValue="Road No. 36, Jubilee Hills, Hyderabad, Telangana 500033" required rows={3} /></Field><Field label="Latitude" required><input defaultValue="17.4318" required /></Field><Field label="Longitude" required><input defaultValue="78.4073" required /></Field>
        <button className="portal-primary wide" type="submit">Save profile changes</button>
      </form>
    </section>
    <div className="portal-split">
      <section className="portal-panel"><div className="portal-panel-heading compact"><div><h2>Bank details</h2><p>Used for marketplace settlements.</p></div><Landmark size={20} /></div><form className="portal-form-grid" onSubmit={(event) => { event.preventDefault(); setSaved(true); }}><Field label="Bank name"><input defaultValue="HDFC Bank" /></Field><Field label="Account name"><input defaultValue="Sri Balaji Pharmacy" /></Field><Field label="Account number"><input defaultValue="502000XXXX123" /></Field><Field label="IFSC code"><input defaultValue="HDFC0001234" /></Field><button className="portal-secondary wide" type="submit">Update bank details</button></form></section>
      <section className="portal-panel"><div className="portal-panel-heading compact"><div><h2>Change password</h2><p>Use a strong password not used elsewhere.</p></div><LockKeyhole size={20} /></div><form className="portal-form-grid one" onSubmit={(event) => { event.preventDefault(); setSaved(true); }}><Field label="Current password"><input required type="password" /></Field><Field label="New password"><input minLength={8} required type="password" /></Field><Field label="Confirm new password"><input minLength={8} required type="password" /></Field><button className="portal-secondary wide" type="submit">Change password</button></form></section>
    </div>
  </div>;
}

function VendorOverview({ setSection }: { setSection: (section: VendorSection) => void }) {
  return <><div className="portal-metrics"><article><span className="green"><BadgeIndianRupee size={21} /></span><div><small>Today’s total sales</small><strong>₹42,680</strong><em>Online ₹17,820 · Offline ₹24,860</em></div></article><article><span className="blue"><ShoppingBag size={21} /></span><div><small>Marketplace orders</small><strong>18</strong><em>6 require confirmation</em></div></article><article><span className="amber"><Boxes size={21} /></span><div><small>Zero / low stock</small><strong>23</strong><em>8 zero-stock medicines</em></div></article><article><span className="red"><CalendarClock size={21} /></span><div><small>Near expiry</small><strong>11</strong><em>Within the next 3 months</em></div></article></div>
    <div className="portal-dashboard-grid"><section className="portal-panel"><div className="portal-panel-heading compact"><div><h2>Priority actions</h2><p>Items that need attention today.</p></div></div><div className="priority-list"><button onClick={() => setSection("orders")} type="button"><ShoppingBag size={18} /><span><strong>6 online orders</strong><small>Awaiting pharmacist confirmation</small></span><ChevronRight size={17} /></button><button onClick={() => setSection("reports")} type="button"><AlertTriangle size={18} /><span><strong>11 batches near expiry</strong><small>Expiry within 90 days</small></span><ChevronRight size={17} /></button><button onClick={() => setSection("purchase")} type="button"><PackagePlus size={18} /><span><strong>8 products at zero stock</strong><small>Create a purchase order</small></span><ChevronRight size={17} /></button></div></section><section className="portal-panel"><div className="portal-panel-heading compact"><div><h2>Sales mix</h2><p>Today’s collection by channel.</p></div></div><div className="sales-donut"><div><span>₹42.7K</span><small>Total</small></div></div><div className="legend-row"><span><i className="online" />Online 42%</span><span><i className="offline" />Offline 58%</span></div></section></div>
  </>;
}

function OrdersView() {
  return <section className="portal-panel"><div className="portal-panel-heading"><div><span className="portal-kicker">ONLINE ORDERS</span><h2>Customer and order details</h2><p>Review prescription, payment, delivery and fulfilment from one queue.</p></div><div className="panel-actions"><button type="button"><Filter size={15} /> Filter</button><button type="button"><Search size={15} /> Search</button></div></div><div className="portal-table-wrap"><table className="portal-table"><thead><tr><th>Order</th><th>Customer</th><th>Medicines</th><th>Payment</th><th>Delivery</th><th>Status</th><th /></tr></thead><tbody><tr><td><strong>#UR1048</strong><small>10 Aug · 6:42 PM</small></td><td><strong>Ananya Reddy</strong><small>98XXXXXX15 · Jubilee Hills</small></td><td><strong>Dolo 650 × 2</strong><small>Shelcal 500 × 1</small></td><td><strong>₹187.30</strong><small>Paid online</small></td><td><strong>URMED partner</strong><small>35–45 min</small></td><td><span className="portal-status green">Ready</span></td><td><button type="button">Review</button></td></tr><tr><td><strong>#UR1047</strong><small>10 Aug · 6:27 PM</small></td><td><strong>Rohan Mehta</strong><small>99XXXXXX46 · Madhapur</small></td><td><strong>Telma 40 × 1</strong><small>Prescription attached</small></td><td><strong>₹198.40</strong><small>Cash on delivery</small></td><td><strong>Pharmacy delivery</strong><small>45–60 min</small></td><td><span className="portal-status amber">Rx review</span></td><td><button type="button">Review</button></td></tr></tbody></table></div></section>;
}

function ProductMaster() {
  const [saved, setSaved] = useState(false);
  return <div className="portal-product-layout"><section className="portal-panel">{saved && <FormSuccess text="Product saved to the vendor catalogue." />}<div className="portal-panel-heading"><div><span className="portal-kicker">PRODUCT MASTER</span><h2>Add or update medicine</h2><p>Maintain the product master and default batch pricing.</p></div></div><form className="portal-form-grid" onSubmit={(event) => { event.preventDefault(); setSaved(true); }}><Field label="Product category" required><select required><option>Tablet</option><option>Capsule</option><option>Injection</option><option>Ointment</option><option>Cream</option><option>Aerosol</option><option>Transdermal patch</option><option>Syrup</option></select></Field><Field label="Drug name" required><input required placeholder="Generic drug name" /></Field><Field label="Trade name" required><input required placeholder="Brand / trade name" /></Field><Field label="Dosage unit" required><input required placeholder="e.g. 50 mg" /></Field><Field label="Purchase price per unit"><input min="0" step="0.01" type="number" /></Field><Field label="Sale price per unit"><input min="0" step="0.01" type="number" /></Field><Field label="Batch number"><input /></Field><Field label="Manufacturer"><select><option>Micro Labs Ltd.</option><option>Glenmark Pharmaceuticals</option><option>Torrent Pharmaceuticals</option></select></Field><Field label="Prescription mandatory?"><select><option>Yes</option><option>No</option></select></Field><Field label="GST"><select><option>0%</option><option>5%</option><option>12%</option><option>18%</option><option>28%</option></select></Field><Field label="Product information" wide><textarea rows={4} /></Field><button className="portal-primary wide" type="submit">Save product</button></form></section><aside className="alternate-panel"><span className="portal-kicker">ALTERNATE PRODUCTS</span><h3>Link substitutes</h3><p>Search and select clinically equivalent products.</p><div className="portal-search"><Search size={16} /><input placeholder="Search product list" /></div>{["Paracip 650 Tablet", "Calpol 650 Tablet", "P-650 Tablet"].map((name, index) => <button key={name} type="button"><span><Pill size={17} /></span><div><strong>{name}</strong><small>Paracetamol 650 mg</small></div><i>{index === 0 ? <Check size={13} /> : <Plus size={13} />}</i></button>)}</aside></div>;
}

function ReportsView() {
  return <VendorOperationsCenter />;
}

function CustomerPortal({ section }: { section: CustomerSection }) {
  const [saved, setSaved] = useState(false);
  if (section === "account") return <div className="portal-split">{saved && <FormSuccess text="Customer registration completed. OTP and email verification initiated." />}<section className="portal-panel"><div className="portal-panel-heading"><div><span className="portal-kicker">NEW CUSTOMER</span><h2>Create an URMED account</h2><p>Register to order medicines, save addresses and receive pill reminders.</p></div></div><form className="portal-form-grid one" onSubmit={(event) => { event.preventDefault(); setSaved(true); }}><Field label="Name" required><input required /></Field><Field label="Phone" required hint="OTP and duplicate validation"><div className="field-action"><input maxLength={10} minLength={10} pattern="[0-9]{10}" required /><button type="button">Send OTP</button></div></Field><Field label="Email" required><input required type="email" /></Field><Field label="Password" required><input minLength={8} required type="password" /></Field><button className="portal-primary wide" type="submit">Register customer</button></form></section><section className="portal-panel"><div className="portal-panel-heading"><div><span className="portal-kicker">CUSTOMER LOGIN</span><h2>Welcome back</h2><p>Unverified accounts receive a new email verification link.</p></div></div><form className="portal-form-grid one" onSubmit={(event) => event.preventDefault()}><Field label="Email"><input required type="email" /></Field><Field label="Password"><input required type="password" /></Field><button className="portal-secondary wide" type="submit">Sign in</button></form><div className="portal-note"><MailCheck size={18} /><span><strong>Email verification required</strong><small>Verified customers are automatically signed in after opening the secure link.</small></span></div></section></div>;
  if (section === "orders") return <section className="portal-panel"><div className="portal-panel-heading"><div><span className="portal-kicker">CUSTOMER ORDER</span><h2>Delivery and prescription</h2><p>Search and cart remain available in the marketplace. Confirm delivery details here.</p></div></div><form className="portal-form-grid" onSubmit={(event) => { event.preventDefault(); setSaved(true); }}><Field label="Name" required><input defaultValue="Ananya Reddy" required /></Field><Field label="Phone" required><input defaultValue="9848012315" maxLength={10} required /></Field><Field label="Delivery address" wide required><textarea defaultValue="Road No. 45, Jubilee Hills, Hyderabad" rows={3} /></Field><Field label="Latitude"><input defaultValue="17.4325" /></Field><Field label="Longitude"><input defaultValue="78.4071" /></Field><Field label="Fulfilment"><select><option>Home delivery</option><option>Pickup from pharmacy</option></select></Field><Field label="Prescription upload"><div className="file-control"><Upload size={17} /><span>Upload prescription</span><input accept=".jpg,.jpeg,.png,.pdf" type="file" /></div></Field><button className="portal-primary wide" type="submit">Save delivery details</button></form></section>;
  if (section === "history") return <section className="portal-panel"><div className="portal-panel-heading"><div><span className="portal-kicker">PURCHASE HISTORY</span><h2>Previous orders</h2><p>Reorder eligible medicines and download invoices.</p></div></div><div className="history-cards"><article><span><PackageCheck size={20} /></span><div><strong>#UR1042 · Delivered</strong><small>5 Aug 2026 · Dolo 650, Shelcal 500</small><em>₹187.30 · Online payment</em></div><button type="button">Reorder</button></article><article><span><Store size={20} /></span><div><strong>#UR1018 · Picked up</strong><small>24 Jul 2026 · Telma 40</small><em>₹198.40 · Paid online</em></div><button type="button">Invoice</button></article></div></section>;
  return <div className="portal-stack"><RefillCenter /><CustomerSafetyCenter /></div>;
}

type RecoveryPayload = {
  counts: { products: number; customers: number; categories: number; manufacturers: number };
  audit: Array<{ entity: string; sourceRows: number; importedRows: number; rejectedRows: number; notes: string }>;
  customers: Array<{ legacyId: number; name: string; email: string; mobile: string; registeredAt: string | null; passwordResetRequired: number }>;
  security: { legacyPasswordsImported: boolean; customerAccess: string; passwordResetRequired: boolean };
};

function RecoveredDataCard() {
  const [data, setData] = useState<RecoveryPayload | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/admin/recovery", { cache: "no-store" });
      if (!response.ok) throw new Error(response.status === 401 ? "Owner authentication is required to view recovered customers." : "Recovery database is unavailable.");
      setData(await response.json() as RecoveryPayload);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Recovery database is unavailable.");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, []);

  return <section className="portal-panel recovered-data-panel"><div className="portal-panel-heading"><div><span className="portal-kicker">RECOVERED SQL BACKUP</span><h2>Migration control centre</h2><p>Verified import totals from the February 2025 URMED database backup.</p></div><button className="portal-outline" onClick={() => void load()} type="button"><RefreshCw size={15} /> Refresh</button></div>
    {loading && <div className="recovery-loading"><span className="catalogue-loader" /> Reading the secured URMED database…</div>}
    {error && <div className="recovery-error"><AlertTriangle size={18} /><span><strong>Protected data unavailable</strong><small>{error}</small></span></div>}
    {data && <><div className="recovery-counts"><article><Database size={20} /><span><small>Recovered products</small><strong>{data.counts.products.toLocaleString("en-IN")}</strong></span></article><article><UserRound size={20} /><span><small>Verified customers</small><strong>{data.counts.customers}</strong></span></article><article><Building2 size={20} /><span><small>Manufacturers</small><strong>{data.counts.manufacturers.toLocaleString("en-IN")}</strong></span></article><article><Pill size={20} /><span><small>Categories</small><strong>{data.counts.categories}</strong></span></article></div>
      <div className="recovery-grid"><div><h3>Customer recovery</h3><p className="secure-recovery-note"><ShieldCheck size={16} /> Legacy passwords were not imported. Every recovered customer must create a new password.</p><div className="recovered-customers">{data.customers.map((customer) => <article key={customer.legacyId}><span>{customer.name.slice(0, 2).toUpperCase()}</span><div><strong>{customer.name}</strong><small>{customer.email} · {customer.mobile}</small><em>Registered {customer.registeredAt?.slice(0, 10) || "date unavailable"} · Reset required</em></div></article>)}</div></div><div><h3>Import audit</h3><div className="migration-audit">{data.audit.map((row) => <article key={row.entity}><div><strong>{row.entity}</strong><span>{row.importedRows.toLocaleString("en-IN")} imported</span></div><small>{row.sourceRows.toLocaleString("en-IN")} source · {row.rejectedRows.toLocaleString("en-IN")} rejected</small><p>{row.notes}</p></article>)}</div></div></div></>}
  </section>;
}

type ArchitecturePayload = {
  totals: { tables: number; views: number; safeguards: number; modulesReady: number; modules: number };
  modules: Array<{ name: string; ready: boolean; readyObjects: number; totalObjects: number; objects: readonly string[] }>;
  preservedData: { products: number; verifiedCustomers: number; legacyPasswordsImported: boolean };
  phase: string;
};

function DatabaseArchitecture() {
  const [data, setData] = useState<ArchitecturePayload | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/admin/architecture", { cache: "no-store" });
      const payload = await response.json() as ArchitecturePayload & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Database architecture status is unavailable");
      setData(payload);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Database architecture status is unavailable");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, []);
  return <div className="portal-stack">
    <section className="portal-panel architecture-hero"><div className="portal-panel-heading"><div><span className="portal-kicker">PHASE 6 · DATABASE FIRST</span><h2>Production data architecture</h2><p>The recovered catalogue remains intact while compliance, pharmacy operations and audit controls are added around it.</p></div><button className="portal-outline" onClick={() => void load()} type="button"><RefreshCw size={15} /> Verify foundation</button></div>
      {loading && <div className="recovery-loading"><span className="catalogue-loader" /> Verifying the database foundation…</div>}
      {error && <div className="recovery-error"><AlertTriangle size={18} /><span><strong>Protected status unavailable</strong><small>{error}</small></span></div>}
      {data && <><div className="recovery-counts architecture-counts"><article><Database size={20} /><span><small>Operational tables</small><strong>{data.totals.tables}</strong></span></article><article><ShieldCheck size={20} /><span><small>Safety views</small><strong>{data.totals.views}</strong></span></article><article><LockKeyhole size={20} /><span><small>Immutable safeguards</small><strong>{data.totals.safeguards}</strong></span></article><article><CheckCircle2 size={20} /><span><small>Data modules ready</small><strong>{data.totals.modulesReady}/{data.totals.modules}</strong></span></article></div>
        <div className="architecture-preserved"><ShieldCheck size={18} /><div><strong>Recovered information preserved</strong><small>{data.preservedData.products.toLocaleString("en-IN")} products and {data.preservedData.verifiedCustomers} verified customers remain available. Legacy passwords remain excluded.</small></div><span>{data.phase}</span></div>
        <div className="architecture-grid">{data.modules.map((module) => <article key={module.name}><span className={module.ready ? "ready" : "building"}>{module.ready ? <CheckCircle2 size={17} /> : <CalendarClock size={17} />}</span><div><strong>{module.name}</strong><small>{module.readyObjects} of {module.totalObjects} database objects verified</small><p>{module.objects.map((object) => object.replaceAll("_", " ")).join(" · ")}</p></div><em>{module.ready ? "Ready" : "Building"}</em></article>)}</div>
      </>}
    </section>
  </div>;
}

function AdminPortal({ section }: { section: AdminSection }) {
  if (section === "overview") return <div className="portal-stack"><AdminOperationsCenter mode="overview" /><RecoveredDataCard /></div>;
  if (section === "architecture") return <DatabaseArchitecture />;
  if (section === "registrations") return <VendorCompliance />;
  if (section === "categories") return <AdminOperationsCenter mode="categories" />;
  if (section === "accounts") return <AdminOperationsCenter mode="accounts" />;
  return <AdminOperationsCenter mode="reports" />;
}

export function RequirementsPortal({ initialRole, onBack }: { initialRole: PortalRole; onBack: () => void }) {
  const [role, setRole] = useState<PortalRole>(initialRole);
  const [vendorSection, setVendorSection] = useState<VendorSection>(initialRole === "vendor" ? "overview" : "overview");
  const [customerSection, setCustomerSection] = useState<CustomerSection>("account");
  const [adminSection, setAdminSection] = useState<AdminSection>("overview");
  const section = role === "vendor" ? vendorSection : role === "customer" ? customerSection : adminSection;
  const setSection = (value: string) => { if (role === "vendor") setVendorSection(value as VendorSection); else if (role === "customer") setCustomerSection(value as CustomerSection); else setAdminSection(value as AdminSection); };
  const roleTitle = role === "vendor" ? "Vendor workspace" : role === "customer" ? "Customer account" : "URMED administration";
  let content: React.ReactNode;
  if (role === "vendor") {
    content = vendorSection === "overview" ? <div className="portal-stack"><VendorOverview setSection={setVendorSection} /><LiveMarketplace role="vendor" /></div> : vendorSection === "registration" ? <div className="portal-stack"><AuthPanel role="vendor" /><VendorSetup registrationMode /></div> : vendorSection === "profile" ? <VendorSetup /> : vendorSection === "orders" ? <div className="portal-stack"><LiveMarketplace role="vendor" /><OrdersView /></div> : vendorSection === "sales" ? <VendorOperationsCenter /> : vendorSection === "purchase" ? <ProcurementCenter mode="purchase" /> : vendorSection === "products" ? <div className="portal-stack"><LiveMarketplace role="vendor" /><ProductMaster /></div> : vendorSection === "masters" ? <ProcurementCenter mode="masters" /> : <ReportsView />;
  } else if (role === "customer") content = customerSection === "account" ? <AuthPanel role="customer" /> : customerSection === "orders" || customerSection === "history" ? <LiveMarketplace role="customer" /> : <CustomerPortal section={customerSection} />;
  else content = <AdminPortal section={adminSection} />;

  return <main className="requirements-shell"><aside className="requirements-sidebar"><button className="brand sidebar-brand" onClick={onBack} type="button"><span className="brand-mark"><Pill size={21} /></span><span>ur<span>med</span></span></button><div className="portal-role-card"><span>{role === "vendor" ? <Store size={18} /> : role === "customer" ? <UserRound size={18} /> : <ShieldCheck size={18} />}</span><div><small>Current workspace</small><strong>{roleTitle}</strong></div></div><nav className="requirements-nav">{portalNavigation[role].map(([key, label, Icon]) => <button className={section === key ? "active" : ""} key={key} onClick={() => setSection(key)} type="button"><Icon size={17} /><span>{label}</span></button>)}</nav><div className="role-switch"><small>Private testing role</small><div>{(["vendor", "customer", "admin"] as PortalRole[]).map((item) => <button className={role === item ? "active" : ""} key={item} onClick={() => setRole(item)} type="button">{item}</button>)}</div></div><button className="back-marketplace" onClick={onBack} type="button"><ArrowLeft size={17} /> Back to marketplace</button></aside><section className="requirements-main"><header className="requirements-header"><div><span className="portal-kicker">{role.toUpperCase()} MODULE</span><h1>{roleTitle}</h1><p>URMED Pharmacy & Medicine Delivery · Private test mode</p></div><div><button aria-label="Notifications" type="button"><BellRing size={18} /><b>3</b></button><button type="button"><UserRound size={18} /> {role === "vendor" ? "VE" : role === "admin" ? "AD" : "CU"}</button></div></header>{content}</section></main>;
}
