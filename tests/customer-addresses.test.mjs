import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CustomerAddressValidationError,
  validateCustomerAddress,
} from "../lib/customer-address.ts";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("customer addresses normalize labels, map coordinates, and explicit default values", () => {
  assert.deepEqual(validateCustomerAddress({
    label: " Work ",
    address: " Complete customer delivery address ",
    latitude: "17.4318",
    longitude: "78.4073",
    isDefault: "0",
  }), {
    label: "Work",
    address: "Complete customer delivery address",
    latitude: "17.431800",
    longitude: "78.407300",
    isDefault: false,
  });
  assert.equal(validateCustomerAddress({
    address: "Another complete delivery address",
    latitude: 0,
    longitude: 0,
    isDefault: "1",
  }).isDefault, true);
});

test("customer addresses reject incomplete text and invalid map pins", () => {
  for (const [input, message] of [
    [{ address: "short", latitude: "17", longitude: "78" }, /complete delivery address/i],
    [{ address: "Complete delivery address", latitude: "91", longitude: "78" }, /valid delivery location/i],
    [{ address: "Complete delivery address", latitude: "17", longitude: "181" }, /valid delivery location/i],
  ]) {
    assert.throws(() => validateCustomerAddress(input), (error) => {
      assert.ok(error instanceof CustomerAddressValidationError);
      assert.match(error.message, message);
      return true;
    });
  }
});

test("address API uses the verified customer gate and scopes every read and write by profile", () => {
  const route = read("../app/api/customer/addresses/route.ts");
  assert.match(route, /requireLocalProfile\(request, \["customer"\]\)/);
  assert.match(route, /WHERE profile_id=\?/);
  assert.match(route, /WHERE id=\? AND profile_id=\?/);
  assert.match(route, /UPDATE customer_addresses SET is_default=0 WHERE profile_id=\?/);
  assert.match(route, /identity: \{ name: profile\.name, email: profile\.email, phone: profile\.phone \}/);
  assert.match(route, /customer\.address\.created/);
  assert.match(route, /customer\.address\.updated/);
  assert.doesNotMatch(route, /customers\s+WHERE|legacy_id|recovered/i);
});

test("checkout identity and address are resolved server-side from owned live records", () => {
  const route = read("../app/api/orders/route.ts");
  assert.match(route, /const customerName = profile\.name/);
  assert.match(route, /normalizeIndianMobile\(profile\.phone\)/);
  assert.match(route, /Change and re-verify the mobile number in your customer account/);
  assert.match(route, /FROM customer_addresses\s+WHERE id=\? AND profile_id=\?/s);
  assert.match(route, /const deliveryAddress = customerAddress\.address/);
  assert.match(route, /const latitude = customerAddress\.latitude/);
  assert.match(route, /const longitude = customerAddress\.longitude/);
  assert.doesNotMatch(route, /String\(body\.deliveryAddress/);
});

test("customer checkout presents saved map addresses and readonly verified identity", () => {
  const marketplace = read("../app/live-marketplace.tsx");
  const addressBook = read("../app/customer-address-book.tsx");
  assert.match(marketplace, /<CustomerAddressBook onIdentity=/);
  assert.match(marketplace, /Verified customer name/);
  assert.match(marketplace, /Verified mobile number/);
  assert.match(marketplace, /readOnly value=\{customerPhone\}/);
  assert.match(marketplace, /customerAddressId/);
  assert.doesNotMatch(marketplace, /setCustomerPhone\(event\.target/);
  assert.match(addressBook, /Make default/);
  assert.match(addressBook, /Update address/);
  assert.match(addressBook, /<GeoLocationPicker/);
  assert.doesNotMatch(addressBook, /localStorage|sessionStorage/);
});

test("packaged Worker coverage includes default and cross-customer address controls", () => {
  const integration = read("./integration/phase0-api.integration.test.mjs");
  assert.match(integration, /saved customer addresses are verified, editable, defaulted, and tenant scoped/);
  assert.match(integration, /cross-customer address edit/);
  assert.match(integration, /cross-customer checkout address/);
  assert.match(integration, /checkout phone cannot override verified profile/);
});
