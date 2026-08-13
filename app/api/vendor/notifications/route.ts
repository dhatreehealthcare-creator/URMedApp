import { getD1 } from "../../../../db/d1";
import { errorResponse } from "../../../../lib/auth-server";
import {
  listVendorNotifications,
  transitionVendorNotification,
  VendorNotificationError,
  type VendorNotificationAction,
} from "../../../../lib/vendor-notifications";
import { requireVendorPermission } from "../../../../lib/vendor-access";

export async function GET(request: Request) {
  try {
    const access = await requireVendorPermission(request, "inventory.read");
    let canManage = true;
    try {
      await requireVendorPermission(request, "inventory.write", { profile: access.profile });
    } catch (error) {
      if (!(error instanceof Response) || error.status !== 403) throw error;
      canManage = false;
    }
    const url = new URL(request.url);
    const includeResolved = url.searchParams.get("includeResolved") === "true";
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const inbox = await listVendorNotifications(getD1(), access.vendorId, { includeResolved, limit });
    return Response.json({ ...inbox, canManage }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof VendorNotificationError) return Response.json({ error: error.message }, { status: error.status });
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const action = String(body.action ?? "") as VendorNotificationAction;
    const permission = action === "read" ? "inventory.read" : "inventory.write";
    const { profile, vendorId } = await requireVendorPermission(request, permission);
    const result = await transitionVendorNotification({
      db: getD1(),
      vendorId,
      actorProfileId: profile.id,
      notificationId: Number(body.id),
      expectedVersion: Number(body.version),
      action,
      snoozedUntil: typeof body.snoozedUntil === "string" ? body.snoozedUntil : undefined,
      reason: typeof body.reason === "string" ? body.reason : undefined,
      requestId: request.headers.get("cf-ray") ?? "",
    });
    return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof VendorNotificationError) return Response.json({ error: error.message }, { status: error.status });
    return errorResponse(error);
  }
}
