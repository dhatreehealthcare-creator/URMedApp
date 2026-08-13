import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("public catalogue logs internal failures but returns a stable non-cacheable message", async () => {
  const route = await readFile(new URL("../app/api/catalog/route.ts", import.meta.url), "utf8");
  assert.match(route, /console\.error\("Public catalogue query failed", error\)/);
  assert.match(route, /error: "Catalogue is temporarily unavailable"/);
  assert.match(route, /headers: \{ "Cache-Control": "no-store" \}/);
  assert.doesNotMatch(route, /error instanceof Error \? error\.message/);
});
