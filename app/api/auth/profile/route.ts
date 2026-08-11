import { getD1 } from "../../../../db/d1";
import { errorResponse, getLocalProfile, requireAuthUser } from "../../../../lib/auth-server";

const roles = new Set(["customer", "vendor"]);

export async function GET(request: Request) {
  try {
    const user = await requireAuthUser(request);
    const profile = await getLocalProfile(user.id);
    return Response.json({ user: { id: user.id, email: user.email ?? "", phone: user.phone ?? "" }, profile });
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
    const email = (user.email ?? "").trim().toLowerCase();
    const rawPhone = (user.phone ?? String(body.phone ?? "")).replace(/\D/g, "");
    const phone = rawPhone.length > 10 ? rawPhone.slice(-10) : rawPhone;
    if (role === "vendor" && !/^\d{10}$/.test(phone)) return Response.json({ error: "Vendor phone must contain exactly 10 digits" }, { status: 400 });
    const db = getD1();
    if (phone) {
      const duplicate = await db.prepare("SELECT id FROM account_profiles WHERE phone = ? AND auth_user_id <> ? LIMIT 1").bind(phone, user.id).first();
      if (duplicate) return Response.json({ error: "This phone number is already registered" }, { status: 409 });
    }
    await db.prepare(`
      INSERT INTO account_profiles (auth_user_id, role, name, email, phone, email_verified, phone_verified, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
      ON CONFLICT(auth_user_id) DO UPDATE SET
        name = excluded.name, email = excluded.email, phone = excluded.phone,
        email_verified = excluded.email_verified, phone_verified = excluded.phone_verified,
        updated_at = CURRENT_TIMESTAMP
    `).bind(user.id, role, name, email, phone, user.email_confirmed_at ? 1 : 0, user.phone_confirmed_at ? 1 : 0).run();
    const profile = await getLocalProfile(user.id);
    if (profile?.role === "vendor" && !profile.vendorId) {
      await db.prepare(`
        INSERT INTO vendors (profile_id, business_name, owner_name, phone, email, gst_number, licence_number,
          address, latitude, longitude, home_delivery, approval_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'testing')
      `).bind(
        profile.id, businessName, name, phone, email,
        String(body.gstNumber ?? "").trim().slice(0, 20), String(body.licenceNumber ?? "").trim().slice(0, 80),
        String(body.address ?? "").trim().slice(0, 500), String(body.latitude ?? "").trim().slice(0, 40),
        String(body.longitude ?? "").trim().slice(0, 40), body.homeDelivery ? 1 : 0,
      ).run();
    }
    return Response.json({ profile: await getLocalProfile(user.id) });
  } catch (error) {
    return errorResponse(error);
  }
}
