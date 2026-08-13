import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  attachPublishedVendorLocation,
  validateVendorPublicLocation,
  VendorPublicLocationValidationError,
} from "../lib/vendor-public-location.ts";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const valid = {
  label: "Customer entrance",
  address: "Public entrance, Market Road, Hyderabad",
  latitude: "17.4318",
  longitude: "78.4073",
  pickupEnabled: true,
  serviceEnabled: true,
  serviceRadiusKm: 8,
};

test("public-location validation requires an intentional usable customer point", () => {
  assert.deepEqual(validateVendorPublicLocation(valid), {
    ...valid,
    latitude: "17.431800",
    longitude: "78.407300",
  });
  assert.throws(
    () => validateVendorPublicLocation({ ...valid, pickupEnabled: false, serviceEnabled: false }),
    (error) => error instanceof VendorPublicLocationValidationError && /Enable pickup/i.test(error.message),
  );
  assert.throws(
    () => validateVendorPublicLocation({ ...valid, latitude: "91" }),
    (error) => error instanceof VendorPublicLocationValidationError && /valid customer-facing map location/i.test(error.message),
  );
  assert.throws(
    () => validateVendorPublicLocation({ ...valid, serviceRadiusKm: 51 }),
    (error) => error instanceof VendorPublicLocationValidationError && /1 to 50 km/i.test(error.message),
  );
});

test("only complete published-location columns become a public nested contract", () => {
  const publicRecord = attachPublishedVendorLocation({
    inventoryId: 42,
    publicLocationLabel: valid.label,
    publicLocationAddress: valid.address,
    publicLocationLatitude: valid.latitude,
    publicLocationLongitude: valid.longitude,
    publicPickupEnabled: 1,
    publicServiceEnabled: 1,
    publicServiceRadiusKm: 8,
  });
  assert.deepEqual(publicRecord, { inventoryId: 42, publicLocation: valid });

  const unpublished = attachPublishedVendorLocation({
    inventoryId: 42,
    publicLocationLabel: null,
    publicLocationAddress: null,
    publicLocationLatitude: null,
    publicLocationLongitude: null,
  });
  assert.deepEqual(unpublished, { inventoryId: 42, publicLocation: null });
});

test("P1-09 migration creates a separate table without copying private vendor data", () => {
  const migration = read("../drizzle/0036_low_prodigy.sql");
  assert.match(migration, /CREATE TABLE `vendor_public_locations`/);
  assert.match(migration, /`publication_consent_at` text/);
  assert.match(migration, /vendor_public_locations_vendor_uidx/);
  assert.doesNotMatch(migration, /INSERT INTO `?vendor_public_locations`?/i);
  assert.doesNotMatch(migration, /SELECT .*vendors/i);

  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON; CREATE TABLE vendors (id integer PRIMARY KEY);");
  database.exec(migration.replaceAll("--> statement-breakpoint", ""));
  const columns = database.prepare("PRAGMA table_info(vendor_public_locations)").all().map((row) => row.name);
  assert.deepEqual(columns, [
    "id", "vendor_id", "label", "address", "latitude", "longitude", "pickup_enabled",
    "service_enabled", "service_radius_km", "publication_status", "publication_consent_at",
    "published_at", "created_at", "updated_at",
  ]);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM vendor_public_locations").get().count, 0);
  database.close();
});

test("owner publication is explicit, audited, and unavailable to incomplete vendors", () => {
  const route = read("../app/api/vendor/public-location/route.ts");
  const component = read("../app/vendor-public-location.tsx");
  assert.match(route, /requireVendorOnboardingAccess\(request\)/);
  assert.match(route, /profile\.vendorAccessStatus !== "operational"/);
  assert.match(route, /body\.publicationConsent !== true/);
  assert.match(route, /vendor\.public_location\.published/);
  assert.match(route, /vendor\.public_location\.unpublished/);
  assert.match(component, /Save private draft/);
  assert.match(component, /I confirm that customers may see this exact address and map pin/);
  assert.match(component, /Publish customer location/);
});

test("public inventory, catalog and serviceability use only explicitly published points", () => {
  const inventory = read("../app/api/inventory/route.ts");
  const catalog = read("../app/api/catalog/route.ts");
  const orders = read("../app/api/orders/route.ts");
  for (const route of [inventory, catalog, orders]) {
    assert.match(route, /public_location\.publication_status = 'published'/);
  }
  assert.match(orders, /publicPickupEnabled/);
  assert.match(orders, /hasPublishedServicePoint/);
  assert.match(orders, /Delivery is unavailable until this pharmacy publishes a customer service point/);
  assert.doesNotMatch(orders, /v\.latitude|v\.longitude|deliveryRadiusKm/);
  assert.match(orders, /Pickup is unavailable until this pharmacy publishes a customer pickup point/);
});
