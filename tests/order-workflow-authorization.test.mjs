import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("generic vendor order reads and workflow mutations require sale.write after one authentication", () => {
  const list = read("../app/api/orders/route.ts");
  const tracking = read("../app/api/orders/[id]/tracking/route.ts");
  const vendorAccess = read("../lib/vendor-access.ts");

  for (const source of [list, tracking]) {
    assert.match(source, /const authenticated = await requireLocalProfile\(request, \["customer", "vendor", "admin", "delivery"\]\)/);
    assert.match(source, /requireVendorPermission\(request, "sale\.write", authenticated\)/);
  }
  assert.match(vendorAccess, /authenticated\?: \{ profile: LocalProfile \}/);
  assert.match(vendorAccess, /authenticated \?\? await requireLocalProfile\(request, \["vendor"\]\)/);
  assert.match(vendorAccess, /profile\.role !== "vendor" \|\| profile\.status !== "active"/);
});

test("generic order and tracking responses are explicitly private and non-cacheable", () => {
  const list = read("../app/api/orders/route.ts");
  const tracking = read("../app/api/orders/[id]/tracking/route.ts");
  assert.match(list, /"Cache-Control": "private, no-store"/);
  assert.match(list, /Response\.json\(\{ orders \}, \{ headers: privateResponseHeaders \}\)/);
  assert.match(tracking, /headers\.set\("Cache-Control", "private, no-store"\)/);
  assert.match(tracking, /return privateJson\(\{ events: events\.results \}\)/);
});

test("online delivery journal credits medicine, GST, and delivery income against the full receipt", () => {
  const tracking = read("../app/api/orders/[id]/tracking/route.ts");
  assert.match(tracking, /'CASH_BANK'.*total_paise/s);
  assert.match(tracking, /'SALES'.*subtotal_paise/s);
  assert.match(tracking, /'GST_PAYABLE'.*tax_paise/s);
  assert.match(tracking, /'DELIVERY_INCOME'.*delivery_fee_paise/s);
  assert.match(tracking, /delivery_fee_paise>0/);
});

test("packaged Worker fixtures prove denied staff cannot mutate state while sale.write staff can", () => {
  const fixture = read("./integration/fixtures/phase0.sql");
  const integration = read("./integration/phase0-api.integration.test.mjs");
  const harness = read("../scripts/test-integration.mjs");

  assert.match(fixture, /'inventory_manager'/);
  assert.match(fixture, /'delivery_coordinator'/);
  assert.match(fixture, /'counter_staff'/);
  assert.match(integration, /vendor order workflow requires sale\.write without unauthorized side effects/);
  assert.match(integration, /context\.tokens\.vendorInventoryStaff/);
  assert.match(integration, /context\.tokens\.vendorDeliveryCoordinator/);
  assert.match(integration, /counter staff sale\.write tracking mutation/);
  assert.match(integration, /denied staff requests must not change order, inventory, stock\/accounting ledgers, events, or audit evidence/);
  assert.match(harness, /__URMED_INTEGRATION_ORDER_EVIDENCE__/);
  assert.match(harness, /stockLedgerCount/);
  assert.match(harness, /accountingLedgerCount/);
});
