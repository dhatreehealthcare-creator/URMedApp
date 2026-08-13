import { getD1 } from "../../../../db/d1";
import { errorResponse, getLocalProfile, requireAuthUser, synchronizeProviderIdentity } from "../../../../lib/auth-server";
import { providerVerificationState } from "../../../../lib/identity-verification";
import { IdentityConflictError } from "../../../../lib/identity-conflicts";
import { getCustomerOnboardingState } from "../../../../lib/customer-registration";

const roles = new Set(["customer", "vendor"]);
const privateResponseHeaders = { "Cache-Control": "private, no-store" };

export async function GET(request: Request) {
  try {
    const user = await requireAuthUser(request);
    const profile = await synchronizeProviderIdentity(user);
    const onboarding = profile?.role === "customer" ? getCustomerOnboardingState(profile) : null;
    return Response.json({ user: { id: user.id, email: user.email ?? "", phone: user.phone ?? "" }, profile, onboarding }, { headers: privateResponseHeaders });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireAuthUser(request);
    const body = await request.json() as Record<string, unknown>;
    const role = String(body.role ?? user.user_metadata?.role ?? "customer").toLowerCase();
    if (!roles.has(role)) return Response.json({ error: "Choose customer or vendor" }, { status: 400 });
    const existingProfile = await getLocalProfile(user.id);
    if (existingProfile && existingProfile.role !== role) {
      return Response.json({ error: "An existing account role cannot be changed through public registration" }, { status: 409 });
    }
    const name = String(body.name ?? user.user_metadata?.name ?? "").trim().slice(0, 120);
    const businessName = String(body.businessName ?? user.user_metadata?.business_name ?? "").trim().slice(0, 180);
    if (!name) return Response.json({ error: "Name is required" }, { status: 400 });
    if (role === "vendor" && !businessName) return Response.json({ error: "Shop or business name is required" }, { status: 400 });
    const provider = providerVerificationState(user);
    const { email, phone } = provider;
    if (!email) {
      return Response.json({ error: `${role === "vendor" ? "Vendor" : "Customer"} registration requires an email and password account before phone OTP verification` }, { status: 400 });
    }
    const db = getD1();
    if (email) {
      const duplicateEmail = await db.prepare(`
        SELECT id FROM account_profiles WHERE lower(trim(email)) = ? AND auth_user_id <> ?
        UNION SELECT profile_id AS id FROM vendors
          WHERE lower(trim(email)) = ? AND email <> ''
            AND (profile_id IS NULL OR profile_id <> COALESCE((SELECT id FROM account_profiles WHERE auth_user_id = ?), -1))
        LIMIT 1
      `).bind(email, user.id, email, user.id).first();
      if (duplicateEmail) throw new IdentityConflictError(["email"]);
    }
    if (phone) {
      const duplicate = await db.prepare(`
        SELECT id FROM account_profiles WHERE phone = ? AND auth_user_id <> ?
        UNION SELECT profile_id AS id FROM vendors
          WHERE phone = ? AND phone <> ''
            AND (profile_id IS NULL OR profile_id <> COALESCE((SELECT id FROM account_profiles WHERE auth_user_id = ?), -1))
        LIMIT 1
      `).bind(phone, user.id, phone, user.id).first();
      if (duplicate) throw new IdentityConflictError(["phone"]);
    }
    const profileWrite = db.prepare(`
      INSERT INTO account_profiles (auth_user_id, role, name, email, phone, email_verified, phone_verified, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
      ON CONFLICT(auth_user_id) DO UPDATE SET
        name = excluded.name, email = excluded.email, phone = excluded.phone,
        email_verified = excluded.email_verified, phone_verified = excluded.phone_verified,
        updated_at = CURRENT_TIMESTAMP
    `).bind(user.id, role, name, email, phone, provider.emailVerified ? 1 : 0, provider.phoneVerified ? 1 : 0);
    if (role === "vendor") {
      await db.batch([
        profileWrite,
        db.prepare(`
          INSERT INTO vendors (profile_id, business_name, owner_name, phone, email, approval_status, compliance_status)
          SELECT id, ?, ?, ?, ?, 'draft', 'pending' FROM account_profiles WHERE auth_user_id = ?
          ON CONFLICT(profile_id) DO NOTHING
        `).bind(businessName, name, phone, email, user.id),
      ]);
    } else {
      await profileWrite.run();
    }
    const profile = await getLocalProfile(user.id);
    const onboarding = profile?.role === "customer" ? getCustomerOnboardingState(profile) : null;
    return Response.json({ profile, onboarding }, { headers: privateResponseHeaders });
  } catch (error) {
    return errorResponse(error);
  }
}
