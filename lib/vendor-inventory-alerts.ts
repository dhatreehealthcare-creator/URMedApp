import { currentOperationalVendorPredicate } from "./operational-vendor.ts";

export const VENDOR_ALERT_PROCESSING_LIMIT = 500;
// One notification represents one continuing condition. Read, acknowledged and
// snoozed records remain active and dedupe generator retries. Resolution closes
// that occurrence; if the condition still exists at a later scheduled
// evaluation, exactly one new active occurrence may be created.
export const VENDOR_ALERT_RENOTIFICATION_POLICY = "after_resolution_if_condition_persists" as const;
export const VENDOR_ALERT_REFERENCE_TYPES = {
  nearExpiryBatch: "inventory_batch",
  reorderProduct: "inventory_reorder_product",
} as const;

export type VendorInventoryAlertResult = {
  processingDate: string;
  generated: {
    nearExpiry: number;
    stock: number;
    total: number;
  };
};

export type GenerateVendorInventoryAlertsInput = {
  db: D1Database;
  processingDate: string;
  limit?: number;
};

function normalizedProcessingDate(value: string) {
  const normalized = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) throw new Error("Vendor alert processing date must use YYYY-MM-DD");
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) {
    throw new Error("Vendor alert processing date is invalid");
  }
  return normalized;
}

function boundedLimit(value: number | undefined) {
  return Math.min(VENDOR_ALERT_PROCESSING_LIMIT, Math.max(1, Math.trunc(value ?? 100)));
}

export async function generateVendorInventoryAlerts(
  input: GenerateVendorInventoryAlertsInput,
): Promise<VendorInventoryAlertResult> {
  const processingDate = normalizedProcessingDate(input.processingDate);
  const createdAt = `${processingDate}T00:00:00.000Z`;
  const limit = boundedLimit(input.limit);
  const operationalVendor = currentOperationalVendorPredicate("vendor", processingDate);

  const results = await input.db.batch([
    input.db.prepare(`INSERT OR IGNORE INTO notifications
      (profile_id,vendor_id,notification_type,severity,title,message,reference_type,reference_id,created_at)
      SELECT NULL,candidate.vendor_id,'inventory_near_expiry','warning','Batch expires within 90 days',
        candidate.product_name||' batch '||candidate.batch_number||' expires on '||candidate.expiry_date||
          '. Review sell-through, transfer, or supplier return options.',
        '${VENDOR_ALERT_REFERENCE_TYPES.nearExpiryBatch}',candidate.inventory_id,?
      FROM (
        SELECT inventory.id AS inventory_id,inventory.vendor_id,product.name AS product_name,
          inventory.batch_number,inventory.expiry_date
        FROM pharmacy_inventory inventory
        JOIN products product ON product.id=inventory.product_id
        JOIN vendors vendor ON vendor.id=inventory.vendor_id
        WHERE inventory.active=1 AND product.active=1 AND ${operationalVendor}
          AND inventory.expiry_date IS NOT NULL
          AND date(inventory.expiry_date)>=date(?)
          AND date(inventory.expiry_date)<=date(?,'+90 day')
          AND NOT EXISTS (
            SELECT 1 FROM notifications existing
            WHERE existing.vendor_id=inventory.vendor_id
              AND existing.notification_type='inventory_near_expiry'
              AND existing.reference_type='${VENDOR_ALERT_REFERENCE_TYPES.nearExpiryBatch}'
              AND existing.reference_id=inventory.id
              AND existing.lifecycle_status<>'resolved'
          )
        ORDER BY date(inventory.expiry_date),inventory.vendor_id,inventory.id
        LIMIT ?
      ) candidate`)
      .bind(createdAt, processingDate, processingDate, limit),
    input.db.prepare(`INSERT OR IGNORE INTO notifications
      (profile_id,vendor_id,notification_type,severity,title,message,reference_type,reference_id,created_at)
      SELECT NULL,candidate.vendor_id,
        CASE WHEN candidate.available_quantity=0 THEN 'inventory_zero_stock' ELSE 'inventory_low_stock' END,
        CASE WHEN candidate.available_quantity=0 THEN 'critical' ELSE 'warning' END,
        CASE WHEN candidate.available_quantity=0 THEN 'Product is out of available stock' ELSE 'Product stock is below reorder level' END,
        candidate.product_name||' has '||candidate.available_quantity||
          ' available unit(s) across eligible batches. Reorder level: '||candidate.reorder_level||
          '. Open purchasing to create a purchase order.',
        '${VENDOR_ALERT_REFERENCE_TYPES.reorderProduct}',candidate.product_id,?
      FROM (
        SELECT inventory.vendor_id,inventory.product_id,product.name AS product_name,
          SUM(CASE
            WHEN inventory.active=1
              AND inventory.quarantine_status='available'
              AND inventory.cold_chain_status IN ('not_applicable','within_range')
              AND inventory.expiry_date IS NOT NULL
              AND date(inventory.expiry_date)>=date(?)
            THEN CASE WHEN inventory.quantity>inventory.reserved_quantity
              THEN inventory.quantity-inventory.reserved_quantity ELSE 0 END
            ELSE 0 END) AS available_quantity,
          MAX(CASE WHEN inventory.active=1 AND inventory.reorder_level>0
            THEN inventory.reorder_level ELSE 0 END) AS reorder_level
        FROM pharmacy_inventory inventory
        JOIN products product ON product.id=inventory.product_id
        JOIN vendors vendor ON vendor.id=inventory.vendor_id
        WHERE product.active=1 AND ${operationalVendor}
        GROUP BY inventory.vendor_id,inventory.product_id,product.name
        HAVING available_quantity<=reorder_level
          AND NOT EXISTS (
            SELECT 1 FROM notifications existing
            WHERE existing.vendor_id=inventory.vendor_id
              AND existing.notification_type IN ('inventory_zero_stock','inventory_low_stock')
              AND existing.reference_type='${VENDOR_ALERT_REFERENCE_TYPES.reorderProduct}'
              AND existing.reference_id=inventory.product_id
              AND existing.lifecycle_status<>'resolved'
          )
        ORDER BY CASE WHEN available_quantity=0 THEN 0 ELSE 1 END,
          available_quantity,inventory.vendor_id,inventory.product_id
        LIMIT ?
      ) candidate`)
      .bind(createdAt, processingDate, limit),
  ]);

  const nearExpiry = Number(results[0]?.meta.changes ?? 0);
  const stock = Number(results[1]?.meta.changes ?? 0);
  return {
    processingDate,
    generated: { nearExpiry, stock, total: nearExpiry + stock },
  };
}
