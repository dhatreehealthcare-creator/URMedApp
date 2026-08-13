import { getD1 } from "../../../../db/d1";
import { errorResponse } from "../../../../lib/auth-server";
import {
  applyInventoryAdjustment,
  completeInventoryCount,
  InventoryAdjustmentError,
} from "../../../../lib/inventory-adjustments";
import { requireVendorPermission } from "../../../../lib/vendor-access";

async function loadReconciliation(vendorId: number) {
  const db = getD1();
  const [summary, inventory, reasons, adjustments, counts] = await Promise.all([
    db.prepare(`SELECT
      COUNT(*) AS totalBatches,
      COALESCE(SUM(CASE WHEN last_counted_at IS NULL THEN 1 ELSE 0 END), 0) AS neverCounted,
      COALESCE(SUM(CASE WHEN datetime(last_counted_at) >= datetime('now','-30 day') THEN 1 ELSE 0 END), 0) AS countedLast30Days,
      COALESCE(SUM(CASE WHEN reserved_quantity > quantity THEN 1 ELSE 0 END), 0) AS reservationConflicts,
      COALESCE(SUM(CASE WHEN latest.balance_after IS NOT NULL AND latest.balance_after <> inventory.quantity THEN 1 ELSE 0 END), 0) AS ledgerMismatches
      FROM pharmacy_inventory inventory
      LEFT JOIN stock_ledger latest ON latest.id = (
        SELECT ledger.id FROM stock_ledger ledger WHERE ledger.vendor_id = inventory.vendor_id
          AND ledger.inventory_id = inventory.id ORDER BY ledger.id DESC LIMIT 1)
      WHERE inventory.vendor_id = ? AND inventory.active = 1`).bind(vendorId).first(),
    db.prepare(`SELECT inventory.id, product.name AS productName, inventory.batch_number AS batchNumber,
        inventory.expiry_date AS expiryDate, inventory.quantity,
        inventory.reserved_quantity AS reservedQuantity,
        inventory.quantity - inventory.reserved_quantity AS availableQuantity,
        inventory.last_counted_at AS lastCountedAt,
        (SELECT ledger.balance_after FROM stock_ledger ledger
          WHERE ledger.vendor_id = inventory.vendor_id AND ledger.inventory_id = inventory.id
          ORDER BY ledger.id DESC LIMIT 1) AS ledgerBalance
      FROM pharmacy_inventory inventory JOIN products product ON product.id = inventory.product_id
      WHERE inventory.vendor_id = ? AND inventory.active = 1
      ORDER BY CASE WHEN inventory.last_counted_at IS NULL THEN 0 ELSE 1 END,
        datetime(inventory.last_counted_at), product.name, inventory.id LIMIT 300`).bind(vendorId).all(),
    db.prepare(`SELECT code, label, direction, requires_notes AS requiresNotes
      FROM inventory_adjustment_reason_codes WHERE active = 1 AND code <> 'cycle_count_variance'
      ORDER BY sort_order, code`).all(),
    db.prepare(`SELECT adjustment.id, adjustment.adjustment_number AS adjustmentNumber,
        adjustment.source_type AS sourceType, adjustment.reason_code AS reasonCode,
        adjustment.reason_label AS reasonLabel, adjustment.quantity_before AS quantityBefore,
        adjustment.quantity_delta AS quantityDelta, adjustment.balance_after AS balanceAfter,
        adjustment.reserved_quantity_snapshot AS reservedQuantitySnapshot,
        adjustment.notes, adjustment.created_at AS createdAt,
        inventory.batch_number AS batchNumber, product.name AS productName, actor.name AS actorName
      FROM inventory_adjustments adjustment
      JOIN pharmacy_inventory inventory ON inventory.id = adjustment.inventory_id
      JOIN products product ON product.id = inventory.product_id
      JOIN account_profiles actor ON actor.id = adjustment.created_by_profile_id
      WHERE adjustment.vendor_id = ? AND inventory.vendor_id = ?
      ORDER BY adjustment.id DESC LIMIT 100`).bind(vendorId, vendorId).all(),
    db.prepare(`SELECT session.id, session.session_number AS sessionNumber,
        session.scope_label AS scopeLabel, session.notes, session.status,
        session.line_count AS lineCount, session.variance_line_count AS varianceLineCount,
        session.net_variance_quantity AS netVarianceQuantity,
        session.completed_at AS completedAt, actor.name AS actorName
      FROM inventory_count_sessions session
      JOIN account_profiles actor ON actor.id = session.completed_by_profile_id
      WHERE session.vendor_id = ? ORDER BY session.id DESC LIMIT 50`).bind(vendorId).all(),
  ]);
  return {
    summary: summary ?? { totalBatches: 0, neverCounted: 0, countedLast30Days: 0, reservationConflicts: 0, ledgerMismatches: 0 },
    inventory: inventory.results,
    reasons: reasons.results,
    adjustments: adjustments.results,
    counts: counts.results,
  };
}

export async function GET(request: Request) {
  try {
    const { vendorId, staffRole } = await requireVendorPermission(request, "inventory.read");
    return Response.json({ ...(await loadReconciliation(vendorId)), canAdjust: ["owner", "inventory_manager"].includes(staffRole) }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const { profile, vendorId } = await requireVendorPermission(request, "inventory.write");
    const body = await request.json() as Record<string, unknown>;
    const action = String(body.action ?? "");
    const common = {
      db: getD1(), vendorId, actorProfileId: profile.id,
      idempotencyKey: String(body.idempotencyKey ?? ""),
      requestId: request.headers.get("cf-ray") ?? "",
    };
    if (action === "adjust") {
      const result = await applyInventoryAdjustment({
        ...common,
        inventoryId: Number(body.inventoryId),
        expectedQuantity: Number(body.expectedQuantity),
        quantityDelta: Number(body.quantityDelta),
        reasonCode: String(body.reasonCode ?? ""),
        notes: String(body.notes ?? ""),
      });
      return Response.json({ adjusted: true, ...result, reconciliation: await loadReconciliation(vendorId) }, { status: result.duplicate ? 200 : 201 });
    }
    if (action === "count") {
      const result = await completeInventoryCount({
        ...common,
        scopeLabel: String(body.scopeLabel ?? ""),
        notes: String(body.notes ?? ""),
        lines: Array.isArray(body.lines) ? body.lines.map((line) => {
          const value = line as Record<string, unknown>;
          return {
            inventoryId: Number(value.inventoryId),
            expectedQuantity: Number(value.expectedQuantity),
            countedQuantity: Number(value.countedQuantity),
          };
        }) : [],
      });
      return Response.json({ counted: true, ...result, reconciliation: await loadReconciliation(vendorId) }, { status: result.duplicate ? 200 : 201 });
    }
    return Response.json({ error: "Inventory reconciliation action is invalid" }, { status: 400 });
  } catch (error) {
    if (error instanceof InventoryAdjustmentError) return Response.json({ error: error.message }, { status: error.status });
    return errorResponse(error);
  }
}
