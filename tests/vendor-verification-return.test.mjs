import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  inspectVendorVerificationReturn,
  vendorVerificationProfileSeed,
} from "../lib/vendor-verification-return.ts";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("valid Supabase signup fragments are accepted without copying provider flags into a profile seed", () => {
  assert.deepEqual(inspectVendorVerificationReturn("https://urmed.example/vendor/verification-return#access_token=access&refresh_token=refresh&expires_in=3600&token_type=bearer&type=signup"), {
    kind: "session",
    accessToken: "access",
    refreshToken: "refresh",
  });
  assert.deepEqual(vendorVerificationProfileSeed({
    email: "vendor@example.com",
    email_confirmed_at: "2026-08-12T00:00:00Z",
    user_metadata: { role: "vendor", name: "Vendor Owner", business_name: "Verified Pharmacy", phone: "9876543210", emailVerified: true, phoneVerified: true },
  }), {
    role: "vendor",
    name: "Vendor Owner",
    businessName: "Verified Pharmacy",
    phone: "9876543210",
  });
});

test("provider errors, malformed fragments, and non-signup sessions cannot auto-login", () => {
  assert.deepEqual(inspectVendorVerificationReturn("https://urmed.example/vendor/verification-return?error=access_denied&error_description=secret-provider-message"), { kind: "provider_error" });
  assert.deepEqual(inspectVendorVerificationReturn("https://urmed.example/vendor/verification-return#access_token=access&type=signup"), { kind: "invalid" });
  assert.deepEqual(inspectVendorVerificationReturn("https://urmed.example/vendor/verification-return#access_token=access&refresh_token=refresh&expires_in=3600&token_type=bearer&type=recovery"), { kind: "invalid" });
  assert.deepEqual(inspectVendorVerificationReturn("https://urmed.example/vendor/verification-return"), { kind: "none" });
});

test("only a provider-confirmed vendor signup can seed a missing vendor shell", () => {
  const base = { email: "vendor@example.com", email_confirmed_at: "2026-08-12T00:00:00Z", user_metadata: { role: "vendor", name: "Owner", business_name: "Pharmacy" } };
  assert.ok(vendorVerificationProfileSeed(base));
  assert.equal(vendorVerificationProfileSeed({ ...base, email_confirmed_at: null }), null);
  assert.equal(vendorVerificationProfileSeed({ ...base, user_metadata: { ...base.user_metadata, role: "customer" } }), null);
  assert.equal(vendorVerificationProfileSeed({ ...base, user_metadata: { ...base.user_metadata, business_name: "" } }), null);
});

test("verification return explicitly completes a provider session, synchronizes D1, scrubs tokens, and preserves fallback", () => {
  const client = read("../app/marketplace-client.ts");
  const callback = read("../app/vendor-verification-return.tsx");
  assert.match(client, /detectSessionInUrl: false/);
  assert.match(client, /flowType: "implicit"/);
  assert.match(callback, /client\.auth\.setSession/);
  assert.match(callback, /client\.auth\.getUser/);
  assert.match(callback, /providerData\.user\?\.email_confirmed_at/);
  assert.match(callback, /fetch\("\/api\/auth\/profile"/);
  assert.match(callback, /window\.history\.replaceState/);
  assert.match(callback, /window\.location\.replace\(statusPath\)/);
  assert.match(callback, /Sign in with vendor email/);
  assert.doesNotMatch(callback, /emailVerified\s*:|phoneVerified\s*:/);
});
