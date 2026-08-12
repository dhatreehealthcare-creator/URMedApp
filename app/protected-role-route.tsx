"use client";

import { useCallback, useState } from "react";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { isWorkspaceRoleAuthorized, type WorkspaceProfile, type WorkspaceRole } from "../lib/role-access";
import { AuthPanel } from "./auth-panel";
import { DeliveryOperationsCenter } from "./operations-centers";
import { RequirementsPortal } from "./requirements-portal";

const workspaceLabels: Record<WorkspaceRole, string> = {
  vendor: "Vendor workspace",
  customer: "Customer account",
  admin: "URMED administration",
  delivery: "Delivery workspace",
};

export function ProtectedRoleRoute({ role }: { role: WorkspaceRole }) {
  const [profile, setProfile] = useState<WorkspaceProfile | null>(null);
  const authorized = isWorkspaceRoleAuthorized(profile, role);
  const updateProfile = useCallback((nextProfile: WorkspaceProfile | null) => {
    setProfile(isWorkspaceRoleAuthorized(nextProfile, role) ? nextProfile : null);
  }, [role]);

  return <div className={`protected-route protected-route-${role}`}>
    <section className={`protected-session ${authorized ? "authenticated" : ""}`}>
      <div className="protected-session-heading">
        <Link href="/"><ArrowLeft size={16} /> Marketplace</Link>
        {!authorized && <div><span><ShieldCheck size={18} /></span><div><small>PROTECTED WORKSPACE</small><h1>{workspaceLabels[role]}</h1><p>Sign in with an active {role} account. Other account roles cannot open this workspace.</p></div></div>}
      </div>
      <AuthPanel role={role} onProfileChange={updateProfile} />
    </section>
    {authorized && (role === "delivery"
      ? <main className="delivery-route-main"><DeliveryOperationsCenter /></main>
      : <RequirementsPortal initialRole={role} onBack={() => window.location.assign("/")} />)}
  </div>;
}
