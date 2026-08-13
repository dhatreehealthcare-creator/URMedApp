import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { redactPrivateVendorLocation } from "../lib/location-privacy.ts";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("public marketplace records remove every private vendor-location alias", () => {
  const record = redactPrivateVendorLocation({
    id: 41,
    businessName: "Privacy Test Pharmacy",
    homeDelivery: 1,
    address: "Private legal address",
    latitude: "17.431800",
    longitude: "78.407300",
    vendorAddress: "Private legal address",
    vendorLatitude: "17.431800",
    vendorLongitude: "78.407300",
    pickupAddress: "Private legal address",
    pickupLatitude: "17.431800",
    pickupLongitude: "78.407300",
  });

  assert.deepEqual(record, {
    id: 41,
    businessName: "Privacy Test Pharmacy",
    homeDelivery: 1,
  });
});

test("public inventory and catalog contracts do not expose the private registered location", () => {
  const inventoryRoute = read("../app/api/inventory/route.ts");
  const catalogRoute = read("../app/api/catalog/route.ts");

  assert.match(inventoryRoute, /mine \? row as unknown as Record<string, unknown> : redactPrivateVendorLocation\(row\)/);
  assert.match(inventoryRoute, /attachPublishedVendorLocation/);
  assert.doesNotMatch(inventoryRoute, /v\.(?:address|latitude|longitude)/);
  assert.doesNotMatch(catalogRoute, /v\.(?:address|latitude|longitude)/);
  assert.doesNotMatch(catalogRoute, /(?:vendor|pickup)(?:Address|Latitude|Longitude)/);
});

test("customer marketplace never receives or derives an exact pharmacy location", () => {
  const marketplace = read("../app/live-marketplace.tsx");
  const orderRoute = read("../app/api/orders/route.ts");

  assert.doesNotMatch(marketplace, /vendorLatitude|vendorLongitude/);
  assert.match(marketplace, /item\.publicLocation\?\.serviceEnabled/);
  assert.match(marketplace, /No public service pin is shared/);
  assert.match(orderRoute, /outside the pharmacy service area/);
  assert.doesNotMatch(orderRoute, /return Response\.json\(\{ error: `Delivery address is/);
  assert.doesNotMatch(orderRoute, /return Response\.json\(\{ order: \{[^\n]*deliveryDistanceKm/);
});

test("exact locations remain available only on owner/admin/assigned-delivery boundaries", () => {
  const vendorSetup = read("../app/api/vendor/setup/route.ts");
  const deliveryRoute = read("../app/api/delivery/route.ts");
  const adminOperations = read("../app/api/admin/operations/route.ts");

  assert.match(vendorSetup, /requireVendorOnboardingAccess\(request\)/);
  assert.match(vendorSetup, /Cache-Control": "private, no-store/);
  assert.match(deliveryRoute, /requireLocalProfile\(request,\s*\["delivery"\]\)/);
  assert.match(deliveryRoute, /WHERE agent\.profile_id=\? AND a\.status<>'cancelled'/);
  assert.match(deliveryRoute, /JOIN vendor_public_locations public_location/);
  assert.doesNotMatch(deliveryRoute, /v\.address AS pickupAddress|v\.latitude AS pickupLatitude|v\.longitude AS pickupLongitude/);
  assert.match(deliveryRoute, /CASE WHEN a\.status='delivered'.*THEN '' ELSE o\.customer_name END AS customerName/s);
  assert.match(deliveryRoute, /Cache-Control", "private, no-store"/);
  assert.match(adminOperations, /requireAdminProfile\(request\)/);
});

test("rider UI has no default proof and requires fresh browser geolocation", () => {
  const operations = read("../app/operations-centers.tsx");
  const tracking = read("../app/api/orders/[id]/tracking/route.ts");
  const integration = read("./integration/phase0-api.integration.test.mjs");
  const harness = read("../scripts/test-integration.mjs");
  assert.doesNotMatch(operations, /useState\("17\.4318"\)|useState\("78\.4073"\)/);
  assert.match(operations, /getCurrentPosition/);
  assert.match(operations, /maximumAge:0/);
  assert.match(operations, /Capture GPS & mark/);
  assert.match(tracking, /validateDeliveryLocationProof\(body\)/);
  assert.match(tracking, /This delivery location proof was already used/);
  assert.match(integration, /delivery locations require fresh proof and expose only published operational coordinates/);
  assert.match(integration, /missing browser location timestamp/);
  assert.match(integration, /throttled live location update/);
  assert.match(integration, /replayed transition proof/);
  assert.match(harness, /__URMED_INTEGRATION_DELIVERY_EVIDENCE__/);
});

test("private address forms do not contact a map tile provider before explicit consent", () => {
  const picker = read("../app/geo-location-picker.tsx");
  const consentGuard = picker.indexOf("if (!mapEnabled) return");
  const leafletImport = picker.indexOf('import("leaflet")');
  const externalTile = picker.indexOf("tile.openstreetmap.org");
  assert.match(picker, /useState\(false\)/);
  assert.ok(consentGuard >= 0 && consentGuard < leafletImport && leafletImport < externalTile);
  assert.match(picker, /External map tiles are off/);
  assert.match(picker, /Loading the interactive map sends the viewed map area to OpenStreetMap/);
  assert.match(picker, /Use my GPS/);
});
