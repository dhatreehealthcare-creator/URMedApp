export type WorkspaceRole = "customer" | "vendor" | "admin" | "delivery";

export type WorkspaceProfile = {
  role: WorkspaceRole;
  name: string;
  email: string;
  phone: string;
  status: string;
};

export function isWorkspaceRoleAuthorized(
  profile: Pick<WorkspaceProfile, "role" | "status"> | null,
  expectedRole: WorkspaceRole,
): boolean {
  return profile?.role === expectedRole && profile.status === "active";
}
