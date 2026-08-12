import { releaseExpiredReservations } from "./inventory-reservations.ts";

export const RESERVATION_RECOVERY_BATCH_SIZE = 50;
export const RESERVATION_RECOVERY_MAX_BATCHES = 10;

type RecoveryTriggerSource = "scheduled" | "manual";
type RecoveryRunStatus = "running" | "completed" | "failed";

type RecoveryRunRow = {
  runKey: string;
  scheduledAt: string;
  status: RecoveryRunStatus;
  attempts: number;
  batchesProcessed: number;
  ordersReleased: number;
  reservationsReleased: number;
  remainingExpiredOrders: number;
};

export type ReservationRecoveryResult = RecoveryRunRow & {
  duplicate: boolean;
};

function boundedInteger(value: number, fallback: number, maximum: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), 1), maximum);
}

function normalizeScheduledAt(value: Date | number | string) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new RangeError("A valid recovery schedule time is required");
  return date.toISOString();
}

export function reservationRecoveryRunKey(scheduledAt: Date | number | string) {
  return `inventory-reservation-expiry:${normalizeScheduledAt(scheduledAt)}`;
}

async function loadRecoveryRun(db: D1Database, runKey: string) {
  return db.prepare(`SELECT run_key AS runKey,scheduled_at AS scheduledAt,status,attempts,
    batches_processed AS batchesProcessed,orders_released AS ordersReleased,
    reservations_released AS reservationsReleased,remaining_expired_orders AS remainingExpiredOrders
    FROM inventory_reservation_recovery_runs WHERE run_key=? LIMIT 1`)
    .bind(runKey).first<RecoveryRunRow>();
}

async function countExpiredReservationOrders(db: D1Database) {
  const row = await db.prepare(`SELECT COUNT(DISTINCT reservation.order_id) AS count
    FROM inventory_reservations reservation JOIN orders current_order ON current_order.id=reservation.order_id
    WHERE reservation.status='active' AND reservation.expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND current_order.inventory_status='reserved' AND current_order.payment_status<>'paid'`)
    .first<{ count: number }>();
  return Number(row?.count ?? 0);
}

export async function runReservationRecovery(input: {
  db: D1Database;
  scheduledAt: Date | number | string;
  runKey?: string;
  triggerSource?: RecoveryTriggerSource;
  batchSize?: number;
  maxBatches?: number;
}): Promise<ReservationRecoveryResult> {
  const scheduledAt = normalizeScheduledAt(input.scheduledAt);
  const runKey = input.runKey?.trim().slice(0, 200) || reservationRecoveryRunKey(scheduledAt);
  const triggerSource = input.triggerSource ?? "scheduled";
  const batchSize = boundedInteger(input.batchSize ?? RESERVATION_RECOVERY_BATCH_SIZE, RESERVATION_RECOVERY_BATCH_SIZE, 100);
  const maxBatches = boundedInteger(input.maxBatches ?? RESERVATION_RECOVERY_MAX_BATCHES, RESERVATION_RECOVERY_MAX_BATCHES, 20);

  const acquired = await input.db.prepare(`INSERT INTO inventory_reservation_recovery_runs
    (run_key,trigger_source,scheduled_at,status,attempts,batch_size,max_batches,started_at)
    VALUES (?,?,?,'running',1,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(run_key) DO UPDATE SET
      trigger_source=excluded.trigger_source,scheduled_at=excluded.scheduled_at,status='running',
      attempts=inventory_reservation_recovery_runs.attempts+1,batch_size=excluded.batch_size,
      max_batches=excluded.max_batches,batches_processed=0,orders_released=0,
      reservations_released=0,remaining_expired_orders=0,started_at=CURRENT_TIMESTAMP,
      completed_at=NULL,error_message=''
    WHERE inventory_reservation_recovery_runs.status='failed'`)
    .bind(runKey, triggerSource, scheduledAt, batchSize, maxBatches).run();

  if (!acquired.meta.changes) {
    const existing = await loadRecoveryRun(input.db, runKey);
    if (!existing) throw new Error("Reservation recovery run could not be acquired");
    return { ...existing, duplicate: true };
  }

  let batchesProcessed = 0;
  let ordersReleased = 0;
  let reservationsReleased = 0;
  let remainingExpiredOrders = 0;

  try {
    while (batchesProcessed < maxBatches) {
      const batch = await releaseExpiredReservations(input.db, batchSize);
      if (!batch.ordersReleased && !batch.reservationsReleased) break;
      batchesProcessed += 1;
      ordersReleased += batch.ordersReleased;
      reservationsReleased += batch.reservationsReleased;
    }
    remainingExpiredOrders = await countExpiredReservationOrders(input.db);
    await input.db.prepare(`UPDATE inventory_reservation_recovery_runs SET status='completed',
      batches_processed=?,orders_released=?,reservations_released=?,remaining_expired_orders=?,
      completed_at=CURRENT_TIMESTAMP,error_message='' WHERE run_key=? AND status='running'`)
      .bind(batchesProcessed, ordersReleased, reservationsReleased, remainingExpiredOrders, runKey).run();
  } catch (error) {
    const message = (error instanceof Error ? error.message : "Reservation recovery failed").slice(0, 1000);
    try {
      await input.db.prepare(`UPDATE inventory_reservation_recovery_runs SET status='failed',
        batches_processed=?,orders_released=?,reservations_released=?,remaining_expired_orders=?,
        completed_at=CURRENT_TIMESTAMP,error_message=? WHERE run_key=? AND status='running'`)
        .bind(batchesProcessed, ordersReleased, reservationsReleased, remainingExpiredOrders, message, runKey).run();
    } catch (recordingError) {
      console.error("Unable to record the reservation recovery failure", recordingError);
    }
    throw error;
  }

  const completed = await loadRecoveryRun(input.db, runKey);
  if (!completed) throw new Error("Completed reservation recovery run is unavailable");
  return { ...completed, duplicate: false };
}
