import { getD1 } from "../../../db/d1";
import { appendAuditEvent } from "../../../lib/audit";
import { errorResponse, requireLocalProfile } from "../../../lib/auth-server";
import { asPositiveInteger, orderNumber } from "../../../lib/money";
import { allocateFefo, calculateGst } from "../../../lib/order-controls";
import { nextDeliveryStatuses, type DeliveryMethod, type WorkflowRole } from "../../../lib/order-workflow";
import { prepareTransactionalEmailEnqueueStatement } from "../../../lib/transactional-email-outbox";
import { haversineKm, isValidGeoPoint } from "../../../lib/geo";
import { prepareOnlineOrderReservation, releaseExpiredReservations, reservationExpiresAt } from "../../../lib/inventory-reservations";
import { normalizeIndianMobile } from "../../../lib/identity-verification";
import { currentOperationalVendorPredicate } from "../../../lib/operational-vendor";
import { requireVendorPermission } from "../../../lib/vendor-access";
import { prepareVendorNewOrderNotificationStatement } from "../../../lib/vendor-order-notifications";
import { effectivePriceFallbackSql } from "../../../lib/effective-pricing";

const privateResponseHeaders = { "Cache-Control": "private, no-store" };

type OrderItemInput = { inventoryId?: unknown; quantity?: unknown };
type SelectedOffer = {
  inventoryId: number; vendorId: number; branchId: number; branchName: string; productId: number; productName: string; prescriptionRequired: number;
};
type AllocationBatch = {
  inventoryId: number; productId: number; productName: string; batchNumber: string; expiryDate: string;
  salePricePaise: number; gstPercent: number; hsnCode: string; availableQuantity: number;
};
type AllocatedLine = AllocationBatch & {
  allocatedQuantity: number; taxablePaise: number; taxPaise: number; cgstPaise: number; sgstPaise: number;
  igstPaise: number; lineTotalPaise: number;
};
type OrderListRow = {
  id: number; orderNumber: string; subtotalPaise: number; taxPaise: number; deliveryFeePaise: number; totalPaise: number;
  paymentMethod: string; paymentStatus: string; deliveryMethod: DeliveryMethod; orderStatus: string; deliveryStatus: string;
  prescriptionId: number | null; prescriptionStatus: string; customerName: string; deliveryAddress: string;
  placeOfSupplyStateCode: string; inventoryStatus: string; reservationExpiresAt: string | null;
  createdAt: string; businessName: string; items: string;
};
type TrackingEventRow = { orderId: number; status: string; note: string; createdAt: string; actorName: string; actorRole: string };

export async function GET(request: Request) {
  try {
    const authenticated = await requireLocalProfile(request, ["customer", "vendor", "admin", "delivery"]);
    const { profile } = authenticated;
    const vendorAccess = profile.role === "vendor"
      ? await requireVendorPermission(request, "sale.write", authenticated)
      : null;
    const db = getD1();
    await releaseExpiredReservations(db);
    let clause = "o.customer_profile_id = ?";
    let ownerId: number | string | null = profile.id;
    if (profile.role === "vendor") {
      clause = "o.vendor_id = ?";
      ownerId = vendorAccess!.vendorId;
    } else if (profile.role === "admin") {
      clause = "1 = ?";
      ownerId = 1;
    } else if (profile.role === "delivery") {
      clause = `o.delivery_method = 'urmed' AND EXISTS (
        SELECT 1 FROM delivery_assignments assignment
        JOIN delivery_agents agent ON agent.id = assignment.agent_id
        WHERE assignment.order_id = o.id AND agent.profile_id = ? AND assignment.status <> 'cancelled'
      )`;
      ownerId = profile.id;
    }
    if (!ownerId) return Response.json({ orders: [] }, { headers: privateResponseHeaders });
    const orderResult = await db.prepare(`
      SELECT o.id, o.order_number AS orderNumber, o.subtotal_paise AS subtotalPaise,
        o.tax_paise AS taxPaise, o.delivery_fee_paise AS deliveryFeePaise, o.total_paise AS totalPaise,
        o.payment_method AS paymentMethod, o.payment_status AS paymentStatus,
        o.delivery_method AS deliveryMethod, o.order_status AS orderStatus,
        o.delivery_status AS deliveryStatus, o.prescription_id AS prescriptionId,
        o.prescription_status AS prescriptionStatus, o.customer_name AS customerName,
        o.delivery_address AS deliveryAddress, o.place_of_supply_state_code AS placeOfSupplyStateCode,
        o.inventory_status AS inventoryStatus, o.reservation_expires_at AS reservationExpiresAt,
        o.created_at AS createdAt, v.business_name AS businessName,
        (SELECT group_concat(oi.product_name || ' × ' || oi.quantity || ' [' || oi.batch_number || ']', ', ')
          FROM order_items oi WHERE oi.order_id = o.id) AS items
      FROM orders o JOIN vendors v ON v.id = o.vendor_id
      WHERE ${clause} ORDER BY o.created_at DESC LIMIT 100
    `).bind(ownerId).all<OrderListRow>();
    const eventResult = await db.prepare(`
      SELECT e.order_id AS orderId, e.status, e.note, e.created_at AS createdAt,
        COALESCE(actor.name, 'URMED system') AS actorName, COALESCE(actor.role, 'system') AS actorRole
      FROM delivery_events e JOIN orders o ON o.id = e.order_id
      LEFT JOIN account_profiles actor ON actor.id = e.actor_profile_id
      WHERE ${clause} ORDER BY e.order_id, e.created_at, e.id
    `).bind(ownerId).all<TrackingEventRow>();
    const eventsByOrder = new Map<number, TrackingEventRow[]>();
    for (const event of eventResult.results) eventsByOrder.set(event.orderId, [...(eventsByOrder.get(event.orderId) ?? []), event]);
    const orders = orderResult.results.map((order) => ({
      ...order,
      trackingEvents: eventsByOrder.get(order.id) ?? [],
      nextStatuses: nextDeliveryStatuses({
        role: profile.role as WorkflowRole, deliveryMethod: order.deliveryMethod, deliveryStatus: order.deliveryStatus,
        orderStatus: order.orderStatus, prescriptionStatus: order.prescriptionStatus,
        paymentMethod: order.paymentMethod, paymentStatus: order.paymentStatus,
      }),
    }));
    return Response.json({ orders }, { headers: privateResponseHeaders });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  // Legacy public_location.publication_status = 'published' is mirrored into
  // the selected branch; checkout never falls back to private vendor coords.
  try {
    const { profile } = await requireLocalProfile(request, ["customer"]);
    const body = await request.json() as Record<string, unknown>;
    const items = Array.isArray(body.items) ? body.items as OrderItemInput[] : [];
    if (!items.length || items.length > 30) return Response.json({ error: "Add at least one stocked medicine" }, { status: 400 });
    const paymentMethod = body.paymentMethod === "cod" ? "cod" : "online";
    const deliveryMethod = ["pickup", "pharmacy", "urmed"].includes(String(body.deliveryMethod)) ? String(body.deliveryMethod) : "urmed";
    const placeOfSupplyStateCode = String(body.placeOfSupplyStateCode ?? "").trim();
    if (!/^\d{2}$/.test(placeOfSupplyStateCode)) return Response.json({ error: "Enter the 2-digit GST state code for the delivery place" }, { status: 400 });
    const customerName = profile.name.trim().slice(0, 120);
    const customerPhone = normalizeIndianMobile(profile.phone);
    if (!customerName || !customerPhone) return Response.json({ error: "A verified customer name and mobile number are required before checkout" }, { status: 409 });
    if (body.customerPhone !== undefined && normalizeIndianMobile(body.customerPhone) !== customerPhone) {
      return Response.json({ error: "Change and re-verify the mobile number in your customer account before checkout" }, { status: 409 });
    }
    const customerAddressId = Number(body.customerAddressId);
    if (!Number.isInteger(customerAddressId) || customerAddressId < 1) return Response.json({ error: "Select a saved delivery address" }, { status: 400 });

    const requestedByInventory = new Map<number, number>();
    for (const item of items) {
      const inventoryId = asPositiveInteger(item.inventoryId, "Inventory item", 1000000000);
      const quantity = asPositiveInteger(item.quantity, "Quantity", 100);
      requestedByInventory.set(inventoryId, (requestedByInventory.get(inventoryId) ?? 0) + quantity);
    }
    if ([...requestedByInventory.values()].some((quantity) => quantity > 100)) return Response.json({ error: "A medicine quantity cannot exceed 100 units" }, { status: 400 });

    const db = getD1();
    await releaseExpiredReservations(db);
    const operationalVendor = currentOperationalVendorPredicate("v");
    const customerAddress = await db.prepare(`SELECT id,address,latitude,longitude FROM customer_addresses
      WHERE id=? AND profile_id=? LIMIT 1`).bind(customerAddressId, profile.id).first<{
      id: number; address: string; latitude: string; longitude: string;
    }>();
    if (!customerAddress) return Response.json({ error: "The selected delivery address does not belong to this customer" }, { status: 404 });
    const selected: Array<SelectedOffer & { requestedQuantity: number }> = [];
    for (const [inventoryId, requestedQuantity] of requestedByInventory) {
      const row = await db.prepare(`
        SELECT i.id AS inventoryId, i.vendor_id AS vendorId, i.branch_id AS branchId,
          branch.name AS branchName, i.product_id AS productId,
          p.name AS productName, p.prescription_required AS prescriptionRequired
        FROM pharmacy_inventory i JOIN products p ON p.id = i.product_id
        JOIN vendors v ON v.id = i.vendor_id
        JOIN pharmacy_branches branch ON branch.id = i.branch_id AND branch.vendor_id = i.vendor_id AND branch.status = 'active'
        WHERE i.id = ? AND p.active = 1 AND ${operationalVendor} LIMIT 1
      `).bind(inventoryId).first<SelectedOffer>();
      if (!row) return Response.json({ error: "A selected medicine is no longer available" }, { status: 409 });
      selected.push({ ...row, requestedQuantity });
    }
    const vendorId = selected[0].vendorId;
    if (selected.some((row) => row.vendorId !== vendorId)) return Response.json({ error: "Place separate orders for different pharmacies" }, { status: 400 });
    const branchId = selected[0].branchId;
    if (selected.some((row) => row.branchId !== branchId)) return Response.json({ error: "Place separate orders for different pharmacy branches" }, { status: 400 });

    const productRequests = new Map<number, { productName: string; quantity: number; prescriptionRequired: boolean }>();
    for (const item of selected) {
      const current = productRequests.get(item.productId);
      productRequests.set(item.productId, {
        productName: item.productName,
        quantity: (current?.quantity ?? 0) + item.requestedQuantity,
        prescriptionRequired: Boolean(item.prescriptionRequired || current?.prescriptionRequired),
      });
    }
    if ([...productRequests.values()].some((item) => item.quantity > 100)) return Response.json({ error: "A medicine quantity cannot exceed 100 units" }, { status: 400 });

    let refillReminderId: number | null = null;
    if (body.refillReminderId !== undefined) {
      refillReminderId = Number(body.refillReminderId);
      if (!Number.isInteger(refillReminderId) || refillReminderId < 1) return Response.json({ error: "Refill reminder is invalid" }, { status: 400 });
      const reminder = await db.prepare(`SELECT id, vendor_id AS vendorId, product_id AS productId, status
        FROM refill_reminders WHERE id = ? AND customer_profile_id = ? LIMIT 1`)
        .bind(refillReminderId, profile.id).first<{ id: number; vendorId: number; productId: number; status: string }>();
      if (!reminder || reminder.vendorId !== vendorId || !productRequests.has(reminder.productId)
        || ["completed", "cancelled"].includes(reminder.status)) {
        return Response.json({ error: "This refill reminder cannot be used for the selected medicine" }, { status: 409 });
      }
    }

    const vendor = await db.prepare(`SELECT v.gst_number AS gstNumber, v.home_delivery AS homeDelivery,
      CASE WHEN branch.public_location_status = 'published' THEN branch.public_latitude ELSE '' END AS publicLatitude,
      CASE WHEN branch.public_location_status = 'published' THEN branch.public_longitude ELSE '' END AS publicLongitude,
      CASE WHEN branch.public_location_status = 'published' THEN branch.pickup_enabled ELSE 0 END AS publicPickupEnabled,
      CASE WHEN branch.public_location_status = 'published' THEN branch.service_enabled ELSE 0 END AS publicServiceEnabled,
      CASE WHEN branch.public_location_status = 'published' THEN branch.service_radius_km ELSE 0 END AS publicServiceRadiusKm
      FROM vendors v JOIN pharmacy_branches branch ON branch.id = ? AND branch.vendor_id = v.id AND branch.status = 'active'
      WHERE v.id = ? AND ${operationalVendor} LIMIT 1`)
      .bind(branchId, vendorId).first<{
        gstNumber: string; homeDelivery: number;
        publicLatitude: string | null; publicLongitude: string | null; publicPickupEnabled: number | null;
        publicServiceEnabled: number | null; publicServiceRadiusKm: number | null;
      }>();
    if (!vendor) return Response.json({ error: "The selected pharmacy is unavailable" }, { status: 409 });
    const sellerStateCode = /^\d{2}/.test(vendor.gstNumber) ? vendor.gstNumber.slice(0, 2) : "";

    const allocationBatches: Array<AllocationBatch & { allocatedQuantity: number }> = [];
    for (const [productId, productRequest] of productRequests) {
      const batches = await db.prepare(`
        SELECT i.id AS inventoryId, i.product_id AS productId, p.name AS productName,
          i.batch_number AS batchNumber, i.expiry_date AS expiryDate,
          ${effectivePriceFallbackSql("i", "sale_price_paise")} AS salePricePaise,
          ${effectivePriceFallbackSql("i", "gst_percent")} AS gstPercent, p.hsn_code AS hsnCode,
          (i.quantity - i.reserved_quantity) AS availableQuantity
        FROM pharmacy_inventory i JOIN products p ON p.id = i.product_id
        WHERE i.vendor_id = ? AND i.branch_id = ? AND i.product_id = ? AND i.active = 1 AND p.active = 1
          AND i.quarantine_status = 'available' AND i.expiry_date IS NOT NULL
          AND i.cold_chain_status IN ('not_applicable','within_range')
          AND date(i.expiry_date) >= date('now') AND (i.quantity - i.reserved_quantity) > 0
        ORDER BY date(i.expiry_date), i.id
      `).bind(vendorId, branchId, productId).all<AllocationBatch>();
      try {
        allocationBatches.push(...allocateFefo(productRequest.quantity, batches.results));
      } catch {
        return Response.json({ error: `${productRequest.productName} does not have enough non-expired FEFO stock` }, { status: 409 });
      }
    }

    if (!sellerStateCode && allocationBatches.some((line) => line.gstPercent > 0)) {
      return Response.json({ error: "The pharmacy must add a valid GSTIN before selling GST-rated stock" }, { status: 409 });
    }
    const allocatedLines: AllocatedLine[] = allocationBatches.map((line) => {
      const taxablePaise = line.salePricePaise * line.allocatedQuantity;
      const gst = calculateGst(taxablePaise, line.gstPercent, sellerStateCode, placeOfSupplyStateCode);
      return { ...line, taxablePaise, ...gst, lineTotalPaise: taxablePaise + gst.taxPaise };
    });

    const requiresPrescription = [...productRequests.values()].some((item) => item.prescriptionRequired);
    let prescriptionId: number | null = null;
    let prescriptionStatus = "not_required";
    if (requiresPrescription) {
      prescriptionId = Number(body.prescriptionId);
      if (!Number.isInteger(prescriptionId) || prescriptionId < 1) return Response.json({ error: "Upload and select a prescription for this medicine" }, { status: 400 });
      const prescription = await db.prepare(`SELECT id, vendor_id AS vendorId, status FROM prescriptions
        WHERE id = ? AND customer_profile_id = ? AND vendor_id = ? AND status IN ('uploaded', 'approved')
          AND NOT EXISTS (SELECT 1 FROM orders WHERE prescription_id = prescriptions.id) LIMIT 1`)
        .bind(prescriptionId, profile.id, vendorId).first<{ id: number; vendorId: number; status: string }>();
      if (!prescription) return Response.json({ error: "Choose an unused prescription submitted to this pharmacy" }, { status: 409 });
      prescriptionStatus = prescription.status === "approved" ? "approved" : "pending_review";
    }

    const subtotalPaise = allocatedLines.reduce((sum, line) => sum + line.taxablePaise, 0);
    const taxPaise = allocatedLines.reduce((sum, line) => sum + line.taxPaise, 0);
    const deliveryFeePaise = deliveryMethod === "pickup" ? 0 : deliveryMethod === "pharmacy" ? 2500 : 3900;
    const totalPaise = subtotalPaise + taxPaise + deliveryFeePaise;
    const deliveryAddress = customerAddress.address;
    const latitude = customerAddress.latitude;
    const longitude = customerAddress.longitude;
    const lat = Number(latitude); const lon = Number(longitude);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) return Response.json({ error: "Valid delivery latitude and longitude are required" }, { status: 400 });
    const publicServicePoint = {
      latitude: Number(vendor.publicLatitude),
      longitude: Number(vendor.publicLongitude),
    };
    const hasPublishedServicePoint = isValidGeoPoint(publicServicePoint);
    if (deliveryMethod === "pickup" && (!vendor.publicPickupEnabled || !hasPublishedServicePoint)) {
      return Response.json({ error: "Pickup is unavailable until this pharmacy publishes a customer pickup point" }, { status: 409 });
    }
    if (deliveryMethod !== "pickup" && (!vendor.publicServiceEnabled || !hasPublishedServicePoint)) {
      return Response.json({ error: "Delivery is unavailable until this pharmacy publishes a customer service point" }, { status: 409 });
    }
    const serviceRadiusKm = Number(vendor.publicServiceRadiusKm);
    let deliveryDistanceKm = 0;
    if (deliveryMethod !== "pickup") {
      if (deliveryMethod === "pharmacy" && !vendor.homeDelivery) return Response.json({ error: "This pharmacy does not currently offer self-delivery" }, { status: 409 });
      deliveryDistanceKm = haversineKm(publicServicePoint, { latitude: lat, longitude: lon });
      if (deliveryDistanceKm > serviceRadiusKm) {
        return Response.json({ error: "This delivery address is outside the pharmacy service area. Choose pickup or another pharmacy." }, { status: 409 });
      }
    }

    const number = orderNumber();
    const reservationExpiry = paymentMethod === "online" ? reservationExpiresAt() : null;
    const statements = [
      db.prepare(`INSERT INTO orders (order_number, customer_profile_id, vendor_id, branch_id, prescription_id, subtotal_paise, tax_paise,
        delivery_fee_paise, total_paise, payment_method, payment_status, delivery_method, order_status,
        delivery_status, prescription_status, place_of_supply_state_code, customer_name, customer_phone,
        delivery_address, latitude, longitude, inventory_status, reservation_expires_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        FROM vendors checkout_vendor
        WHERE checkout_vendor.id = ? AND ${currentOperationalVendorPredicate("checkout_vendor")}
          AND (? IS NULL OR EXISTS (SELECT 1 FROM prescriptions eligible_prescription
          WHERE eligible_prescription.id=? AND eligible_prescription.customer_profile_id=?
            AND eligible_prescription.vendor_id=? AND eligible_prescription.status IN ('uploaded','approved')
            AND NOT EXISTS (SELECT 1 FROM orders used_order
              WHERE used_order.prescription_id=eligible_prescription.id)))`)
        .bind(number, profile.id, vendorId, branchId, prescriptionId, subtotalPaise, taxPaise, deliveryFeePaise, totalPaise,
          paymentMethod, paymentMethod === "cod" ? "cod_due" : "pending", deliveryMethod,
          prescriptionStatus === "pending_review" ? "awaiting_prescription_review" : paymentMethod === "online" ? "awaiting_payment" : "placed",
          prescriptionStatus === "pending_review" ? "pharmacist_review" : "awaiting_confirmation", prescriptionStatus,
          placeOfSupplyStateCode, customerName, customerPhone, deliveryAddress, latitude, longitude,
          paymentMethod === "online" ? "reserved" : "committed", reservationExpiry,
          vendorId, prescriptionId, prescriptionId, profile.id, vendorId),
      ...allocatedLines.flatMap((line) => {
        const lineStatements = [db.prepare(`INSERT INTO order_items (order_id, inventory_id, product_id, product_name,
          batch_number, quantity, unit_price_paise, gst_percent, hsn_code, expiry_date, taxable_paise, cgst_paise,
          sgst_paise, igst_paise, discount_paise, line_total_paise)
          SELECT id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ? FROM orders WHERE order_number = ?`)
          .bind(line.inventoryId, line.productId, line.productName, line.batchNumber, line.allocatedQuantity,
            line.salePricePaise, line.gstPercent, line.hsnCode, line.expiryDate, line.taxablePaise,
            line.cgstPaise, line.sgstPaise, line.igstPaise, line.lineTotalPaise, number)];
        if (paymentMethod === "online") {
          lineStatements.push(prepareOnlineOrderReservation(db, {
            orderNumber: number,
            inventoryId: line.inventoryId,
            expiresAt: reservationExpiry!,
          }));
        } else {
          lineStatements.push(
            db.prepare(`UPDATE pharmacy_inventory SET quantity = quantity - ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND active = 1 AND quarantine_status = 'available'
            AND expiry_date IS NOT NULL AND date(expiry_date) >= date('now')
            AND (quantity - reserved_quantity) >= ?
            AND EXISTS (SELECT 1 FROM orders placed_order WHERE placed_order.order_number=?)`)
              .bind(line.allocatedQuantity, line.inventoryId, line.allocatedQuantity, number),
            db.prepare(`INSERT INTO stock_ledger (vendor_id, inventory_id, movement_type, quantity_delta, balance_after,
          reference_type, reference_id, reason, actor_profile_id)
          SELECT i.vendor_id, i.id, 'online_sale', ?, i.quantity, 'order', o.id, 'Atomic FEFO allocation', o.customer_profile_id
          FROM pharmacy_inventory i JOIN orders o ON o.order_number = ? WHERE i.id = ?`)
              .bind(-line.allocatedQuantity, number, line.inventoryId),
          );
        }
        return lineStatements;
      }),
      db.prepare(`INSERT INTO delivery_events (order_id, status, actor_profile_id, note)
        SELECT id, ?, ?, ? FROM orders WHERE order_number = ?`)
        .bind(prescriptionStatus === "pending_review" ? "pharmacist_review" : "placed", profile.id,
          prescriptionStatus === "pending_review" ? "Prescription received and awaiting pharmacist review" : "Order received by URMED", number),
      prepareVendorNewOrderNotificationStatement(db, { orderNumber: number, orderId: 0, vendorId }),
    ];
    statements.push(prepareTransactionalEmailEnqueueStatement(db, {
      profileId: profile.id,
      eventType: "order_placed",
      payload: { orderNumber: number, totalPaise, taxPaise },
      dedupeKey: `order_placed:${number}`,
    }));
    if (refillReminderId) {
      statements.push(db.prepare(`UPDATE refill_reminders SET status = 'completed', repeat_order_id =
        (SELECT id FROM orders WHERE order_number = ?), snoozed_until = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND customer_profile_id = ? AND status NOT IN ('completed', 'cancelled')
          AND EXISTS (SELECT 1 FROM orders placed_order WHERE placed_order.order_number=?)`)
        .bind(number, refillReminderId, profile.id, number));
    }
    try {
      await db.batch(statements);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/stock_unavailable|fefo_violation|expired_stock|quarantined_stock|reservation_stock_unavailable/i.test(message)) {
        return Response.json({ error: "Stock changed while the order was being placed. Refresh and try again." }, { status: 409 });
      }
      throw error;
    }
    const savedOrder = await db.prepare("SELECT id FROM orders WHERE order_number = ? LIMIT 1").bind(number).first<{ id: number }>();
    if (!savedOrder) return Response.json({ error: "This prescription was already used by another order. Refresh and select another prescription." }, { status: 409 });

    await appendAuditEvent({ vendorId, actorProfileId: profile.id, action: "order.placed", entityType: "order", entityId: savedOrder.id, after: { number, customerAddressId, prescriptionId, prescriptionStatus, refillReminderId, subtotalPaise, taxPaise, totalPaise, placeOfSupplyStateCode, paymentMethod, deliveryMethod, deliveryDistanceKm: Number(deliveryDistanceKm.toFixed(3)), latitude, longitude, reservationExpiresAt: reservationExpiry, allocations: allocatedLines.map(({ inventoryId, batchNumber, allocatedQuantity }) => ({ inventoryId, batchNumber, allocatedQuantity })) }, requestId: request.headers.get("cf-ray") ?? "" });
    return Response.json({ order: { id: savedOrder.id, orderNumber: number, subtotalPaise, taxPaise, deliveryFeePaise, totalPaise, paymentMethod, prescriptionStatus, reservationExpiresAt: reservationExpiry, requiresPrescriptionReview: prescriptionStatus === "pending_review" } }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
