import { getD1 } from "../../../../db/d1";
import { requireAdminProfile } from "../../../../lib/admin-access";
import { errorResponse } from "../../../../lib/auth-server";
import { RECOVERED_CUSTOMER_IDENTITY_POLICY } from "../../../../lib/customer-identity";

type CountRow = { products: number; customers: number; categories: number; manufacturers: number };
type AuditRow = { entity: string; sourceRows: number; importedRows: number; rejectedRows: number; notes: string; completedAt: string };
type CustomerRow = { legacyId: number; name: string; email: string; mobile: string; registeredAt: string | null };

export async function GET(request: Request) {
  try {
    await requireAdminProfile(request);
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
      db.prepare(`SELECT legacy_id AS legacyId, name, email, mobile, registered_at AS registeredAt
        FROM customers ORDER BY legacy_id`),
    ]);
    return Response.json({
      counts: (counts.results[0] ?? { products: 0, customers: 0, categories: 0, manufacturers: 0 }) as CountRow,
      audit: audit.results as AuditRow[],
      customers: customers.results as CustomerRow[],
      identityPolicy: RECOVERED_CUSTOMER_IDENTITY_POLICY,
      security: {
        legacyPasswordsImported: false,
        recoveredRecordsCanAuthenticate: false,
        customerAccess: "admin_only_reference",
        automaticLinking: false,
      },
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
