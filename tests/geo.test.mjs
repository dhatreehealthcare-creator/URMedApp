import assert from "node:assert/strict";
import test from "node:test";
import { formatDistance, haversineKm, isValidGeoPoint, isWithinDeliveryRadius } from "../lib/geo.ts";

const pharmacy = { latitude: 17.4318, longitude: 78.4073 };

test("geotag validation accepts real coordinates and rejects invalid ranges", () => {
  assert.equal(isValidGeoPoint(pharmacy), true);
  assert.equal(isValidGeoPoint({ latitude: 91, longitude: 78.4 }), false);
  assert.equal(isValidGeoPoint({ latitude: 17.4, longitude: Number.NaN }), false);
});

test("haversine distance is zero for the same pin and symmetric", () => {
  const customer = { latitude: 17.385, longitude: 78.4867 };
  assert.equal(haversineKm(pharmacy, pharmacy), 0);
  assert.ok(Math.abs(haversineKm(pharmacy, customer) - haversineKm(customer, pharmacy)) < 0.000001);
  assert.ok(haversineKm(pharmacy, customer) > 9 && haversineKm(pharmacy, customer) < 12);
});

test("delivery radius blocks an address outside the pharmacy service area", () => {
  const nearbyCustomer = { latitude: 17.4305, longitude: 78.409 };
  const distantCustomer = { latitude: 17.385, longitude: 78.4867 };
  assert.equal(isWithinDeliveryRadius(pharmacy, nearbyCustomer, 5), true);
  assert.equal(isWithinDeliveryRadius(pharmacy, distantCustomer, 5), false);
});

test("distance labels remain understandable at metre and kilometre scales", () => {
  assert.equal(formatDistance(0.245), "245 m away");
  assert.equal(formatDistance(4.26), "4.3 km away");
});
