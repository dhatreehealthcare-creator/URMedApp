import { getD1 } from "../../../../db/d1";
import { appendAuditEvent } from "../../../../lib/audit";
import { errorResponse, requireLocalProfile } from "../../../../lib/auth-server";
import { requireVendorPermission } from "../../../../lib/vendor-access";
import { validateSupplierReturn } from "../../../../lib/operations-controls";

export async function GET(request: Request) {
  try {
    const { profile } = await requireLocalProfile(request, ["vendor"]);
    const vendorId = profile.vendorId!; const db = getD1();
    await requireVendorPermission(request, "inventory.read");
    const [summary, alerts, sales, inventory, returns, supplierReturns, returnablePurchases, temperatures, registers] = await Promise.all([
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
        i.quantity, i.sale_price_paise AS salePricePaise, i.storage_location AS storageLocation,
        p.cold_chain_required AS coldChainRequired, i.quarantine_status AS quarantineStatus
        FROM pharmacy_inventory i JOIN products p ON p.id=i.product_id WHERE i.vendor_id=? ORDER BY p.name, date(i.expiry_date) LIMIT 250`).bind(vendorId).all(),
      db.prepare(`SELECT return_number AS returnNumber, credit_note_number AS creditNoteNumber, source_type AS sourceType,
        source_id AS sourceId, reason, refund_paise AS refundPaise, status, created_at AS createdAt
        FROM sales_returns WHERE vendor_id=? ORDER BY id DESC LIMIT 50`).bind(vendorId).all(),
      db.prepare(`SELECT r.return_number AS returnNumber,r.debit_note_number AS debitNoteNumber,r.reason,
        r.total_paise AS totalPaise,r.status,r.created_at AS createdAt,s.business_name AS supplierName,
        po.purchase_number AS purchaseNumber FROM supplier_returns r JOIN suppliers s ON s.id=r.supplier_id
        JOIN purchase_orders po ON po.id=r.purchase_order_id WHERE r.vendor_id=? ORDER BY r.id DESC LIMIT 50`).bind(vendorId).all(),
      db.prepare(`SELECT item.id AS purchaseOrderItemId,item.purchase_order_id AS purchaseOrderId,
        item.inventory_id AS inventoryId,item.product_id AS productId,p.name AS productName,
        item.batch_number AS batchNumber,item.quantity + item.free_quantity AS purchasedQuantity,
        item.purchase_price_paise AS purchasePricePaise,po.purchase_number AS purchaseNumber,
        po.supplier_id AS supplierId,s.business_name AS supplierName,i.quantity AS currentQuantity,
        COALESCE((SELECT SUM(ri.quantity) FROM supplier_return_items ri JOIN supplier_returns r ON r.id=ri.supplier_return_id
          WHERE ri.purchase_order_item_id=item.id AND r.status<>'cancelled'),0) AS returnedQuantity
        FROM purchase_order_items item JOIN purchase_orders po ON po.id=item.purchase_order_id
        JOIN suppliers s ON s.id=po.supplier_id JOIN products p ON p.id=item.product_id
        JOIN pharmacy_inventory i ON i.id=item.inventory_id
        WHERE po.vendor_id=? AND po.status='posted' AND i.quantity>0
        ORDER BY po.invoice_date DESC,item.id DESC LIMIT 250`).bind(vendorId).all(),
      db.prepare(`SELECT t.id, t.storage_location AS storageLocation, t.temperature_celsius_x10 AS temperatureCelsiusX10,
        t.within_range AS withinRange, t.excursion_action AS excursionAction, t.recorded_at AS recordedAt,
        p.name AS productName, i.batch_number AS batchNumber FROM temperature_logs t
        LEFT JOIN pharmacy_inventory i ON i.id=t.inventory_id LEFT JOIN products p ON p.id=i.product_id
        WHERE t.vendor_id=? ORDER BY t.id DESC LIMIT 50`).bind(vendorId).all(),
      db.prepare(`SELECT register_type AS registerType, serial_number AS serialNumber, transaction_date AS transactionDate,
        patient_name AS patientName, prescriber_name AS prescriberName, batch_number AS batchNumber,
        quantity_supplied AS quantitySupplied, retention_until AS retentionUntil FROM statutory_register_entries
        WHERE vendor_id=? ORDER BY transaction_date DESC, id DESC LIMIT 100`).bind(vendorId).all(),
    ]);
    return Response.json({ summary, alerts: alerts.results, sales: sales.results, inventory: inventory.results,
      returns: returns.results, supplierReturns: supplierReturns.results, returnablePurchases: returnablePurchases.results,
      temperatures: temperatures.results, registers: registers.results });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const { profile } = await requireLocalProfile(request, ["vendor"]); const vendorId = profile.vendorId!;
    const body = await request.json() as Record<string, unknown>; const action = String(body.action ?? ""); const db = getD1();
    await requireVendorPermission(request, action === "supplier_return" ? "purchase.write" : ["offline_sale","return"].includes(action) ? "sale.write" : "inventory.write");
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
      return Response.json({ recorded: true, withinRange, action: actionText });
    }
    if (action === "return") {
      const inventoryId=Number(body.inventoryId), sourceId=Number(body.sourceId), quantity=Number(body.quantity);
      const sourceType=String(body.sourceType ?? "online"), condition=String(body.condition ?? "sealed"), reason=String(body.reason ?? "").trim().slice(0,300);
      if (!Number.isInteger(inventoryId)||!Number.isInteger(sourceId)||!Number.isInteger(quantity)||quantity<1||!reason||!["online","offline"].includes(sourceType)||!["sealed","damaged","expired"].includes(condition)) return Response.json({error:"Return details are invalid"},{status:400});
      const item = await db.prepare(`SELECT i.id,i.quantity,i.expiry_date AS expiryDate, COALESCE((SELECT unit_price_paise FROM order_items WHERE inventory_id=i.id AND order_id=? LIMIT 1),(SELECT unit_price_paise FROM offline_sale_items WHERE inventory_id=i.id AND offline_sale_id=? LIMIT 1),i.sale_price_paise) AS unitPrice FROM pharmacy_inventory i WHERE i.id=? AND i.vendor_id=?`).bind(sourceId,sourceId,inventoryId,vendorId).first<{id:number;quantity:number;expiryDate:string;unitPrice:number}>();
      if(!item) return Response.json({error:"Return inventory batch not found"},{status:404});
      const sourceCount = await db.prepare(sourceType === "online" ? `SELECT COALESCE(SUM(quantity),0) AS qty FROM order_items WHERE order_id=? AND inventory_id=?` : `SELECT COALESCE(SUM(quantity),0) AS qty FROM offline_sale_items WHERE offline_sale_id=? AND inventory_id=?`).bind(sourceId,inventoryId).first<{qty:number}>();
      const prior = await db.prepare(`SELECT COALESCE(SUM(ri.quantity),0) AS qty FROM sales_return_items ri JOIN sales_returns r ON r.id=ri.sales_return_id WHERE r.vendor_id=? AND r.source_type=? AND r.source_id=? AND ri.inventory_id=?`).bind(vendorId,sourceType,sourceId,inventoryId).first<{qty:number}>();
      if(quantity > Number(sourceCount?.qty ?? 0)-Number(prior?.qty ?? 0)) return Response.json({error:"Return quantity exceeds the unreturned sold quantity"},{status:409});
      const saleable = condition === "sealed" && item.expiryDate >= new Date().toISOString().slice(0,10);
      const nonce=`${Date.now()}-${crypto.randomUUID().slice(0,8)}`, returnNumber=`RET-${nonce}`, creditNote=`CN-${nonce}`;
      const refund=quantity*item.unitPrice;
      try {
        await db.batch([
          db.prepare(`INSERT INTO sales_returns (return_number,vendor_id,source_type,source_id,reason,credit_note_number,refund_paise,status,created_by_profile_id) VALUES (?,?,?,?,?,?,?,'completed',?)`).bind(returnNumber,vendorId,sourceType,sourceId,reason,creditNote,refund,profile.id),
          db.prepare(`INSERT INTO sales_return_items (sales_return_id,inventory_id,quantity,condition,disposition,amount_paise)
            SELECT id,?,?,?,?,? FROM sales_returns WHERE return_number=?`).bind(inventoryId,quantity,condition,saleable?"restocked":"quarantined",refund,returnNumber),
          db.prepare(`UPDATE pharmacy_inventory SET quantity=quantity+?, quarantine_status=CASE WHEN ? THEN quarantine_status ELSE 'returned_quarantine' END, updated_at=CURRENT_TIMESTAMP WHERE id=? AND vendor_id=?`).bind(saleable?quantity:0,saleable?1:0,inventoryId,vendorId),
          db.prepare(`INSERT INTO stock_ledger (vendor_id,inventory_id,movement_type,quantity_delta,balance_after,reference_type,reference_id,reason,actor_profile_id)
            SELECT i.vendor_id,i.id,?, ?,i.quantity,'sales_return',r.id,?,? FROM pharmacy_inventory i JOIN sales_returns r ON r.return_number=? WHERE i.id=? AND i.vendor_id=?`).bind(saleable?"sale_return_restock":"sale_return_quarantine",saleable?quantity:0,reason,profile.id,returnNumber,inventoryId,vendorId),
          db.prepare(`INSERT INTO ledger_entries (vendor_id,account_code,entry_date,description,debit_paise,credit_paise,reference_type,reference_id,created_by_profile_id)
            SELECT vendor_id,'SALES_RETURNS',date('now'),'Credit note '||credit_note_number,refund_paise,0,'sales_return',id,? FROM sales_returns WHERE return_number=?`).bind(profile.id,returnNumber),
          db.prepare(`INSERT INTO ledger_entries (vendor_id,account_code,entry_date,description,debit_paise,credit_paise,reference_type,reference_id,created_by_profile_id)
            SELECT vendor_id,'CUSTOMER_REFUNDS',date('now'),'Refund '||credit_note_number,0,refund_paise,'sales_return',id,? FROM sales_returns WHERE return_number=?`).bind(profile.id,returnNumber),
        ]);
      } catch (error) {
        if (/sales_return_quantity_invalid/i.test(error instanceof Error ? error.message : "")) return Response.json({error:"Return quantity changed or exceeds the unreturned sold quantity"},{status:409});
        throw error;
      }
      const returnRow=await db.prepare(`SELECT id FROM sales_returns WHERE return_number=?`).bind(returnNumber).first<{id:number}>();
      await appendAuditEvent({vendorId,actorProfileId:profile.id,action:"sales_return.completed",entityType:"sales_return",entityId:returnRow!.id,after:{sourceType,sourceId,inventoryId,quantity,refund,disposition:saleable?"restocked":"quarantined"},requestId:request.headers.get("cf-ray")??""});
      return Response.json({created:true,returnNumber,creditNote,refundPaise:refund,disposition:saleable?"restocked":"quarantined"},{status:201});
    }
    if (action === "offline_sale") {
      const inventoryId=Number(body.inventoryId), quantity=Number(body.quantity); const customerName=String(body.customerName??"Walk-in customer").trim().slice(0,160)||"Walk-in customer";
      const customerPhone=String(body.customerPhone??"").replace(/\D/g,"").slice(0,10), paymentMode=String(body.paymentMode??"cash").trim().slice(0,40);
      if(!Number.isInteger(inventoryId)||!Number.isInteger(quantity)||quantity<1||!new Set(["cash","upi","card","credit"]).has(paymentMode)) return Response.json({error:"Counter-sale details are invalid"},{status:400});
      if(customerPhone&&customerPhone.length!==10) return Response.json({error:"Customer phone must contain exactly 10 digits"},{status:400});
      const item=await db.prepare(`SELECT i.id,i.product_id AS productId,i.batch_number AS batchNumber,i.expiry_date AS expiryDate,i.sale_price_paise AS unitPrice,i.gst_percent AS gstPercent,p.name AS productName,v.gst_number AS gstNumber
        FROM pharmacy_inventory i JOIN products p ON p.id=i.product_id JOIN vendors v ON v.id=i.vendor_id WHERE i.id=? AND i.vendor_id=? AND i.active=1 AND p.active=1
          AND v.approval_status='approved' AND v.compliance_status='verified' AND v.suspended_at IS NULL
          AND i.quarantine_status='available' AND i.cold_chain_status IN ('not_applicable','within_range') AND date(i.expiry_date)>=date('now')
          AND (i.quantity-i.reserved_quantity)>=? AND i.id=(SELECT first.id FROM pharmacy_inventory first WHERE first.vendor_id=i.vendor_id AND first.product_id=i.product_id AND first.active=1 AND first.quarantine_status='available' AND date(first.expiry_date)>=date('now') AND (first.quantity-first.reserved_quantity)>0 ORDER BY date(first.expiry_date),first.id LIMIT 1)`)
        .bind(inventoryId,vendorId,quantity).first<{id:number;productId:number;batchNumber:string;expiryDate:string;unitPrice:number;gstPercent:number;productName:string;gstNumber:string}>();
      if(!item)return Response.json({error:"Select the earliest-expiry eligible batch with sufficient stock"},{status:409});
      const sellerStateCode=/^\d{2}/.test(item.gstNumber)?item.gstNumber.slice(0,2):"";
      if(item.gstPercent>0&&!sellerStateCode)return Response.json({error:"Add a valid GSTIN before billing GST-rated stock"},{status:409});
      const taxable=item.unitPrice*quantity,tax=Math.round(taxable*item.gstPercent/100),total=taxable+tax; const saleNumber=`POS-${Date.now()}-${crypto.randomUUID().slice(0,6)}`;
      try {
        const results=await db.batch([
          db.prepare(`INSERT INTO offline_sales (sale_number,vendor_id,customer_name,customer_phone,subtotal_paise,tax_paise,discount_paise,total_paise,payment_mode,created_by_profile_id) VALUES (?,?,?,?,?,?,0,?,?,?)`).bind(saleNumber,vendorId,customerName,customerPhone,taxable,tax,total,paymentMode,profile.id),
          db.prepare(`INSERT INTO offline_sale_items (offline_sale_id,inventory_id,product_id,batch_number,expiry_date,quantity,unit_price_paise,gst_percent,taxable_paise,tax_paise,line_total_paise) SELECT id,?,?,?,?,?,?,?,?,?,? FROM offline_sales WHERE sale_number=?`).bind(inventoryId,item.productId,item.batchNumber,item.expiryDate,quantity,item.unitPrice,item.gstPercent,taxable,tax,total,saleNumber),
          db.prepare(`UPDATE pharmacy_inventory SET quantity=quantity-?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND vendor_id=? AND active=1 AND quarantine_status='available' AND date(expiry_date)>=date('now') AND (quantity-reserved_quantity)>=?`).bind(quantity,inventoryId,vendorId,quantity),
          db.prepare(`INSERT INTO stock_ledger (vendor_id,inventory_id,movement_type,quantity_delta,balance_after,reference_type,reference_id,reason,actor_profile_id) SELECT ?,?,'offline_sale',-?,i.quantity,'offline_sale',sale.id,'Counter sale',? FROM pharmacy_inventory i JOIN offline_sales sale ON sale.sale_number=? WHERE i.id=?`).bind(vendorId,inventoryId,quantity,profile.id,saleNumber,inventoryId),
          db.prepare(`INSERT INTO tax_invoices (invoice_number,vendor_id,source_type,source_id,seller_gstin,buyer_gstin,place_of_supply_state_code,subtotal_paise,cgst_paise,sgst_paise,igst_paise,total_paise) SELECT 'GST-'||sale.sale_number,sale.vendor_id,'offline_sale',sale.id,v.gst_number,'',?,sale.subtotal_paise,CAST(sale.tax_paise/2 AS INTEGER),sale.tax_paise-CAST(sale.tax_paise/2 AS INTEGER),0,sale.total_paise FROM offline_sales sale JOIN vendors v ON v.id=sale.vendor_id WHERE sale.sale_number=?`).bind(sellerStateCode||"00",saleNumber),
          db.prepare(`INSERT INTO ledger_entries (vendor_id,account_code,entry_date,description,debit_paise,credit_paise,reference_type,reference_id,created_by_profile_id) SELECT vendor_id,'CASH_BANK',date('now'),'Counter receipt '||sale_number,total_paise,0,'offline_sale',id,? FROM offline_sales WHERE sale_number=?`).bind(profile.id,saleNumber),
          db.prepare(`INSERT INTO ledger_entries (vendor_id,account_code,entry_date,description,debit_paise,credit_paise,reference_type,reference_id,created_by_profile_id) SELECT vendor_id,'SALES',date('now'),'Counter sale '||sale_number,0,subtotal_paise,'offline_sale',id,? FROM offline_sales WHERE sale_number=?`).bind(profile.id,saleNumber),
          db.prepare(`INSERT INTO ledger_entries (vendor_id,account_code,entry_date,description,debit_paise,credit_paise,reference_type,reference_id,created_by_profile_id) SELECT vendor_id,'GST_PAYABLE',date('now'),'GST '||sale_number,0,tax_paise,'offline_sale',id,? FROM offline_sales WHERE sale_number=? AND tax_paise>0`).bind(profile.id,saleNumber),
        ]);
        if(!results[2]?.meta.changes)return Response.json({error:"Stock changed during billing. Refresh and retry"},{status:409});
      } catch (error) {
        if (/offline_sale_stock_invalid|stock_unavailable|fefo_violation/i.test(error instanceof Error ? error.message : "")) return Response.json({error:"Stock changed during billing. Refresh and retry"},{status:409});
        throw error;
      }
      const sale=await db.prepare(`SELECT id FROM offline_sales WHERE sale_number=?`).bind(saleNumber).first<{id:number}>();
      await appendAuditEvent({vendorId,actorProfileId:profile.id,action:"offline_sale.completed",entityType:"offline_sale",entityId:sale!.id,after:{saleNumber,inventoryId,quantity,taxable,tax,total,paymentMode},requestId:request.headers.get("cf-ray")??""});
      return Response.json({created:true,saleNumber,totalPaise:total},{status:201});
    }
    if (action === "supplier_return") {
      const purchaseOrderItemId=Number(body.purchaseOrderItemId), quantity=Number(body.quantity);
      const reason=String(body.reason??"").trim().slice(0,300);
      if(!Number.isInteger(purchaseOrderItemId)||!Number.isInteger(quantity)||quantity<1||reason.length<5) return Response.json({error:"Purchase item, quantity and a clear return reason are required"},{status:400});
      const item=await db.prepare(`SELECT item.id,item.purchase_order_id AS purchaseOrderId,item.inventory_id AS inventoryId,
        item.purchase_price_paise AS purchasePricePaise,item.quantity+item.free_quantity AS purchasedQuantity,
        po.supplier_id AS supplierId,i.quantity AS currentQuantity,
        COALESCE((SELECT SUM(ri.quantity) FROM supplier_return_items ri JOIN supplier_returns r ON r.id=ri.supplier_return_id
          WHERE ri.purchase_order_item_id=item.id AND r.status<>'cancelled'),0) AS returnedQuantity
        FROM purchase_order_items item JOIN purchase_orders po ON po.id=item.purchase_order_id
        JOIN pharmacy_inventory i ON i.id=item.inventory_id
        WHERE item.id=? AND po.vendor_id=? AND po.status='posted'`).bind(purchaseOrderItemId,vendorId)
        .first<{id:number;purchaseOrderId:number;inventoryId:number;purchasePricePaise:number;purchasedQuantity:number;supplierId:number;currentQuantity:number;returnedQuantity:number}>();
      if(!item)return Response.json({error:"Posted purchase item not found"},{status:404});
      try{validateSupplierReturn({quantity,currentQuantity:item.currentQuantity,purchasedQuantity:item.purchasedQuantity,returnedQuantity:item.returnedQuantity});}
      catch(error){return Response.json({error:error instanceof Error?error.message:"Return quantity is invalid"},{status:409});}
      const nonce=`${Date.now()}-${crypto.randomUUID().slice(0,8)}`,returnNumber=`SRET-${nonce}`,debitNoteNumber=`DN-${nonce}`,totalPaise=quantity*item.purchasePricePaise;
      try {
        const results=await db.batch([
          db.prepare(`INSERT INTO supplier_returns (return_number,vendor_id,supplier_id,purchase_order_id,debit_note_number,reason,total_paise,status,created_by_profile_id) VALUES (?,?,?,?,?,?,?,'completed',?)`).bind(returnNumber,vendorId,item.supplierId,item.purchaseOrderId,debitNoteNumber,reason,totalPaise,profile.id),
          db.prepare(`INSERT INTO supplier_return_items (supplier_return_id,purchase_order_item_id,inventory_id,quantity,amount_paise,disposition)
            SELECT id,?,?,?,?,'returned_to_supplier' FROM supplier_returns WHERE return_number=?`).bind(purchaseOrderItemId,item.inventoryId,quantity,totalPaise,returnNumber),
          db.prepare(`UPDATE pharmacy_inventory SET quantity=quantity-?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND vendor_id=? AND quantity>=?`).bind(quantity,item.inventoryId,vendorId,quantity),
          db.prepare(`INSERT INTO stock_ledger (vendor_id,inventory_id,movement_type,quantity_delta,balance_after,reference_type,reference_id,reason,actor_profile_id)
            SELECT ?,?,'supplier_return',-?,i.quantity,'supplier_return',r.id,?,? FROM pharmacy_inventory i JOIN supplier_returns r ON r.return_number=? WHERE i.id=?`).bind(vendorId,item.inventoryId,quantity,reason,profile.id,returnNumber,item.inventoryId),
          db.prepare(`INSERT INTO ledger_entries (vendor_id,account_code,entry_date,description,debit_paise,credit_paise,reference_type,reference_id,created_by_profile_id)
            SELECT vendor_id,'SUPPLIER_PAYABLE',date('now'),'Debit note '||debit_note_number,total_paise,0,'supplier_return',id,? FROM supplier_returns WHERE return_number=?`).bind(profile.id,returnNumber),
          db.prepare(`INSERT INTO ledger_entries (vendor_id,account_code,entry_date,description,debit_paise,credit_paise,reference_type,reference_id,created_by_profile_id)
            SELECT vendor_id,'PURCHASE_RETURNS',date('now'),'Purchase return '||return_number,0,total_paise,'supplier_return',id,? FROM supplier_returns WHERE return_number=?`).bind(profile.id,returnNumber),
        ]);
        if(!results[2]?.meta.changes)return Response.json({error:"Stock changed during return processing. Refresh and retry"},{status:409});
      } catch (error) {
        if (/supplier_return_quantity_invalid/i.test(error instanceof Error ? error.message : "")) return Response.json({error:"Stock or returnable quantity changed. Refresh and retry"},{status:409});
        throw error;
      }
      const saved=await db.prepare(`SELECT id FROM supplier_returns WHERE return_number=?`).bind(returnNumber).first<{id:number}>();
      await appendAuditEvent({vendorId,actorProfileId:profile.id,action:"supplier_return.completed",entityType:"supplier_return",entityId:saved!.id,after:{returnNumber,debitNoteNumber,purchaseOrderItemId,quantity,totalPaise,reason},requestId:request.headers.get("cf-ray")??""});
      return Response.json({created:true,returnNumber,debitNoteNumber,totalPaise},{status:201});
    }
    return Response.json({ error: "Vendor operation is invalid" }, { status: 400 });
  } catch (error) { return errorResponse(error); }
}
