import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("general inventory operations never return regulated patient register data", async () => {
  const source = await readFile(new URL("../app/api/vendor/operations/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /statutory_register_entries/);
  assert.doesNotMatch(source, /registers:\s*registers\.results/);
  assert.match(source, /requireVendorPermission\(request,\s*"inventory\.read"\)/);
});

test("statutory register access requires prescription-review authority and vendor scope", async () => {
  const [route, ui] = await Promise.all([
    readFile(new URL("../app/api/vendor/statutory-register/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/operations-centers.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(route, /requireVendorPermission\(request,\s*"prescription\.review"\)/);
  assert.match(route, /WHERE vendor_id=\?/);
  assert.match(route, /private, no-store/);
  assert.doesNotMatch(route, /requireLocalProfile/);
  assert.match(ui, /\/api\/vendor\/statutory-register/);
  assert.match(ui, /response\.status===403/);
});
