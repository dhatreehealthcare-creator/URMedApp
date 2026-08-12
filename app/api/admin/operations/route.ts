import { getD1 } from "../../../../db/d1";
import { requireAdminProfile } from "../../../../lib/admin-access";
import { appendAuditEvent } from "../../../../lib/audit";
import { errorResponse } from "../../../../lib/auth-server";

export async function GET(request: Request) {
  try {
    await requireAdminProfile(request); const db=getD1();
    const [summary,categories,stores,stock,sales,expenses,ledger,deliveries,deliveryAgents,governance] = await Promise.all([
      db.prepare(`SELECT
        (SELECT COUNT(*) FROM vendors) AS vendors,
        (SELECT COUNT(*) FROM vendors WHERE compliance_status='verified') AS verifiedVendors,
        (SELECT COUNT(*) FROM products WHERE active=1) AS products,
        (SELECT COUNT(*) FROM orders) AS orders,
        (SELECT COALESCE(SUM(total_paise),0) FROM orders WHERE order_status='completed') AS onlineSalesPaise,
        (SELECT COALESCE(SUM(total_paise),0) FROM offline_sales) AS offlineSalesPaise,
        (SELECT COALESCE(SUM(amount_paise),0) FROM expenses) AS expensesPaise,
        (SELECT COUNT(*) FROM delivery_assignments WHERE status NOT IN ('delivered','cancelled')) AS activeDeliveries`).first(),
      db.prepare(`SELECT id,name,status FROM categories ORDER BY name`).all(),
      db.prepare(`SELECT v.id,v.business_name AS businessName,v.owner_name AS ownerName,v.email,v.phone,v.latitude,v.longitude,v.approval_status AS approvalStatus,v.compliance_status AS complianceStatus,v.home_delivery AS homeDelivery FROM vendors v ORDER BY v.id DESC LIMIT 250`).all(),
      db.prepare(`SELECT p.name AS productName,p.manufacturer,SUM(i.quantity) AS quantity,SUM(i.reserved_quantity) AS reservedQuantity,COUNT(DISTINCT i.vendor_id) AS stores,MIN(i.expiry_date) AS nearestExpiry FROM pharmacy_inventory i JOIN products p ON p.id=i.product_id WHERE i.active=1 GROUP BY p.id,p.name,p.manufacturer ORDER BY quantity ASC,p.name LIMIT 250`).all(),
      db.prepare(`SELECT date(created_at) AS saleDate,'online' AS channel,COUNT(*) AS transactions,SUM(total_paise) AS totalPaise FROM orders GROUP BY date(created_at) UNION ALL SELECT date(created_at),'offline',COUNT(*),SUM(total_paise) FROM offline_sales GROUP BY date(created_at) ORDER BY saleDate DESC LIMIT 120`).all(),
      db.prepare(`SELECT e.id,e.purpose,e.expense_head AS expenseHead,e.amount_paise AS amountPaise,e.expense_date AS expenseDate,e.payment_mode AS paymentMode,e.reference_number AS referenceNumber,v.business_name AS businessName FROM expenses e LEFT JOIN vendors v ON v.id=e.vendor_id ORDER BY e.expense_date DESC,e.id DESC LIMIT 100`).all(),
      db.prepare(`SELECT l.id,l.account_code AS accountCode,l.entry_date AS entryDate,l.description,l.debit_paise AS debitPaise,l.credit_paise AS creditPaise,l.reference_type AS referenceType,v.business_name AS businessName FROM ledger_entries l LEFT JOIN vendors v ON v.id=l.vendor_id ORDER BY l.entry_date DESC,l.id DESC LIMIT 200`).all(),
      db.prepare(`SELECT o.id AS orderId,o.order_number AS orderNumber,o.customer_name AS customerName,o.delivery_method AS deliveryMethod,o.delivery_status AS deliveryStatus,o.delivery_address AS deliveryAddress,o.created_at AS createdAt,v.business_name AS businessName,agent.name AS agentName,a.status AS assignmentStatus,a.assigned_at AS assignedAt,a.delivered_at AS deliveredAt FROM orders o JOIN vendors v ON v.id=o.vendor_id LEFT JOIN delivery_assignments a ON a.id=(SELECT id FROM delivery_assignments latest WHERE latest.order_id=o.id AND latest.status<>'cancelled' ORDER BY latest.id DESC LIMIT 1) LEFT JOIN delivery_agents da ON da.id=a.agent_id LEFT JOIN account_profiles agent ON agent.id=da.profile_id WHERE o.delivery_method<>'pickup' ORDER BY o.id DESC LIMIT 150`).all(),
      db.prepare(`SELECT da.id,profile.name,profile.phone,da.vehicle_type AS vehicleType,da.vehicle_number AS vehicleNumber,
        da.availability_status AS availabilityStatus,da.current_latitude AS currentLatitude,da.current_longitude AS currentLongitude,
        (SELECT COUNT(*) FROM delivery_assignments a WHERE a.agent_id=da.id AND a.status NOT IN ('delivered','cancelled')) AS activeAssignments
        FROM delivery_agents da JOIN account_profiles profile ON profile.id=da.profile_id
        WHERE profile.status='active' ORDER BY CASE da.availability_status WHEN 'available' THEN 1 WHEN 'online' THEN 2 ELSE 3 END,profile.name`).all(),
      db.prepare(`SELECT
        (SELECT COUNT(*) FROM data_consents) AS consentEvents,
        (SELECT COUNT(*) FROM audit_events) AS auditEvents,
        (SELECT COUNT(*) FROM retention_policies) AS retentionPolicies,
        (SELECT COUNT(*) FROM breach_incidents WHERE closed_at IS NULL) AS openBreaches,
        (SELECT COUNT(*) FROM backup_runs WHERE verification_status='verified') AS verifiedBackups,
        (SELECT COUNT(*) FROM tax_invoices WHERE irn<>'') AS irnInvoices,
        (SELECT COUNT(*) FROM tax_invoices) AS taxInvoices`).first(),
    ]);
    return Response.json({summary,categories:categories.results,stores:stores.results,stock:stock.results,sales:sales.results,expenses:expenses.results,ledger:ledger.results,deliveries:deliveries.results,deliveryAgents:deliveryAgents.results,governance,eInvoice:{ready:Boolean(process.env.EINVOICE_API_URL&&process.env.EINVOICE_API_KEY),message:process.env.EINVOICE_API_URL&&process.env.EINVOICE_API_KEY?"Government e-invoice connector configured":"Awaiting authorized GST e-invoice provider credentials"}});
  } catch(error){return errorResponse(error);}
}

export async function POST(request: Request){
  try{
    const profile=await requireAdminProfile(request); const body=await request.json() as Record<string,unknown>; const action=String(body.action??""); const db=getD1();
    if(action==="category"){
      const name=String(body.name??"").trim().slice(0,100); const status=String(body.status??"active"); const id=Number(body.id||0);
      if(!name||!["active","inactive"].includes(status)) return Response.json({error:"Category name and status are required"},{status:400});
      if(id) await db.prepare(`UPDATE categories SET name=?,status=? WHERE id=?`).bind(name,status,id).run();
      else await db.prepare(`INSERT INTO categories (name,status) VALUES (?,?)`).bind(name,status).run();
      await appendAuditEvent({actorProfileId:profile.id,action:id?"category.updated":"category.created",entityType:"category",entityId:id||name,after:{name,status},requestId:request.headers.get("cf-ray")??""});
      return Response.json({updated:true});
    }
    if(action==="expense"){
      const purpose=String(body.purpose??"").trim().slice(0,200), expenseHead=String(body.expenseHead??"").trim().slice(0,100), paymentMode=String(body.paymentMode??"").trim().slice(0,50), reference=String(body.referenceNumber??"").trim().slice(0,100);
      const amountPaise=Math.round(Number(body.amount)*100), expenseDate=String(body.expenseDate??""); const vendorId=body.vendorId?Number(body.vendorId):null;
      const actorId=profile.id;
      if(!purpose||!expenseHead||!paymentMode||!Number.isInteger(amountPaise)||amountPaise<1||!/^\d{4}-\d{2}-\d{2}$/.test(expenseDate)) return Response.json({error:"Complete all expense fields with a positive amount"},{status:400});
      const result=await db.prepare(`INSERT INTO expenses (vendor_id,purpose,expense_head,amount_paise,expense_date,payment_mode,reference_number,created_by_profile_id) VALUES (?,?,?,?,?,?,?,?)`).bind(vendorId,purpose,expenseHead,amountPaise,expenseDate,paymentMode,reference,actorId).run();
      const expenseId=Number(result.meta.last_row_id);
      await db.batch([
        db.prepare(`INSERT INTO ledger_entries (vendor_id,account_code,entry_date,description,debit_paise,credit_paise,reference_type,reference_id,created_by_profile_id) VALUES (?,'EXPENSE',?,?,?,0,'expense',?,?)`).bind(vendorId,expenseDate,purpose,amountPaise,expenseId,actorId),
        db.prepare(`INSERT INTO ledger_entries (vendor_id,account_code,entry_date,description,debit_paise,credit_paise,reference_type,reference_id,created_by_profile_id) VALUES (?,'CASH_BANK',?,?,0,?,'expense',?,?)`).bind(vendorId,expenseDate,purpose,amountPaise,expenseId,actorId),
      ]);
      await appendAuditEvent({vendorId,actorProfileId:actorId,action:"expense.created",entityType:"expense",entityId:expenseId,after:{purpose,expenseHead,amountPaise,expenseDate,paymentMode},requestId:request.headers.get("cf-ray")??""});
      return Response.json({created:true,expenseId},{status:201});
    }
    if(action==="retention_policy"){
      const recordType=String(body.recordType??"").trim().slice(0,100), legalBasis=String(body.legalBasis??"").trim().slice(0,300), disposalMethod=String(body.disposalMethod??"").trim().slice(0,150), activeFrom=String(body.activeFrom??""); const months=Number(body.retentionMonths);
      if(!recordType||!legalBasis||!disposalMethod||!Number.isInteger(months)||months<1||months>240||!/^\d{4}-\d{2}-\d{2}$/.test(activeFrom)) return Response.json({error:"Retention policy details are invalid"},{status:400});
      await db.prepare(`INSERT INTO retention_policies (record_type,retention_months,legal_basis,disposal_method,active_from) VALUES (?,?,?,?,?)`).bind(recordType,months,legalBasis,disposalMethod,activeFrom).run();
      await appendAuditEvent({actorProfileId:profile.id,action:"retention_policy.created",entityType:"retention_policy",entityId:recordType,after:{months,legalBasis,disposalMethod,activeFrom},requestId:request.headers.get("cf-ray")??""});
      return Response.json({created:true},{status:201});
    }
    if(action==="assign_delivery"){
      const orderId=Number(body.orderId),agentId=Number(body.agentId);
      const actorId=profile.id;
      if(!Number.isInteger(orderId)||!Number.isInteger(agentId))return Response.json({error:"Order and delivery agent are required"},{status:400});
      const order=await db.prepare(`SELECT id,vendor_id AS vendorId,delivery_method AS deliveryMethod,delivery_status AS deliveryStatus,order_status AS orderStatus FROM orders WHERE id=?`).bind(orderId).first<{id:number;vendorId:number;deliveryMethod:string;deliveryStatus:string;orderStatus:string}>();
      const agent=await db.prepare(`SELECT da.id,da.availability_status AS availabilityStatus,profile.status FROM delivery_agents da JOIN account_profiles profile ON profile.id=da.profile_id WHERE da.id=?`).bind(agentId).first<{id:number;availabilityStatus:string;status:string}>();
      if(!order||order.deliveryMethod!=="urmed"||order.deliveryStatus!=="ready_for_pickup"||["completed","cancelled"].includes(order.orderStatus))return Response.json({error:"Only ready-for-pickup URMED orders can be assigned"},{status:409});
      if(!agent||agent.status!=="active"||!["available","online"].includes(agent.availabilityStatus))return Response.json({error:"Delivery agent is unavailable"},{status:409});
      try {
        await db.batch([
          db.prepare(`UPDATE delivery_assignments SET status='cancelled' WHERE order_id=? AND status NOT IN ('delivered','cancelled')`).bind(orderId),
          db.prepare(`INSERT INTO delivery_assignments (order_id,agent_id,assigned_by_profile_id,status) VALUES (?,?,?,'assigned')`).bind(orderId,agentId,actorId),
          db.prepare(`UPDATE orders SET delivery_status='assigned',order_status='processing',updated_at=CURRENT_TIMESTAMP WHERE id=? AND delivery_method='urmed' AND delivery_status='ready_for_pickup' AND order_status NOT IN ('completed','cancelled')`).bind(orderId),
          db.prepare(`INSERT INTO delivery_events (order_id,status,actor_profile_id,note) VALUES (?,'assigned',?,'URMED delivery agent assigned')`).bind(orderId,actorId),
        ]);
      } catch (error) {
        if (/delivery_assignment_invalid/i.test(error instanceof Error ? error.message : "")) return Response.json({error:"Order or rider availability changed. Refresh dispatch and retry."},{status:409});
        throw error;
      }
      await appendAuditEvent({vendorId:order.vendorId,actorProfileId:actorId,action:"delivery.assigned",entityType:"order",entityId:orderId,before:{deliveryStatus:order.deliveryStatus},after:{deliveryStatus:"assigned",agentId},requestId:request.headers.get("cf-ray")??""});
      return Response.json({assigned:true});
    }
    return Response.json({error:"Admin operation is invalid"},{status:400});
  }catch(error){return errorResponse(error);}
}
