import { prepareAuditEventStatement } from "./audit.ts";
import { VENDOR_ALERT_REFERENCE_TYPES } from "./vendor-inventory-alerts.ts";

export type VendorNotificationStatus = "unread" | "read" | "acknowledged" | "snoozed" | "resolved";
export type VendorNotificationAction = "read" | "acknowledge" | "snooze" | "resolve";

type NotificationRow = {
  id: number;
  notificationType: string;
  severity: string;
  title: string;
  message: string;
  referenceType: string;
  referenceId: number | null;
  lifecycleStatus: VendorNotificationStatus;
  readAt: string | null;
  acknowledgedAt: string | null;
  snoozedUntil: string | null;
  resolvedAt: string | null;
  resolutionReason: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  referenceValid: number;
};

export type VendorNotification = Omit<NotificationRow, "referenceValid"> & {
  action: null | {
    kind: "inventory_batch" | "reorder_product";
    label: string;
    targetSection: "reports" | "purchase";
    referenceId: number;
  };
};

export class VendorNotificationError extends Error {
  readonly status: number;

  constructor(message: string, status = 409) {
    super(message);
    this.name = "VendorNotificationError";
    this.status = status;
  }
}

const allowedTransitions: Record<Exclude<VendorNotificationStatus, "resolved">, VendorNotificationStatus[]> = {
  unread: ["read", "acknowledged", "snoozed", "resolved"],
  read: ["acknowledged", "snoozed", "resolved"],
  acknowledged: ["snoozed", "resolved"],
  snoozed: ["snoozed", "acknowledged", "resolved"],
};

function actionMetadata(row: NotificationRow): VendorNotification["action"] {
  if (!row.referenceValid || !row.referenceId) return null;
  if (row.referenceType === VENDOR_ALERT_REFERENCE_TYPES.nearExpiryBatch) {
    return { kind: "inventory_batch", label: "Open batch report", targetSection: "reports", referenceId: row.referenceId };
  }
  if (row.referenceType === VENDOR_ALERT_REFERENCE_TYPES.reorderProduct) {
    return { kind: "reorder_product", label: "Create purchase order", targetSection: "purchase", referenceId: row.referenceId };
  }
  return null;
}

function publicNotification(row: NotificationRow): VendorNotification {
  return {
    id: row.id,
    notificationType: row.notificationType,
    severity: row.severity,
    title: row.title,
    message: row.message,
    referenceType: row.referenceType,
    referenceId: row.referenceId,
    lifecycleStatus: row.lifecycleStatus,
    readAt: row.readAt,
    acknowledgedAt: row.acknowledgedAt,
    snoozedUntil: row.snoozedUntil,
    resolvedAt: row.resolvedAt,
    resolutionReason: row.resolutionReason,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    action: actionMetadata(row),
  };
}

const inventoryNotificationPredicate = `notification.profile_id IS NULL
  AND notification.notification_type IN ('inventory_near_expiry','inventory_low_stock','inventory_zero_stock')`;

const selectNotification = `SELECT notification.id,notification.notification_type AS notificationType,
  notification.severity,notification.title,notification.message,
  notification.reference_type AS referenceType,notification.reference_id AS referenceId,
  notification.lifecycle_status AS lifecycleStatus,notification.read_at AS readAt,
  notification.acknowledged_at AS acknowledgedAt,notification.snoozed_until AS snoozedUntil,
  notification.resolved_at AS resolvedAt,notification.resolution_reason AS resolutionReason,
  notification.lifecycle_version AS version,notification.created_at AS createdAt,
  notification.updated_at AS updatedAt,
  CASE
    WHEN notification.reference_type='${VENDOR_ALERT_REFERENCE_TYPES.nearExpiryBatch}' THEN EXISTS(
      SELECT 1 FROM pharmacy_inventory inventory
      WHERE inventory.id=notification.reference_id AND inventory.vendor_id=notification.vendor_id)
    WHEN notification.reference_type='${VENDOR_ALERT_REFERENCE_TYPES.reorderProduct}' THEN EXISTS(
      SELECT 1 FROM pharmacy_inventory inventory JOIN products product ON product.id=inventory.product_id
      WHERE inventory.vendor_id=notification.vendor_id AND inventory.product_id=notification.reference_id AND product.active=1)
    ELSE 0 END AS referenceValid
  FROM notifications notification`;

async function notificationForVendor(db: D1Database, vendorId: number, id: number) {
  const row = await db.prepare(`${selectNotification}
    WHERE notification.id=? AND notification.vendor_id=? AND ${inventoryNotificationPredicate} LIMIT 1`)
    .bind(id, vendorId).first<NotificationRow>();
  if (!row) throw new VendorNotificationError("Notification not found", 404);
  return row;
}

export async function listVendorNotifications(
  db: D1Database,
  vendorId: number,
  options: { includeResolved?: boolean; limit?: number; now?: string } = {},
) {
  const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 50)));
  const now = options.now ?? new Date().toISOString();
  const statusClause = options.includeResolved ? "" : "AND notification.lifecycle_status<>'resolved'";
  const [rows, counts] = await db.batch([
    db.prepare(`${selectNotification}
      WHERE notification.vendor_id=? AND ${inventoryNotificationPredicate} ${statusClause}
      ORDER BY CASE
        WHEN notification.lifecycle_status='snoozed' AND notification.snoozed_until>? THEN 2
        WHEN notification.lifecycle_status='resolved' THEN 3 ELSE 1 END,
        CASE notification.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
        notification.created_at DESC,notification.id DESC LIMIT ?`).bind(vendorId, now, limit),
    db.prepare(`SELECT
      SUM(CASE WHEN lifecycle_status='unread' THEN 1 ELSE 0 END) AS unreadCount,
      SUM(CASE WHEN lifecycle_status<>'resolved' THEN 1 ELSE 0 END) AS activeCount,
      SUM(CASE WHEN lifecycle_status='snoozed' AND snoozed_until>? THEN 1 ELSE 0 END) AS snoozedCount
      FROM notifications notification WHERE notification.vendor_id=? AND ${inventoryNotificationPredicate}`)
      .bind(now, vendorId),
  ]);
  const summary = (counts.results?.[0] ?? {}) as Record<string, unknown>;
  return {
    notifications: ((rows.results ?? []) as unknown as NotificationRow[]).map(publicNotification),
    summary: {
      unreadCount: Number(summary.unreadCount ?? 0),
      activeCount: Number(summary.activeCount ?? 0),
      snoozedCount: Number(summary.snoozedCount ?? 0),
    },
  };
}

function validTimestamp(value: string, label: string) {
  const parsed = new Date(value);
  if (!value || !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new VendorNotificationError(`${label} is invalid`, 400);
  }
  return value;
}

export async function transitionVendorNotification(input: {
  db: D1Database;
  vendorId: number;
  actorProfileId: number;
  notificationId: number;
  expectedVersion: number;
  action: VendorNotificationAction;
  snoozedUntil?: string;
  reason?: string;
  requestId?: string;
  now?: string;
}) {
  const { db, vendorId, actorProfileId, notificationId, expectedVersion, action } = input;
  if (!Number.isInteger(notificationId) || notificationId < 1 || !Number.isInteger(expectedVersion) || expectedVersion < 0) {
    throw new VendorNotificationError("Notification and version are required", 400);
  }
  const current = await notificationForVendor(db, vendorId, notificationId);
  const now = validTimestamp(input.now ?? new Date().toISOString(), "Transition time");
  let nextStatus: VendorNotificationStatus;
  let snoozedUntil: string | null = null;
  let reason = "";
  if (action === "read") nextStatus = "read";
  else if (action === "acknowledge") nextStatus = "acknowledged";
  else if (action === "snooze") {
    nextStatus = "snoozed";
    snoozedUntil = validTimestamp(input.snoozedUntil ?? "", "Snooze time");
    const duration = new Date(snoozedUntil).getTime() - new Date(now).getTime();
    if (duration <= 0 || duration > 30 * 24 * 60 * 60 * 1000) {
      throw new VendorNotificationError("Snooze time must be within the next 30 days", 400);
    }
  } else if (action === "resolve") {
    nextStatus = "resolved";
    reason = String(input.reason ?? "").trim().slice(0, 300);
    if (reason.length < 5) throw new VendorNotificationError("Enter a clear resolution reason", 400);
  } else {
    throw new VendorNotificationError("Notification action is invalid", 400);
  }

  const alreadyApplied = current.version >= expectedVersion
    && current.lifecycleStatus === nextStatus
    && (nextStatus !== "snoozed" || current.snoozedUntil === snoozedUntil)
    && (nextStatus !== "resolved" || current.resolutionReason === reason);
  if (alreadyApplied) return { updated: false as const, unchanged: true as const, notification: publicNotification(current) };
  if (current.lifecycleStatus === "resolved") throw new VendorNotificationError("A resolved notification cannot be changed");
  if (current.version !== expectedVersion) throw new VendorNotificationError("Notification changed. Refresh before retrying");
  if (!allowedTransitions[current.lifecycleStatus].includes(nextStatus)) {
    throw new VendorNotificationError(`A ${current.lifecycleStatus} notification cannot return to ${nextStatus}`);
  }

  const update = db.prepare(`UPDATE notifications SET
      lifecycle_status=?,read_at=COALESCE(read_at,?),
      acknowledged_at=CASE WHEN ?='acknowledged' THEN ? ELSE acknowledged_at END,
      snoozed_until=CASE WHEN ?='snoozed' THEN ? ELSE NULL END,
      resolved_at=CASE WHEN ?='resolved' THEN ? ELSE NULL END,
      resolution_reason=CASE WHEN ?='resolved' THEN ? ELSE '' END,
      lifecycle_version=lifecycle_version+1,updated_at=?
    WHERE id=? AND vendor_id=? AND lifecycle_status=? AND lifecycle_version=?
      AND profile_id IS NULL
      AND notification_type IN ('inventory_near_expiry','inventory_low_stock','inventory_zero_stock')`)
    .bind(nextStatus, now, nextStatus, now, nextStatus, snoozedUntil,
      nextStatus, now, nextStatus, reason, now, notificationId, vendorId,
      current.lifecycleStatus, current.version);
  const audit = await prepareAuditEventStatement({
    vendorId,
    actorProfileId,
    action: `notification.${action}`,
    entityType: "notification",
    entityId: notificationId,
    before: { status: current.lifecycleStatus, version: current.version, snoozedUntil: current.snoozedUntil },
    after: { status: nextStatus, version: current.version + 1, snoozedUntil, reason },
    reason,
    requestId: input.requestId ?? "",
  }, db, { whenPreviousStatementChanged: true });
  const results = await db.batch([update, audit]);
  if (Number(results[0]?.meta.changes ?? 0) !== 1 || Number(results[1]?.meta.changes ?? 0) !== 1) {
    const latest = await notificationForVendor(db, vendorId, notificationId);
    const racedToSameState = latest.lifecycleStatus === nextStatus
      && (nextStatus !== "snoozed" || latest.snoozedUntil === snoozedUntil)
      && (nextStatus !== "resolved" || latest.resolutionReason === reason);
    if (racedToSameState) return { updated: false as const, unchanged: true as const, notification: publicNotification(latest) };
    throw new VendorNotificationError("Notification changed. Refresh before retrying");
  }
  return { updated: true as const, notification: publicNotification(await notificationForVendor(db, vendorId, notificationId)) };
}
