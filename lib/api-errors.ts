import { identityConflictFromDatabaseError, identityConflictMessage } from "./identity-conflicts.ts";

export async function errorResponse(error: unknown) {
  const identityConflict = identityConflictFromDatabaseError(error);
  if (identityConflict) {
    return Response.json({
      error: identityConflictMessage(identityConflict.fields),
      code: identityConflict.code,
      fields: identityConflict.fields,
    }, { status: 409, headers: { "Cache-Control": "no-store" } });
  }
  if (error instanceof Response) {
    const message = (await error.text()).trim() || (error.status === 401 ? "Authentication required" : "The request could not be completed");
    return Response.json({ error: message }, { status: error.status, headers: { "Cache-Control": "no-store" } });
  }
  const detail = error instanceof Error ? error.message : "";
  const message = /SQLITE|D1_ERROR|constraint failed|database/i.test(detail)
    ? "The requested operation could not be completed safely"
    : detail || "Unexpected server error";
  return Response.json({ error: message }, { status: 500, headers: { "Cache-Control": "no-store" } });
}
