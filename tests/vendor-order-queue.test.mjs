import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  escapeSqlLike,
  parseVendorOrderQueueQuery,
  vendorOrderSortExpression,
  vendorOrderStatusPredicate,
} from "../lib/vendor-order-query.ts";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("vendor order queue parameters are allowlisted, bounded, and normalized", () => {
  assert.deepEqual(parseVendorOrderQueueQuery(new URL("https://urmed.test/api/vendor/orders")), {
    query: "",
    status: "all",
    payment: "all",
    delivery: "all",
    sort: "newest",
    page: 1,
    pageSize: 20,
  });
  assert.deepEqual(parseVendorOrderQueueQuery(new URL("https://urmed.test/api/vendor/orders?q=%20Dolo%20%20Reddy%20&status=action_required&payment=paid&delivery=pickup&sort=amount_high&page=4&pageSize=50")), {
    query: "Dolo Reddy",
    status: "action_required",
    payment: "paid",
    delivery: "pickup",
    sort: "amount_high",
    page: 4,
    pageSize: 50,
  });
  const rejected = parseVendorOrderQueueQuery(new URL("https://urmed.test/api/vendor/orders?status=DROP+TABLE&payment=%25&delivery=private&sort=random&page=-5&pageSize=500"));
  assert.equal(rejected.status, "all");
  assert.equal(rejected.payment, "all");
  assert.equal(rejected.delivery, "all");
  assert.equal(rejected.sort, "newest");
  assert.equal(rejected.page, 1);
  assert.equal(rejected.pageSize, 50);
});

test("vendor order search escapes SQL LIKE metacharacters and uses fixed SQL fragments", () => {
  assert.equal(escapeSqlLike("50%_off\\today"), "50\\%\\_off\\\\today");
  assert.match(vendorOrderStatusPredicate("action_required"), /prescription_status = 'pending_review'/);
  assert.match(vendorOrderStatusPredicate("action_required"), /payment_status = 'paid'/);
  assert.equal(vendorOrderStatusPredicate("completed"), "o.order_status = 'completed'");
  assert.equal(vendorOrderSortExpression("amount_high"), "o.total_paise DESC, datetime(o.created_at) DESC, o.id DESC");
});

test("vendor order APIs authenticate first and scope every order read to the resolved vendor", () => {
  const queueRoute = read("../app/api/vendor/orders/route.ts");
  const detailRoute = read("../app/api/vendor/orders/[id]/route.ts");
  assert.match(queueRoute, /requireVendorPermission\(request, "sale\.write"\)/);
  assert.match(queueRoute, /basePredicates = \["o\.vendor_id = \?", "o\.order_type = 'online'"\]/);
  assert.match(queueRoute, /\.bind\(\.\.\.baseBindings/);
  assert.match(detailRoute, /requireVendorPermission\(request, "sale\.write"\)/);
  assert.match(detailRoute, /WHERE o\.id = \? AND o\.vendor_id = \? AND \(\? IS NULL OR o\.branch_id = \?\) AND o\.order_type = 'online'/);
  assert.match(detailRoute, /WHERE item\.order_id = \? AND scoped_order\.vendor_id = \?/);
  assert.match(detailRoute, /WHERE event\.order_id = \? AND scoped_order\.vendor_id = \?/);
  assert.match(detailRoute, /prescription\.id = \? AND prescription\.vendor_id = \?/);
  assert.match(detailRoute, /Order not found/);
  assert.doesNotMatch(detailRoute, /razorpayOrderId|razorpayPaymentId/);
});

test("live vendor queue replaces static examples and reuses the controlled tracking command", () => {
  const component = read("../app/vendor-order-queue.tsx");
  assert.match(component, /authenticatedFetch\(`\/api\/vendor\/orders\?\$\{parameters\}`/);
  assert.match(component, /authenticatedFetch\(`\/api\/vendor\/orders\/\$\{orderId\}`/);
  assert.match(component, /authenticatedFetch\(`\/api\/orders\/\$\{detail\.id\}\/tracking`/);
  assert.match(component, /authenticatedFetch\(`\/api\/prescriptions\/\$\{detail\.prescriptionId\}\/review`/);
  assert.match(component, /authenticatedFetch\(`\/api\/documents\/\$\{detail\.prescription\.documentId\}`/);
  assert.match(component, /Order, customer, phone or medicine/);
  assert.match(component, /queue\.pagination\.totalPages/);
  assert.match(component, /detail\.items\.map/);
  assert.match(component, /detail\.trackingEvents/);
  assert.doesNotMatch(component, /UR1048|Ananya Reddy|Rohan Mehta/);
});
