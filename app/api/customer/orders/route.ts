import { getD1 } from "../../../../db/d1";
import { errorResponse, requireLocalProfile } from "../../../../lib/auth-server";
import {
  canCustomerCancelOrder,
  customerOrderSortExpression,
  customerOrderStatusPredicate,
  escapeCustomerOrderSearch,
  parseCustomerOrderHistoryQuery,
} from "../../../../lib/customer-order-history";

type CustomerOrderListRow = {
  id: number; orderNumber: string; businessName: string; totalPaise: number; paymentMethod: string;
  paymentStatus: string; deliveryMethod: string; orderStatus: string; deliveryStatus: string;
  prescriptionStatus: string; inventoryStatus: string; invoiceId: number | null; createdAt: string;
  itemCount: number; unitCount: number; itemPreview: string;
};

export async function GET(request: Request) {
  try {
    const { profile } = await requireLocalProfile(request, ["customer"]);
    const filters = parseCustomerOrderHistoryQuery(new URL(request.url));
    const predicates = ["o.customer_profile_id=?", "o.order_type='online'"];
    const bindings: Array<string | number> = [profile.id];
    if (filters.query) {
      const pattern = `%${escapeCustomerOrderSearch(filters.query)}%`;
      predicates.push(`(o.order_number LIKE ? ESCAPE '\\' OR v.business_name LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM order_items search_item WHERE search_item.order_id=o.id
          AND search_item.product_name LIKE ? ESCAPE '\\'))`);
      bindings.push(pattern, pattern, pattern);
    }
    if (filters.payment !== "all") { predicates.push("o.payment_status=?"); bindings.push(filters.payment); }
    if (filters.delivery !== "all") { predicates.push("o.delivery_method=?"); bindings.push(filters.delivery); }
    predicates.push(customerOrderStatusPredicate(filters.status));
    const where = predicates.join(" AND ");
    const db = getD1();
    const [count, rows, summary] = await Promise.all([
      db.prepare(`SELECT COUNT(*) AS count FROM orders o JOIN vendors v ON v.id=o.vendor_id WHERE ${where}`)
        .bind(...bindings).first<{ count: number }>(),
      db.prepare(`SELECT o.id,o.order_number AS orderNumber,v.business_name AS businessName,
        o.total_paise AS totalPaise,o.payment_method AS paymentMethod,o.payment_status AS paymentStatus,
        o.delivery_method AS deliveryMethod,o.order_status AS orderStatus,o.delivery_status AS deliveryStatus,
        o.prescription_status AS prescriptionStatus,o.inventory_status AS inventoryStatus,o.invoice_id AS invoiceId,
        o.created_at AS createdAt,
        (SELECT COUNT(*) FROM order_items item WHERE item.order_id=o.id) AS itemCount,
        (SELECT COALESCE(SUM(item.quantity),0) FROM order_items item WHERE item.order_id=o.id) AS unitCount,
        (SELECT group_concat(item.product_name || ' × ' || item.quantity, ', ')
          FROM order_items item WHERE item.order_id=o.id) AS itemPreview
        FROM orders o JOIN vendors v ON v.id=o.vendor_id WHERE ${where}
        ORDER BY ${customerOrderSortExpression(filters.sort)} LIMIT ? OFFSET ?`)
        .bind(...bindings, filters.pageSize, (filters.page - 1) * filters.pageSize).all<CustomerOrderListRow>(),
      db.prepare(`SELECT COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN o.order_status NOT IN ('completed','cancelled') THEN 1 ELSE 0 END),0) AS active,
        COALESCE(SUM(CASE WHEN o.order_status='completed' THEN 1 ELSE 0 END),0) AS completed,
        COALESCE(SUM(CASE WHEN o.order_status='cancelled' THEN 1 ELSE 0 END),0) AS cancelled
        FROM orders o WHERE o.customer_profile_id=? AND o.order_type='online'`).bind(profile.id)
        .first<{ total: number; active: number; completed: number; cancelled: number }>(),
    ]);
    const total = Number(count?.count ?? 0);
    return Response.json({
      orders: rows.results.map((order) => ({
        ...order,
        invoiceAvailable: Boolean(order.invoiceId),
        canCancel: canCustomerCancelOrder(order),
      })),
      summary: summary ?? { total: 0, active: 0, completed: 0, cancelled: 0 },
      pagination: { page: filters.page, pageSize: filters.pageSize, total, totalPages: Math.max(1, Math.ceil(total / filters.pageSize)) },
      filters,
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
