import { getD1 } from "../../../db/d1";
import { errorResponse, requireLocalProfile } from "../../../lib/auth-server";
import {
  notificationPreferenceSettings,
  NotificationPreferenceError,
  updateNotificationPreference,
} from "../../../lib/notification-preferences";

export async function GET(request: Request) {
  try {
    const { profile } = await requireLocalProfile(request, ["customer", "vendor"], { allowIncompleteVendor: true });
    return Response.json(await notificationPreferenceSettings(getD1(), profile.id), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof NotificationPreferenceError) return Response.json({ error: error.message }, { status: error.status });
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const { profile } = await requireLocalProfile(request, ["customer", "vendor"], { allowIncompleteVendor: true });
    const body = await request.json() as Record<string, unknown>;
    const result = await updateNotificationPreference({
      db: getD1(),
      profileId: profile.id,
      emailVerified: profile.emailVerified,
      category: body.category,
      inAppEnabled: body.inAppEnabled,
      emailEnabled: body.emailEnabled,
      smsEnabled: body.smsEnabled,
      timeZone: body.timeZone,
      expectedVersion: body.version,
      requestId: request.headers.get("cf-ray") ?? "",
    });
    return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof NotificationPreferenceError) return Response.json({ error: error.message }, { status: error.status });
    return errorResponse(error);
  }
}
