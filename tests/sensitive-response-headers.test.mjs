import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("payment, prescription-review, and refill routes use private JSON responses", () => {
  const files = [
    "app/api/payments/razorpay/order/route.ts",
    "app/api/payments/razorpay/refund/route.ts",
    "app/api/payments/razorpay/verify/route.ts",
    "app/api/prescriptions/[id]/review/route.ts",
    "app/api/refills/route.ts",
  ];
  for (const file of files) {
    const source = read(file);
    assert.match(source, /privateJson/);
    assert.doesNotMatch(source, /Response\.json\(/);
  }
});

test("privateJson always overrides cacheability for sensitive responses", () => {
  const helper = read("lib/http-response.ts");
  assert.match(helper, /headers\.set\("Cache-Control", "private, no-store"\)/);
});
