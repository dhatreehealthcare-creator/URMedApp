import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { POST } from "../app/api/webhooks/razorpay/route.ts";
import {
  RAZORPAY_WEBHOOK_MAX_BYTES,
  readBoundedRequestText,
  RequestBodyTooLargeError,
} from "../lib/bounded-request-body.ts";
import { hmacHex } from "../lib/signatures.ts";

const endpoint = "https://urmed.example/api/webhooks/razorpay";
const secret = "unit-webhook-secret";

function oversizedRequest(contentLength) {
  const headers = new Headers({ "x-razorpay-signature": "not-evaluated" });
  if (contentLength !== undefined) headers.set("content-length", contentLength);
  return new Request(endpoint, {
    method: "POST",
    headers,
    body: "x".repeat(RAZORPAY_WEBHOOK_MAX_BYTES + 1),
  });
}

test("bounded raw-body reading counts bytes when Content-Length is missing or false", async () => {
  for (const request of [oversizedRequest(), oversizedRequest("1"), oversizedRequest("invalid")]) {
    await assert.rejects(
      readBoundedRequestText(request, RAZORPAY_WEBHOOK_MAX_BYTES),
      (error) => error instanceof RequestBodyTooLargeError
        && error.maximumBytes === RAZORPAY_WEBHOOK_MAX_BYTES,
    );
  }
});

test("oversized webhook requests return a stable 413 before D1 or provider side effects", async () => {
  let databaseCalls = 0;
  let providerCalls = 0;
  globalThis.__URMED_RUNTIME__ = {};
  globalThis.__URMED_D1__ = {
    prepare() {
      databaseCalls += 1;
      throw new Error("D1 must not be reached for an oversized webhook");
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    providerCalls += 1;
    throw new Error("Provider network must not be reached for an oversized webhook");
  };
  try {
    for (const request of [oversizedRequest(), oversizedRequest("1")]) {
      const response = await POST(request);
      assert.equal(response.status, 413);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), {
        error: "Razorpay webhook payload exceeds the 256 KiB limit",
        code: "webhook_payload_too_large",
      });
    }
    assert.equal(databaseCalls, 0);
    assert.equal(providerCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.__URMED_D1__;
    delete globalThis.__URMED_RUNTIME__;
  }
});

test("normal signed Razorpay webhook payloads remain compatible", async () => {
  const raw = JSON.stringify({ event: "unit.compatibility", payload: {} });
  const signature = await hmacHex(secret, raw);
  let eventWrites = 0;
  globalThis.__URMED_RUNTIME__ = { RAZORPAY_WEBHOOK_SECRET: secret };
  globalThis.__URMED_D1__ = {
    prepare(sql) {
      assert.match(sql, /INSERT OR IGNORE INTO payment_events/);
      return {
        bind() { return this; },
        async run() {
          eventWrites += 1;
          return { meta: { changes: 1 } };
        },
      };
    },
  };
  try {
    const response = await POST(new Request(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "x-razorpay-signature": signature },
      body: raw,
    }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { received: true });
    assert.equal(eventWrites, 1);
  } finally {
    delete globalThis.__URMED_D1__;
    delete globalThis.__URMED_RUNTIME__;
  }
});

test("webhook size enforcement precedes signature, JSON, and database processing", () => {
  const route = readFileSync(new URL("../app/api/webhooks/razorpay/route.ts", import.meta.url), "utf8");
  const limit = route.indexOf("readBoundedRequestText(request");
  assert.ok(limit >= 0);
  for (const marker of ["hmacHex(", "JSON.parse(raw)", "const db = getD1()"] ) {
    assert.ok(limit < route.indexOf(marker), `${marker} must execute after bounded reading`);
  }
});
