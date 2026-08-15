"use client";

import { useEffect, useState } from "react";
import { authenticatedFetch } from "./marketplace-client";

type AdminBranch = { id: number; vendorId: number; businessName: string; branchCode: string; name: string; status: string; publicLocationStatus: string; publicLabel: string; pickupEnabled: number; serviceEnabled: number; isPrimary: number };

export function AdminBranchDirectory() {
  const [branches, setBranches] = useState<AdminBranch[]>([]);
  useEffect(() => { void Promise.resolve().then(async () => { const response = await authenticatedFetch("/api/admin/branches", { cache: "no-store" }); if (response.ok) setBranches(((await response.json()) as { branches: AdminBranch[] }).branches); }); }, []);
  return <section className="portal-panel"><div className="portal-panel-heading"><div><span className="portal-kicker">ADMIN DIRECTORY</span><h2>Operational pharmacy branches</h2><p>Vendor-scoped branch status and published customer-location state. Private legal coordinates are intentionally omitted.</p></div></div><div className="live-list">{branches.length ? branches.map((branch) => <article key={branch.id}><div><strong>{branch.businessName} · {branch.name}</strong><small>Vendor #{branch.vendorId} · {branch.branchCode} · {branch.isPrimary ? "Primary · " : ""}{branch.status}</small></div><span><small>{branch.publicLocationStatus === "published" ? branch.publicLabel || "Published location" : "Location draft"}</small><small>{branch.pickupEnabled ? "Pickup" : ""}{branch.pickupEnabled && branch.serviceEnabled ? " · " : ""}{branch.serviceEnabled ? "Delivery" : ""}</small></span></article>) : <p>No operational branches found.</p>}</div></section>;
}
