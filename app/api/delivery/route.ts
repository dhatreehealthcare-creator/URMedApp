import { getD1 } from "../../../db/d1";
import { appendAuditEvent } from "../../../lib/audit";
import { errorResponse, requireLocalProfile } from "../../../lib/auth-server";

export async function GET(request:Request){
  try{
    const {profile}=await requireLocalProfile(request,["delivery"]);const db=getD1();
    const agent=await db.prepare(`SELECT id,vehicle_type AS vehicleType,vehicle_number AS vehicleNumber,
      licence_number AS licenceNumber,availability_status AS availabilityStatus,current_latitude AS currentLatitude,
      current_longitude AS currentLongitude FROM delivery_agents WHERE profile_id=?`).bind(profile.id).first();
    if(!agent)return Response.json({error:"Delivery-agent profile not found"},{status:404});
    const assignments=await db.prepare(`SELECT a.id AS assignmentId,o.id AS orderId,o.order_number AS orderNumber,
      o.customer_name AS customerName,o.customer_phone AS customerPhone,o.delivery_address AS deliveryAddress,
      o.latitude,o.longitude,o.delivery_status AS deliveryStatus,o.payment_method AS paymentMethod,
      o.payment_status AS paymentStatus,o.total_paise AS totalPaise,v.business_name AS businessName,
      v.address AS pickupAddress,v.latitude AS pickupLatitude,v.longitude AS pickupLongitude,
      a.status AS assignmentStatus,a.assigned_at AS assignedAt,a.picked_up_at AS pickedUpAt,a.delivered_at AS deliveredAt
      FROM delivery_assignments a JOIN orders o ON o.id=a.order_id JOIN vendors v ON v.id=o.vendor_id
      JOIN delivery_agents agent ON agent.id=a.agent_id WHERE agent.profile_id=? AND a.status<>'cancelled'
      ORDER BY CASE a.status WHEN 'delivered' THEN 2 ELSE 1 END,a.id DESC LIMIT 100`).bind(profile.id).all();
    return Response.json({profile,agent,assignments:assignments.results});
  }catch(error){return errorResponse(error);}
}

export async function POST(request:Request){
  try{
    const {profile}=await requireLocalProfile(request,["delivery"]);const body=await request.json() as Record<string,unknown>;
    const availability=String(body.availabilityStatus??"");const latitude=String(body.latitude??"").trim(),longitude=String(body.longitude??"").trim();
    const source=body.source==="gps_watch"?"gps_watch":"manual";
    const lat=Number(latitude),lon=Number(longitude);
    if(!["available","online","offline"].includes(availability)||!Number.isFinite(lat)||lat< -90||lat>90||!Number.isFinite(lon)||lon< -180||lon>180)return Response.json({error:"Availability and valid location coordinates are required"},{status:400});
    const result=await getD1().prepare(`UPDATE delivery_agents SET availability_status=?,current_latitude=?,current_longitude=?,updated_at=CURRENT_TIMESTAMP WHERE profile_id=?`).bind(availability,latitude,longitude,profile.id).run();
    if(!result.meta.changes)return Response.json({error:"Delivery-agent profile not found"},{status:404});
    await appendAuditEvent({actorProfileId:profile.id,action:source==="gps_watch"?"delivery_agent.location_ping":"delivery_agent.availability",entityType:"delivery_agent",entityId:profile.id,after:{availability,latitude,longitude,source},requestId:request.headers.get("cf-ray")??""});
    return Response.json({updated:true});
  }catch(error){return errorResponse(error);}
}
