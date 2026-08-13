import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the recovered-customer archive is admin-only, bounded, searchable, and paginated", async () => {
  const [route, portal] = await Promise.all([
    readFile(new URL("../app/api/admin/recovery/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/requirements-portal.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(route, /requireAdminProfile\(request\)/);
  assert.match(route, /Math\.min\(50, Math\.max\(10, requestedPageSize\)\)/);
  assert.match(route, /ORDER BY legacy_id LIMIT \? OFFSET \?/);
  assert.match(route, /lower\(name\) LIKE \?/);
  assert.match(route, /private, no-store/);
  assert.match(portal, /Search the archive/);
  assert.match(portal, /data\.pagination\.totalPages/);
});
