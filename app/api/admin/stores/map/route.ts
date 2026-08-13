import { getD1 } from "../../../../../db/d1";
import { requireAdminProfile } from "../../../../../lib/admin-access";
import { AdminStoreMapFilterError, loadAdminStoreMap } from "../../../../../lib/admin-store-map";
import { errorResponse } from "../../../../../lib/auth-server";

export async function GET(request: Request) {
  try {
    await requireAdminProfile(request);
    return Response.json(await loadAdminStoreMap(getD1(), new URL(request.url)), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof AdminStoreMapFilterError) {
      return Response.json({ error: error.message }, { status: error.status, headers: { "Cache-Control": "private, no-store" } });
    }
    return errorResponse(error);
  }
}
