import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the shared admin overview omits unused precise locations and contact fields", async () => {
  const route = await readFile(new URL("../app/api/admin/operations/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(route, /v\.email,v\.phone,v\.latitude,v\.longitude/);
  assert.doesNotMatch(route, /o\.delivery_address AS deliveryAddress/);
  assert.doesNotMatch(route, /profile\.phone,da\.vehicle_type/);
  assert.doesNotMatch(route, /da\.current_latitude AS currentLatitude/);
  assert.match(route, /"Cache-Control": "private, no-store"/);
});
