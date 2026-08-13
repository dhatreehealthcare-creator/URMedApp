import { getD1 } from "../../../../../db/d1";
import { errorResponse } from "../../../../../lib/auth-server";
import { normalizePosLookup } from "../../../../../lib/offline-pos";
import { requireVendorPermission } from "../../../../../lib/vendor-access";

type CustomerRow = {
  id: number;
  name: string;
  email: string;
  phone: string;
};

export async function GET(request: Request) {
  try {
    await requireVendorPermission(request, "sale.write");
    const lookup = normalizePosLookup(new URL(request.url).searchParams.get("q"));
    const predicate = lookup.kind === "phone" ? "phone = ?" : "lower(trim(email)) = ?";
    const customer = await getD1().prepare(`
      SELECT id, name, email, phone FROM account_profiles
      WHERE role = 'customer' AND status = 'active'
        AND email_verified = 1 AND phone_verified = 1 AND ${predicate}
      LIMIT 1
    `).bind(lookup.value).first<CustomerRow>();
    return Response.json({ customer: customer ?? null }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
