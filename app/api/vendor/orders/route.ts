import { getD1 } from "../../../../db/d1";
import { errorResponse } from "../../../../lib/auth-server";
import { nextDeliveryStatuses, type DeliveryMethod } from "../../../../lib/order-workflow";
import { requireVendorPermission } from "../../../../lib/vendor-access";
import {
  escapeSqlLike,
  parseVendorOrderQueueQuery,
  vendorOrderSortExpression,
  vendorOrderStatusPredicate,
} from "../../../../lib/vendor-order-query";

type QueueOrderRow = {
  id: number;
  orderNumber: string;
  customerName: string;
  customerPhone: string;
  subtotalPaise: number;
  taxPaise: number;
  deliveryFeePaise: number;
  totalPaise: number;
  paymentMethod: string;
  paymentStatus: string;
  deliveryMethod: DeliveryMethod;
  orderStatus: string;
  deliveryStatus: string;
  prescriptionId: number | null;
  prescriptionStatus: string;
  inventoryStatus: string;
  reservationExpiresAt: string | null;
  deliveryAddress: string;
  createdAt: string;
  updatedAt: string;
  itemCount: number;
  unitCount: number;
  itemPreview: string;
};

type QueueSummary = {
  total: number;
  actionRequired: number;
  prescriptionReview: number;
  awaitingConfirmation: number;
  inProgress: number;
  completed: number;
  cancelled: number;
};

export async function GET(request: Request) {
  try {
    const { vendorId } = await requireVendorPermission(request, "sale.write");
    const filters = parseVendorOrderQueueQuery(new URL(request.url));
    const basePredicates = ["o.vendor_id = ?", "o.order_type = 'online'"];
    const baseBindings: Array<string | number> = [vendorId];

    if (filters.query) {
      basePredicates.push(`(
        o.order_number LIKE ? ESCAPE '\\'
        OR o.customer_name LIKE ? ESCAPE '\\'
        OR o.customer_phone LIKE ? ESCAPE '\\'
        OR EXISTS (
          SELECT 1 FROM order_items search_item
          WHERE search_item.order_id = o.id AND search_item.product_name LIKE ? ESCAPE '\\'
        )
      )`);
      const pattern = `%${escapeSqlLike(filters.query)}%`;
      baseBindings.push(pattern, pattern, pattern, pattern);
    }
    if (filters.payment !== "all") {
      basePredicates.push("o.payment_status = ?");
      baseBindings.push(filters.payment);
    }
    if (filters.delivery !== "all") {
      basePredicates.push("o.delivery_method = ?");
      baseBindings.push(filters.delivery);
    }

    const baseWhere = basePredicates.join(" AND ");
    const filteredWhere = `${baseWhere} AND ${vendorOrderStatusPredicate(filters.status)}`;
    const db = getD1();
    const [countResult, orderResult, summary] = await Promise.all([
      db.prepare(`SELECT COUNT(*) AS count FROM orders o WHERE ${filteredWhere}`)
        .bind(...baseBindings).first<{ count: number }>(),
      db.prepare(`
        SELECT o.id, o.order_number AS orderNumber, o.customer_name AS customerName,
          o.customer_phone AS customerPhone, o.subtotal_paise AS subtotalPaise,
          o.tax_paise AS taxPaise, o.delivery_fee_paise AS deliveryFeePaise,
          o.total_paise AS totalPaise, o.payment_method AS paymentMethod,
          o.payment_status AS paymentStatus, o.delivery_method AS deliveryMethod,
          o.order_status AS orderStatus, o.delivery_status AS deliveryStatus,
          o.prescription_id AS prescriptionId, o.prescription_status AS prescriptionStatus,
          o.inventory_status AS inventoryStatus, o.reservation_expires_at AS reservationExpiresAt,
          o.delivery_address AS deliveryAddress, o.created_at AS createdAt, o.updated_at AS updatedAt,
          (SELECT COUNT(*) FROM order_items item WHERE item.order_id = o.id) AS itemCount,
          (SELECT COALESCE(SUM(item.quantity), 0) FROM order_items item WHERE item.order_id = o.id) AS unitCount,
          (SELECT group_concat(item.product_name || ' × ' || item.quantity, ', ')
            FROM order_items item WHERE item.order_id = o.id
          ) AS itemPreview
        FROM orders o
        WHERE ${filteredWhere}
        ORDER BY ${vendorOrderSortExpression(filters.sort)}
        LIMIT ? OFFSET ?
      `).bind(...baseBindings, filters.pageSize, (filters.page - 1) * filters.pageSize).all<QueueOrderRow>(),
      db.prepare(`
        SELECT COUNT(*) AS total,
          COALESCE(SUM(CASE WHEN ${vendorOrderStatusPredicate("action_required")} THEN 1 ELSE 0 END), 0) AS actionRequired,
          COALESCE(SUM(CASE WHEN o.prescription_status IN ('pending_review', 'clarification_required') THEN 1 ELSE 0 END), 0) AS prescriptionReview,
          COALESCE(SUM(CASE WHEN o.delivery_status = 'awaiting_confirmation' THEN 1 ELSE 0 END), 0) AS awaitingConfirmation,
          COALESCE(SUM(CASE WHEN o.order_status NOT IN ('completed', 'cancelled') THEN 1 ELSE 0 END), 0) AS inProgress,
          COALESCE(SUM(CASE WHEN o.order_status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
          COALESCE(SUM(CASE WHEN o.order_status = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled
        FROM orders o WHERE ${baseWhere}
      `).bind(...baseBindings).first<QueueSummary>(),
    ]);

    const total = Number(countResult?.count ?? 0);
    const orders = orderResult.results.map((order) => ({
      ...order,
      nextStatuses: nextDeliveryStatuses({
        role: "vendor",
        deliveryMethod: order.deliveryMethod,
        deliveryStatus: order.deliveryStatus,
        orderStatus: order.orderStatus,
        prescriptionStatus: order.prescriptionStatus,
        paymentMethod: order.paymentMethod,
        paymentStatus: order.paymentStatus,
      }),
    }));

    return Response.json({
      orders,
      summary: summary ?? {
        total: 0,
        actionRequired: 0,
        prescriptionReview: 0,
        awaitingConfirmation: 0,
        inProgress: 0,
        completed: 0,
        cancelled: 0,
      },
      pagination: {
        page: filters.page,
        pageSize: filters.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / filters.pageSize)),
      },
      filters,
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
