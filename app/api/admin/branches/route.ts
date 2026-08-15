import { getD1 } from "../../../../db/d1";
import { errorResponse } from "../../../../lib/auth-server";
import { requireAdminProfile } from "../../../../lib/admin-access";

export async function GET(request: Request) {
  try {
    await requireAdminProfile(request);
    const url = new URL(request.url);
    const vendorId = Number(url.searchParams.get("vendorId"));
    const status = url.searchParams.get("status");
    const where = ["1=1"];
    const bindings: Array<number | string> = [];
    if (Number.isInteger(vendorId) && vendorId > 0) { where.push("b.vendor_id = ?"); bindings.push(vendorId); }
    if (status === "active" || status === "inactive") { where.push("b.status = ?"); bindings.push(status); }
    const rows = await getD1().prepare(`SELECT b.id, b.vendor_id AS vendorId, v.business_name AS businessName,
      b.branch_code AS branchCode, b.name, b.status, b.public_location_status AS publicLocationStatus,
      b.public_label AS publicLabel, b.public_address AS publicAddress,
      b.pickup_enabled AS pickupEnabled, b.service_enabled AS serviceEnabled,
      b.service_radius_km AS serviceRadiusKm, b.is_primary AS isPrimary,
      b.created_at AS createdAt, b.updated_at AS updatedAt
      FROM pharmacy_branches b JOIN vendors v ON v.id = b.vendor_id
      WHERE ${where.join(" AND ")} ORDER BY v.business_name, b.is_primary DESC, b.id`).bind(...bindings).all();
    return Response.json({ branches: rows.results }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}
