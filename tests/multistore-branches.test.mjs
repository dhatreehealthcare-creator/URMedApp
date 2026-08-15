import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { groupCustomerCart } from "../lib/customer-cart.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("branch migration creates a deterministic primary backfill and branch-scoped inventory uniqueness", () => {
  const migration = read("drizzle/0064_pharmacy_branches.sql");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS pharmacy_branches/);
  assert.match(migration, /SELECT v\.id, 'PRIMARY'/);
  assert.match(migration, /WHERE NOT EXISTS \(SELECT 1 FROM pharmacy_branches existing/);
  assert.match(migration, /UPDATE pharmacy_inventory SET branch_id/);
  assert.match(migration, /pharmacy_inventory_branch_batch_uidx/);
  assert.match(migration, /inventory_branch_vendor_mismatch/);
  assert.match(read("drizzle/0065_branch_scoped_fefo_guards.sql"), /earlier\.branch_id = chosen\.branch_id/);
  assert.match(read("drizzle/0065_branch_scoped_fefo_guards.sql"), /inventory\.branch_id = sale\.branch_id/);
});

test("branch APIs enforce vendor/admin boundaries and keep public fields separate", () => {
  const vendor = read("app/api/vendor/branches/route.ts");
  const admin = read("app/api/admin/branches/route.ts");
  assert.match(vendor, /requireVendorPermission\(request, "inventory\.read"\)/);
  assert.match(vendor, /requireVendorPermission\(request, "profile\.manage"\)/);
  assert.match(vendor, /WHERE id = \? AND vendor_id = \?/);
  assert.match(vendor, /public_location_status/);
  assert.match(admin, /requireAdminProfile\(request\)/);
  assert.match(admin, /vendor_id AS vendorId/);
  assert.match(admin, /Cache-Control.*private, no-store/);
  assert.match(vendor, /assign_staff/);
  assert.match(read("lib/vendor-access.ts"), /staff\.branchId/);
});

test("cart groups offers by branch and does not silently create a mixed-branch checkout", () => {
  const lines = [
    { inventoryId: 1, vendorId: 7, branchId: 70, branchName: "Main", businessName: "A", productId: 1, productName: "A", salePricePaise: 100, gstPercent: 0, availableQuantity: 5, prescriptionRequired: false, quantity: 1, homeDelivery: true, publicLocation: null },
    { inventoryId: 2, vendorId: 7, branchId: 71, branchName: "North", businessName: "A", productId: 2, productName: "B", salePricePaise: 100, gstPercent: 0, availableQuantity: 5, prescriptionRequired: false, quantity: 1, homeDelivery: true, publicLocation: null },
  ];
  const groups = groupCustomerCart(lines);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((group) => group.branchId), [70, 71]);
  assert.match(read("app/api/orders/route.ts"), /Place separate orders for different pharmacy branches/);
});

test("public discovery and checkout use branch identity without private vendor coordinates", () => {
  const inventory = read("app/api/inventory/route.ts");
  const catalog = read("app/api/catalog/route.ts");
  const orders = read("app/api/orders/route.ts");
  assert.match(inventory, /i\.branch_id AS branchId/);
  assert.match(catalog, /i\.branch_id AS branchId/);
  assert.match(catalog, /JOIN pharmacy_branches branch/);
  assert.match(orders, /JOIN pharmacy_branches branch/);
  assert.doesNotMatch(inventory, /SELECT .*v\.latitude.*v\.longitude/s);
});

test("admin operational reports expose branch-scoped filters without weakening vendor scope", () => {
  const reporting = read("lib/admin-reporting.ts");
  const reportsUi = read("app/admin-operational-reports.tsx");
  assert.match(reporting, /branchId = optionalInteger\(parameters\.get\("branchId"\)/);
  assert.match(reporting, /i\.branch_id/);
  assert.match(reporting, /o\.branch_id/);
  assert.match(reportsUi, /Branch ID/);
});
