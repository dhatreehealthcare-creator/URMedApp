import { getD1 } from "../../../../db/d1";
import { errorResponse } from "../../../../lib/auth-server";
import { requireVendorPermission } from "../../../../lib/vendor-access";
import {
  escapeSupplierSqlLike,
  parseVendorSupplierQuery,
  vendorSupplierSortExpression,
} from "../../../../lib/vendor-supplier-query";

type SupplierSummaryRow = {
  id: number;
  businessName: string;
  contactName: string;
  phone: string;
  email: string;
  address: string;
  gstNumber: string;
  drugLicenceNumber: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  purchaseCount: number;
  grossPurchasePaise: number;
  returnPaise: number;
  payablePaise: number;
  lastPurchaseDate: string | null;
};

const receivedPurchasePredicate = "purchase.status IN ('partially_received', 'received', 'posted')";

export async function GET(request: Request) {
  try {
    const { vendorId } = await requireVendorPermission(request, "purchase.write");
    const filters = parseVendorSupplierQuery(new URL(request.url));
    const predicates = ["supplier.vendor_id = ?"];
    const bindings: Array<string | number> = [vendorId];
    if (filters.status !== "all") {
      predicates.push("supplier.status = ?");
      bindings.push(filters.status);
    }
    if (filters.query) {
      const pattern = `%${escapeSupplierSqlLike(filters.query)}%`;
      predicates.push(`(
        supplier.business_name LIKE ? ESCAPE '\\'
        OR supplier.contact_name LIKE ? ESCAPE '\\'
        OR supplier.phone LIKE ? ESCAPE '\\'
        OR supplier.email LIKE ? ESCAPE '\\'
        OR supplier.gst_number LIKE ? ESCAPE '\\'
      )`);
      bindings.push(pattern, pattern, pattern, pattern, pattern);
    }
    const where = predicates.join(" AND ");
    const db = getD1();
    const [count, supplierResult, totals] = await Promise.all([
      db.prepare(`SELECT COUNT(*) AS count FROM suppliers supplier WHERE ${where}`)
        .bind(...bindings).first<{ count: number }>(),
      db.prepare(`
        SELECT supplier.id, supplier.business_name AS businessName,
          supplier.contact_name AS contactName, supplier.phone, supplier.email,
          supplier.address, supplier.gst_number AS gstNumber,
          supplier.drug_licence_number AS drugLicenceNumber, supplier.status,
          supplier.created_at AS createdAt, supplier.updated_at AS updatedAt,
          (SELECT COUNT(*) FROM purchase_orders purchase
            WHERE purchase.supplier_id = supplier.id AND purchase.vendor_id = supplier.vendor_id
              AND ${receivedPurchasePredicate}) AS purchaseCount,
          COALESCE((SELECT SUM(purchase.total_paise) FROM purchase_orders purchase
            WHERE purchase.supplier_id = supplier.id AND purchase.vendor_id = supplier.vendor_id
              AND ${receivedPurchasePredicate}), 0) AS grossPurchasePaise,
          COALESCE((SELECT SUM(supplier_return.total_paise) FROM supplier_returns supplier_return
            WHERE supplier_return.supplier_id = supplier.id
              AND supplier_return.vendor_id = supplier.vendor_id
              AND supplier_return.status = 'completed'), 0) AS returnPaise,
          COALESCE((SELECT SUM(ledger.credit_paise - ledger.debit_paise)
            FROM ledger_entries ledger
            JOIN purchase_orders purchase ON purchase.id = ledger.reference_id
            WHERE ledger.vendor_id = supplier.vendor_id
              AND ledger.reference_type = 'purchase_order'
              AND purchase.vendor_id = supplier.vendor_id
              AND purchase.supplier_id = supplier.id
              AND ledger.account_code IN ('ACCOUNTS_PAYABLE', 'SUPPLIER_PAYABLE')), 0)
          + COALESCE((SELECT SUM(ledger.credit_paise - ledger.debit_paise)
            FROM ledger_entries ledger
            JOIN purchase_receipts receipt ON receipt.id = ledger.reference_id
            JOIN purchase_orders purchase ON purchase.id = receipt.purchase_order_id
            WHERE ledger.vendor_id = supplier.vendor_id
              AND ledger.reference_type = 'purchase_receipt'
              AND receipt.vendor_id = supplier.vendor_id
              AND purchase.vendor_id = supplier.vendor_id
              AND purchase.supplier_id = supplier.id
              AND ledger.account_code IN ('ACCOUNTS_PAYABLE', 'SUPPLIER_PAYABLE')), 0)
          + COALESCE((SELECT SUM(ledger.credit_paise - ledger.debit_paise)
            FROM ledger_entries ledger
            JOIN supplier_returns supplier_return ON supplier_return.id = ledger.reference_id
            WHERE ledger.vendor_id = supplier.vendor_id
              AND ledger.reference_type = 'supplier_return'
              AND supplier_return.vendor_id = supplier.vendor_id
              AND supplier_return.supplier_id = supplier.id
              AND ledger.account_code IN ('ACCOUNTS_PAYABLE', 'SUPPLIER_PAYABLE')), 0) AS payablePaise,
          (SELECT MAX(purchase.invoice_date) FROM purchase_orders purchase
            WHERE purchase.supplier_id = supplier.id AND purchase.vendor_id = supplier.vendor_id
              AND ${receivedPurchasePredicate}) AS lastPurchaseDate
        FROM suppliers supplier
        WHERE ${where}
        ORDER BY ${vendorSupplierSortExpression(filters.sort)}
        LIMIT ? OFFSET ?
      `).bind(...bindings, filters.pageSize, (filters.page - 1) * filters.pageSize).all<SupplierSummaryRow>(),
      db.prepare(`
        SELECT COUNT(*) AS total,
          COALESCE(SUM(CASE WHEN supplier.status = 'active' THEN 1 ELSE 0 END), 0) AS active,
          COALESCE(SUM(CASE WHEN supplier.status = 'inactive' THEN 1 ELSE 0 END), 0) AS inactive
        FROM suppliers supplier WHERE supplier.vendor_id = ?
      `).bind(vendorId).first<{ total: number; active: number; inactive: number }>(),
    ]);
    const total = Number(count?.count ?? 0);
    return Response.json({
      suppliers: supplierResult.results,
      totals: totals ?? { total: 0, active: 0, inactive: 0 },
      pagination: {
        page: filters.page,
        pageSize: filters.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / filters.pageSize)),
      },
      filters,
      balanceBasis: "recorded_supplier_ledger",
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
