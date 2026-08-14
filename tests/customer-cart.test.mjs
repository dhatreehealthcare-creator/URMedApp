import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  addCustomerCartLine,
  customerCartCheckoutItems,
  groupCustomerCart,
  updateCustomerCartQuantity,
} from "../lib/customer-cart.ts";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const offer = (inventoryId, vendorId, productName, prescriptionRequired = false) => ({
  inventoryId, vendorId, productId: inventoryId + 100, businessName: `Pharmacy ${vendorId}`,
  productName, salePricePaise: 1000 + inventoryId, gstPercent: 5, availableQuantity: 20,
  prescriptionRequired, homeDelivery: true, publicLocation: null,
});

test("cart adds, merges, bounds, updates, and removes live inventory lines", () => {
  let cart = addCustomerCartLine([], offer(1, 10, "Medicine A"), 2);
  cart = addCustomerCartLine(cart, offer(1, 10, "Medicine A"), 3);
  assert.equal(cart.length, 1);
  assert.equal(cart[0].quantity, 5);
  cart = updateCustomerCartQuantity(cart, 1, 999);
  assert.equal(cart[0].quantity, 20);
  assert.deepEqual(updateCustomerCartQuantity(cart, 1, 0), []);
});

test("cart groups lines by pharmacy and prepares separate order payloads", () => {
  let cart = addCustomerCartLine([], offer(1, 10, "OTC A"), 2);
  cart = addCustomerCartLine(cart, offer(2, 10, "Rx B", true), 1);
  cart = addCustomerCartLine(cart, offer(3, 20, "OTC C"), 4);
  const groups = groupCustomerCart(cart);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].lines.length, 2);
  assert.equal(groups[0].requiresPrescription, true);
  assert.deepEqual(customerCartCheckoutItems(groups[0]), [
    { inventoryId: 1, quantity: 2 }, { inventoryId: 2, quantity: 1 },
  ]);
});

test("production customer marketplace uses multi-line pharmacy carts and live checkout", () => {
  const marketplace = read("../app/live-marketplace.tsx");
  assert.match(marketplace, /groupCustomerCart\(cart\)/);
  assert.match(marketplace, /customerCartCheckoutItems\(checkoutGroup\)/);
  assert.match(marketplace, /Pharmacy groups are checked out as separate orders/);
  assert.match(marketplace, /setCart\(\(current\) => updateCustomerCartQuantity/);
  assert.match(marketplace, /current\.filter\(\(item\) => item\.inventoryId !== line\.inventoryId\)/);
  assert.match(marketplace, /prescriptionByVendor\[checkoutGroup\.vendorId\]/);
  assert.match(marketplace, /Final FEFO batches, prices, GST, prescription eligibility, stock and delivery serviceability are validated by the server/);
});

test("server keeps pharmacy, FEFO, current price, tax, Rx, address and serviceability authority", () => {
  const orders = read("../app/api/orders/route.ts");
  assert.match(orders, /Place separate orders for different pharmacies/);
  assert.match(orders, /allocateFefo\(productRequest\.quantity, batches\.results\)/);
  assert.match(orders, /effectivePriceFallbackSql\("i", "sale_price_paise"\)/);
  assert.match(orders, /calculateGst\(/);
  assert.match(orders, /customer_addresses\s+WHERE id=\? AND profile_id=\?/);
  assert.match(orders, /outside the pharmacy service area/);
  assert.match(orders, /NOT EXISTS \(SELECT 1 FROM orders used_order/);
  assert.match(orders, /This prescription was already used by another order/);
});

test("production storefront no longer contains demo cart, products, pharmacies or order success", () => {
  const page = read("../app/page.tsx");
  const portal = read("../app/requirements-portal.tsx");
  for (const marker of ["Dolo 650 Tablet", "Sri Balaji Pharmacy", "#UR1049", "Order #UR1048", "Ananya Reddy", "#UR1042"]) {
    assert.doesNotMatch(`${page}\n${portal}`, new RegExp(marker));
  }
  assert.match(page, /fetch\(`\/api\/catalog/);
  assert.match(page, /href="\/customer"/);
});

test("storefront search actions preserve the live inventory handoff", () => {
  const page = read("../app/page.tsx");
  const marketplace = read("../app/live-marketplace.tsx");
  assert.match(page, /Choose delivery location/);
  assert.match(page, /setQuery\(term\)/);
  assert.match(page, /\/customer\?section=orders&inventoryId=\$\{product\.inventoryId\}&add=1/);
  assert.match(marketplace, /url\.searchParams\.get\("add"\) === "1"/);
  assert.match(marketplace, /was added to your live pharmacy cart/);
  assert.match(marketplace, /LIVE MEDICINE DETAILS/);
  assert.match(read("../app/requirements-portal.tsx"), /URLSearchParams\(window\.location\.search\).*section.*orders/s);
});

test("packaged Worker covers multi-line checkout and Rx reuse controls", () => {
  const integration = read("./integration/phase0-api.integration.test.mjs");
  assert.match(integration, /multi-line pharmacy order/);
  assert.match(integration, /mixed pharmacy cart rejected/);
  assert.match(integration, /multiple Rx lines use one owned pharmacy prescription/);
  assert.match(integration, /used prescription cannot be reused/);
  assert.match(integration, /concurrent prescription reuse is rejected atomically/);
});
