export async function errorResponse(error: unknown) {
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
