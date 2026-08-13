"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  BellRing,
  Building2,
  CalendarClock,
  CheckCircle2,
  Database,
  FileText,
  History,
  Landmark,
  LayoutDashboard,
  LockKeyhole,
  MailCheck,
  PackagePlus,
  Pill,
  ReceiptIndianRupee,
  RefreshCw,
  ShieldCheck,
  ShoppingBag,
  Store,
  UserRound,
} from "lucide-react";
import { LiveMarketplace } from "./live-marketplace";
import { VendorSetup } from "./vendor-setup";
import { VendorOrderQueue } from "./vendor-order-queue";
import { VendorPublicLocation } from "./vendor-public-location";
import { VendorNotificationInbox } from "./vendor-notification-inbox";
import { NotificationPreferences } from "./notification-preferences";
import { VendorCompliance } from "./vendor-compliance";
import { AdminRegistrationList } from "./admin-registration-list";
import { AdminStoreMap } from "./admin-store-map";
import { AdminOperationalReports } from "./admin-operational-reports";
import { AdminEmailOutbox } from "./admin-email-outbox";
import { ProcurementCenter } from "./procurement-center";
import { RefillCenter } from "./refill-center";
import { AdminOperationsCenter, CustomerSafetyCenter, VendorOperationsCenter } from "./operations-centers";
import { authenticatedFetch } from "./marketplace-client";
import { ProductMaster } from "./product-master";
import { CustomerOrderHistory } from "./customer-order-history";
import type { CustomerReorderRequest } from "../lib/customer-order-history";

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
    ["accounts", "Ledgers & expenses", Landmark], ["reports", "Operational reports", FileText],
  ],
} as const;

function VendorOverview({ setSection }: { setSection: (section: VendorSection) => void }) {
  return <section className="portal-panel"><div className="portal-panel-heading compact"><div><span className="portal-kicker">LIVE WORKSPACE</span><h2>Pharmacy operations</h2><p>Open a live, tenant-scoped module to review current orders, inventory controls, purchases, and reports.</p></div><VendorNotificationInbox onNavigate={setSection} /></div><div className="priority-list"><button onClick={() => setSection("orders")} type="button"><ShoppingBag size={18} /><span><strong>Review online orders</strong><small>Open the live order queue and fulfilment controls</small></span></button><button onClick={() => setSection("reports")} type="button"><AlertTriangle size={18} /><span><strong>Review stock and expiry alerts</strong><small>Open current batch, sales, and statutory records</small></span></button><button onClick={() => setSection("purchase")} type="button"><PackagePlus size={18} /><span><strong>Manage procurement</strong><small>Create and receive purchase orders from approved suppliers</small></span></button></div></section>;
}

function ReportsView() {
  return <VendorOperationsCenter />;
}

function CustomerPortal({ section }: { section: CustomerSection }) {
  if (section === "account") return <div className="portal-stack"><section className="portal-panel"><div className="portal-panel-heading"><div><span className="portal-kicker">AUTHENTICATED CUSTOMER</span><h2>Your protected account</h2><p>This workspace is available only while the active customer session matches the `/customer` route.</p></div><ShieldCheck size={22} /></div><div className="portal-note"><CheckCircle2 size={18} /><span><strong>Customer session verified</strong><small>Orders, purchase history, saved delivery details, and pill reminders remain scoped to this account by the server APIs.</small></span></div></section><NotificationPreferences /></div>;
  return <div className="portal-stack"><RefillCenter /><CustomerSafetyCenter /></div>;
}

type RecoveryPayload = {
  counts: { products: number; customers: number; categories: number; manufacturers: number };
  audit: Array<{ entity: string; sourceRows: number; importedRows: number; rejectedRows: number; notes: string }>;
  customers: Array<{ legacyId: number; name: string; email: string; mobile: string; registeredAt: string | null }>;
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
  identityPolicy: {
    credentialAuthority: "supabase_auth";
    liveProfileAuthority: "account_profiles";
    recoveredCustomerClassification: "admin_only_reference";
    recoveredCustomersCanAuthenticate: false;
    automaticLinking: false;
    linkingStatus: "not_implemented";
  };
  security: { legacyPasswordsImported: boolean; recoveredRecordsCanAuthenticate: boolean; customerAccess: string; automaticLinking: boolean };
};

function RecoveredDataCard() {
  const [data, setData] = useState<RecoveryPayload | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const load = useCallback(async (nextPage: number, nextSearch: string) => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ page: String(nextPage), pageSize: "20" });
      if (nextSearch.trim()) params.set("q", nextSearch.trim());
      const response = await authenticatedFetch(`/api/admin/recovery?${params}`, { cache: "no-store" });
      if (!response.ok) throw new Error(response.status === 401 ? "Administrator authentication is required to view recovered customers." : "Recovery database is unavailable.");
      setData(await response.json() as RecoveryPayload);
      setPage(nextPage);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Recovery database is unavailable.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(1, "");
  }, [load]);

  return <section className="portal-panel recovered-data-panel"><div className="portal-panel-heading"><div><span className="portal-kicker">RECOVERED SQL BACKUP</span><h2>Migration control centre</h2><p>Verified import totals from the February 2025 URMED database backup.</p></div><button className="portal-outline" onClick={() => void load(page, search)} type="button"><RefreshCw size={15} /> Refresh</button></div>
    {loading && <div className="recovery-loading"><span className="catalogue-loader" /> Reading the secured URMED database…</div>}
    {error && <div className="recovery-error"><AlertTriangle size={18} /><span><strong>Protected data unavailable</strong><small>{error}</small></span></div>}
    {data && <><div className="recovery-counts"><article><Database size={20} /><span><small>Recovered products</small><strong>{data.counts.products.toLocaleString("en-IN")}</strong></span></article><article><UserRound size={20} /><span><small>Legacy references</small><strong>{data.counts.customers}</strong></span></article><article><Building2 size={20} /><span><small>Manufacturers</small><strong>{data.counts.manufacturers.toLocaleString("en-IN")}</strong></span></article><article><Pill size={20} /><span><small>Categories</small><strong>{data.counts.categories}</strong></span></article></div>
      <div className="recovery-grid"><div><h3>Legacy customer archive</h3><p className="secure-recovery-note"><ShieldCheck size={16} /> Reference only: these records cannot sign in and are not automatically linked by email or phone. Live customer identity comes from account profiles.</p><form className="portal-form-grid one" onSubmit={(event) => { event.preventDefault(); void load(1, search); }}><label className="portal-field"><span>Search the archive</span><input onChange={(event) => setSearch(event.target.value)} placeholder="Name, email, or mobile" value={search}/></label><button className="portal-outline" type="submit">Search</button></form><div className="recovered-customers">{data.customers.map((customer) => <article key={customer.legacyId}><span>{customer.name.slice(0, 2).toUpperCase()}</span><div><strong>{customer.name}</strong><small>{customer.email} · {customer.mobile}</small><em>Registered {customer.registeredAt?.slice(0, 10) || "date unavailable"} · No live account link</em></div></article>)}</div><div className="pagination-controls"><button disabled={data.pagination.page<=1} onClick={() => void load(data.pagination.page-1,search)} type="button">Previous</button><span>Page {data.pagination.page} of {data.pagination.totalPages} · {data.pagination.total} records</span><button disabled={data.pagination.page>=data.pagination.totalPages} onClick={() => void load(data.pagination.page+1,search)} type="button">Next</button></div></div><div><h3>Import audit</h3><div className="migration-audit">{data.audit.map((row) => <article key={row.entity}><div><strong>{row.entity}</strong><span>{row.importedRows.toLocaleString("en-IN")} imported</span></div><small>{row.sourceRows.toLocaleString("en-IN")} source · {row.rejectedRows.toLocaleString("en-IN")} rejected</small><p>{row.notes}</p></article>)}</div></div></div></>}
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
      const response = await authenticatedFetch("/api/admin/architecture", { cache: "no-store" });
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
    <section className="portal-panel architecture-hero"><div className="portal-panel-heading"><div><span className="portal-kicker">DATABASE FOUNDATION</span><h2>Production data architecture</h2><p>The recovered catalogue remains intact while compliance, pharmacy operations and audit controls are added around it.</p></div><button className="portal-outline" onClick={() => void load()} type="button"><RefreshCw size={15} /> Verify foundation</button></div>
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
  if (section === "registrations") return <div className="portal-stack"><AdminRegistrationList /><AdminStoreMap /><VendorCompliance /></div>;
  if (section === "categories") return <ProductMaster role="admin" />;
  if (section === "accounts") return <div className="portal-stack"><AdminOperationsCenter mode="accounts" /><AdminEmailOutbox /></div>;
  return <AdminOperationalReports />;
}

export function RequirementsPortal({ initialRole, onBack }: { initialRole: PortalRole; onBack: () => void }) {
  const role = initialRole;
  const [vendorSection, setVendorSection] = useState<VendorSection>(initialRole === "vendor" ? "overview" : "overview");
  const [customerSection, setCustomerSection] = useState<CustomerSection>("account");
  const [customerReorder, setCustomerReorder] = useState<CustomerReorderRequest | null>(null);
  const [adminSection, setAdminSection] = useState<AdminSection>("overview");
  const section = role === "vendor" ? vendorSection : role === "customer" ? customerSection : adminSection;
  const setSection = (value: string) => { if (role === "vendor") setVendorSection(value as VendorSection); else if (role === "customer") setCustomerSection(value as CustomerSection); else setAdminSection(value as AdminSection); };
  const roleTitle = role === "vendor" ? "Vendor workspace" : role === "customer" ? "Customer account" : "URMED administration";
  let content: React.ReactNode;
  if (role === "vendor") {
    content = vendorSection === "overview" ? <div className="portal-stack"><VendorOverview setSection={setVendorSection} /><NotificationPreferences /><LiveMarketplace role="vendor" /></div> : vendorSection === "registration" ? <VendorSetup registrationMode /> : vendorSection === "profile" ? <div className="portal-stack"><VendorSetup /><VendorPublicLocation /></div> : vendorSection === "orders" ? <VendorOrderQueue /> : vendorSection === "sales" ? <VendorOperationsCenter /> : vendorSection === "purchase" ? <ProcurementCenter mode="purchase" /> : vendorSection === "products" ? <ProductMaster role="vendor" /> : vendorSection === "masters" ? <ProcurementCenter mode="masters" /> : <ReportsView />;
  } else if (role === "customer") {
    if (customerSection === "orders") content = <LiveMarketplace onReorderPrepared={() => setCustomerReorder(null)} reorderRequest={customerReorder} role="customer" />;
    else if (customerSection === "history") content = <CustomerOrderHistory onReorder={(request) => { setCustomerReorder(request); setCustomerSection("orders"); }} />;
    else content = <CustomerPortal section={customerSection} />;
  }
  else content = <AdminPortal section={adminSection} />;

  return <main className="requirements-shell"><aside className="requirements-sidebar"><button className="brand sidebar-brand" onClick={onBack} type="button"><span className="brand-mark"><Pill size={21} /></span><span>ur<span>med</span></span></button><div className="portal-role-card"><span>{role === "vendor" ? <Store size={18} /> : role === "customer" ? <UserRound size={18} /> : <ShieldCheck size={18} />}</span><div><small>Current workspace</small><strong>{roleTitle}</strong></div></div><nav className="requirements-nav">{portalNavigation[role].map(([key, label, Icon]) => <button className={section === key ? "active" : ""} key={key} onClick={() => setSection(key)} type="button"><Icon size={17} /><span>{label}</span></button>)}</nav><button className="back-marketplace" onClick={onBack} type="button"><ArrowLeft size={17} /> Back to marketplace</button></aside><section className="requirements-main"><header className="requirements-header"><div><span className="portal-kicker">{role.toUpperCase()} MODULE</span><h1>{roleTitle}</h1><p>URMED Pharmacy & Medicine Delivery</p></div><div><button aria-label="Notifications" type="button"><BellRing size={18} /></button><button type="button"><UserRound size={18} /> {role === "vendor" ? "VE" : role === "admin" ? "AD" : "CU"}</button></div></header>{content}</section></main>;
}
