import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("interactive controls have a global visible keyboard focus treatment and mobile navigation remains usable", async () => {
  const css = await source("app/globals.css");
  assert.match(css, /:where\(a, button, input, select, textarea, \[tabindex\]\):focus-visible\s*\{[^}]*outline: 3px solid #087c6c;[^}]*outline-offset: 3px;/s);
  assert.match(css, /@media \(max-width: 980px\)[\s\S]*?\.main-nav\s*\{[^}]*display: flex;[^}]*overflow-x: auto;/);
  assert.doesNotMatch(css, /\.main-nav\s*\{\s*display:\s*none/);
});

test("purchase selection uses a native pressed button instead of a mouse-only table row", async () => {
  const component = await source("app/purchase-lifecycle-center.tsx");
  assert.match(component, /<button aria-pressed=\{purchase\.id === selectedId\} className="purchase-select-button"/);
  assert.match(component, /onClick=\{\(\) => setSelectedId\(purchase\.id\)\} type="button"/);
  assert.doesNotMatch(component, /<tr key=\{purchase\.id\} onClick=/);
});

test("vendor notification popover exposes its relationship and keyboard lifecycle", async () => {
  const component = await source("app/vendor-notification-inbox.tsx");
  assert.match(component, /aria-controls=\{popoverId\}/);
  assert.match(component, /aria-expanded=\{open\}/);
  assert.match(component, /aria-haspopup="dialog"/);
  assert.match(component, /aria-labelledby=\{popoverTitleId\}[\s\S]*role="dialog"/);
  assert.match(component, /closeButtonRef\.current\?\.focus\(\)/);
  assert.match(component, /event\.key !== "Escape"/);
  assert.match(component, /triggerRef\.current\?\.focus\(\)/);
});

test("POS icon-only pagination and cart controls have accessible names", async () => {
  const component = await source("app/offline-pos.tsx");
  assert.match(component, /aria-label="Previous product page"/);
  assert.match(component, /aria-label="Next product page"/);
  assert.match(component, /aria-label=\{`Reduce \$\{line\.productName\} quantity`\}/);
  assert.match(component, /aria-label=\{`Increase \$\{line\.productName\} quantity`\}/);
  assert.match(component, /aria-label=\{`Remove \$\{line\.productName\} from cart`\}/);
});

test("representative asynchronous UI states are announced", async () => {
  const [location, history, purchase, operations] = await Promise.all([
    source("app/vendor-public-location.tsx"),
    source("app/customer-order-history.tsx"),
    source("app/purchase-lifecycle-center.tsx"),
    source("app/operations-centers.tsx"),
  ]);
  assert.match(location, /role="status"/);
  assert.match(location, /role="alert"/);
  assert.match(history, /aria-live="polite"[\s\S]*role="status"/);
  assert.match(history, /role="alert"/);
  assert.match(purchase, /className="recovery-error" role="alert"/);
  assert.match(operations, /className="auth-message error" role="alert"/);
});

test("generic order responses do not select or type exact delivery proof coordinates", async () => {
  const route = await source("app/api/orders/route.ts");
  assert.doesNotMatch(route, /\be\.latitude\b/);
  assert.doesNotMatch(route, /\be\.longitude\b/);
  assert.doesNotMatch(route, /type TrackingEventRow = \{[^}]*latitude|type TrackingEventRow = \{[^}]*longitude/);
});

test("authenticated identity, health, vendor, and inventory successes are explicitly non-cacheable", async () => {
  const [profile, safety, operations, inventory] = await Promise.all([
    source("app/api/auth/profile/route.ts"),
    source("app/api/customer/safety/route.ts"),
    source("app/api/vendor/operations/route.ts"),
    source("app/api/inventory/route.ts"),
  ]);
  for (const route of [profile, safety, operations]) {
    assert.match(route, /const privateResponseHeaders = \{ "Cache-Control": "private, no-store" \}/);
    assert.match(route, /headers: privateResponseHeaders/);
  }
  assert.match(inventory, /mine \? "private, no-store" : "no-store"/);
  assert.match(inventory, /status: 201, headers: \{ "Cache-Control": "private, no-store" \}/);
});

test("application error, loading, and not-found surfaces are accessible and actionable", async () => {
  const [error, loading, notFound] = await Promise.all([
    source("app/error.tsx"),
    source("app/loading.tsx"),
    source("app/not-found.tsx"),
  ]);
  assert.match(error, /"use client"/);
  assert.match(error, /role="alert"/);
  assert.match(error, /onClick=\{reset\}/);
  assert.match(loading, /aria-live="polite"[\s\S]*role="status"/);
  assert.match(notFound, /href="\/"/);
  assert.match(notFound, /Page not found/);
});
