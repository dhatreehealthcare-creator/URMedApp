import assert from "node:assert/strict";
import test from "node:test";

import { withSecurityHeaders } from "../lib/security-headers.ts";

test("Worker security headers protect all responses without disabling rider geolocation", async () => {
  const response = withSecurityHeaders(
    new Request("https://urmed.example/vendor"),
    new Response("ok", { headers: { "Cache-Control": "private, no-store" } }),
  );

  assert.equal(await response.text(), "ok");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.equal(response.headers.get("permissions-policy"), "camera=(), microphone=(), geolocation=(self), payment=(self)");
  assert.equal(response.headers.get("strict-transport-security"), "max-age=31536000; includeSubDomains");
});

test("local HTTP responses do not set HSTS and explicit route safeguards are preserved", () => {
  const response = withSecurityHeaders(
    new Request("http://127.0.0.1:8787/api/documents/1"),
    new Response(null, { status: 204, headers: { "X-Frame-Options": "SAMEORIGIN" } }),
  );

  assert.equal(response.status, 204);
  assert.equal(response.headers.get("strict-transport-security"), null);
  assert.equal(response.headers.get("x-frame-options"), "SAMEORIGIN");
});
