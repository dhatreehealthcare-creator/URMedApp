import { getD1 } from "../../../../../db/d1";
import { errorResponse, requireLocalProfile } from "../../../../../lib/auth-server";
import { requireVendorPermission } from "../../../../../lib/vendor-access";
import { CodCollectionError, collectCodPayment, transitionCodCustody } from "../../../../../lib/cod-collection";

const privateHeaders = { "Cache-Control": "private, no-store" };
const json = (body: unknown, init: ResponseInit = {}) => Response.json(body, { ...init, headers: { ...privateHeaders, ...(init.headers ?? {}) } });

async function authorized(request: Request, orderId: number) {
  const authenticated = await requireLocalProfile(request, ["customer", "vendor", "admin", "delivery"]);
  const { profile } = authenticated;
  const db = getD1();
  const order = await db.prepare("SELECT id,vendor_id AS vendorId,customer_profile_id AS customerProfileId,delivery_method AS deliveryMethod FROM orders WHERE id=?").bind(orderId).first<{ id: number; vendorId: number; customerProfileId: number; deliveryMethod: string }>();
  if (!order) throw new CodCollectionError("Order not found", 404);
  if (profile.role === "customer") {
    throw new CodCollectionError("Only an assigned delivery operator or vendor can record COD collection", 403);
  } else if (profile.role === "vendor") {
    const access = await requireVendorPermission(request, "sale.write", authenticated);
    if (access.vendorId !== order.vendorId) throw new CodCollectionError("Order not found", 404);
  } else if (profile.role === "delivery") {
    const assigned = await db.prepare(`SELECT a.id FROM delivery_assignments a JOIN delivery_agents agent ON agent.id=a.agent_id
      WHERE a.order_id=? AND agent.profile_id=? AND a.status NOT IN ('cancelled')`).bind(orderId, profile.id).first();
    if (!assigned) throw new CodCollectionError("This delivery is not assigned to you", 403);
  }
  return { profile, order };
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const orderId = Number((await context.params).id);
    if (!Number.isInteger(orderId) || orderId < 1) return json({ error: "Order is invalid" }, { status: 400 });
    const { profile } = await authorized(request, orderId);
    const body = await request.json() as Record<string, unknown>;
    const action = String(body.action ?? "collect");
    if (action !== "collect" && !["vendor", "admin"].includes(profile.role)) {
      return json({ error: "Only vendor or administrator staff can reconcile COD custody" }, { status: 403 });
    }
    const result = action === "collect"
      ? await collectCodPayment({ db: getD1(), orderId, actorProfileId: profile.id, amountPaise: body.amountPaise, tenderMode: body.tenderMode, receiptReference: body.receiptReference, idempotencyKey: body.idempotencyKey, notes: body.notes, requestId: request.headers.get("cf-ray") ?? "" })
      : action === "deposit" || action === "reconcile"
        ? await transitionCodCustody({ db: getD1(), orderId, actorProfileId: profile.id, action, reference: body.reference, requestId: request.headers.get("cf-ray") ?? "" })
        : (() => { throw new CodCollectionError("COD collection action is invalid", 400); })();
    return json(result);
  } catch (error) {
    if (error instanceof CodCollectionError) return json({ error: error.message }, { status: error.status });
    return errorResponse(error);
  }
}
