import { getD1 } from "../db/d1";
import { requireLocalProfile, type LocalProfile } from "./auth-server";

export type VendorPermission =
  | "profile.manage"
  | "licence.manage"
  | "staff.manage"
  | "inventory.read"
  | "inventory.write"
  | "purchase.write"
  | "sale.write"
  | "prescription.review"
  | "reports.read"
  | "accounts.write";

const rolePermissions: Record<string, VendorPermission[]> = {
  owner: ["profile.manage", "licence.manage", "staff.manage", "inventory.read", "inventory.write", "purchase.write", "sale.write", "prescription.review", "reports.read", "accounts.write"],
  pharmacist: ["inventory.read", "sale.write", "prescription.review", "reports.read"],
  counter_staff: ["inventory.read", "sale.write"],
  inventory_manager: ["inventory.read", "inventory.write", "purchase.write", "reports.read"],
  delivery_coordinator: ["reports.read"],
};

type StaffAccess = { staffRole: string; permissionsJson: string };

export async function requireVendorOnboardingAccess(request: Request): Promise<{ profile: LocalProfile; vendorId: number }> {
  const { profile } = await requireLocalProfile(request, ["vendor"], { allowIncompleteVendor: true });
  if (!profile.vendorId) throw new Response("This account is not attached to a pharmacy", { status: 403 });
  const vendor = await getD1().prepare("SELECT profile_id AS profileId FROM vendors WHERE id = ? LIMIT 1")
    .bind(profile.vendorId).first<{ profileId: number | null }>();
  if (vendor?.profileId !== profile.id) throw new Response("Only the pharmacy owner can complete vendor onboarding", { status: 403 });
  return { profile, vendorId: profile.vendorId };
}

export async function requireVendorPermission(request: Request, permission: VendorPermission): Promise<{ profile: LocalProfile; vendorId: number; staffRole: string }> {
  const { profile } = await requireLocalProfile(request, ["vendor"]);
  if (!profile.vendorId) throw new Response("This account is not attached to a pharmacy", { status: 403 });
  if (profile.vendorAccessStatus !== "operational") {
    throw new Response("Complete verified vendor onboarding and administrator review before using pharmacy operations", { status: 403 });
  }
  const vendor = await getD1().prepare("SELECT profile_id AS profileId FROM vendors WHERE id = ? LIMIT 1").bind(profile.vendorId).first<{ profileId: number | null }>();
  if (vendor?.profileId === profile.id) return { profile, vendorId: profile.vendorId, staffRole: "owner" };
  const staff = await getD1().prepare(`
    SELECT staff_role AS staffRole, permissions_json AS permissionsJson
    FROM vendor_staff WHERE vendor_id = ? AND profile_id = ? AND status = 'active' LIMIT 1
  `).bind(profile.vendorId, profile.id).first<StaffAccess>();
  if (!staff) throw new Response("Your pharmacy staff access is inactive", { status: 403 });
  let extra: string[] = [];
  try { extra = JSON.parse(staff.permissionsJson) as string[]; } catch { extra = []; }
  if (![...(rolePermissions[staff.staffRole] ?? []), ...extra].includes(permission)) {
    throw new Response("Your pharmacy role cannot perform that action", { status: 403 });
  }
  return { profile, vendorId: profile.vendorId, staffRole: staff.staffRole };
}
