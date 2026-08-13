import { appendAuditEvent } from "./audit.ts";

export class InventoryAdjustmentError extends Error {
  readonly status: number;

  constructor(message: string, status = 409) {
    super(message);
    this.name = "InventoryAdjustmentError";
    this.status = status;
  }
}

type AdjustmentReason = {
  code: string;
  label: string;
  direction: "increase" | "decrease" | "both";
  requiresNotes: number;
};

type InventorySnapshot = {
  id: number;
  productName: string;
  batchNumber: string;
  quantity: number;
  reservedQuantity: number;
};

type ManualAdjustmentInput = {
  db: D1Database;
  vendorId: number;
  actorProfileId: number;
  inventoryId: number;
  expectedQuantity: number;
  quantityDelta: number;
  reasonCode: string;
  notes: string;
  idempotencyKey: string;
  requestId?: string;
};

type CountLineInput = {
  inventoryId: number;
  expectedQuantity: number;
  countedQuantity: number;
};

type CompleteCountInput = {
  db: D1Database;
  vendorId: number;
  actorProfileId: number;
  scopeLabel: string;
  notes?: string;
  idempotencyKey: string;
  lines: CountLineInput[];
  requestId?: string;
};

function integer(value: unknown, label: string, minimum: number, maximum = 1_000_000) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new InventoryAdjustmentError(`${label} is invalid`, 400);
  }
  return parsed;
}

function idempotencyKey(value: string) {
  const normalized = value.trim();
  if (normalized.length < 8 || normalized.length > 100 || !/^[A-Za-z0-9._:-]+$/.test(normalized)) {
    throw new InventoryAdjustmentError("A valid idempotency key is required", 400);
  }
  return normalized;
}

function referenceNumber(prefix: string) {
  return `${prefix}-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${crypto.randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
}

async function inventoryForVendor(db: D1Database, vendorId: number, inventoryId: number) {
  const inventory = await db.prepare(`
    SELECT inventory.id, product.name AS productName, inventory.batch_number AS batchNumber,
      inventory.quantity, inventory.reserved_quantity AS reservedQuantity
    FROM pharmacy_inventory inventory JOIN products product ON product.id = inventory.product_id
    WHERE inventory.id = ? AND inventory.vendor_id = ? LIMIT 1
  `).bind(inventoryId, vendorId).first<InventorySnapshot>();
  if (!inventory) throw new InventoryAdjustmentError("Inventory batch not found", 404);
  return inventory;
}

async function adjustmentByKey(db: D1Database, vendorId: number, key: string) {
  return db.prepare(`SELECT id, adjustment_number AS adjustmentNumber, inventory_id AS inventoryId,
      expected_quantity AS expectedQuantity, quantity_delta AS quantityDelta,
      balance_after AS balanceAfter, source_type AS sourceType, reason_code AS reasonCode, notes
    FROM inventory_adjustments WHERE vendor_id = ? AND idempotency_key = ? LIMIT 1`)
    .bind(vendorId, key).first<{ id: number; adjustmentNumber: string; inventoryId: number; expectedQuantity: number; quantityDelta: number; balanceAfter: number; sourceType: string; reasonCode: string; notes: string }>();
}

function assertSameAdjustment(existing: NonNullable<Awaited<ReturnType<typeof adjustmentByKey>>>, input: ManualAdjustmentInput) {
  if (existing.sourceType !== "manual"
    || existing.inventoryId !== Number(input.inventoryId)
    || existing.expectedQuantity !== Number(input.expectedQuantity)
    || existing.quantityDelta !== Number(input.quantityDelta)
    || existing.reasonCode !== input.reasonCode.trim().toLowerCase()
    || existing.notes !== input.notes.trim().slice(0, 300)) {
    throw new InventoryAdjustmentError("This idempotency key was already used for a different inventory adjustment");
  }
}

function mapGuardError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (/inventory_(?:adjustment|count)_(?:stale|reserved|scope|invalid)/i.test(message)) {
    throw new InventoryAdjustmentError("Inventory changed or the resulting physical stock would be below reserved stock. Refresh and recount before retrying.");
  }
  throw error;
}

export async function applyInventoryAdjustment(input: ManualAdjustmentInput) {
  const { db, vendorId, actorProfileId, requestId = "" } = input;
  const inventoryId = integer(input.inventoryId, "Inventory batch", 1, 1_000_000_000);
  const expectedQuantity = integer(input.expectedQuantity, "Expected quantity", 0);
  const quantityDelta = integer(Math.abs(input.quantityDelta), "Adjustment quantity", 1) * Math.sign(input.quantityDelta);
  const key = idempotencyKey(input.idempotencyKey);
  const existing = await adjustmentByKey(db, vendorId, key);
  if (existing) {
    assertSameAdjustment(existing, input);
    return { ...existing, duplicate: true as const };
  }
  const reasonCode = input.reasonCode.trim().toLowerCase();
  const notes = input.notes.trim().slice(0, 300);
  const [inventory, reason] = await Promise.all([
    inventoryForVendor(db, vendorId, inventoryId),
    db.prepare(`SELECT code, label, direction, requires_notes AS requiresNotes
      FROM inventory_adjustment_reason_codes WHERE code = ? AND active = 1 LIMIT 1`)
      .bind(reasonCode).first<AdjustmentReason>(),
  ]);
  if (!reason || reason.code === "cycle_count_variance") throw new InventoryAdjustmentError("Choose an active manual adjustment reason", 400);
  if ((quantityDelta > 0 && reason.direction === "decrease") || (quantityDelta < 0 && reason.direction === "increase")) {
    throw new InventoryAdjustmentError(`${reason.label} cannot be used for this adjustment direction`, 400);
  }
  if ((reason.requiresNotes || notes.length > 0) && notes.length < 5) throw new InventoryAdjustmentError("Enter adjustment notes of at least 5 characters", 400);
  if (inventory.quantity !== expectedQuantity) throw new InventoryAdjustmentError("Inventory changed. Refresh before adjusting it.");
  const balanceAfter = expectedQuantity + quantityDelta;
  if (balanceAfter < inventory.reservedQuantity) {
    throw new InventoryAdjustmentError(`Physical stock cannot be reduced below ${inventory.reservedQuantity} reserved units`);
  }
  const adjustmentNumber = referenceNumber("ADJ");
  const statements: D1PreparedStatement[] = [
    db.prepare(`INSERT INTO inventory_adjustments
      (adjustment_number, idempotency_key, vendor_id, inventory_id, source_type, source_id,
        reason_code, reason_label, expected_quantity, quantity_before, quantity_delta, balance_after,
        reserved_quantity_snapshot, notes, created_by_profile_id)
      VALUES (?, ?, ?, ?, 'manual', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(adjustmentNumber, key, vendorId, inventoryId, reason.code, reason.label, expectedQuantity,
        expectedQuantity, quantityDelta, balanceAfter, inventory.reservedQuantity, notes, actorProfileId),
    db.prepare(`UPDATE pharmacy_inventory SET quantity = quantity + ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND vendor_id = ? AND quantity = ?
        AND quantity + ? >= reserved_quantity AND quantity + ? >= 0`)
      .bind(quantityDelta, inventoryId, vendorId, expectedQuantity, quantityDelta, quantityDelta),
    db.prepare(`INSERT INTO stock_ledger (vendor_id, inventory_id, movement_type, quantity_delta,
        balance_after, reference_type, reference_id, reason, actor_profile_id)
      SELECT adjustment.vendor_id, adjustment.inventory_id, 'inventory_adjustment',
        adjustment.quantity_delta, inventory.quantity, 'inventory_adjustment', adjustment.id,
        adjustment.reason_label || CASE WHEN adjustment.notes = '' THEN '' ELSE ' · ' || adjustment.notes END,
        adjustment.created_by_profile_id
      FROM inventory_adjustments adjustment
      JOIN pharmacy_inventory inventory ON inventory.id = adjustment.inventory_id
      WHERE adjustment.adjustment_number = ? AND adjustment.vendor_id = ?`)
      .bind(adjustmentNumber, vendorId),
  ];
  let results: D1Result<unknown>[];
  try {
    results = await db.batch(statements);
  } catch (error) {
    const duplicate = await adjustmentByKey(db, vendorId, key);
    if (duplicate) {
      assertSameAdjustment(duplicate, input);
      return { ...duplicate, duplicate: true as const };
    }
    mapGuardError(error);
  }
  if (Number(results[1]?.meta.changes ?? 0) !== 1 || Number(results[2]?.meta.changes ?? 0) !== 1) {
    throw new InventoryAdjustmentError("Inventory adjustment could not be reconciled. Refresh before retrying.");
  }
  const saved = await adjustmentByKey(db, vendorId, key);
  if (!saved) throw new Error("Inventory adjustment could not be loaded");
  await appendAuditEvent({
    vendorId, actorProfileId, action: "inventory.adjustment.completed", entityType: "inventory_adjustment",
    entityId: saved.id, before: { inventoryId, quantity: expectedQuantity, reservedQuantity: inventory.reservedQuantity },
    after: { inventoryId, quantityDelta, balanceAfter, reasonCode, notes }, requestId,
  }, db);
  return { ...saved, duplicate: false as const };
}

async function countSessionByKey(db: D1Database, vendorId: number, key: string) {
  return db.prepare(`SELECT id, session_number AS sessionNumber, line_count AS lineCount,
      variance_line_count AS varianceLineCount, net_variance_quantity AS netVarianceQuantity,
      scope_label AS scopeLabel, notes
    FROM inventory_count_sessions WHERE vendor_id = ? AND idempotency_key = ? LIMIT 1`)
    .bind(vendorId, key).first<{ id: number; sessionNumber: string; lineCount: number; varianceLineCount: number; netVarianceQuantity: number; scopeLabel: string; notes: string }>();
}

async function assertSameCount(db: D1Database, existing: NonNullable<Awaited<ReturnType<typeof countSessionByKey>>>, input: CompleteCountInput) {
  const requested = (Array.isArray(input.lines) ? input.lines : []).map((line) => ({
    inventoryId: Number(line.inventoryId), expectedQuantity: Number(line.expectedQuantity), countedQuantity: Number(line.countedQuantity),
  })).sort((left, right) => left.inventoryId - right.inventoryId);
  const stored = await db.prepare(`SELECT inventory_id AS inventoryId, expected_quantity AS expectedQuantity,
      counted_quantity AS countedQuantity FROM inventory_count_lines WHERE count_session_id = ? ORDER BY inventory_id`)
    .bind(existing.id).all<{ inventoryId: number; expectedQuantity: number; countedQuantity: number }>();
  if (existing.scopeLabel !== input.scopeLabel.trim().slice(0, 120)
    || existing.notes !== (input.notes ?? "").trim().slice(0, 300)
    || JSON.stringify(stored.results) !== JSON.stringify(requested)) {
    throw new InventoryAdjustmentError("This idempotency key was already used for a different inventory count");
  }
}

export async function completeInventoryCount(input: CompleteCountInput) {
  const { db, vendorId, actorProfileId, requestId = "" } = input;
  const key = idempotencyKey(input.idempotencyKey);
  const existing = await countSessionByKey(db, vendorId, key);
  if (existing) {
    await assertSameCount(db, existing, input);
    return { ...existing, duplicate: true as const };
  }
  const scopeLabel = input.scopeLabel.trim().slice(0, 120);
  const notes = (input.notes ?? "").trim().slice(0, 300);
  if (scopeLabel.length < 3) throw new InventoryAdjustmentError("Enter a count scope of at least 3 characters", 400);
  if (!Array.isArray(input.lines) || input.lines.length < 1 || input.lines.length > 100) {
    throw new InventoryAdjustmentError("Choose between 1 and 100 inventory batches to count", 400);
  }
  const normalized = new Map<number, { expectedQuantity: number; countedQuantity: number }>();
  for (const raw of input.lines) {
    const inventoryId = integer(raw.inventoryId, "Inventory batch", 1, 1_000_000_000);
    if (normalized.has(inventoryId)) throw new InventoryAdjustmentError("An inventory batch appears twice in this count", 400);
    normalized.set(inventoryId, {
      expectedQuantity: integer(raw.expectedQuantity, "Expected quantity", 0),
      countedQuantity: integer(raw.countedQuantity, "Counted quantity", 0),
    });
  }
  const placeholders = [...normalized].map(() => "?").join(",");
  const inventoryResult = await db.prepare(`SELECT inventory.id, product.name AS productName,
      inventory.batch_number AS batchNumber, inventory.quantity,
      inventory.reserved_quantity AS reservedQuantity
    FROM pharmacy_inventory inventory JOIN products product ON product.id = inventory.product_id
    WHERE inventory.vendor_id = ? AND inventory.id IN (${placeholders}) ORDER BY inventory.id`)
    .bind(vendorId, ...normalized.keys()).all<InventorySnapshot>();
  if (inventoryResult.results.length !== normalized.size) throw new InventoryAdjustmentError("A selected inventory batch was not found", 404);
  for (const inventory of inventoryResult.results) {
    const line = normalized.get(inventory.id)!;
    if (inventory.quantity !== line.expectedQuantity) throw new InventoryAdjustmentError(`${inventory.productName}: inventory changed before the count was submitted`);
    if (line.countedQuantity < inventory.reservedQuantity) {
      throw new InventoryAdjustmentError(`${inventory.productName}: counted stock cannot be below ${inventory.reservedQuantity} reserved units`);
    }
  }
  const sessionNumber = referenceNumber("COUNT");
  const variances = inventoryResult.results.map((inventory) => ({
    inventory,
    ...normalized.get(inventory.id)!,
    quantityDelta: normalized.get(inventory.id)!.countedQuantity - normalized.get(inventory.id)!.expectedQuantity,
  }));
  const varianceLineCount = variances.filter((line) => line.quantityDelta !== 0).length;
  const netVarianceQuantity = variances.reduce((sum, line) => sum + line.quantityDelta, 0);
  const statements: D1PreparedStatement[] = [
    db.prepare(`INSERT INTO inventory_count_sessions
      (session_number, idempotency_key, vendor_id, scope_label, notes, status,
        line_count, variance_line_count, net_variance_quantity, completed_by_profile_id)
      VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)`)
      .bind(sessionNumber, key, vendorId, scopeLabel, notes, variances.length,
        varianceLineCount, netVarianceQuantity, actorProfileId),
  ];
  const inventoryUpdateResultIndexes: number[] = [];
  for (const line of variances) {
    statements.push(db.prepare(`INSERT INTO inventory_count_lines
      (count_session_id, inventory_id, expected_quantity, counted_quantity, variance_quantity,
        reserved_quantity_snapshot)
      SELECT session.id, ?, ?, ?, ?, ? FROM inventory_count_sessions session
      WHERE session.session_number = ? AND session.vendor_id = ?`)
      .bind(line.inventory.id, line.expectedQuantity, line.countedQuantity, line.quantityDelta,
        line.inventory.reservedQuantity, sessionNumber, vendorId));
    if (line.quantityDelta !== 0) {
      const adjustmentNumber = referenceNumber("ADJ");
      const lineKey = `${key}:${line.inventory.id}`;
      statements.push(db.prepare(`INSERT INTO inventory_adjustments
        (adjustment_number, idempotency_key, vendor_id, inventory_id, source_type, source_id,
          reason_code, reason_label, expected_quantity, quantity_before, quantity_delta, balance_after,
          reserved_quantity_snapshot, notes, created_by_profile_id)
        SELECT ?, ?, ?, ?, 'cycle_count', session.id, 'cycle_count_variance', 'Cycle-count variance', ?, ?, ?, ?, ?, ?, ?
        FROM inventory_count_sessions session WHERE session.session_number = ? AND session.vendor_id = ?`)
        .bind(adjustmentNumber, lineKey, vendorId, line.inventory.id, line.expectedQuantity,
          line.expectedQuantity, line.quantityDelta, line.countedQuantity, line.inventory.reservedQuantity,
          `Cycle count ${sessionNumber}`, actorProfileId, sessionNumber, vendorId));
      inventoryUpdateResultIndexes.push(statements.length);
      statements.push(db.prepare(`UPDATE pharmacy_inventory SET quantity = ?, last_counted_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP WHERE id = ? AND vendor_id = ? AND quantity = ? AND ? >= reserved_quantity`)
        .bind(line.countedQuantity, line.inventory.id, vendorId, line.expectedQuantity, line.countedQuantity));
      statements.push(db.prepare(`INSERT INTO stock_ledger (vendor_id, inventory_id, movement_type,
          quantity_delta, balance_after, reference_type, reference_id, reason, actor_profile_id)
        SELECT adjustment.vendor_id, adjustment.inventory_id, 'cycle_count_adjustment',
          adjustment.quantity_delta, inventory.quantity, 'inventory_adjustment', adjustment.id,
          'Cycle count ' || ?, adjustment.created_by_profile_id
        FROM inventory_adjustments adjustment JOIN pharmacy_inventory inventory ON inventory.id = adjustment.inventory_id
        WHERE adjustment.adjustment_number = ? AND adjustment.vendor_id = ?`)
        .bind(sessionNumber, adjustmentNumber, vendorId));
    } else {
      inventoryUpdateResultIndexes.push(statements.length);
      statements.push(db.prepare(`UPDATE pharmacy_inventory SET last_counted_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP WHERE id = ? AND vendor_id = ? AND quantity = ? AND ? >= reserved_quantity`)
        .bind(line.inventory.id, vendorId, line.expectedQuantity, line.countedQuantity));
    }
  }
  let results: D1Result<unknown>[];
  try {
    results = await db.batch(statements);
  } catch (error) {
    const duplicate = await countSessionByKey(db, vendorId, key);
    if (duplicate) {
      await assertSameCount(db, duplicate, input);
      return { ...duplicate, duplicate: true as const };
    }
    mapGuardError(error);
  }
  if (inventoryUpdateResultIndexes.some((index) => Number(results[index]?.meta.changes ?? 0) !== 1)) {
    throw new InventoryAdjustmentError("Inventory changed while the count was being completed. Refresh and recount.");
  }
  const saved = await countSessionByKey(db, vendorId, key);
  if (!saved) throw new Error("Inventory count could not be loaded");
  await appendAuditEvent({
    vendorId, actorProfileId, action: "inventory.count.completed", entityType: "inventory_count_session",
    entityId: saved.id, before: { scopeLabel }, after: {
      sessionNumber, lineCount: variances.length, varianceLineCount, netVarianceQuantity,
      lines: variances.map((line) => ({ inventoryId: line.inventory.id, expectedQuantity: line.expectedQuantity,
        countedQuantity: line.countedQuantity, quantityDelta: line.quantityDelta })),
    }, requestId,
  }, db);
  return { ...saved, duplicate: false as const };
}
