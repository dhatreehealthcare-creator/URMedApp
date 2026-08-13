"use client";

import { useCallback, useState } from "react";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { isRoleSessionAuthorized, isWorkspaceRoleAuthorized, type WorkspaceProfile, type WorkspaceRole } from "../lib/role-access";
import { AuthPanel } from "./auth-panel";
import { DeliveryOperationsCenter } from "./operations-centers";
import { RequirementsPortal } from "./requirements-portal";
import { VendorSetup } from "./vendor-setup";

const workspaceLabels: Record<WorkspaceRole, string> = {
  vendor: "Vendor workspace",
  customer: "Customer account",
  admin: "URMED administration",
  delivery: "Delivery workspace",
};

export function ProtectedRoleRoute({ role }: { role: WorkspaceRole }) {
  const [profile, setProfile] = useState<WorkspaceProfile | null>(null);
  const sessionAuthorized = isRoleSessionAuthorized(profile, role);
  const authorized = isWorkspaceRoleAuthorized(profile, role);
  const updateProfile = useCallback((nextProfile: WorkspaceProfile | null) => {
    setProfile(isRoleSessionAuthorized(nextProfile, role) ? nextProfile : null);
  }, [role]);

  return <div className={`protected-route protected-route-${role}`}>
    <section className={`protected-session ${authorized ? "authenticated" : ""}`}>
      <div className="protected-session-heading">
        <Link href="/"><ArrowLeft size={16} /> Marketplace</Link>
        {!sessionAuthorized && <div><span><ShieldCheck size={18} /></span><div><small>PROTECTED WORKSPACE</small><h1>{workspaceLabels[role]}</h1><p>Sign in with an active {role} account. Other account roles cannot open this workspace.</p></div></div>}
        {sessionAuthorized && role === "vendor" && !authorized && <div><span><ShieldCheck size={18} /></span><div><small>RESTRICTED ONBOARDING</small><h1>Complete vendor verification</h1><p>{profile?.vendorAccessStatus === "review_pending" ? "Your verified registration is under administrator review. Pharmacy operations remain locked until approval." : "Verify both identity factors and submit the pharmacy registration before operational access is enabled."}</p></div></div>}
        {sessionAuthorized && role === "customer" && !authorized && <div><span><ShieldCheck size={18} /></span><div><small>RESTRICTED ONBOARDING</small><h1>Complete customer verification</h1><p>Verify both the account email and required mobile OTP on the same email/password account before customer ordering and account operations are enabled.</p></div></div>}
      </div>
      <AuthPanel role={role} onProfileChange={updateProfile} />
    </section>
    {sessionAuthorized && role === "vendor" && !authorized && <main className="vendor-onboarding-route-main"><VendorSetup registrationMode /></main>}
    {authorized && (role === "delivery"
      ? <main className="delivery-route-main"><DeliveryOperationsCenter /></main>
      : <RequirementsPortal initialRole={role} onBack={() => window.location.assign("/")} />)}
  </div>;
}
