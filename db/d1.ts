export function getD1(): D1Database {
  const database = (globalThis as typeof globalThis & { __URMED_D1__?: D1Database }).__URMED_D1__;
  if (!database) throw new Error("URMED database binding is unavailable");
  return database;
}

export function isAuthorizedOwner(request: Request): boolean {
  const email = request.headers.get("oai-authenticated-user-email")?.trim().toLowerCase();
  if (email === "dhatreehealthcare@gmail.com") return true;
  return new URL(request.url).hostname === "terminal.local";
}
