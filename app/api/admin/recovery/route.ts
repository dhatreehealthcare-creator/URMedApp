import { getD1, isAuthorizedOwner } from "../../../../db/d1";

type CountRow = { products: number; customers: number; categories: number; manufacturers: number };
type AuditRow = { entity: string; sourceRows: number; importedRows: number; rejectedRows: number; notes: string; completedAt: string };
type CustomerRow = { legacyId: number; name: string; email: string; mobile: string; registeredAt: string | null; passwordResetRequired: number };

export async function GET(request: Request) {
  if (!isAuthorizedOwner(request)) return Response.json({ error: "Owner authentication required" }, { status: 401 });
  try {
    const db = getD1();
    const [counts, audit, customers] = await db.batch([
      db.prepare(`SELECT
        (SELECT COUNT(*) FROM products) AS products,
        (SELECT COUNT(*) FROM customers) AS customers,
        (SELECT COUNT(*) FROM categories) AS categories,
        (SELECT COUNT(*) FROM manufacturers) AS manufacturers`),
      db.prepare(`SELECT entity, source_rows AS sourceRows, imported_rows AS importedRows,
        rejected_rows AS rejectedRows, notes, completed_at AS completedAt
        FROM migration_audit ORDER BY id`),
      db.prepare(`SELECT legacy_id AS legacyId, name, email, mobile,
        registered_at AS registeredAt, password_reset_required AS passwordResetRequired
        FROM customers ORDER BY legacy_id`),
    ]);
    return Response.json({
      counts: (counts.results[0] ?? { products: 0, customers: 0, categories: 0, manufacturers: 0 }) as CountRow,
      audit: audit.results as AuditRow[],
      customers: customers.results as CustomerRow[],
      security: { legacyPasswordsImported: false, customerAccess: "owner_only", passwordResetRequired: true },
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Recovery status unavailable";
    return Response.json({ error: message }, { status: 500 });
  }
}
