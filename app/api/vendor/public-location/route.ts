import { getD1 } from "../../../../db/d1";
import { appendAuditEvent } from "../../../../lib/audit";
import { errorResponse } from "../../../../lib/auth-server";
import { requireVendorOnboardingAccess } from "../../../../lib/vendor-access";
import {
  validateVendorPublicLocation,
  VendorPublicLocationValidationError,
} from "../../../../lib/vendor-public-location";

type PublicLocationRow = {
  id: number;
  label: string;
  address: string;
  latitude: string;
  longitude: string;
  pickupEnabled: number;
  serviceEnabled: number;
  serviceRadiusKm: number;
  publicationStatus: "draft" | "published";
  publicationConsentAt: string | null;
  publishedAt: string | null;
  updatedAt: string;
};

async function loadPublicLocation(vendorId: number) {
  return getD1().prepare(`
    SELECT id, label, address, latitude, longitude,
      pickup_enabled AS pickupEnabled, service_enabled AS serviceEnabled,
      service_radius_km AS serviceRadiusKm, publication_status AS publicationStatus,
      publication_consent_at AS publicationConsentAt, published_at AS publishedAt,
      updated_at AS updatedAt
    FROM vendor_public_locations WHERE vendor_id = ? LIMIT 1
  `).bind(vendorId).first<PublicLocationRow>();
}

export async function GET(request: Request) {
  try {
    const { vendorId } = await requireVendorOnboardingAccess(request);
    return Response.json({ publicLocation: await loadPublicLocation(vendorId) ?? null }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const { profile, vendorId } = await requireVendorOnboardingAccess(request);
    const body = await request.json() as Record<string, unknown>;
    const action = body.action === "publish" ? "publish" : body.action === "unpublish" ? "unpublish" : "save";
    const before = await loadPublicLocation(vendorId);

    if (action === "unpublish") {
      if (before) {
        await getD1().prepare(`UPDATE vendor_public_locations
          SET publication_status = 'draft', published_at = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE vendor_id = ?`).bind(vendorId).run();
        await getD1().prepare(`UPDATE pharmacy_branches SET public_location_status='draft', public_published_at=NULL,
          updated_at=CURRENT_TIMESTAMP WHERE vendor_id = ? AND is_primary = 1`).bind(vendorId).run();
        await appendAuditEvent({
          vendorId,
          actorProfileId: profile.id,
          action: "vendor.public_location.unpublished",
          entityType: "vendor_public_location",
          entityId: before.id,
          before,
          after: { ...before, publicationStatus: "draft", publishedAt: null },
          reason: "Vendor owner removed the customer-facing location from public use",
          requestId: request.headers.get("cf-ray") ?? "",
        });
      }
      return Response.json({ publicLocation: await loadPublicLocation(vendorId) ?? null });
    }

    let location;
    try {
      location = validateVendorPublicLocation(body);
    } catch (error) {
      if (error instanceof VendorPublicLocationValidationError) {
        return Response.json({ error: error.message }, { status: 400 });
      }
      throw error;
    }

    if (action === "publish") {
      if (profile.vendorAccessStatus !== "operational") {
        return Response.json({ error: "Administrator-approved operational vendors can publish a customer location" }, { status: 403 });
      }
      if (body.publicationConsent !== true) {
        return Response.json({ error: "Confirm that this address and map pin may be shown publicly" }, { status: 400 });
      }
    }

    const publicationStatus = action === "publish" ? "published" : "draft";
    await getD1().prepare(`
      INSERT INTO vendor_public_locations
        (vendor_id, label, address, latitude, longitude, pickup_enabled, service_enabled,
         service_radius_km, publication_status, publication_consent_at, published_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?,
        CASE WHEN ? = 'published' THEN CURRENT_TIMESTAMP ELSE NULL END,
        CASE WHEN ? = 'published' THEN CURRENT_TIMESTAMP ELSE NULL END)
      ON CONFLICT(vendor_id) DO UPDATE SET
        label = excluded.label,
        address = excluded.address,
        latitude = excluded.latitude,
        longitude = excluded.longitude,
        pickup_enabled = excluded.pickup_enabled,
        service_enabled = excluded.service_enabled,
        service_radius_km = excluded.service_radius_km,
        publication_status = excluded.publication_status,
        publication_consent_at = CASE WHEN excluded.publication_status = 'published'
          THEN CURRENT_TIMESTAMP ELSE vendor_public_locations.publication_consent_at END,
        published_at = CASE WHEN excluded.publication_status = 'published'
          THEN COALESCE(vendor_public_locations.published_at, CURRENT_TIMESTAMP) ELSE NULL END,
        updated_at = CURRENT_TIMESTAMP
    `).bind(
      vendorId,
      location.label,
      location.address,
      location.latitude,
      location.longitude,
      location.pickupEnabled ? 1 : 0,
      location.serviceEnabled ? 1 : 0,
      location.serviceRadiusKm,
      publicationStatus,
      publicationStatus,
      publicationStatus,
    ).run();

    const after = await loadPublicLocation(vendorId);
    await getD1().prepare(`UPDATE pharmacy_branches SET public_label=?, public_address=?, public_latitude=?, public_longitude=?,
      pickup_enabled=?, service_enabled=?, service_radius_km=?, public_location_status=?,
      public_location_consent_at=CASE WHEN ?='published' THEN CURRENT_TIMESTAMP ELSE public_location_consent_at END,
      public_published_at=CASE WHEN ?='published' THEN COALESCE(public_published_at,CURRENT_TIMESTAMP) ELSE NULL END,
      updated_at=CURRENT_TIMESTAMP WHERE vendor_id = ? AND is_primary = 1`).bind(
      location.label, location.address, location.latitude, location.longitude,
      location.pickupEnabled ? 1 : 0, location.serviceEnabled ? 1 : 0, location.serviceRadiusKm,
      publicationStatus, publicationStatus, publicationStatus, vendorId,
    ).run();
    await appendAuditEvent({
      vendorId,
      actorProfileId: profile.id,
      action: action === "publish" ? "vendor.public_location.published" : "vendor.public_location.saved",
      entityType: "vendor_public_location",
      entityId: after?.id ?? vendorId,
      before,
      after,
      reason: action === "publish" ? "Vendor owner explicitly approved this location for customer visibility" : "Private public-location draft saved",
      requestId: request.headers.get("cf-ray") ?? "",
    });
    return Response.json({ publicLocation: after }, { status: before ? 200 : 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
