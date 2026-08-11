import { getD1 } from "../db/d1";
import { getRequiredRuntimeValue } from "./runtime-env";
import { sha256, TEST_TOKEN_PREFIX } from "./test-auth";
export { errorResponse } from "./api-errors";

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
  status: string;
  vendorId: number | null;
};

function bearerToken(request: Request): string {
  const value = request.headers.get("authorization") ?? "";
  if (!value.startsWith("Bearer ")) throw new Response("Authentication required", { status: 401 });
  return value.slice(7).trim();
}

export async function requireAuthUser(request: Request): Promise<AuthUser> {
  const token = bearerToken(request);
  if (token.startsWith(TEST_TOKEN_PREFIX)) {
    const tokenHash = await sha256(token);
    const testUser = await getD1().prepare(`
      SELECT p.auth_user_id AS id, p.email, p.phone, p.role
      FROM test_sessions session
      JOIN test_accounts account ON account.id = session.test_account_id
      JOIN account_profiles p ON p.id = account.profile_id
      WHERE session.token_hash = ? AND account.active = 1 AND p.status = 'active'
        AND datetime(session.expires_at) > datetime('now') LIMIT 1
    `).bind(tokenHash).first<{ id: string; email: string; phone: string; role: string }>();
    if (!testUser) throw new Response("Your test session is invalid or expired", { status: 401 });
    return {
      id: testUser.id, email: testUser.email, phone: `+91${testUser.phone}`,
      email_confirmed_at: new Date().toISOString(), phone_confirmed_at: new Date().toISOString(),
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
    SELECT p.id, p.auth_user_id AS authUserId, p.role, p.name, p.email, p.phone, p.status,
      COALESCE(v.id, vs.vendor_id) AS vendorId
    FROM account_profiles p
    LEFT JOIN vendors v ON v.profile_id = p.id
    LEFT JOIN vendor_staff vs ON vs.profile_id = p.id AND vs.status = 'active'
    WHERE p.auth_user_id = ? LIMIT 1
  `).bind(authUserId).first<LocalProfile>();
  return result ?? null;
}

export async function requireLocalProfile(request: Request, allowedRoles?: LocalProfile["role"][]) {
  const user = await requireAuthUser(request);
  const profile = await getLocalProfile(user.id);
  if (!profile) throw new Response("Complete your URMED account profile first", { status: 403 });
  if (allowedRoles && !allowedRoles.includes(profile.role)) throw new Response("This account cannot perform that action", { status: 403 });
  if (profile.status !== "active") throw new Response("This account is not active", { status: 403 });
  return { user, profile };
}
