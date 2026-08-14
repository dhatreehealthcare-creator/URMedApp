import { getD1 } from "../../../../db/d1";
import { appendAuditEvent } from "../../../../lib/audit";
import { errorResponse, requireLocalProfile } from "../../../../lib/auth-server";
import { requireVendorPermission } from "../../../../lib/vendor-access";
import { releaseExpiredReservations } from "../../../../lib/inventory-reservations";
import { completeSupplierReturn, listReturnablePurchases, PurchaseLifecycleError } from "../../../../lib/supplier-returns";
import { completeSalesReturn, SalesReturnError } from "../../../../lib/sales-returns";
import { effectivePriceFallbackSql } from "../../../../lib/effective-pricing";

const privateResponseHeaders = { "Cache-Control": "private, no-store" };

export async function GET(request: Request) {
  try {
    const { profile } = await requireLocalProfile(request, ["vendor"]);
    const vendorId = profile.vendorId!; const db = getD1();
    await requireVendorPermission(request, "inventory.read");
    const [summary, alerts, sales, inventory, returns, supplierReturns, returnablePurchases, temperatures] = await Promise.all([
      db.prepare(`SELECT
        (SELECT COUNT(*) FROM pharmacy_inventory WHERE vendor_id = ? AND active = 1 AND quantity <= reorder_level) AS lowStock,
        (SELECT COUNT(*) FROM pharmacy_inventory WHERE vendor_id = ? AND active = 1 AND date(expiry_date) BETWEEN date('now') AND date('now','+90 day')) AS nearExpiry,
        (SELECT COUNT(*) FROM pharmacy_inventory WHERE vendor_id = ? AND quarantine_status <> 'available') AS quarantined,
        (SELECT COALESCE(SUM(total_paise),0) FROM orders WHERE vendor_id = ? AND order_status = 'completed') AS onlineSalesPaise,
        (SELECT COALESCE(SUM(total_paise),0) FROM offline_sales WHERE vendor_id = ?) AS offlineSalesPaise`).bind(vendorId, vendorId, vendorId, vendorId, vendorId).first(),
      db.prepare(`SELECT i.id, p.name AS productName, i.batch_number AS batchNumber, i.expiry_date AS expiryDate,
        i.quantity, i.reorder_level AS reorderLevel, i.quarantine_status AS quarantineStatus,
        CASE WHEN date(i.expiry_date) < date('now') THEN 'expired' WHEN date(i.expiry_date) <= date('now','+90 day') THEN 'near_expiry'
          WHEN i.quantity = 0 THEN 'zero_stock' WHEN i.quantity <= i.reorder_level THEN 'low_stock' ELSE 'ok' END AS alertType
        FROM pharmacy_inventory i JOIN products p ON p.id = i.product_id
        WHERE i.vendor_id = ? AND i.active = 1 AND (i.quantity <= i.reorder_level OR date(i.expiry_date) <= date('now','+90 day') OR i.quarantine_status <> 'available')
        ORDER BY date(i.expiry_date), i.quantity LIMIT 100`).bind(vendorId).all(),
      db.prepare(`SELECT date(created_at) AS saleDate, 'online' AS channel, COUNT(*) AS transactions, SUM(total_paise) AS totalPaise
        FROM orders WHERE vendor_id = ? GROUP BY date(created_at)
        UNION ALL SELECT date(created_at), 'offline', COUNT(*), SUM(total_paise) FROM offline_sales WHERE vendor_id = ? GROUP BY date(created_at)
        ORDER BY saleDate DESC LIMIT 60`).bind(vendorId, vendorId).all(),
      db.prepare(`SELECT i.id, p.name AS productName, i.batch_number AS batchNumber, i.expiry_date AS expiryDate,
        i.quantity, ${effectivePriceFallbackSql("i", "sale_price_paise")} AS salePricePaise, i.storage_location AS storageLocation,
        p.cold_chain_required AS coldChainRequired, i.quarantine_status AS quarantineStatus
        FROM pharmacy_inventory i JOIN products p ON p.id=i.product_id WHERE i.vendor_id=? ORDER BY p.name, date(i.expiry_date) LIMIT 250`).bind(vendorId).all(),
      db.prepare(`SELECT return_number AS returnNumber, credit_note_number AS creditNoteNumber, source_type AS sourceType,
        source_id AS sourceId, reason, refund_paise AS refundPaise, status, created_at AS createdAt
        FROM sales_returns WHERE vendor_id=? ORDER BY id DESC LIMIT 50`).bind(vendorId).all(),
      db.prepare(`SELECT r.return_number AS returnNumber,r.debit_note_number AS debitNoteNumber,r.reason,
        r.total_paise AS totalPaise,r.status,r.created_at AS createdAt,s.business_name AS supplierName,
        po.purchase_number AS purchaseNumber FROM supplier_returns r JOIN suppliers s ON s.id=r.supplier_id
        JOIN purchase_orders po ON po.id=r.purchase_order_id WHERE r.vendor_id=? ORDER BY r.id DESC LIMIT 50`).bind(vendorId).all(),
      listReturnablePurchases(db, vendorId),
      db.prepare(`SELECT t.id, t.storage_location AS storageLocation, t.temperature_celsius_x10 AS temperatureCelsiusX10,
        t.within_range AS withinRange, t.excursion_action AS excursionAction, t.recorded_at AS recordedAt,
        p.name AS productName, i.batch_number AS batchNumber FROM temperature_logs t
        LEFT JOIN pharmacy_inventory i ON i.id=t.inventory_id LEFT JOIN products p ON p.id=i.product_id
        WHERE t.vendor_id=? ORDER BY t.id DESC LIMIT 50`).bind(vendorId).all(),
    ]);
    return Response.json({ summary, alerts: alerts.results, sales: sales.results, inventory: inventory.results,
      returns: returns.results, supplierReturns: supplierReturns.results, returnablePurchases,
      temperatures: temperatures.results }, { headers: privateResponseHeaders });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const { profile } = await requireLocalProfile(request, ["vendor"]); const vendorId = profile.vendorId!;
    const body = await request.json() as Record<string, unknown>; const action = String(body.action ?? ""); const db = getD1();
    await releaseExpiredReservations(db);
    await requireVendorPermission(request, action === "supplier_return" ? "purchase.write" : action === "return" ? "sale.write" : "inventory.write");
    if (action === "temperature") {
      const inventoryId = Number(body.inventoryId); const temperature = Number(body.temperatureCelsius);
      const storageLocation = String(body.storageLocation ?? "").trim().slice(0, 120);
      if (!Number.isInteger(inventoryId) || !Number.isFinite(temperature) || temperature < -50 || temperature > 80 || !storageLocation) return Response.json({ error: "Inventory, storage location and a valid temperature are required" }, { status: 400 });
      const item = await db.prepare(`SELECT i.id, p.cold_chain_required AS coldChainRequired FROM pharmacy_inventory i JOIN products p ON p.id=i.product_id WHERE i.id=? AND i.vendor_id=?`).bind(inventoryId, vendorId).first<{id:number;coldChainRequired:number}>();
      if (!item) return Response.json({ error: "Inventory batch not found" }, { status: 404 });
      const withinRange = !item.coldChainRequired || (temperature >= 2 && temperature <= 8);
      const actionText = withinRange ? "No excursion" : "Batch automatically quarantined; pharmacist assessment required";
      await db.batch([
        db.prepare(`INSERT INTO temperature_logs (vendor_id,storage_location,inventory_id,temperature_celsius_x10,within_range,excursion_action,recorded_by_profile_id) VALUES (?,?,?,?,?,?,?)`).bind(vendorId, storageLocation, inventoryId, Math.round(temperature*10), withinRange ? 1 : 0, actionText, profile.id),
        db.prepare(`UPDATE pharmacy_inventory SET quarantine_status=CASE WHEN ? THEN quarantine_status ELSE 'temperature_excursion' END, cold_chain_status=CASE WHEN ? THEN 'within_range' ELSE 'excursion' END, updated_at=CURRENT_TIMESTAMP WHERE id=? AND vendor_id=?`).bind(withinRange ? 1 : 0, withinRange ? 1 : 0, inventoryId, vendorId),
      ]);
      await appendAuditEvent({ vendorId, actorProfileId: profile.id, action: "cold_chain.recorded", entityType: "inventory", entityId: inventoryId, after: { temperature, withinRange, actionText }, requestId: request.headers.get("cf-ray") ?? "" });
      return Response.json({ recorded: true, withinRange, action: actionText }, { headers: privateResponseHeaders });
    }
    if (action === "return") {
      try {
        const result = await completeSalesReturn({
          db, vendorId, actorProfileId: profile.id,
          sourceType: String(body.sourceType ?? "online") as "online" | "offline",
          sourceId: Number(body.sourceId), inventoryId: Number(body.inventoryId), quantity: Number(body.quantity),
          condition: String(body.condition ?? "sealed") as "sealed" | "damaged" | "expired",
          reason: String(body.reason ?? ""), idempotencyKey: String(body.idempotencyKey ?? ""),
          refundMethod: String(body.refundMethod ?? "credit") as "credit" | "cash" | "upi" | "card" | "razorpay",
          refundReference: String(body.refundReference ?? ""), requestId: request.headers.get("cf-ray") ?? "",
        });
        return Response.json(result, { status: result.duplicate ? 200 : 201, headers: privateResponseHeaders });
      } catch (error) {
        if (error instanceof SalesReturnError) return Response.json({ error: error.message }, { status: error.status, headers: privateResponseHeaders });
        throw error;
      }
    }
    if (action === "supplier_return") {
      try {
        const result = await completeSupplierReturn({
          db,
          vendorId,
          actorProfileId: profile.id,
          purchaseOrderItemId: Number(body.purchaseOrderItemId),
          quantity: Number(body.quantity),
          reason: String(body.reason ?? ""),
          requestId: request.headers.get("cf-ray") ?? "",
        });
        return Response.json(result, { status: 201, headers: privateResponseHeaders });
      } catch (error) {
        if (error instanceof PurchaseLifecycleError) return Response.json({ error: error.message }, { status: error.status });
        throw error;
      }
    }
    return Response.json({ error: "Vendor operation is invalid" }, { status: 400 });
  } catch (error) { return errorResponse(error); }
}
