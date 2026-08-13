import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { AdminStoreMapFilterError, loadAdminStoreMap } from "../lib/admin-store-map.ts";

class Statement {
  constructor(sqlite, sql) { this.sqlite = sqlite; this.sql = sql; this.parameters = []; }
  bind(...parameters) { this.parameters = parameters; return this; }
  async first() { return this.sqlite.prepare(this.sql).get(...this.parameters) ?? null; }
  async all() { return { results: this.sqlite.prepare(this.sql).all(...this.parameters) }; }
}
class D1 { constructor(sqlite) { this.sqlite = sqlite; } prepare(sql) { return new Statement(this.sqlite, sql); } }

function fixture(t) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE vendors (id INTEGER PRIMARY KEY,business_name TEXT,owner_name TEXT,registration_status TEXT,
      approval_status TEXT,compliance_status TEXT,suspended_at TEXT,home_delivery INTEGER,latitude TEXT,longitude TEXT);
    CREATE TABLE vendor_public_locations (vendor_id INTEGER,label TEXT,address TEXT,latitude TEXT,longitude TEXT,
      publication_status TEXT,pickup_enabled INTEGER,service_enabled INTEGER);
    INSERT INTO vendors VALUES
      (1,'Published Pharmacy','Owner A','submitted','approved','verified',NULL,1,'17.4300','78.4000'),
      (2,'Private Pharmacy','Owner B','submitted','pending','pending',NULL,0,'12.9700','77.5900'),
      (3,'Suspended Pharmacy','Owner C','submitted','approved','verified','2026-08-01',1,'','');
    INSERT INTO vendor_public_locations VALUES
      (1,'Published pickup','Public market road','17.4400','78.4100','published',1,1),
      (2,'Draft pickup','Private draft address','12.9800','77.6000','draft',0,0);
  `);
  t.after(() => sqlite.close());
  return new D1(sqlite);
}

test("admin store map filters public/private location state and effective vendor status", async (t) => {
  const db = fixture(t);
  const all = await loadAdminStoreMap(db, new URL("https://urmed.test/api/admin/stores/map"));
  assert.deepEqual(all.counts, { total: 3, published: 1, privateLocated: 2, approved: 1, suspended: 1 });
  const publishedStore = all.stores.find((store) => store.vendorId === 1);
  assert.equal(publishedStore.publicLocation.address, "Public market road");
  assert.deepEqual(publishedStore.privatePoint, { latitude: 17.43, longitude: 78.4 });
  const published = await loadAdminStoreMap(db, new URL("https://urmed.test/api/admin/stores/map?location=published&status=approved&homeDelivery=yes"));
  assert.equal(published.stores.length, 1);
  assert.equal(published.stores[0].businessName, "Published Pharmacy");
  const missing = await loadAdminStoreMap(db, new URL("https://urmed.test/api/admin/stores/map?location=private_missing"));
  assert.equal(missing.stores[0].effectiveStatus, "suspended");
});

test("admin store map rejects unsupported filters and never relies on third-party tiles", async (t) => {
  const db = fixture(t);
  await assert.rejects(loadAdminStoreMap(db, new URL("https://urmed.test/api/admin/stores/map?status=operational")),
    (error) => error instanceof AdminStoreMapFilterError);
  const { readFile } = await import("node:fs/promises");
  const [route, ui] = await Promise.all([
    readFile(new URL("../app/api/admin/stores/map/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/admin-store-map.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(route, /requireAdminProfile\(request\)/);
  assert.match(route, /private, no-store/);
  assert.match(ui, /authenticatedFetch\(`\/api\/admin\/stores\/map/);
  assert.doesNotMatch(ui, /tileLayer|openstreetmap|google\.com\/maps|leaflet/i);
  assert.match(ui, /no external map tiles/);
});
