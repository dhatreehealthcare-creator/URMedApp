import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("document downloads use purpose and relationship authorization instead of pharmacy-wide access", async () => {
  const [route, access, permissions] = await Promise.all([
    readFile(new URL("../app/api/documents/[id]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/document-access.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/vendor-access.ts", import.meta.url), "utf8"),
  ]);
  assert.match(route, /canDownloadStoredDocument/);
  assert.doesNotMatch(route, /row\.vendorId\s*&&\s*row\.vendorId\s*===\s*profile\.vendorId/);
  assert.match(access, /requireVendorPermission\(request, "prescription\.review"\)/);
  assert.match(access, /requireVendorOnboardingAccess\(request\)/);
  assert.match(access, /requireVendorPermission\(request, "sale\.write"\)/);
  assert.match(access, /assignment\.proof_document_id = \?/);
  assert.match(access, /prescriptions[\s\S]*document_id = \?/);
  assert.match(permissions, /pharmacist: \[[^\]]*"prescription\.review"/);
});

test("successful document downloads are private, sandboxed, and audited", async () => {
  const route = await readFile(new URL("../app/api/documents/[id]/route.ts", import.meta.url), "utf8");
  assert.match(route, /action: "document\.downloaded"/);
  assert.match(route, /"Cache-Control": "private, no-store"/);
  assert.match(route, /"X-Content-Type-Options": "nosniff"/);
  assert.match(route, /"Content-Security-Policy": "default-src 'none'; sandbox"/);
});

test("packaged storage coverage enforces linked pharmacist access and staff isolation", async () => {
  const integration = await readFile(new URL("./integration/phase0-api.integration.test.mjs", import.meta.url), "utf8");
  assert.match(integration, /pharmacy cannot read an unlinked customer upload/);
  assert.match(integration, /pharmacy owner with prescription review access downloads linked prescription/);
  assert.match(integration, /counter staff cannot download linked prescription bytes/);
  assert.match(integration, /other pharmacy cannot download linked prescription bytes/);
});
