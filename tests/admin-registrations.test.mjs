import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { AdminRegistrationFilterError, listAdminRegistrations } from "../lib/admin-registrations.ts";

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
    CREATE TABLE account_profiles (id INTEGER PRIMARY KEY,role TEXT,name TEXT,email TEXT,phone TEXT,
      email_verified INTEGER,phone_verified INTEGER,status TEXT,created_at TEXT);
    CREATE TABLE vendors (id INTEGER PRIMARY KEY,profile_id INTEGER,business_name TEXT,registration_status TEXT,
      approval_status TEXT,compliance_status TEXT,suspended_at TEXT);
    CREATE TABLE vendor_staff (id INTEGER PRIMARY KEY,vendor_id INTEGER,profile_id INTEGER,status TEXT);
    INSERT INTO account_profiles VALUES
      (1,'vendor','Owner One','owner@example.test','+917000000001',1,1,'active','2026-08-10T10:00:00Z'),
      (2,'customer','Customer Two','customer@example.test','+917000000002',1,0,'active','2026-08-11T10:00:00Z'),
      (3,'vendor','Suspended Staff','staff@example.test','+917000000003',1,1,'active','2026-08-12T10:00:00Z'),
      (4,'admin','Inactive Admin','admin@example.test','',1,1,'inactive','2026-08-13T10:00:00Z');
    INSERT INTO vendors VALUES (10,1,'Alpha Pharmacy','submitted','approved','verified',NULL),
      (11,NULL,'Suspended Pharmacy','submitted','approved','verified','2026-08-12T11:00:00Z');
    INSERT INTO vendor_staff VALUES (1,11,3,'active');
  `);
  t.after(() => sqlite.close());
  return new D1(sqlite);
}

test("registration directory filters live roles, effective status, dates and names with pagination", async (t) => {
  const db = fixture(t);
  const vendors = await listAdminRegistrations(db, new URL("https://urmed.test/api/admin/registrations?role=vendor&pageSize=5"));
  assert.equal(vendors.categoryDefinition.includes("live account role"), true);
  assert.deepEqual(vendors.registrations.map((row) => [row.name, row.accountStatus]), [
    ["Suspended Staff", "suspended"], ["Owner One", "active"],
  ]);
  const customer = await listAdminRegistrations(db, new URL("https://urmed.test/api/admin/registrations?q=customer&dateFrom=2026-08-11&dateTo=2026-08-11&pageSize=5"));
  assert.equal(customer.registrations.length, 1);
  assert.equal(customer.registrations[0].verificationStatus, "phone_pending");
  const inactive = await listAdminRegistrations(db, new URL("https://urmed.test/api/admin/registrations?status=inactive&pageSize=5"));
  assert.equal(inactive.registrations[0].role, "admin");
});

test("registration directory rejects unbounded or ambiguous filters", async (t) => {
  const db = fixture(t);
  await assert.rejects(listAdminRegistrations(db, new URL("https://urmed.test/api/admin/registrations?role=owner")),
    (error) => error instanceof AdminRegistrationFilterError);
  await assert.rejects(listAdminRegistrations(db, new URL("https://urmed.test/api/admin/registrations?dateFrom=2026-09-01&dateTo=2026-08-01")),
    /must not be after/);
});

test("registration HTTP and UI surfaces use admin auth, no-store and authenticated requests", async () => {
  const { readFile } = await import("node:fs/promises");
  const [route, ui, portal] = await Promise.all([
    readFile(new URL("../app/api/admin/registrations/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/admin-registration-list.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/requirements-portal.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(route, /requireAdminProfile\(request\)/);
  assert.match(route, /private, no-store/);
  assert.match(ui, /authenticatedFetch\(`\/api\/admin\/registrations/);
  assert.match(ui, /Account category \/ role/);
  assert.match(portal, /<AdminRegistrationList \/>/);
});
