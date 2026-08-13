import { getD1 } from "../db/d1.ts";
import {
  getIdentityVerificationStatus,
  getVendorAccessStatus,
  providerVerificationState,
  type IdentityVerificationStatus,
  type VendorAccessStatus,
} from "./identity-verification.ts";
import { getRequiredRuntimeValue } from "./runtime-env.ts";
import { isTestAuthenticationEnabled, sha256, TEST_TOKEN_PREFIX } from "./test-auth.ts";
export { errorResponse } from "./api-errors.ts";

export type AuthUser = {
  id: string;
  email?: string;
  phone?: string;
  email_confirmed_at?: string | null;
  phone_confirmed_at?: string | null;
  user_metadata?: Record<string, unknown>;
};

export type LocalProfile = {
  id: number;
  authUserId: string;
  role: "customer" | "vendor" | "admin" | "delivery";
  name: string;
  email: string;
  phone: string;
  emailVerified: boolean;
  phoneVerified: boolean;
  identityVerificationStatus: IdentityVerificationStatus;
  status: string;
  vendorId: number | null;
  vendorRegistrationStatus: string | null;
  vendorApprovalStatus: string | null;
  vendorComplianceStatus: string | null;
  vendorAccessStatus: VendorAccessStatus | null;
};

type StoredLocalProfile = Omit<LocalProfile,
  "emailVerified" | "phoneVerified" | "identityVerificationStatus" | "vendorAccessStatus"
> & {
  emailVerified: number;
  phoneVerified: number;
};

function bearerToken(request: Request): string {
  const value = request.headers.get("authorization") ?? "";
  if (!value.startsWith("Bearer ")) throw new Response("Authentication required", { status: 401 });
  return value.slice(7).trim();
}

export async function requireAuthUser(request: Request): Promise<AuthUser> {
  const token = bearerToken(request);
  if (token.startsWith(TEST_TOKEN_PREFIX)) {
    if (!isTestAuthenticationEnabled()) {
      throw new Response("Your sign-in session is invalid or expired", { status: 401 });
    }
    const tokenHash = await sha256(token);
    const testUser = await getD1().prepare(`
      SELECT p.auth_user_id AS id, account.email, account.phone, p.role,
        account.email_confirmed AS emailConfirmed, account.phone_confirmed AS phoneConfirmed
      FROM test_sessions session
      JOIN test_accounts account ON account.id = session.test_account_id
      JOIN account_profiles p ON p.id = account.profile_id
      WHERE session.token_hash = ? AND account.active = 1 AND p.status = 'active'
        AND datetime(session.expires_at) > datetime('now') LIMIT 1
    `).bind(tokenHash).first<{
      id: string; email: string; phone: string; role: string;
      emailConfirmed: number; phoneConfirmed: number;
    }>();
    if (!testUser) throw new Response("Your test session is invalid or expired", { status: 401 });
    return {
      id: testUser.id, email: testUser.email, phone: testUser.phone ? `+91${testUser.phone}` : "",
      email_confirmed_at: testUser.emailConfirmed ? new Date().toISOString() : null,
      phone_confirmed_at: testUser.phoneConfirmed ? new Date().toISOString() : null,
      user_metadata: { role: testUser.role, test_account: true },
    };
  }
  let url: string;
  let anonKey: string;
  try {
    url = getRequiredRuntimeValue("SUPABASE_URL");
    anonKey = getRequiredRuntimeValue("SUPABASE_ANON_KEY");
  } catch (error) {
    throw new Response(error instanceof Error ? error.message : "Authentication is not configured", { status: 503 });
  }
  const response = await fetch(`${url.replace(/\/$/, "")}/auth/v1/user`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Response("Your sign-in session is invalid or expired", { status: 401 });
  return response.json() as Promise<AuthUser>;
}

export async function getLocalProfile(authUserId: string): Promise<LocalProfile | null> {
  const result = await getD1().prepare(`
    SELECT p.id, p.auth_user_id AS authUserId, p.role, p.name, p.email, p.phone,
      p.email_verified AS emailVerified, p.phone_verified AS phoneVerified, p.status,
      COALESCE(v.id, vs.vendor_id) AS vendorId,
      COALESCE(v.registration_status, staff_vendor.registration_status) AS vendorRegistrationStatus,
      COALESCE(v.approval_status, staff_vendor.approval_status) AS vendorApprovalStatus,
      COALESCE(v.compliance_status, staff_vendor.compliance_status) AS vendorComplianceStatus
    FROM account_profiles p
    LEFT JOIN vendors v ON v.profile_id = p.id
    LEFT JOIN vendor_staff vs ON vs.profile_id = p.id AND vs.status = 'active'
    LEFT JOIN vendors staff_vendor ON staff_vendor.id = vs.vendor_id
    WHERE p.auth_user_id = ? LIMIT 1
  `).bind(authUserId).first<StoredLocalProfile>();
  if (!result) return null;
  const emailVerified = Boolean(result.emailVerified);
  const phoneVerified = Boolean(result.phoneVerified);
  return {
    ...result,
    emailVerified,
    phoneVerified,
    identityVerificationStatus: getIdentityVerificationStatus(emailVerified, phoneVerified),
    vendorAccessStatus: result.role === "vendor" ? getVendorAccessStatus({
      ...result,
      emailVerified,
      phoneVerified,
    }) : null,
  };
}

export async function synchronizeProviderIdentity(user: AuthUser): Promise<LocalProfile | null> {
  const profile = await getLocalProfile(user.id);
  if (!profile) return null;
  const provider = providerVerificationState(user);
  if (
    profile.email === provider.email
    && profile.phone === provider.phone
    && profile.emailVerified === provider.emailVerified
    && profile.phoneVerified === provider.phoneVerified
  ) return profile;
  await getD1().prepare(`UPDATE account_profiles SET email=?,phone=?,email_verified=?,phone_verified=?,updated_at=CURRENT_TIMESTAMP
    WHERE auth_user_id=? AND status='active'`).bind(
    provider.email,
    provider.phone,
    provider.emailVerified ? 1 : 0,
    provider.phoneVerified ? 1 : 0,
    user.id,
  ).run();
  return getLocalProfile(user.id);
}

export async function requireLocalProfile(
  request: Request,
  allowedRoles?: LocalProfile["role"][],
  options: { allowIncompleteVendor?: boolean } = {},
) {
  const user = await requireAuthUser(request);
  const profile = await synchronizeProviderIdentity(user);
  if (!profile) throw new Response("Complete your URMED account profile first", { status: 403 });
  if (allowedRoles && !allowedRoles.includes(profile.role)) throw new Response("This account cannot perform that action", { status: 403 });
  if (profile.status !== "active") throw new Response("This account is not active", { status: 403 });
  if (profile.role === "customer" && (!profile.emailVerified || !profile.phoneVerified)) {
    throw new Response("Verify both the account email and mobile number before using customer operations", { status: 403 });
  }
  if (profile.role === "vendor" && profile.vendorAccessStatus !== "operational" && !options.allowIncompleteVendor) {
    throw new Response("Complete verified vendor onboarding and administrator review before using pharmacy operations", { status: 403 });
  }
  return { user, profile };
}
