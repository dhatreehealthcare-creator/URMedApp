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
    const url = new URL(request.url);
    const query = (url.searchParams.get("q") ?? "").trim().toLowerCase().replace(/[%_]/g, "").slice(0, 100);
    const requestedPage = Number(url.searchParams.get("page") ?? "1");
    const requestedPageSize = Number(url.searchParams.get("pageSize") ?? "20");
    const page = Number.isInteger(requestedPage) ? Math.min(100_000, Math.max(1, requestedPage)) : 1;
    const pageSize = Number.isInteger(requestedPageSize) ? Math.min(50, Math.max(10, requestedPageSize)) : 20;
    const search = `%${query}%`;
    const [counts, audit, customerCount, customers] = await db.batch([
      db.prepare(`SELECT
        (SELECT COUNT(*) FROM products) AS products,
        (SELECT COUNT(*) FROM customers) AS customers,
        (SELECT COUNT(*) FROM categories) AS categories,
        (SELECT COUNT(*) FROM manufacturers) AS manufacturers`),
      db.prepare(`SELECT entity, source_rows AS sourceRows, imported_rows AS importedRows,
        rejected_rows AS rejectedRows, notes, completed_at AS completedAt
        FROM migration_audit ORDER BY id`),
      db.prepare(`SELECT COUNT(*) AS total FROM customers
        WHERE ? = '' OR lower(name) LIKE ? OR lower(email) LIKE ? OR mobile LIKE ?`)
        .bind(query, search, search, search),
      db.prepare(`SELECT legacy_id AS legacyId, name, email, mobile, registered_at AS registeredAt
        FROM customers WHERE ? = '' OR lower(name) LIKE ? OR lower(email) LIKE ? OR mobile LIKE ?
        ORDER BY legacy_id LIMIT ? OFFSET ?`)
        .bind(query, search, search, search, pageSize, (page - 1) * pageSize),
    ]);
    const total = Number((customerCount.results[0] as { total?: number } | undefined)?.total ?? 0);
    return Response.json({
      counts: (counts.results[0] ?? { products: 0, customers: 0, categories: 0, manufacturers: 0 }) as CountRow,
      audit: audit.results as AuditRow[],
      customers: customers.results as CustomerRow[],
      pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
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
