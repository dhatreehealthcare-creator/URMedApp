export type WorkspaceRole = "customer" | "vendor" | "admin" | "delivery";

export type WorkspaceProfile = {
  role: WorkspaceRole;
  name: string;
  email: string;
  phone: string;
  emailVerified: boolean;
  phoneVerified: boolean;
  identityVerificationStatus: string;
  status: string;
  vendorRegistrationStatus: string | null;
  vendorApprovalStatus: string | null;
  vendorComplianceStatus: string | null;
  vendorAccessStatus: string | null;
};

export function isRoleSessionAuthorized(
  profile: Pick<WorkspaceProfile, "role" | "status"> | null,
  expectedRole: WorkspaceRole,
): boolean {
  return profile?.role === expectedRole && profile.status === "active";
}

export function isWorkspaceRoleAuthorized(
  profile: Pick<WorkspaceProfile, "role" | "status" | "vendorAccessStatus"> | null,
  expectedRole: WorkspaceRole,
): boolean {
  if (!isRoleSessionAuthorized(profile, expectedRole)) return false;
  return expectedRole !== "vendor" || profile?.vendorAccessStatus === "operational";
}
