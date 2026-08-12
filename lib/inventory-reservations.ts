export const INVENTORY_RESERVATION_TTL_MINUTES = 15;

type ReservationStatus = "active" | "committed" | "released" | "expired";
type InventoryStatus = "reserved" | "committed" | "released";

type ReservationOrderState = {
  id: number;
  paymentMethod: string;
  paymentStatus: string;
  paymentId: string;
  orderStatus: string;
  inventoryStatus: InventoryStatus;
  reservationExpiresAt: string | null;
  itemCount: number;
  reservationCount: number;
  activeReservationCount: number;
  validActiveReservationCount: number;
};

type ActiveReservation = {
  id: number;
  inventoryId: number;
  quantity: number;
  status: ReservationStatus;
};

type ReleaseStatus = "released" | "expired";

export class InventoryReservationError extends Error {
  readonly status: number;

  constructor(message: string, status = 409) {
    super(message);
    this.name = "InventoryReservationError";
    this.status = status;
  }
}

export function reservationExpiresAt(now = new Date()): string {
  return new Date(now.valueOf() + INVENTORY_RESERVATION_TTL_MINUTES * 60_000).toISOString();
}

export function prepareOnlineOrderReservation(db: D1Database, input: {
  orderNumber: string;
  inventoryId: number;
  expiresAt: string;
}) {
  return db.prepare(`INSERT INTO inventory_reservations
    (order_id,order_item_id,vendor_id,inventory_id,quantity,status,expires_at)
    SELECT o.id,item.id,o.vendor_id,item.inventory_id,item.quantity,'active',?
    FROM orders o JOIN order_items item ON item.order_id=o.id
    WHERE o.order_number=? AND item.inventory_id=?`)
    .bind(input.expiresAt, input.orderNumber, input.inventoryId);
}

export function prepareOrderReservationReleaseStatements(db: D1Database, input: {
  orderId: number;
  status: ReleaseStatus;
  reason: string;
}) {
  const reason = input.reason.trim().slice(0, 200) || (input.status === "expired" ? "Reservation expired" : "Reservation released");
  return [
    db.prepare(`UPDATE inventory_reservations SET status=?,released_at=COALESCE(released_at,CURRENT_TIMESTAMP),
      status_reason=CASE WHEN status_reason='' THEN ? ELSE status_reason END,updated_at=CURRENT_TIMESTAMP
      WHERE order_id=? AND status='active'
        AND (?<>'expired' OR datetime(expires_at)<=datetime('now'))
        AND EXISTS (SELECT 1 FROM orders current_order WHERE current_order.id=inventory_reservations.order_id
          AND current_order.inventory_status='reserved' AND current_order.payment_status<>'paid')`)
      .bind(input.status, reason, input.orderId, input.status),
    db.prepare(`UPDATE orders SET inventory_status='released',updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND inventory_status='reserved' AND payment_status<>'paid'
        AND NOT EXISTS (SELECT 1 FROM inventory_reservations reservation
          WHERE reservation.order_id=orders.id AND reservation.status='active')`)
      .bind(input.orderId),
  ];
}

export async function releaseOrderReservations(input: {
  db: D1Database;
  orderId: number;
  status?: ReleaseStatus;
  reason: string;
}) {
  const statements = prepareOrderReservationReleaseStatements(input.db, {
    orderId: input.orderId,
    status: input.status ?? "released",
    reason: input.reason,
  });
  const results = await input.db.batch(statements);
  return {
    releasedReservations: Number(results[0]?.meta.changes ?? 0),
    orderReleased: Boolean(results[1]?.meta.changes),
  };
}

export async function releaseExpiredReservations(db: D1Database, limit = 100) {
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
  const expired = await db.prepare(`SELECT DISTINCT reservation.order_id AS orderId
    FROM inventory_reservations reservation JOIN orders current_order ON current_order.id=reservation.order_id
    WHERE reservation.status='active' AND reservation.expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND current_order.inventory_status='reserved' AND current_order.payment_status<>'paid'
    ORDER BY reservation.order_id LIMIT ?`).bind(safeLimit).all<{orderId:number}>();
  if (!expired.results.length) return { ordersReleased: 0, reservationsReleased: 0 };

  const orderIds = expired.results.map(({ orderId }) => orderId);
  const placeholders = orderIds.map(() => "?").join(",");
  const results = await db.batch([
    db.prepare(`UPDATE inventory_reservations SET status='expired',released_at=COALESCE(released_at,CURRENT_TIMESTAMP),
      status_reason=CASE WHEN status_reason='' THEN 'Reservation expired before payment' ELSE status_reason END,
      updated_at=CURRENT_TIMESTAMP WHERE order_id IN (${placeholders}) AND status='active'
        AND expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        AND EXISTS (SELECT 1 FROM orders current_order WHERE current_order.id=inventory_reservations.order_id
          AND current_order.inventory_status='reserved' AND current_order.payment_status<>'paid')`).bind(...orderIds),
    db.prepare(`UPDATE orders SET inventory_status='released',updated_at=CURRENT_TIMESTAMP
      WHERE id IN (${placeholders}) AND inventory_status='reserved' AND payment_status<>'paid'
        AND NOT EXISTS (SELECT 1 FROM inventory_reservations reservation
          WHERE reservation.order_id=orders.id AND reservation.status='active')`).bind(...orderIds),
  ]);
  return {
    ordersReleased: Number(results[1]?.meta.changes ?? 0),
    reservationsReleased: Number(results[0]?.meta.changes ?? 0),
  };
}

async function loadReservationOrder(db: D1Database, orderId: number) {
  return db.prepare(`SELECT o.id,o.payment_method AS paymentMethod,o.payment_status AS paymentStatus,
    o.razorpay_payment_id AS paymentId,o.order_status AS orderStatus,
    o.inventory_status AS inventoryStatus,o.reservation_expires_at AS reservationExpiresAt,
    (SELECT COUNT(*) FROM order_items item WHERE item.order_id=o.id) AS itemCount,
    (SELECT COUNT(*) FROM inventory_reservations reservation WHERE reservation.order_id=o.id) AS reservationCount,
    (SELECT COUNT(*) FROM inventory_reservations reservation WHERE reservation.order_id=o.id AND reservation.status='active') AS activeReservationCount,
    (SELECT COUNT(*) FROM inventory_reservations reservation WHERE reservation.order_id=o.id AND reservation.status='active'
      AND datetime(reservation.expires_at)>datetime('now')) AS validActiveReservationCount
    FROM orders o WHERE o.id=? LIMIT 1`).bind(orderId).first<ReservationOrderState>();
}

export async function ensureOnlineReservationPayable(db: D1Database, orderId: number) {
  const order = await loadReservationOrder(db, orderId);
  if (!order) throw new InventoryReservationError("Order not found", 404);
  if (order.paymentMethod !== "online") throw new InventoryReservationError("This is a cash-on-delivery order");
  if (order.orderStatus === "cancelled" || order.inventoryStatus === "released") {
    throw new InventoryReservationError("A cancelled or released order cannot be paid");
  }
  if (order.paymentStatus === "paid") return order;

  // Existing orders were already physically committed before reservation support was introduced.
  if (order.inventoryStatus === "committed" && order.reservationCount === 0) return order;
  if (order.inventoryStatus !== "reserved" || order.itemCount < 1 || order.reservationCount !== order.itemCount) {
    throw new InventoryReservationError("The order does not have a complete stock reservation");
  }
  if (order.activeReservationCount !== order.itemCount || order.validActiveReservationCount !== order.itemCount) {
    await releaseOrderReservations({ db, orderId, status: "expired", reason: "Reservation expired before payment" });
    throw new InventoryReservationError("The stock reservation has expired. Refresh the cart and place a new order.");
  }
  return order;
}

export async function captureOnlineOrderPayment(input: {
  db: D1Database;
  orderId: number;
  paymentId: string;
  actorProfileId?: number | null;
  note: string;
}) {
  const { db, orderId, paymentId, actorProfileId = null } = input;
  const order = await ensureOnlineReservationPayable(db, orderId);
  if (order.paymentStatus === "paid") {
    if (order.paymentId && order.paymentId !== paymentId) {
      throw new InventoryReservationError("A different payment is already recorded for this order");
    }
    return { committed: false, duplicate: true };
  }

  const reservations = order.inventoryStatus === "reserved"
    ? (await db.prepare(`SELECT id,inventory_id AS inventoryId,quantity,status FROM inventory_reservations
        WHERE order_id=? AND status='active' ORDER BY id`).bind(orderId).all<ActiveReservation>()).results
    : [];
  const reason = input.note.trim().slice(0, 200) || "Online payment confirmed";
  const statements: D1PreparedStatement[] = [];
  for (const reservation of reservations) {
    statements.push(
      db.prepare(`UPDATE inventory_reservations SET status='committed',committed_at=CURRENT_TIMESTAMP,
        committed_by_profile_id=?,status_reason=?,updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND status='active' AND datetime(expires_at)>datetime('now')`)
        .bind(actorProfileId, reason, reservation.id),
      db.prepare(`INSERT INTO stock_ledger (vendor_id,inventory_id,movement_type,quantity_delta,balance_after,
        reference_type,reference_id,reason,actor_profile_id)
        SELECT reservation.vendor_id,reservation.inventory_id,'online_sale',-reservation.quantity,inventory.quantity,
          'order',reservation.order_id,?,?
        FROM inventory_reservations reservation JOIN pharmacy_inventory inventory ON inventory.id=reservation.inventory_id
        WHERE reservation.id=? AND reservation.status='committed'
          AND NOT EXISTS (SELECT 1 FROM stock_ledger existing WHERE existing.movement_type='online_sale'
            AND existing.reference_type='order' AND existing.reference_id=reservation.order_id
            AND existing.inventory_id=reservation.inventory_id)`)
        .bind(reason, actorProfileId, reservation.id),
    );
  }

  const orderUpdateIndex = statements.length;
  statements.push(
    db.prepare(`UPDATE orders SET payment_status='paid',inventory_status='committed',
      order_status=CASE WHEN order_status='awaiting_payment' THEN 'placed' ELSE order_status END,
      delivery_status=CASE WHEN order_status='awaiting_payment' THEN 'awaiting_confirmation' ELSE delivery_status END,
      razorpay_payment_id=?,updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND payment_status<>'paid' AND order_status<>'cancelled'`)
      .bind(paymentId, orderId),
    db.prepare(`INSERT INTO delivery_events (order_id,status,actor_profile_id,note)
      SELECT ?,'payment_confirmed',?,? WHERE NOT EXISTS
        (SELECT 1 FROM delivery_events WHERE order_id=? AND status='payment_confirmed')`)
      .bind(orderId, actorProfileId, reason, orderId),
  );

  try {
    const results = await db.batch(statements);
    if (!results[orderUpdateIndex]?.meta.changes) {
      const current = await loadReservationOrder(db, orderId);
      if (current?.paymentStatus === "paid" && (!current.paymentId || current.paymentId === paymentId)) {
        return { committed: false, duplicate: true };
      }
      throw new InventoryReservationError("Payment could not commit the stock reservation. Refresh and retry.");
    }
  } catch (error) {
    if (error instanceof InventoryReservationError) throw error;
    if (/reservation_(expired|stock_unavailable|commit_incomplete|invalid_transition)/i.test(error instanceof Error ? error.message : "")) {
      throw new InventoryReservationError("The stock reservation expired or changed before payment confirmation.");
    }
    throw error;
  }
  return { committed: reservations.length > 0, duplicate: false };
}
