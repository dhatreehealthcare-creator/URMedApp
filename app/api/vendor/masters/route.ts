import { getD1 } from "../../../../db/d1";
import { appendAuditEvent } from "../../../../lib/audit";
import { errorResponse } from "../../../../lib/auth-server";
import { requireVendorPermission } from "../../../../lib/vendor-access";

function clean(value: unknown, maximum: number) {
  return String(value ?? "").trim().slice(0, maximum);
}

function normalizedName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

async function loadMasters(vendorId: number, query = "") {
  const db = getD1();
  const manufacturerQuery = normalizedName(query);
  const [suppliers, manufacturers] = await db.batch([
    db.prepare(`
      SELECT id, business_name AS businessName, contact_name AS contactName, phone, email,
        address, gst_number AS gstNumber, drug_licence_number AS drugLicenceNumber,
        status, created_at AS createdAt, updated_at AS updatedAt
      FROM suppliers WHERE vendor_id = ? ORDER BY status = 'active' DESC, business_name LIMIT 200
    `).bind(vendorId),
    db.prepare(`
      SELECT m.id, m.name, COUNT(p.id) AS linkedProducts
      FROM manufacturers m LEFT JOIN products p ON lower(p.manufacturer) = m.normalized_name
      WHERE (? = '' OR m.normalized_name LIKE ?)
      GROUP BY m.id, m.name ORDER BY linkedProducts DESC, m.name LIMIT 100
    `).bind(manufacturerQuery, `%${manufacturerQuery}%`),
  ]);
  return { suppliers: suppliers.results, manufacturers: manufacturers.results };
}

export async function GET(request: Request) {
  try {
    const { vendorId } = await requireVendorPermission(request, "purchase.write");
    const query = new URL(request.url).searchParams.get("q") ?? "";
    return Response.json(await loadMasters(vendorId, query), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const { profile, vendorId } = await requireVendorPermission(request, "purchase.write");
    const body = await request.json() as Record<string, unknown>;
    const action = clean(body.action, 30);
    const db = getD1();

    if (action === "supplier") {
      const id = Number(body.id ?? 0);
      const businessName = clean(body.businessName, 180);
      const contactName = clean(body.contactName, 120);
      const phone = clean(body.phone, 20).replace(/\D/g, "");
      const email = clean(body.email, 180).toLowerCase();
      const address = clean(body.address, 500);
      const gstNumber = clean(body.gstNumber, 15).toUpperCase();
      const drugLicenceNumber = clean(body.drugLicenceNumber, 80).toUpperCase();
      const status = body.status === "inactive" ? "inactive" : "active";
      if (!businessName || !contactName || !/^\d{10}$/.test(phone)) {
        return Response.json({ error: "Business name, contact name and an exact 10-digit phone are required" }, { status: 400 });
      }
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return Response.json({ error: "Supplier email is invalid" }, { status: 400 });
      const before = id > 0 ? await db.prepare("SELECT * FROM suppliers WHERE id = ? AND vendor_id = ?").bind(id, vendorId).first() : null;
      if (id > 0 && !before) return Response.json({ error: "Supplier was not found for this pharmacy" }, { status: 404 });
      try {
        if (id > 0) {
          await db.prepare(`UPDATE suppliers SET business_name = ?, contact_name = ?, phone = ?, email = ?, address = ?,
            gst_number = ?, drug_licence_number = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND vendor_id = ?`)
            .bind(businessName, contactName, phone, email, address, gstNumber, drugLicenceNumber, status, id, vendorId).run();
        } else {
          await db.prepare(`INSERT INTO suppliers (vendor_id, business_name, contact_name, phone, email, address,
            gst_number, drug_licence_number, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .bind(vendorId, businessName, contactName, phone, email, address, gstNumber, drugLicenceNumber, status).run();
        }
      } catch (error) {
        if (error instanceof Error && /unique|constraint/i.test(error.message)) return Response.json({ error: "A supplier with this business name already exists" }, { status: 409 });
        throw error;
      }
      await appendAuditEvent({ vendorId, actorProfileId: profile.id, action: id > 0 ? "supplier.updated" : "supplier.created", entityType: "supplier", entityId: id || businessName, before, after: { businessName, contactName, phone, email, address, gstNumber, drugLicenceNumber, status }, requestId: request.headers.get("cf-ray") ?? "" });
    } else if (action === "manufacturer") {
      const name = clean(body.name, 180);
      const normalized = normalizedName(name);
      if (!name || normalized.length < 2) return Response.json({ error: "Manufacturer business name is required" }, { status: 400 });
      await db.prepare(`INSERT INTO manufacturers (name, normalized_name) VALUES (?, ?)
        ON CONFLICT(normalized_name) DO UPDATE SET name = excluded.name`).bind(name, normalized).run();
      await appendAuditEvent({ vendorId, actorProfileId: profile.id, action: "manufacturer.saved", entityType: "manufacturer", entityId: normalized, after: { name }, requestId: request.headers.get("cf-ray") ?? "" });
    } else {
      return Response.json({ error: "Master action is invalid" }, { status: 400 });
    }

    return Response.json({ saved: true, ...(await loadMasters(vendorId)) }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
