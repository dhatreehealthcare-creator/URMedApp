import { getD1 } from "../../../../db/d1";
import { requireAdminProfile } from "../../../../lib/admin-access";
import { listAdminRegistrations, AdminRegistrationFilterError } from "../../../../lib/admin-registrations";
import { errorResponse } from "../../../../lib/auth-server";

export async function GET(request: Request) {
  try {
    await requireAdminProfile(request);
    const result = await listAdminRegistrations(getD1(), new URL(request.url));
    return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof AdminRegistrationFilterError) {
      return Response.json({ error: error.message }, { status: error.status, headers: { "Cache-Control": "private, no-store" } });
    }
    return errorResponse(error);
  }
}
