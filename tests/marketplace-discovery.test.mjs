import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { rankMarketplaceOffers } from "../lib/marketplace-offer-ranking.ts";

const candidate = (inventoryId, vendorId, latitude, longitude, overrides = {}) => ({
  inventoryId,
  vendorId,
  availableQuantity: overrides.availableQuantity ?? 10,
  expiryDate: overrides.expiryDate ?? "2027-01-01",
  location: {
    latitude,
    longitude,
    pickupEnabled: overrides.pickupEnabled ?? false,
    serviceEnabled: overrides.serviceEnabled ?? true,
    serviceRadiusKm: overrides.serviceRadiusKm ?? 50,
  },
});

test("nearby offers are ranked server-side and retain offers beyond the former boundary", () => {
  const offers = Array.from({ length: 70 }, (_, index) => candidate(index + 1, index + 1, 0.1 + index / 10_000, 0));
  offers.push(candidate(9001, 9001, 0.001, 0, { availableQuantity: 1 }));
  const ranked = rankMarketplaceOffers(offers, { latitude: 0, longitude: 0 }, 1, 20, (value) => value);
  assert.equal(ranked.total, 71);
  assert.equal(ranked.offers[0].value.inventoryId, 9001);
  const fourthPage = rankMarketplaceOffers(offers, { latitude: 0, longitude: 0 }, 4, 20, (value) => value);
  assert.equal(fourthPage.offers.length, 11);
  assert.equal(fourthPage.hasMore, false);
});

test("nearby ranking applies serviceability, pickup and deterministic tie breakers", () => {
  const offers = [
    candidate(1, 1, 0.005, 0, { serviceRadiusKm: 1 }),
    candidate(2, 2, 0.005, 0, { serviceRadiusKm: 1, availableQuantity: 20 }),
    candidate(3, 3, 0.005, 0, { serviceEnabled: false, pickupEnabled: true, serviceRadiusKm: 1 }),
    candidate(4, 4, 1, 0, { serviceRadiusKm: 1 }),
  ];
  const ranked = rankMarketplaceOffers(offers, { latitude: 0, longitude: 0 }, 1, 20, (value) => value);
  assert.deepEqual(ranked.offers.map((offer) => offer.value.inventoryId), [2, 1, 3]);
});

test("invalid customer coordinates fail closed without returning public offers", () => {
  const ranked = rankMarketplaceOffers([candidate(1, 1, 0, 0)], { latitude: 91, longitude: 0 }, 1, 20, (value) => value);
  assert.deepEqual(ranked, { offers: [], total: 0, hasMore: false });
});

test("public search routes use published locations, bounded pagination and the shared ranking policy", async () => {
  const inventory = await readFile(new URL("../app/api/inventory/route.ts", import.meta.url), "utf8");
  const catalog = await readFile(new URL("../app/api/catalog/route.ts", import.meta.url), "utf8");
  const marketplace = await readFile(new URL("../app/live-marketplace.tsx", import.meta.url), "utf8");
  for (const source of [inventory, catalog]) {
    assert.match(source, /rankMarketplaceOffers/);
    assert.match(source, /JOIN vendor_public_locations/);
    assert.match(source, /MAX_CANDIDATES/);
    assert.match(source, /pageSize/);
    assert.doesNotMatch(source, /v\.(?:address|latitude|longitude)/);
  }
  assert.match(marketplace, /publicDistanceKm/);
  assert.match(marketplace, /Load more pharmacy offers/);
  assert.match(marketplace, /Offers are ranked by published pharmacy distance/);
  assert.doesNotMatch(marketplace, /publicInventory = inventory\.map\([\s\S]*?\.sort\(/);
});
