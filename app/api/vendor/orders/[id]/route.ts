import { getD1 } from "../../../../../db/d1";
import { errorResponse } from "../../../../../lib/auth-server";
import { nextDeliveryStatuses, type DeliveryMethod } from "../../../../../lib/order-workflow";
import { requireVendorPermission } from "../../../../../lib/vendor-access";

type OrderDetailRow = {
  id: number;
  orderNumber: string;
  customerProfileId: number;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  deliveryAddress: string;
  latitude: string;
  longitude: string;
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
  placeOfSupplyStateCode: string;
  invoiceId: number | null;
  invoiceNumber: string | null;
  createdAt: string;
  updatedAt: string;
};

type OrderItemRow = {
  id: number;
  inventoryId: number;
  productId: number;
  productName: string;
  batchNumber: string;
  expiryDate: string | null;
  quantity: number;
  unitPricePaise: number;
  gstPercent: number;
  hsnCode: string;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  discountPaise: number;
  lineTotalPaise: number;
};

type TrackingEventRow = {
  id: number;
  status: string;
  note: string;
  createdAt: string;
  actorName: string;
  actorRole: string;
};

type PrescriptionDetail = {
  id: number;
  prescriptionNumber: string;
  documentId: number;
  documentName: string;
  patientName: string;
  patientAddress: string;
  prescriberName: string;
  prescriberAddress: string;
  prescribedOn: string | null;
  status: string;
  rejectionReason: string;
  reviewedAt: string | null;
  reviewDecision: string | null;
  reviewNotes: string | null;
  pharmacistName: string | null;
};

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { vendorId } = await requireVendorPermission(request, "sale.write");
    const orderId = Number((await context.params).id);
    if (!Number.isInteger(orderId) || orderId < 1) {
      return Response.json({ error: "Order is invalid" }, { status: 400 });
    }

    const db = getD1();
    const order = await db.prepare(`
      SELECT o.id, o.order_number AS orderNumber, o.customer_profile_id AS customerProfileId,
        o.customer_name AS customerName, o.customer_phone AS customerPhone,
        customer.email AS customerEmail, o.delivery_address AS deliveryAddress,
        o.latitude, o.longitude, o.subtotal_paise AS subtotalPaise, o.tax_paise AS taxPaise,
        o.delivery_fee_paise AS deliveryFeePaise, o.total_paise AS totalPaise,
        o.payment_method AS paymentMethod, o.payment_status AS paymentStatus,
        o.delivery_method AS deliveryMethod, o.order_status AS orderStatus,
        o.delivery_status AS deliveryStatus, o.prescription_id AS prescriptionId,
        o.prescription_status AS prescriptionStatus, o.inventory_status AS inventoryStatus,
        o.reservation_expires_at AS reservationExpiresAt,
        o.place_of_supply_state_code AS placeOfSupplyStateCode, o.invoice_id AS invoiceId,
        invoice.invoice_number AS invoiceNumber, o.created_at AS createdAt, o.updated_at AS updatedAt
      FROM orders o
      JOIN account_profiles customer ON customer.id = o.customer_profile_id
      LEFT JOIN tax_invoices invoice ON invoice.id = o.invoice_id
      WHERE o.id = ? AND o.vendor_id = ? AND o.order_type = 'online'
      LIMIT 1
    `).bind(orderId, vendorId).first<OrderDetailRow>();
    if (!order) return Response.json({ error: "Order not found" }, { status: 404 });

    const [itemResult, eventResult, prescription] = await Promise.all([
      db.prepare(`
        SELECT item.id, item.inventory_id AS inventoryId, item.product_id AS productId,
          item.product_name AS productName, item.batch_number AS batchNumber,
          item.expiry_date AS expiryDate, item.quantity, item.unit_price_paise AS unitPricePaise,
          item.gst_percent AS gstPercent, item.hsn_code AS hsnCode,
          item.taxable_paise AS taxablePaise, item.cgst_paise AS cgstPaise,
          item.sgst_paise AS sgstPaise, item.igst_paise AS igstPaise,
          item.discount_paise AS discountPaise, item.line_total_paise AS lineTotalPaise
        FROM order_items item
        JOIN orders scoped_order ON scoped_order.id = item.order_id
        WHERE item.order_id = ? AND scoped_order.vendor_id = ?
        ORDER BY item.id
      `).bind(orderId, vendorId).all<OrderItemRow>(),
      db.prepare(`
        SELECT event.id, event.status, event.note, event.created_at AS createdAt,
          COALESCE(actor.name, 'URMED system') AS actorName,
          COALESCE(actor.role, 'system') AS actorRole
        FROM delivery_events event
        JOIN orders scoped_order ON scoped_order.id = event.order_id
        LEFT JOIN account_profiles actor ON actor.id = event.actor_profile_id
        WHERE event.order_id = ? AND scoped_order.vendor_id = ?
        ORDER BY datetime(event.created_at), event.id
      `).bind(orderId, vendorId).all<TrackingEventRow>(),
      order.prescriptionId ? db.prepare(`
        SELECT prescription.id, prescription.prescription_number AS prescriptionNumber,
          prescription.document_id AS documentId, document.original_filename AS documentName,
          prescription.patient_name AS patientName, prescription.patient_address AS patientAddress,
          prescription.prescriber_name AS prescriberName,
          prescription.prescriber_address AS prescriberAddress,
          prescription.prescribed_on AS prescribedOn, prescription.status,
          prescription.rejection_reason AS rejectionReason, prescription.reviewed_at AS reviewedAt,
          review.decision AS reviewDecision, review.notes AS reviewNotes,
          pharmacist.full_name AS pharmacistName
        FROM prescriptions prescription
        JOIN stored_documents document ON document.id = prescription.document_id
        LEFT JOIN prescription_reviews review ON review.id = (
          SELECT latest.id FROM prescription_reviews latest
          WHERE latest.prescription_id = prescription.id ORDER BY latest.id DESC LIMIT 1
        )
        LEFT JOIN pharmacists pharmacist ON pharmacist.id = review.pharmacist_id
        WHERE prescription.id = ? AND prescription.vendor_id = ?
        LIMIT 1
      `).bind(order.prescriptionId, vendorId).first<PrescriptionDetail>() : Promise.resolve(null),
    ]);

    const nextStatuses = nextDeliveryStatuses({
      role: "vendor",
      deliveryMethod: order.deliveryMethod,
      deliveryStatus: order.deliveryStatus,
      orderStatus: order.orderStatus,
      prescriptionStatus: order.prescriptionStatus,
      paymentMethod: order.paymentMethod,
      paymentStatus: order.paymentStatus,
    });

    return Response.json({
      order: {
        ...order,
        items: itemResult.results,
        trackingEvents: eventResult.results,
        prescription,
        nextStatuses,
      },
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
