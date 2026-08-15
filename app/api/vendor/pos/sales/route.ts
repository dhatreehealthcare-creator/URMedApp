import { getD1 } from "../../../../../db/d1";
import { appendAuditEvent } from "../../../../../lib/audit";
import { errorResponse } from "../../../../../lib/auth-server";
import { completeOfflineSale, OfflinePosError } from "../../../../../lib/offline-pos";
import { requireVendorPermission } from "../../../../../lib/vendor-access";

function boundedInteger(value: string | null, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function respondToPosError(error: unknown) {
  if (error instanceof OfflinePosError) {
    return Response.json({ error: error.message }, { status: error.status, headers: { "Cache-Control": "no-store" } });
  }
  return errorResponse(error);
}

export async function GET(request: Request) {
  try {
    const { vendorId, branchId: staffBranchId } = await requireVendorPermission(request, "sale.write");
    const url = new URL(request.url);
    const requestedBranchId = url.searchParams.get("branchId");
    if (requestedBranchId !== null && (!/^\d+$/.test(requestedBranchId) || Number(requestedBranchId) < 1)) {
      return Response.json({ error: "Branch is invalid" }, { status: 400, headers: { "Cache-Control": "private, no-store" } });
    }
    if (staffBranchId !== null && requestedBranchId !== null && Number(requestedBranchId) !== staffBranchId) {
      return Response.json({ error: "Your staff access is limited to another pharmacy branch" }, { status: 403, headers: { "Cache-Control": "private, no-store" } });
    }
    const effectiveBranchId = staffBranchId ?? (requestedBranchId === null ? null : Number(requestedBranchId));
    const query = (url.searchParams.get("q") ?? "").trim().toLowerCase().replace(/[%_]/g, "").slice(0, 100);
    const page = boundedInteger(url.searchParams.get("page"), 1, 1, 100_000);
    const pageSize = boundedInteger(url.searchParams.get("pageSize"), 20, 5, 50);
    const search = `%${query}%`;
    const result = await getD1().prepare(`
      SELECT sale.id, sale.sale_number AS saleNumber, invoice.invoice_number AS invoiceNumber,
        sale.customer_name AS customerName, sale.customer_phone AS customerPhone,
        sale.payment_mode AS paymentMode, sale.total_paise AS totalPaise, sale.created_at AS createdAt,
        COUNT(*) OVER() AS totalCount
      FROM offline_sales sale
      JOIN offline_sale_events event ON event.offline_sale_id = sale.id AND event.event_type = 'completed'
      JOIN tax_invoices invoice ON invoice.source_type = 'offline_sale' AND invoice.source_id = sale.id
      WHERE sale.vendor_id = ? AND (? IS NULL OR sale.branch_id = ?) AND (? = '' OR lower(sale.sale_number) LIKE ?
        OR lower(sale.customer_name) LIKE ? OR sale.customer_phone LIKE ? OR lower(invoice.invoice_number) LIKE ?)
      ORDER BY sale.created_at DESC, sale.id DESC LIMIT ? OFFSET ?
    `).bind(vendorId, effectiveBranchId, effectiveBranchId, query, search, search, search, search, pageSize, (page - 1) * pageSize).all<{
      id: number; saleNumber: string; invoiceNumber: string; customerName: string; customerPhone: string;
      paymentMode: string; totalPaise: number; createdAt: string; totalCount: number;
    }>();
    const total = Number(result.results[0]?.totalCount ?? 0);
    return Response.json({
      sales: result.results.map((row) => {
        const { totalCount, ...sale } = row;
        void totalCount;
        return sale;
      }),
      pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return respondToPosError(error);
  }
}

export async function POST(request: Request) {
  try {
    const { profile, vendorId, branchId: staffBranchId } = await requireVendorPermission(request, "sale.write");
    const body = await request.json() as Record<string, unknown>;
    const requestedBranchId = body.branchId === undefined ? null : Number(body.branchId);
    if (requestedBranchId !== null && (!Number.isInteger(requestedBranchId) || requestedBranchId < 1)) {
      return Response.json({ error: "Branch is invalid" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    }
    if (staffBranchId !== null && requestedBranchId !== null && requestedBranchId !== staffBranchId) {
      return Response.json({ error: "Your staff access is limited to another pharmacy branch" }, { status: 403, headers: { "Cache-Control": "no-store" } });
    }
    const result = await completeOfflineSale({
      database: getD1(), vendorId, actorProfileId: profile.id,
      body: { ...body, ...(staffBranchId === null ? {} : { branchId: staffBranchId }) },
    });
    if (!result.replayed) {
      await appendAuditEvent({
        vendorId,
        actorProfileId: profile.id,
        action: "offline_sale.completed",
        entityType: "offline_sale",
        entityId: result.receipt.id,
        after: { saleNumber: result.receipt.saleNumber, totalPaise: result.receipt.totalPaise },
        requestId: request.headers.get("cf-ray") ?? "",
      }).catch(() => undefined);
    }
    return Response.json(result, {
      status: result.replayed ? 200 : 201,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return respondToPosError(error);
  }
}
