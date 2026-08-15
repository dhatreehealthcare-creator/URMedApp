import { getD1 } from "../../../../db/d1";
import { appendAuditEvent } from "../../../../lib/audit";
import { errorResponse } from "../../../../lib/auth-server";
import { requireVendorPermission } from "../../../../lib/vendor-access";
import { BranchValidationError, validateBranchInput } from "../../../../lib/vendor-branches";

type BranchRow = {
  id: number; vendorId: number; branchCode: string; name: string; status: string; address: string; latitude: string; longitude: string;
  publicLabel: string; publicAddress: string; publicLatitude: string; publicLongitude: string; publicLocationStatus: string;
  pickupEnabled: number; serviceEnabled: number; serviceRadiusKm: number; isPrimary: number;
};

async function list(vendorId: number) {
  return getD1().prepare(`SELECT id, vendor_id AS vendorId, branch_code AS branchCode, name, status, address, latitude, longitude,
    public_label AS publicLabel, public_address AS publicAddress, public_latitude AS publicLatitude,
    public_longitude AS publicLongitude, public_location_status AS publicLocationStatus,
    pickup_enabled AS pickupEnabled, service_enabled AS serviceEnabled, service_radius_km AS serviceRadiusKm,
    is_primary AS isPrimary FROM pharmacy_branches WHERE vendor_id = ? ORDER BY is_primary DESC, id`).bind(vendorId).all<BranchRow>();
}

export async function GET(request: Request) {
  try {
    const { vendorId } = await requireVendorPermission(request, "inventory.read");
    return Response.json({ branches: (await list(vendorId)).results }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const { profile, vendorId } = await requireVendorPermission(request, "profile.manage");
    const body = await request.json() as Record<string, unknown>;
    const action = String(body.action ?? "create");
    if (action === "assign_staff") {
      const staffProfileId = Number(body.staffProfileId);
      const assignedBranchId = body.branchId === null || body.branchId === undefined ? null : Number(body.branchId);
      if (!Number.isInteger(staffProfileId) || staffProfileId < 1 || (assignedBranchId !== null && (!Number.isInteger(assignedBranchId) || assignedBranchId < 1))) {
        return Response.json({ error: "Staff profile or branch is invalid" }, { status: 400 });
      }
      if (assignedBranchId !== null) {
        const branch = await getD1().prepare("SELECT id FROM pharmacy_branches WHERE id = ? AND vendor_id = ? AND status = 'active' LIMIT 1").bind(assignedBranchId, vendorId).first<{ id: number }>();
        if (!branch) return Response.json({ error: "Branch not found" }, { status: 404 });
      }
      const staff = await getD1().prepare("SELECT id, branch_id AS branchId FROM vendor_staff WHERE profile_id = ? AND vendor_id = ? AND status = 'active' LIMIT 1").bind(staffProfileId, vendorId).first<{ id: number; branchId: number | null }>();
      if (!staff) return Response.json({ error: "Active staff member not found" }, { status: 404 });
      await getD1().prepare("UPDATE vendor_staff SET branch_id = ? WHERE id = ? AND vendor_id = ?").bind(assignedBranchId, staff.id, vendorId).run();
      await appendAuditEvent({ vendorId, actorProfileId: profile.id, action: "vendor.staff.branch_assigned", entityType: "vendor_staff", entityId: staff.id, before: { branchId: staff.branchId }, after: { branchId: assignedBranchId }, requestId: request.headers.get("cf-ray") ?? "" });
      return Response.json({ assigned: true, branchId: assignedBranchId }, { headers: { "Cache-Control": "private, no-store" } });
    }
    if (action === "deactivate" || action === "activate") {
      const id = Number(body.id);
      if (!Number.isInteger(id) || id < 1) return Response.json({ error: "Branch is invalid" }, { status: 400 });
      const existing = await getD1().prepare("SELECT id, is_primary AS isPrimary, status FROM pharmacy_branches WHERE id = ? AND vendor_id = ? LIMIT 1").bind(id, vendorId).first<{ id: number; isPrimary: number; status: string }>();
      if (!existing) return Response.json({ error: "Branch not found" }, { status: 404 });
      if (existing.isPrimary && action === "deactivate") return Response.json({ error: "The primary branch cannot be deactivated" }, { status: 409 });
      await getD1().prepare("UPDATE pharmacy_branches SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND vendor_id = ?").bind(action === "activate" ? "active" : "inactive", id, vendorId).run();
      await appendAuditEvent({ vendorId, actorProfileId: profile.id, action: `vendor.branch.${action}d`, entityType: "pharmacy_branch", entityId: id, before: existing, after: { status: action === "activate" ? "active" : "inactive" }, requestId: request.headers.get("cf-ray") ?? "" });
      return Response.json({ branches: (await list(vendorId)).results }, { headers: { "Cache-Control": "private, no-store" } });
    }
    let input;
    try { input = validateBranchInput(body); } catch (error) {
      if (error instanceof BranchValidationError) return Response.json({ error: error.message }, { status: 400 });
      throw error;
    }
    const id = body.id === undefined ? null : Number(body.id);
    if (id !== null && (!Number.isInteger(id) || id < 1)) return Response.json({ error: "Branch is invalid" }, { status: 400 });
    const existing = id === null ? null : await getD1().prepare("SELECT id, is_primary AS isPrimary FROM pharmacy_branches WHERE id = ? AND vendor_id = ? LIMIT 1").bind(id, vendorId).first<{ id: number; isPrimary: number }>();
    if (id !== null && !existing) return Response.json({ error: "Branch not found" }, { status: 404 });
    const publicStatus = input.publishPublicLocation ? "published" : "draft";
    const stmt = id === null
      ? getD1().prepare(`INSERT INTO pharmacy_branches (vendor_id,branch_code,name,address,latitude,longitude,public_label,public_address,public_latitude,public_longitude,public_location_status,public_location_consent_at,public_published_at,pickup_enabled,service_enabled,service_radius_km,is_primary)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,CASE WHEN ?='published' THEN CURRENT_TIMESTAMP ELSE NULL END,CASE WHEN ?='published' THEN CURRENT_TIMESTAMP ELSE NULL END,?,?,?,0)`).bind(vendorId,input.branchCode,input.name,input.address,input.latitude,input.longitude,input.publicLabel ?? "",input.publicAddress ?? "",input.publicLatitude ?? "",input.publicLongitude ?? "",publicStatus,publicStatus,publicStatus,input.pickupEnabled ? 1 : 0,input.serviceEnabled ? 1 : 0,input.serviceRadiusKm)
      : getD1().prepare(`UPDATE pharmacy_branches SET branch_code=?,name=?,address=?,latitude=?,longitude=?,public_label=?,public_address=?,public_latitude=?,public_longitude=?,public_location_status=?,public_location_consent_at=CASE WHEN ?='published' THEN COALESCE(public_location_consent_at,CURRENT_TIMESTAMP) ELSE public_location_consent_at END,public_published_at=CASE WHEN ?='published' THEN COALESCE(public_published_at,CURRENT_TIMESTAMP) ELSE NULL END,pickup_enabled=?,service_enabled=?,service_radius_km=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND vendor_id=?`).bind(input.branchCode,input.name,input.address,input.latitude,input.longitude,input.publicLabel ?? "",input.publicAddress ?? "",input.publicLatitude ?? "",input.publicLongitude ?? "",publicStatus,publicStatus,publicStatus,input.pickupEnabled ? 1 : 0,input.serviceEnabled ? 1 : 0,input.serviceRadiusKm,id,vendorId);
    const result = await stmt.run();
    const branchId = id ?? Number(result.meta.last_row_id);
    await appendAuditEvent({ vendorId, actorProfileId: profile.id, action: id === null ? "vendor.branch.created" : "vendor.branch.updated", entityType: "pharmacy_branch", entityId: branchId, after: { ...input, publicLocationStatus: publicStatus }, requestId: request.headers.get("cf-ray") ?? "" });
    return Response.json({ branches: (await list(vendorId)).results }, { status: id === null ? 201 : 200, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}
