import { getD1 } from "../../../../db/d1";
import { requireAdminProfile } from "../../../../lib/admin-access";
import { errorResponse } from "../../../../lib/auth-server";
import { listOperationalMonitoring, updateOperationalAlert } from "../../../../lib/operational-monitoring";

const headers = { "Cache-Control": "private, no-store" };

export async function GET(request: Request) {
  try {
    await requireAdminProfile(request);
    const params = new URL(request.url).searchParams;
    const vendor = params.get("vendorId");
    const result = await listOperationalMonitoring(getD1(), {
      category: params.get("category") ?? undefined, severity: params.get("severity") ?? undefined,
      status: params.get("status") ?? undefined, provider: params.get("provider") ?? undefined,
      vendorId: vendor && /^\d+$/.test(vendor) ? Number(vendor) : undefined,
      from: params.get("from") ?? undefined, to: params.get("to") ?? undefined,
      page: Number(params.get("page") ?? 1), pageSize: Number(params.get("pageSize") ?? 50),
    });
    return Response.json(result, { headers });
  } catch (error) { return errorResponse(error); }
}

export async function PATCH(request: Request) {
  try {
    const profile = await requireAdminProfile(request);
    const body = await request.json() as Record<string, unknown>;
    const action = String(body.action ?? "");
    if (!["acknowledge", "resolve", "reopen"].includes(action)) return Response.json({ error: "Monitoring action is invalid" }, { status: 400, headers });
    const result = await updateOperationalAlert({ db: getD1(), id: Number(body.id), action: action as "acknowledge" | "resolve" | "reopen", version: Number(body.version), reason: String(body.reason ?? ""), actorProfileId: profile.id, requestId: request.headers.get("cf-ray") ?? "" });
    return Response.json(result, { headers });
  } catch (error) {
    if (error && typeof error === "object" && "status" in error && Number((error as { status?: number }).status) === 409) return Response.json({ error: "Monitoring alert changed; refresh and retry" }, { status: 409, headers });
    return errorResponse(error);
  }
}
