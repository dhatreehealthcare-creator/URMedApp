import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  applyInventoryAdjustment,
  completeInventoryCount,
  InventoryAdjustmentError,
} from "../lib/inventory-adjustments.ts";

class TestStatement {
  constructor(owner, sql) { this.owner = owner; this.sql = sql; this.values = []; }
  bind(...values) { this.values = values; return this; }
  async first() { return this.owner.sqlite.prepare(this.sql).get(...this.values) ?? null; }
  async all() { return { results: this.owner.sqlite.prepare(this.sql).all(...this.values) }; }
  async run() {
    const result = this.owner.sqlite.prepare(this.sql).run(...this.values);
    return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }
}

class TestDatabase {
  constructor(sqlite) { this.sqlite = sqlite; this.beforeNextBatch = null; }
  prepare(sql) { return new TestStatement(this, sql); }
  async batch(statements) {
    if (this.beforeNextBatch) { const callback = this.beforeNextBatch; this.beforeNextBatch = null; callback(); }
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

function fixture(t) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE pharmacy_inventory (
      id INTEGER PRIMARY KEY, vendor_id INTEGER NOT NULL, product_id INTEGER NOT NULL,
      batch_number TEXT NOT NULL, quantity INTEGER NOT NULL, reserved_quantity INTEGER NOT NULL,
      last_counted_at TEXT, active INTEGER DEFAULT 1 NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
    CREATE TABLE inventory_adjustment_reason_codes (
      code TEXT PRIMARY KEY, label TEXT NOT NULL, direction TEXT NOT NULL,
      requires_notes INTEGER NOT NULL, active INTEGER NOT NULL, sort_order INTEGER NOT NULL
    );
    CREATE TABLE inventory_count_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_number TEXT UNIQUE NOT NULL,
      idempotency_key TEXT NOT NULL, vendor_id INTEGER NOT NULL, scope_label TEXT NOT NULL,
      notes TEXT NOT NULL, status TEXT NOT NULL, line_count INTEGER NOT NULL,
      variance_line_count INTEGER NOT NULL, net_variance_quantity INTEGER NOT NULL,
      completed_by_profile_id INTEGER NOT NULL, completed_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      UNIQUE(vendor_id,idempotency_key)
    );
    CREATE TABLE inventory_count_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT, count_session_id INTEGER NOT NULL,
      inventory_id INTEGER NOT NULL, expected_quantity INTEGER NOT NULL,
      counted_quantity INTEGER NOT NULL, variance_quantity INTEGER NOT NULL,
      reserved_quantity_snapshot INTEGER NOT NULL,
      UNIQUE(count_session_id,inventory_id)
    );
    CREATE TABLE inventory_adjustments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, adjustment_number TEXT UNIQUE NOT NULL,
      idempotency_key TEXT NOT NULL, vendor_id INTEGER NOT NULL, inventory_id INTEGER NOT NULL,
      source_type TEXT NOT NULL, source_id INTEGER, reason_code TEXT NOT NULL,
      reason_label TEXT NOT NULL,
      expected_quantity INTEGER NOT NULL, quantity_before INTEGER NOT NULL,
      quantity_delta INTEGER NOT NULL, balance_after INTEGER NOT NULL,
      reserved_quantity_snapshot INTEGER NOT NULL, notes TEXT NOT NULL,
      created_by_profile_id INTEGER NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      UNIQUE(vendor_id,idempotency_key)
    );
    CREATE TABLE stock_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT, vendor_id INTEGER NOT NULL,
      inventory_id INTEGER NOT NULL, movement_type TEXT NOT NULL, quantity_delta INTEGER NOT NULL,
      balance_after INTEGER NOT NULL, reference_type TEXT NOT NULL, reference_id INTEGER NOT NULL,
      reason TEXT NOT NULL, actor_profile_id INTEGER NOT NULL
    );
    CREATE TABLE audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, vendor_id INTEGER, actor_profile_id INTEGER,
      action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
      before_json TEXT NOT NULL, after_json TEXT NOT NULL, reason TEXT NOT NULL,
      request_id TEXT NOT NULL, previous_event_hash TEXT NOT NULL, event_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT INTO products VALUES (1,'Counted Medicine'),(2,'Reserved Medicine');
    INSERT INTO pharmacy_inventory (id,vendor_id,product_id,batch_number,quantity,reserved_quantity)
      VALUES (100,1,1,'COUNT-A',10,2),(101,1,2,'COUNT-B',5,5),(200,2,1,'OTHER',20,0);
    INSERT INTO inventory_adjustment_reason_codes VALUES
      ('damage','Damaged stock','decrease',1,1,10),
      ('found_stock','Found stock','increase',1,1,20),
      ('data_correction','Data correction','both',1,1,30),
      ('cycle_count_variance','Cycle-count variance','both',0,1,40);
    CREATE TRIGGER inventory_adjustment_insert_guard
    BEFORE INSERT ON inventory_adjustments
    WHEN NEW.quantity_delta = 0
      OR NEW.quantity_before <> NEW.expected_quantity
      OR NEW.balance_after <> NEW.quantity_before + NEW.quantity_delta
      OR NEW.vendor_id <> COALESCE((SELECT vendor_id FROM pharmacy_inventory WHERE id=NEW.inventory_id),-1)
      OR NEW.expected_quantity <> COALESCE((SELECT quantity FROM pharmacy_inventory WHERE id=NEW.inventory_id),-1)
      OR NEW.reserved_quantity_snapshot <> COALESCE((SELECT reserved_quantity FROM pharmacy_inventory WHERE id=NEW.inventory_id),-1)
      OR NEW.balance_after < NEW.reserved_quantity_snapshot OR NEW.balance_after < 0
    BEGIN SELECT RAISE(ABORT,'inventory_adjustment_stale'); END;
    CREATE TRIGGER inventory_count_line_insert_guard
    BEFORE INSERT ON inventory_count_lines
    WHEN NEW.expected_quantity <> COALESCE((SELECT quantity FROM pharmacy_inventory WHERE id=NEW.inventory_id),-1)
      OR NEW.reserved_quantity_snapshot <> COALESCE((SELECT reserved_quantity FROM pharmacy_inventory WHERE id=NEW.inventory_id),-1)
      OR NEW.counted_quantity < NEW.reserved_quantity_snapshot
      OR NEW.variance_quantity <> NEW.counted_quantity - NEW.expected_quantity
      OR COALESCE((SELECT vendor_id FROM pharmacy_inventory WHERE id=NEW.inventory_id),-1)
        <> COALESCE((SELECT vendor_id FROM inventory_count_sessions WHERE id=NEW.count_session_id),-2)
    BEGIN SELECT RAISE(ABORT,'inventory_count_stale'); END;
    CREATE TRIGGER inventory_adjustments_no_update BEFORE UPDATE ON inventory_adjustments
      BEGIN SELECT RAISE(ABORT,'inventory_adjustments_immutable'); END;
    CREATE TRIGGER inventory_adjustments_no_delete BEFORE DELETE ON inventory_adjustments
      BEGIN SELECT RAISE(ABORT,'inventory_adjustments_immutable'); END;
    CREATE TRIGGER inventory_count_sessions_no_update BEFORE UPDATE ON inventory_count_sessions
      BEGIN SELECT RAISE(ABORT,'inventory_count_sessions_immutable'); END;
    CREATE TRIGGER inventory_count_sessions_no_delete BEFORE DELETE ON inventory_count_sessions
      BEGIN SELECT RAISE(ABORT,'inventory_count_sessions_immutable'); END;
    CREATE TRIGGER inventory_count_lines_no_update BEFORE UPDATE ON inventory_count_lines
      BEGIN SELECT RAISE(ABORT,'inventory_count_lines_immutable'); END;
    CREATE TRIGGER inventory_count_lines_no_delete BEFORE DELETE ON inventory_count_lines
      BEGIN SELECT RAISE(ABORT,'inventory_count_lines_immutable'); END;
  `);
  const db = new TestDatabase(sqlite);
  t.after(() => sqlite.close());
  return { db, sqlite };
}

test("manual adjustments are reason-coded, append-only, guarded, audited, and idempotent", async (t) => {
  const { db, sqlite } = fixture(t);
  const input = {
    db, vendorId: 1, actorProfileId: 11, inventoryId: 100, expectedQuantity: 10,
    quantityDelta: 2, reasonCode: "found_stock", notes: "Found behind shelf", idempotencyKey: "manual-found-100",
  };
  const applied = await applyInventoryAdjustment(input);
  assert.equal(applied.duplicate, false);
  assert.equal(sqlite.prepare("SELECT quantity FROM pharmacy_inventory WHERE id=100").get().quantity, 12);
  assert.deepEqual({ ...sqlite.prepare("SELECT movement_type AS movementType,quantity_delta AS quantityDelta,balance_after AS balanceAfter FROM stock_ledger").get() }, {
    movementType: "inventory_adjustment", quantityDelta: 2, balanceAfter: 12,
  });
  assert.equal(sqlite.prepare("SELECT action FROM audit_events").get().action, "inventory.adjustment.completed");
  const duplicate = await applyInventoryAdjustment(input);
  assert.equal(duplicate.duplicate, true);
  await assert.rejects(applyInventoryAdjustment({ ...input, quantityDelta: 3 }), /already used for a different/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM inventory_adjustments").get().count, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM stock_ledger").get().count, 1);
  assert.throws(() => sqlite.prepare("UPDATE inventory_adjustments SET notes='changed'").run(), /immutable/);
  assert.throws(() => sqlite.prepare("DELETE FROM inventory_adjustments").run(), /immutable/);
});

test("manual adjustment rejects cross-tenant, wrong-direction, reserved-floor and stale concurrent changes", async (t) => {
  const { db, sqlite } = fixture(t);
  await assert.rejects(applyInventoryAdjustment({
    db, vendorId: 2, actorProfileId: 22, inventoryId: 100, expectedQuantity: 10,
    quantityDelta: 1, reasonCode: "found_stock", notes: "Cross tenant attempt", idempotencyKey: "cross-tenant-100",
  }), (error) => error instanceof InventoryAdjustmentError && error.status === 404);
  await assert.rejects(applyInventoryAdjustment({
    db, vendorId: 1, actorProfileId: 11, inventoryId: 100, expectedQuantity: 10,
    quantityDelta: 1, reasonCode: "damage", notes: "Wrong direction", idempotencyKey: "wrong-direction-100",
  }), /cannot be used/);
  await assert.rejects(applyInventoryAdjustment({
    db, vendorId: 1, actorProfileId: 11, inventoryId: 101, expectedQuantity: 5,
    quantityDelta: -1, reasonCode: "damage", notes: "Damaged reserved unit", idempotencyKey: "reserved-floor-101",
  }), /below 5 reserved units/);
  db.beforeNextBatch = () => sqlite.prepare("UPDATE pharmacy_inventory SET quantity=9 WHERE id=100").run();
  await assert.rejects(applyInventoryAdjustment({
    db, vendorId: 1, actorProfileId: 11, inventoryId: 100, expectedQuantity: 10,
    quantityDelta: -1, reasonCode: "damage", notes: "Concurrent writeoff", idempotencyKey: "concurrent-manual-100",
  }), (error) => error instanceof InventoryAdjustmentError && /Inventory changed/.test(error.message));
  assert.equal(sqlite.prepare("SELECT quantity FROM pharmacy_inventory WHERE id=100").get().quantity, 9);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM inventory_adjustments").get().count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM stock_ledger").get().count, 0);
});

test("a cycle count atomically records immutable lines and posts only variances", async (t) => {
  const { db, sqlite } = fixture(t);
  const input = {
    db, vendorId: 1, actorProfileId: 11, scopeLabel: "Full dispensary", notes: "Morning witnessed count",
    idempotencyKey: "count-full-20260812",
    lines: [
      { inventoryId: 100, expectedQuantity: 10, countedQuantity: 8 },
      { inventoryId: 101, expectedQuantity: 5, countedQuantity: 5 },
    ],
  };
  const completed = await completeInventoryCount(input);
  assert.equal(completed.duplicate, false);
  assert.equal(completed.lineCount, 2);
  assert.equal(completed.varianceLineCount, 1);
  assert.equal(completed.netVarianceQuantity, -2);
  assert.deepEqual(sqlite.prepare("SELECT id,quantity,last_counted_at IS NOT NULL AS counted FROM pharmacy_inventory WHERE id IN (100,101) ORDER BY id").all().map((row) => ({ ...row })), [
    { id: 100, quantity: 8, counted: 1 }, { id: 101, quantity: 5, counted: 1 },
  ]);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM inventory_count_lines").get().count, 2);
  assert.deepEqual({ ...sqlite.prepare("SELECT source_type AS sourceType,reason_code AS reasonCode,quantity_delta AS quantityDelta,balance_after AS balanceAfter FROM inventory_adjustments").get() }, {
    sourceType: "cycle_count", reasonCode: "cycle_count_variance", quantityDelta: -2, balanceAfter: 8,
  });
  assert.equal(sqlite.prepare("SELECT movement_type FROM stock_ledger").get().movement_type, "cycle_count_adjustment");
  assert.equal(sqlite.prepare("SELECT action FROM audit_events").get().action, "inventory.count.completed");
  assert.equal((await completeInventoryCount(input)).duplicate, true);
  await assert.rejects(completeInventoryCount({ ...input, lines: [{ inventoryId: 100, expectedQuantity: 10, countedQuantity: 7 }] }), /already used for a different/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM inventory_count_sessions").get().count, 1);
  assert.throws(() => sqlite.prepare("UPDATE inventory_count_sessions SET notes='changed'").run(), /immutable/);
  assert.throws(() => sqlite.prepare("DELETE FROM inventory_count_lines").run(), /immutable/);
});

test("cycle counts reject below-reservation and roll back all lines after a concurrent balance change", async (t) => {
  const { db, sqlite } = fixture(t);
  await assert.rejects(completeInventoryCount({
    db, vendorId: 1, actorProfileId: 11, scopeLabel: "Reserved shelf", idempotencyKey: "count-reserved-101",
    lines: [{ inventoryId: 101, expectedQuantity: 5, countedQuantity: 4 }],
  }), /cannot be below 5 reserved units/);
  db.beforeNextBatch = () => sqlite.prepare("UPDATE pharmacy_inventory SET quantity=4,reserved_quantity=4 WHERE id=101").run();
  await assert.rejects(completeInventoryCount({
    db, vendorId: 1, actorProfileId: 11, scopeLabel: "Concurrent full count", idempotencyKey: "count-concurrent-all",
    lines: [
      { inventoryId: 100, expectedQuantity: 10, countedQuantity: 9 },
      { inventoryId: 101, expectedQuantity: 5, countedQuantity: 5 },
    ],
  }), (error) => error instanceof InventoryAdjustmentError && /Inventory changed/.test(error.message));
  assert.equal(sqlite.prepare("SELECT quantity FROM pharmacy_inventory WHERE id=100").get().quantity, 10);
  assert.equal(sqlite.prepare("SELECT quantity FROM pharmacy_inventory WHERE id=101").get().quantity, 4);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM inventory_count_sessions").get().count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM inventory_count_lines").get().count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM inventory_adjustments").get().count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM stock_ledger").get().count, 0);
});

test("inventory reconciliation API and UI enforce permissions and tenant scoping", async () => {
  const { readFile } = await import("node:fs/promises");
  const [route, service, ui, permissions] = await Promise.all([
    readFile(new URL("../app/api/vendor/inventory-reconciliation/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/inventory-adjustments.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/stock-reconciliation-center.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/vendor-access.ts", import.meta.url), "utf8"),
  ]);
  assert.match(route, /requireVendorPermission\(request, "inventory\.read"\)/);
  assert.match(route, /requireVendorPermission\(request, "inventory\.write"\)/);
  assert.match(route, /inventory\.vendor_id = \?/);
  assert.match(service, /WHERE inventory\.id = \? AND inventory\.vendor_id = \?/);
  assert.match(service, /quantity \+ \? >= reserved_quantity/);
  assert.match(ui, /Existing quantities are never silently replaced/);
  assert.match(permissions, /inventory_manager: \["inventory\.read", "inventory\.write"/);
  assert.doesNotMatch(permissions, /counter_staff: \[[^\]]*"inventory\.write"/);
});
