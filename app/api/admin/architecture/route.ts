import { getD1 } from "../../../../db/d1";
import { requireAdminProfile } from "../../../../lib/admin-access";
import { errorResponse } from "../../../../lib/auth-server";

const groups = [
  ["Identity & licensing", ["account_profiles", "vendors", "vendor_staff", "vendor_bank_accounts", "pharmacists", "vendor_licences"]],
  ["Catalogue & pricing", ["categories", "manufacturers", "products", "product_alternates", "product_ceiling_prices"]],
  ["Procurement", ["suppliers", "purchase_orders", "purchase_order_items"]],
  ["Inventory & alerts", ["pharmacy_inventory", "stock_ledger", "inventory_alerts", "temperature_logs"]],
  ["Prescription compliance", ["stored_documents", "prescriptions", "prescription_items", "prescription_reviews", "statutory_register_entries"]],
  ["Sales, GST & returns", ["orders", "order_items", "offline_sales", "offline_sale_items", "sales_returns", "sales_return_items", "tax_invoices", "payment_events"]],
  ["Customer & delivery", ["customer_addresses", "pill_reminders", "delivery_agents", "delivery_assignments", "delivery_events", "notifications"]],
  ["Accounts & operations", ["expenses", "ledger_entries", "backup_runs", "migration_audit"]],
  ["Privacy & audit", ["data_consents", "retention_policies", "breach_incidents", "audit_events"]],
] as const;

type ArchitectureObject = { name: string; type: "table" | "view" | "trigger" };

export async function GET(request: Request) {
  try {
    await requireAdminProfile(request);
    const db = getD1();
    const [result, preservedData] = await Promise.all([db.prepare(`
      SELECT name, type FROM sqlite_master
      WHERE type IN ('table', 'view', 'trigger') AND name NOT LIKE 'sqlite_%'
      ORDER BY type, name
    `).all<{ name: string; type: "table" | "view" | "trigger" }>(), db.prepare(`SELECT
      (SELECT COUNT(*) FROM products) AS products,
      (SELECT COUNT(*) FROM account_profiles WHERE role='customer' AND status='active'
        AND email_verified=1 AND phone_verified=1) AS verifiedCustomers`).first()]);
    const records = result.results as ArchitectureObject[];
    const names = new Set(records.map((row) => row.name));
    const modules = groups.map(([name, objects]) => ({
      name,
      ready: objects.every((object) => names.has(object)),
      readyObjects: objects.filter((object) => names.has(object)).length,
      totalObjects: objects.length,
      objects,
    }));
    return Response.json({
      totals: {
        tables: records.filter((row) => row.type === "table").length,
        views: records.filter((row) => row.type === "view").length,
        safeguards: records.filter((row) => row.type === "trigger").length,
        modulesReady: modules.filter((module) => module.ready).length,
        modules: modules.length,
      },
      modules,
      preservedData: { ...(preservedData ?? { products: 0, verifiedCustomers: 0 }), legacyPasswordsImported: false },
      phase: "Live architecture and workflow readiness",
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
