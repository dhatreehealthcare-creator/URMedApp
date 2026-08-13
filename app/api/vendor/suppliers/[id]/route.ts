import { getD1 } from "../../../../../db/d1";
import { errorResponse } from "../../../../../lib/auth-server";
import { requireVendorPermission } from "../../../../../lib/vendor-access";
import { parseSupplierHistoryPage } from "../../../../../lib/vendor-supplier-query";

type SupplierDetailRow = {
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
};

type SupplierFinancialSummary = {
  purchaseCount: number;
  grossPurchasePaise: number;
  returnCount: number;
  returnPaise: number;
  payablePaise: number;
  unpaidPurchaseCount: number;
  lastPurchaseDate: string | null;
};

type SupplierPurchaseRow = {
  id: number;
  purchaseNumber: string;
  invoiceNumber: string;
  invoiceDate: string;
  subtotalPaise: number;
  taxPaise: number;
  totalPaise: number;
  paymentStatus: string;
  status: string;
  postedAt: string | null;
  lineCount: number;
  unitCount: number;
  itemPreview: string;
};

type SupplierLedgerRow = {
  id: number;
  accountCode: string;
  entryDate: string;
  description: string;
  debitPaise: number;
  creditPaise: number;
  referenceType: string;
  referenceId: number;
  referenceNumber: string;
};

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { vendorId } = await requireVendorPermission(request, "purchase.write");
    const supplierId = Number((await context.params).id);
    if (!Number.isInteger(supplierId) || supplierId < 1) {
      return Response.json({ error: "Supplier is invalid" }, { status: 400 });
    }
    const history = parseSupplierHistoryPage(new URL(request.url));
    const db = getD1();
    const supplier = await db.prepare(`
      SELECT id, business_name AS businessName, contact_name AS contactName,
        phone, email, address, gst_number AS gstNumber,
        drug_licence_number AS drugLicenceNumber, status,
        created_at AS createdAt, updated_at AS updatedAt
      FROM suppliers WHERE id = ? AND vendor_id = ? LIMIT 1
    `).bind(supplierId, vendorId).first<SupplierDetailRow>();
    if (!supplier) return Response.json({ error: "Supplier not found" }, { status: 404 });

    const [summary, purchaseCount, purchaseResult, ledgerResult] = await Promise.all([
      db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM purchase_orders purchase
            WHERE purchase.vendor_id = ? AND purchase.supplier_id = ?
              AND purchase.status IN ('partially_received', 'received', 'posted')) AS purchaseCount,
          COALESCE((SELECT SUM(purchase.total_paise) FROM purchase_orders purchase
            WHERE purchase.vendor_id = ? AND purchase.supplier_id = ?
              AND purchase.status IN ('partially_received', 'received', 'posted')), 0) AS grossPurchasePaise,
          (SELECT COUNT(*) FROM supplier_returns supplier_return
            WHERE supplier_return.vendor_id = ? AND supplier_return.supplier_id = ?
              AND supplier_return.status = 'completed') AS returnCount,
          COALESCE((SELECT SUM(supplier_return.total_paise) FROM supplier_returns supplier_return
            WHERE supplier_return.vendor_id = ? AND supplier_return.supplier_id = ?
              AND supplier_return.status = 'completed'), 0) AS returnPaise,
          COALESCE((SELECT SUM(ledger.credit_paise - ledger.debit_paise)
            FROM ledger_entries ledger
            JOIN purchase_orders purchase ON purchase.id = ledger.reference_id
            WHERE ledger.vendor_id = ? AND ledger.reference_type = 'purchase_order'
              AND purchase.vendor_id = ? AND purchase.supplier_id = ?
              AND ledger.account_code IN ('ACCOUNTS_PAYABLE', 'SUPPLIER_PAYABLE')), 0)
          + COALESCE((SELECT SUM(ledger.credit_paise - ledger.debit_paise)
            FROM ledger_entries ledger
            JOIN purchase_receipts receipt ON receipt.id = ledger.reference_id
            JOIN purchase_orders purchase ON purchase.id = receipt.purchase_order_id
            WHERE ledger.vendor_id = ? AND ledger.reference_type = 'purchase_receipt'
              AND receipt.vendor_id = ? AND purchase.vendor_id = ? AND purchase.supplier_id = ?
              AND ledger.account_code IN ('ACCOUNTS_PAYABLE', 'SUPPLIER_PAYABLE')), 0)
          + COALESCE((SELECT SUM(ledger.credit_paise - ledger.debit_paise)
            FROM ledger_entries ledger
            JOIN supplier_returns supplier_return ON supplier_return.id = ledger.reference_id
            WHERE ledger.vendor_id = ? AND ledger.reference_type = 'supplier_return'
              AND supplier_return.vendor_id = ? AND supplier_return.supplier_id = ?
              AND ledger.account_code IN ('ACCOUNTS_PAYABLE', 'SUPPLIER_PAYABLE')), 0) AS payablePaise,
          (SELECT COUNT(*) FROM purchase_orders purchase
            WHERE purchase.vendor_id = ? AND purchase.supplier_id = ?
              AND purchase.status IN ('partially_received', 'received', 'posted') AND purchase.payment_status <> 'paid') AS unpaidPurchaseCount,
          (SELECT MAX(purchase.invoice_date) FROM purchase_orders purchase
            WHERE purchase.vendor_id = ? AND purchase.supplier_id = ?
              AND purchase.status IN ('partially_received', 'received', 'posted')) AS lastPurchaseDate
      `).bind(
        vendorId, supplierId,
        vendorId, supplierId,
        vendorId, supplierId,
        vendorId, supplierId,
        vendorId, vendorId, supplierId,
        vendorId, vendorId, vendorId, supplierId,
        vendorId, vendorId, supplierId,
        vendorId, supplierId,
        vendorId, supplierId,
      ).first<SupplierFinancialSummary>(),
      db.prepare(`SELECT COUNT(*) AS count FROM purchase_orders
        WHERE vendor_id = ? AND supplier_id = ? AND status IN ('partially_received', 'received', 'posted')`)
        .bind(vendorId, supplierId).first<{ count: number }>(),
      db.prepare(`
        SELECT purchase.id, purchase.purchase_number AS purchaseNumber,
          purchase.invoice_number AS invoiceNumber, purchase.invoice_date AS invoiceDate,
          purchase.subtotal_paise AS subtotalPaise, purchase.tax_paise AS taxPaise,
          purchase.total_paise AS totalPaise, purchase.payment_status AS paymentStatus,
          CASE WHEN purchase.status = 'posted' THEN 'received' ELSE purchase.status END AS status,
          purchase.posted_at AS postedAt,
          COUNT(item.id) AS lineCount,
          COALESCE(SUM(item.received_quantity + item.received_free_quantity), 0) AS unitCount,
          COALESCE(group_concat(product.name || ' · ' || item.batch_number || ' × ' || (item.received_quantity + item.received_free_quantity), ', '), '') AS itemPreview
        FROM purchase_orders purchase
        LEFT JOIN purchase_order_items item ON item.purchase_order_id = purchase.id
        LEFT JOIN products product ON product.id = item.product_id
        WHERE purchase.vendor_id = ? AND purchase.supplier_id = ?
          AND purchase.status IN ('partially_received', 'received', 'posted')
        GROUP BY purchase.id
        ORDER BY date(purchase.invoice_date) DESC, purchase.id DESC
        LIMIT ? OFFSET ?
      `).bind(vendorId, supplierId, history.pageSize, (history.page - 1) * history.pageSize).all<SupplierPurchaseRow>(),
      db.prepare(`
        SELECT ledger.id, ledger.account_code AS accountCode,
          ledger.entry_date AS entryDate, ledger.description,
          ledger.debit_paise AS debitPaise, ledger.credit_paise AS creditPaise,
          ledger.reference_type AS referenceType, ledger.reference_id AS referenceId,
          CASE WHEN ledger.reference_type = 'purchase_order' THEN purchase.purchase_number
            WHEN ledger.reference_type = 'purchase_receipt' THEN receipt.receipt_number
            ELSE supplier_return.return_number END AS referenceNumber
        FROM ledger_entries ledger
        LEFT JOIN purchase_orders purchase ON ledger.reference_type = 'purchase_order'
          AND purchase.id = ledger.reference_id AND purchase.vendor_id = ledger.vendor_id
        LEFT JOIN purchase_receipts receipt ON ledger.reference_type = 'purchase_receipt'
          AND receipt.id = ledger.reference_id AND receipt.vendor_id = ledger.vendor_id
        LEFT JOIN purchase_orders receipt_purchase ON receipt_purchase.id = receipt.purchase_order_id
          AND receipt_purchase.vendor_id = ledger.vendor_id
        LEFT JOIN supplier_returns supplier_return ON ledger.reference_type = 'supplier_return'
          AND supplier_return.id = ledger.reference_id AND supplier_return.vendor_id = ledger.vendor_id
        WHERE ledger.vendor_id = ?
          AND ((purchase.supplier_id = ? AND ledger.reference_type = 'purchase_order')
            OR (receipt_purchase.supplier_id = ? AND ledger.reference_type = 'purchase_receipt')
            OR (supplier_return.supplier_id = ? AND ledger.reference_type = 'supplier_return'))
        ORDER BY date(ledger.entry_date) DESC, ledger.id DESC
        LIMIT 100
      `).bind(vendorId, supplierId, supplierId, supplierId).all<SupplierLedgerRow>(),
    ]);

    const totalPurchases = Number(purchaseCount?.count ?? 0);
    return Response.json({
      supplier,
      summary: summary ?? {
        purchaseCount: 0,
        grossPurchasePaise: 0,
        returnCount: 0,
        returnPaise: 0,
        payablePaise: 0,
        unpaidPurchaseCount: 0,
        lastPurchaseDate: null,
      },
      purchases: purchaseResult.results,
      ledger: ledgerResult.results,
      pagination: {
        page: history.page,
        pageSize: history.pageSize,
        total: totalPurchases,
        totalPages: Math.max(1, Math.ceil(totalPurchases / history.pageSize)),
      },
      balanceBasis: "recorded_supplier_ledger",
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
