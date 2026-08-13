import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("production surfaces avoid hard-coded location, counts, financial claims, and phase claims", async () => {
  const [home, architecture, portal, operations] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/architecture/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/requirements-portal.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/operations-centers.tsx", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(home, /Hyderabad, Telangana/);
  assert.doesNotMatch(home, /100,041 recovered medicines/);
  assert.match(home, /Choose your saved address at checkout/);
  assert.doesNotMatch(architecture, /products: 100041/);
  assert.doesNotMatch(architecture, /verifiedCustomers: 3/);
  assert.match(architecture, /SELECT COUNT\(\*\) FROM products/);
  assert.doesNotMatch(architecture, /FROM customers/);
  assert.doesNotMatch(portal, /₹42,680|₹42\.7K|6 online orders|11 batches near expiry|8 products at zero stock|<b>3<\/b>/);
  assert.doesNotMatch(portal, /Reports & balance sheet/);
  assert.doesNotMatch(portal, /PHASE 6/);
  assert.match(portal, /Operational reports/);
  assert.doesNotMatch(operations, /test customer|Net sales less expense|Operational position/);
  assert.match(operations, /Not profit or a balance sheet/);
});
