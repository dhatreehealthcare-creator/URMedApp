import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("local Vite development applies the D1 migrations before serving catalog requests", () => {
  const script = read("scripts/dev-local.sh");
  const packageJson = JSON.parse(read("package.json"));
  assert.equal(packageJson.scripts.dev, "bash scripts/dev-local.sh");
  assert.match(script, /d1 migrations apply DB/);
  assert.match(script, /--local/);
  assert.match(script, /--persist-to/);
  assert.match(script, /migrations_dir/);
  assert.match(script, /CI=1/);
});

test("Vite resolves one React identity across RSC, SSR, and browser environments", () => {
  const config = read("vite.config.ts");
  assert.match(config, /dedupe:\s*\["react",\s*"react-dom",\s*"react-server-dom-webpack"\]/);
});

test("catalog keeps the public no-store contract and bounded request", () => {
  const route = read("app/api/catalog/route.ts");
  assert.match(route, /enforceRateLimit\(request, "public_search"\)/);
  assert.match(route, /MAX_PAGE_SIZE = 50/);
  assert.match(route, /Cache-Control.*no-store/);
});
