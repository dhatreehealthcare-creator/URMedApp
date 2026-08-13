import { getD1 } from "../../../../db/d1";
import { appendAuditEvent } from "../../../../lib/audit";
import { errorResponse, requireLocalProfile, type LocalProfile } from "../../../../lib/auth-server";
import { CustomerAddressValidationError, validateCustomerAddress } from "../../../../lib/customer-address";

type CustomerAddressRow = {
  id: number;
  label: string;
  address: string;
  latitude: string;
  longitude: string;
  isDefault: number;
  createdAt: string;
};

async function addressResponse(profile: LocalProfile) {
  const addresses = await getD1().prepare(`SELECT id,label,address,latitude,longitude,
    is_default AS isDefault,created_at AS createdAt FROM customer_addresses
    WHERE profile_id=? ORDER BY is_default DESC,id DESC`).bind(profile.id).all<CustomerAddressRow>();
  return {
    identity: { name: profile.name, email: profile.email, phone: profile.phone },
    addresses: addresses.results.map((address) => ({ ...address, isDefault: Boolean(address.isDefault) })),
  };
}

export async function GET(request: Request) {
  try {
    const { profile } = await requireLocalProfile(request, ["customer"]);
    return Response.json(await addressResponse(profile), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const { profile } = await requireLocalProfile(request, ["customer"]);
    const body = await request.json() as Record<string, unknown>;
    const action = String(body.action ?? "save");
    const db = getD1();
    if (action === "set_default") {
      const id = Number(body.id);
      if (!Number.isInteger(id) || id < 1) return Response.json({ error: "Choose a valid saved address" }, { status: 400 });
      const owned = await db.prepare("SELECT id FROM customer_addresses WHERE id=? AND profile_id=? LIMIT 1")
        .bind(id, profile.id).first<{ id: number }>();
      if (!owned) return Response.json({ error: "Saved address not found" }, { status: 404 });
      await db.batch([
        db.prepare("UPDATE customer_addresses SET is_default=0 WHERE profile_id=?").bind(profile.id),
        db.prepare("UPDATE customer_addresses SET is_default=1 WHERE id=? AND profile_id=?").bind(id, profile.id),
      ]);
      await appendAuditEvent({ actorProfileId: profile.id, action: "customer.address.default_changed", entityType: "customer_address", entityId: id, after: { isDefault: true }, requestId: request.headers.get("cf-ray") ?? "" });
      return Response.json({ updated: true, selectedAddressId: id, ...(await addressResponse(profile)) });
    }
    if (action !== "save") return Response.json({ error: "Address action is invalid" }, { status: 400 });

    let address;
    try {
      address = validateCustomerAddress(body);
    } catch (error) {
      if (error instanceof CustomerAddressValidationError) return Response.json({ error: error.message }, { status: 400 });
      throw error;
    }
    const requestedId = body.id === undefined || body.id === null || body.id === "" ? null : Number(body.id);
    if (requestedId !== null && (!Number.isInteger(requestedId) || requestedId < 1)) {
      return Response.json({ error: "Saved address is invalid" }, { status: 400 });
    }
    const existing = requestedId === null ? null : await db.prepare(`SELECT id,label,address,latitude,longitude,
      is_default AS isDefault FROM customer_addresses WHERE id=? AND profile_id=? LIMIT 1`)
      .bind(requestedId, profile.id).first<CustomerAddressRow>();
    if (requestedId !== null && !existing) return Response.json({ error: "Saved address not found" }, { status: 404 });
    const count = await db.prepare("SELECT COUNT(*) AS count FROM customer_addresses WHERE profile_id=?")
      .bind(profile.id).first<{ count: number }>();
    const shouldBeDefault = address.isDefault || Boolean(existing?.isDefault) || Number(count?.count ?? 0) === 0;

    let id: number;
    if (existing) {
      const statements = [];
      if (shouldBeDefault) statements.push(db.prepare("UPDATE customer_addresses SET is_default=0 WHERE profile_id=?").bind(profile.id));
      statements.push(db.prepare(`UPDATE customer_addresses SET label=?,address=?,latitude=?,longitude=?,is_default=?
        WHERE id=? AND profile_id=?`).bind(address.label, address.address, address.latitude, address.longitude, shouldBeDefault ? 1 : 0, existing.id, profile.id));
      await db.batch(statements);
      id = existing.id;
    } else {
      const statements = [];
      if (shouldBeDefault) statements.push(db.prepare("UPDATE customer_addresses SET is_default=0 WHERE profile_id=?").bind(profile.id));
      statements.push(db.prepare(`INSERT INTO customer_addresses (profile_id,label,address,latitude,longitude,is_default)
        VALUES (?,?,?,?,?,?)`).bind(profile.id, address.label, address.address, address.latitude, address.longitude, shouldBeDefault ? 1 : 0));
      const results = await db.batch(statements);
      id = Number(results.at(-1)?.meta.last_row_id);
    }
    await appendAuditEvent({
      actorProfileId: profile.id,
      action: existing ? "customer.address.updated" : "customer.address.created",
      entityType: "customer_address",
      entityId: id,
      before: existing ? { label: existing.label, isDefault: Boolean(existing.isDefault) } : undefined,
      after: { label: address.label, isDefault: shouldBeDefault, addressUpdated: true, mapLocationUpdated: true },
      requestId: request.headers.get("cf-ray") ?? "",
    });
    return Response.json({ saved: true, selectedAddressId: id, ...(await addressResponse(profile)) }, { status: existing ? 200 : 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
