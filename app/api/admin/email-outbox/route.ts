import { getD1 } from "../../../../db/d1";
import { requireAdminProfile } from "../../../../lib/admin-access";
import { errorResponse } from "../../../../lib/auth-server";
import { listTransactionalEmailOutbox, retryDeadLetterEmail, TransactionalEmailOutboxError } from "../../../../lib/transactional-email-outbox";

const privateHeaders = { "Cache-Control": "private, no-store" };

export async function GET(request: Request) {
  try {
    await requireAdminProfile(request);
    const status = new URL(request.url).searchParams.get("status") ?? undefined;
    return Response.json(await listTransactionalEmailOutbox(getD1(), status), { headers: privateHeaders });
  } catch (error) {
    if (error instanceof TransactionalEmailOutboxError) return Response.json({ error: error.message }, { status: error.status, headers: privateHeaders });
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const profile = await requireAdminProfile(request);
    const body = await request.json() as Record<string, unknown>;
    if (body.action !== "retry") return Response.json({ error: "Outbox action is invalid" }, { status: 400, headers: privateHeaders });
    const result = await retryDeadLetterEmail({
      db: getD1(),
      id: Number(body.id),
      actorProfileId: profile.id,
      requestId: request.headers.get("cf-ray") ?? "",
    });
    return Response.json(result, { headers: privateHeaders });
  } catch (error) {
    if (error instanceof TransactionalEmailOutboxError) return Response.json({ error: error.message }, { status: error.status, headers: privateHeaders });
    return errorResponse(error);
  }
}
