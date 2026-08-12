export function getD1(): D1Database {
  const database = (globalThis as typeof globalThis & { __URMED_D1__?: D1Database }).__URMED_D1__;
  if (!database) throw new Error("URMED database binding is unavailable");
  return database;
}
