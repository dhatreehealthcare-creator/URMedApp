import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  escapeSupplierSqlLike,
  parseSupplierHistoryPage,
  parseVendorSupplierQuery,
  vendorSupplierSortExpression,
} from "../lib/vendor-supplier-query.ts";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("supplier directory query parameters are normalized, bounded, and allowlisted", () => {
  assert.deepEqual(parseVendorSupplierQuery(new URL("https://urmed.test/api/vendor/suppliers")), {
    query: "",
    status: "all",
    sort: "name",
    page: 1,
    pageSize: 12,
  });
  assert.deepEqual(parseVendorSupplierQuery(new URL("https://urmed.test/api/vendor/suppliers?q=%20Stockist%20%20GST%20&status=active&sort=payable_high&page=3&pageSize=25")), {
    query: "Stockist GST",
    status: "active",
    sort: "payable_high",
    page: 3,
    pageSize: 25,
  });
  const invalid = parseVendorSupplierQuery(new URL("https://urmed.test/api/vendor/suppliers?status=deleted&sort=random&page=-4&pageSize=500"));
  assert.equal(invalid.status, "all");
  assert.equal(invalid.sort, "name");
  assert.equal(invalid.page, 1);
  assert.equal(invalid.pageSize, 50);
  assert.deepEqual(parseSupplierHistoryPage(new URL("https://urmed.test/api/vendor/suppliers/1?page=2&pageSize=5")), { page: 2, pageSize: 5 });
});

test("supplier search escapes SQL LIKE metacharacters and sort fragments are fixed", () => {
  assert.equal(escapeSupplierSqlLike("50%_off\\today"), "50\\%\\_off\\\\today");
  assert.equal(vendorSupplierSortExpression("name"), "supplier.business_name COLLATE NOCASE, supplier.id");
  assert.match(vendorSupplierSortExpression("payable_high"), /^payablePaise DESC/);
});

test("supplier list and detail routes authenticate and scope every read to the resolved vendor", () => {
  const listRoute = read("../app/api/vendor/suppliers/route.ts");
  const detailRoute = read("../app/api/vendor/suppliers/[id]/route.ts");
  for (const route of [listRoute, detailRoute]) assert.match(route, /requireVendorPermission\(request, "purchase\.write"\)/);
  assert.match(listRoute, /predicates = \["supplier\.vendor_id = \?"\]/);
  assert.match(listRoute, /purchase\.vendor_id = supplier\.vendor_id/);
  assert.match(listRoute, /ledger\.reference_type = 'purchase_receipt'/);
  assert.match(listRoute, /supplier_return\.vendor_id = supplier\.vendor_id/);
  assert.match(listRoute, /recorded_supplier_ledger/);
  assert.match(detailRoute, /FROM suppliers WHERE id = \? AND vendor_id = \? LIMIT 1/);
  assert.match(detailRoute, /purchase\.vendor_id = \? AND purchase\.supplier_id = \?/);
  assert.match(detailRoute, /receipt_purchase\.supplier_id = \?/);
  assert.match(detailRoute, /supplier_return\.vendor_id = \? AND supplier_return\.supplier_id = \?/);
  assert.match(detailRoute, /Supplier not found/);
});

test("supplier UI preserves create/edit and adds live directory, balance, history, and ledger surfaces", () => {
  const procurement = read("../app/procurement-center.tsx");
  const directory = read("../app/supplier-directory.tsx");
  assert.match(procurement, /action: "supplier", id: editingSupplier\?\.id/);
  assert.match(procurement, /<SupplierDirectory onEdit=\{setEditingSupplier\}/);
  assert.match(directory, /\/api\/vendor\/suppliers\?\$\{parameters\}/);
  assert.match(directory, /\/api\/vendor\/suppliers\/\$\{supplierId\}\?page=/);
  assert.match(directory, /Recorded payable/);
  assert.match(directory, /detail\.purchases\.map/);
  assert.match(directory, /detail\.ledger\.map/);
  assert.match(directory, /Supplier payment posting is not yet implemented/);
});
