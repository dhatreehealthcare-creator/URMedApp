import { getD1 } from "../../../db/d1";
import { appendAuditEvent } from "../../../lib/audit";
import { errorResponse, requireLocalProfile } from "../../../lib/auth-server";
import {
  DELIVERY_LOCATION_MIN_UPDATE_INTERVAL_MS,
  DeliveryLocationProofError,
  deliveryTimestampMs,
  validateDeliveryLocationProof,
} from "../../../lib/delivery-location";

type DeliveryAgentState = {
  id: number;
  vehicleType: string;
  vehicleNumber: string;
  licenceNumber: string;
  availabilityStatus: string;
  currentLatitude: string;
  currentLongitude: string;
  updatedAt: string;
};

function privateJson(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "private, no-store");
  return Response.json(body, { ...init, headers });
}

export async function GET(request: Request) {
  try {
    const { profile } = await requireLocalProfile(request, ["delivery"]);
    const db = getD1();
    const agent = await db.prepare(`SELECT id,vehicle_type AS vehicleType,vehicle_number AS vehicleNumber,
      licence_number AS licenceNumber,availability_status AS availabilityStatus,current_latitude AS currentLatitude,
      current_longitude AS currentLongitude,updated_at AS updatedAt
      FROM delivery_agents WHERE profile_id=?`).bind(profile.id).first<DeliveryAgentState>();
    if (!agent) return privateJson({ error: "Delivery-agent profile not found" }, { status: 404 });
    const assignments = await db.prepare(`SELECT a.id AS assignmentId,o.id AS orderId,o.order_number AS orderNumber,
      CASE WHEN a.status='delivered' OR o.delivery_status='delivered' THEN '' ELSE o.customer_name END AS customerName,
      CASE WHEN a.status='delivered' OR o.delivery_status='delivered' THEN '' ELSE o.customer_phone END AS customerPhone,
      CASE WHEN a.status='delivered' OR o.delivery_status='delivered' THEN '' ELSE o.delivery_address END AS deliveryAddress,
      CASE WHEN a.status='delivered' OR o.delivery_status='delivered' THEN '' ELSE o.latitude END AS latitude,
      CASE WHEN a.status='delivered' OR o.delivery_status='delivered' THEN '' ELSE o.longitude END AS longitude,
      o.delivery_status AS deliveryStatus,o.payment_method AS paymentMethod,
      o.payment_status AS paymentStatus,o.total_paise AS totalPaise,v.business_name AS businessName,
      COALESCE(public_location.label,'') AS pickupLabel,
      COALESCE(public_location.address,'') AS pickupAddress,
      COALESCE(public_location.latitude,'') AS pickupLatitude,
      COALESCE(public_location.longitude,'') AS pickupLongitude,
      a.status AS assignmentStatus,a.assigned_at AS assignedAt,a.picked_up_at AS pickedUpAt,a.delivered_at AS deliveredAt
      FROM delivery_assignments a JOIN orders o ON o.id=a.order_id JOIN vendors v ON v.id=o.vendor_id
      JOIN delivery_agents agent ON agent.id=a.agent_id
      LEFT JOIN vendor_public_locations public_location ON public_location.vendor_id=v.id
        AND public_location.publication_status='published' AND public_location.pickup_enabled=1
      WHERE agent.profile_id=? AND a.status<>'cancelled'
      ORDER BY CASE a.status WHEN 'delivered' THEN 2 ELSE 1 END,a.id DESC LIMIT 100`).bind(profile.id).all();
    return privateJson({
      profile: { name: profile.name, email: profile.email },
      agent: {
        vehicleType: agent.vehicleType,
        vehicleNumber: agent.vehicleNumber,
        availabilityStatus: agent.availabilityStatus,
      },
      assignments: assignments.results,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const { profile } = await requireLocalProfile(request, ["delivery"]);
    const body = await request.json() as Record<string, unknown>;
    const availability = String(body.availabilityStatus ?? "");
    if (!["available", "online", "offline"].includes(availability)) {
      return privateJson({ error: "A valid availability state is required" }, { status: 400 });
    }
    const db = getD1();
    const agent = await db.prepare(`SELECT id,availability_status AS availabilityStatus,
      current_latitude AS currentLatitude,current_longitude AS currentLongitude,updated_at AS updatedAt
      FROM delivery_agents WHERE profile_id=?`).bind(profile.id).first<DeliveryAgentState>();
    if (!agent) return privateJson({ error: "Delivery-agent profile not found" }, { status: 404 });
    const availabilityChanged = agent.availabilityStatus !== availability;

    if (availability === "offline") {
      if (!availabilityChanged) return privateJson({ updated: false, unchanged: true });
      const updated = await db.prepare(`UPDATE delivery_agents SET availability_status='offline',
        updated_at=CASE WHEN julianday(updated_at)>julianday(CURRENT_TIMESTAMP) THEN updated_at ELSE CURRENT_TIMESTAMP END
        WHERE profile_id=? AND availability_status<>'offline'`).bind(profile.id).run();
      if (!updated.meta.changes) return privateJson({ error: "Delivery-agent state changed. Refresh and retry" }, { status: 409 });
      await appendAuditEvent({
        actorProfileId: profile.id,
        action: "delivery_agent.availability",
        entityType: "delivery_agent",
        entityId: agent.id,
        before: { availability: agent.availabilityStatus },
        after: { availability: "offline" },
        requestId: request.headers.get("cf-ray") ?? "",
      });
      return privateJson({ updated: true, availabilityStatus: "offline" });
    }

    let proof;
    try {
      proof = validateDeliveryLocationProof(body);
    } catch (error) {
      if (error instanceof DeliveryLocationProofError) return privateJson({ error: error.message }, { status: 400 });
      throw error;
    }
    const previousTimestamp = deliveryTimestampMs(agent.updatedAt);
    if (previousTimestamp && proof.capturedAtMs <= previousTimestamp) {
      return privateJson({ error: "This browser geolocation was already used. Capture a fresh position" }, { status: 409 });
    }
    const elapsedMs = previousTimestamp ? proof.capturedAtMs - previousTimestamp : DELIVERY_LOCATION_MIN_UPDATE_INTERVAL_MS;
    if (elapsedMs < DELIVERY_LOCATION_MIN_UPDATE_INTERVAL_MS) {
      const retryAfter = Math.max(1, Math.ceil((DELIVERY_LOCATION_MIN_UPDATE_INTERVAL_MS - elapsedMs) / 1_000));
      return privateJson({ error: "Location updates are limited to one every 15 seconds" }, {
        status: 429,
        headers: { "Retry-After": String(retryAfter) },
      });
    }
    const updated = await db.prepare(`UPDATE delivery_agents
      SET availability_status=?,current_latitude=?,current_longitude=?,updated_at=?
      WHERE profile_id=? AND julianday(updated_at)<julianday(?)
        AND julianday(updated_at)<=julianday(?)-(?/86400000.0)`)
      .bind(
        availability, proof.latitude, proof.longitude, proof.capturedAt, profile.id, proof.capturedAt,
        proof.capturedAt, DELIVERY_LOCATION_MIN_UPDATE_INTERVAL_MS,
      ).run();
    if (!updated.meta.changes) {
      return privateJson({ error: "Location update was replayed or sent too quickly. Capture a fresh position" }, { status: 409 });
    }
    if (availabilityChanged) {
      await appendAuditEvent({
        actorProfileId: profile.id,
        action: "delivery_agent.availability",
        entityType: "delivery_agent",
        entityId: agent.id,
        before: { availability: agent.availabilityStatus },
        after: { availability, source: body.source === "gps_watch" ? "gps_watch" : "browser_geolocation" },
        requestId: request.headers.get("cf-ray") ?? "",
      });
    }
    return privateJson({ updated: true, availabilityStatus: availability });
  } catch (error) {
    return errorResponse(error);
  }
}
