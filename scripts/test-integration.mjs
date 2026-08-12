#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Log, LogLevel, Miniflare } from "miniflare";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = path.join(projectRoot, "node_modules", ".bin", "wrangler");
const config = path.join(projectRoot, "dist", "server", "wrangler.json");
const worker = path.join(projectRoot, "dist", "server", "index.js");
const fixture = path.join(projectRoot, "tests", "integration", "fixtures", "phase0.sql");
const integrationTests = path.join(projectRoot, "tests", "integration", "phase0-api.integration.test.mjs");
const databaseBinding = "DB";

let runtime;
let activeCommand;
let interruptedSignal = "";
let runtimeLog = "";
let temporaryRoot = "";

function appendRuntimeLog(value) {
  runtimeLog += `${String(value).trimEnd()}\n`;
  if (runtimeLog.length > 300_000) runtimeLog = runtimeLog.slice(-300_000);
}

class BufferedLog extends Log {
  log(message) {
    appendRuntimeLog(message);
  }
}

function signalProcess(child, signal) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function terminateProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  signalProcess(child, "SIGTERM");
  const closed = new Promise((resolve) => child.once("close", resolve));
  const deadline = new Promise((resolve) => setTimeout(resolve, 3_000, "deadline"));
  if (await Promise.race([closed, deadline]) === "deadline") {
    signalProcess(child, "SIGKILL");
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2_000))]);
  }
}

function run(command, args) {
  const child = spawn(command, args, {
    cwd: projectRoot,
    env: { ...process.env, CI: "1" },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  activeCommand = child;
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (activeCommand === child) activeCommand = undefined;
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${path.basename(command)} exited ${code ?? `after ${signal}`}\n${stderr || stdout}`));
    });
  });
}

async function countR2PayloadFiles(directory) {
  let count = 0;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) count += await countR2PayloadFiles(candidate);
    else if (!/\.sqlite(?:-(?:wal|shm))?$/.test(entry.name)) count += 1;
  }
  return count;
}

async function collectWorkerModules(root, directory = root) {
  const modules = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) modules.push(...await collectWorkerModules(root, candidate));
    else if (/\.(?:js|mjs)$/.test(entry.name)) {
      modules.push({ type: "ESModule", path: path.relative(root, candidate), contents: await readFile(candidate, "utf8") });
    }
  }
  return modules;
}

async function findD1Database(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = await findD1Database(candidate);
      if (found) return found;
    } else if (entry.name.endsWith(".sqlite") && entry.name !== "metadata.sqlite") {
      return candidate;
    }
  }
  return "";
}

async function cleanup() {
  await terminateProcess(activeCommand);
  if (runtime) await runtime.dispose();
  runtime = undefined;
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    interruptedSignal = signal;
    void cleanup().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  });
}

try {
  await Promise.all([readFile(worker), readFile(config), readFile(fixture), readFile(integrationTests)]);
  const generatedConfig = JSON.parse(await readFile(config, "utf8"));
  const d1 = generatedConfig.d1_databases?.find((binding) => binding.binding === databaseBinding);
  if (d1?.database_id !== "00000000-0000-4000-8000-000000000000" || !generatedConfig.r2_buckets?.some((binding) => binding.binding === "BUCKET")) {
    throw new Error("Integration tests require the generated local-only DB and BUCKET bindings");
  }

  temporaryRoot = await mkdtemp(path.join(tmpdir(), "urmed-integration-"));
  const state = path.join(temporaryRoot, "state");
  const packagedMigrations = (await readdir(path.join(projectRoot, "dist", ".openai", "drizzle")))
    .filter((name) => /^\d+_.+\.sql$/.test(name)).length;
  if (!packagedMigrations) throw new Error("The production artifact does not contain D1 migrations");

  console.log("[integration] applying all packaged migrations to clean local D1 state");
  await run(wrangler, ["d1", "migrations", "apply", databaseBinding, "--local", "--persist-to", state, "--config", config]);
  console.log("[integration] proving migration application is repeatable");
  const repeated = await run(wrangler, ["d1", "migrations", "apply", databaseBinding, "--local", "--persist-to", state, "--config", config]);
  if (!/No migrations to apply/i.test(`${repeated.stdout}\n${repeated.stderr}`)) {
    throw new Error("A second local migration pass did not report an idempotent no-op");
  }
  await run(wrangler, ["d1", "execute", databaseBinding, "--local", "--persist-to", state, "--config", config, "--file", fixture, "--yes"]);
  const d1Path = await findD1Database(path.join(state, "v3", "d1"));
  if (!d1Path) throw new Error("The isolated local D1 SQLite file was not created");

  console.log("[integration] starting packaged Worker with isolated local D1/R2 bindings");
  const workerModules = await collectWorkerModules(path.dirname(worker));
  workerModules.sort((left, right) => left.path === "index.js" ? -1 : right.path === "index.js" ? 1 : left.path.localeCompare(right.path));
  runtime = new Miniflare({
    host: "127.0.0.1",
    port: 0,
    log: new BufferedLog(LogLevel.INFO, { prefix: "integration" }),
    handleRuntimeStdio(stdout, stderr) {
      stdout.on("data", appendRuntimeLog);
      stderr.on("data", appendRuntimeLog);
    },
    logRequests: false,
    unsafeTriggerHandlers: true,
    modules: workerModules,
    compatibilityDate: generatedConfig.compatibility_date,
    compatibilityFlags: generatedConfig.compatibility_flags,
    bindings: {
      APP_STAGE: "integration",
      RAZORPAY_KEY_ID: "rzp_test_urmed_p009",
      RAZORPAY_KEY_SECRET: "urmed-p009-razorpay-secret",
      RAZORPAY_WEBHOOK_SECRET: "urmed-p009-webhook-secret",
    },
    d1Databases: { [databaseBinding]: d1.database_id },
    d1Persist: path.join(state, "v3", "d1"),
    r2Buckets: { BUCKET: "site-creator-r2" },
    r2Persist: path.join(state, "v3", "r2"),
    serviceBindings: { ASSETS: async () => new Response("Not found", { status: 404 }) },
    outboundService: async () => new Response("External network disabled during integration tests", { status: 503 }),
  });
  const readyUrl = await runtime.ready;
  const health = await fetch(new URL("/api/catalog?limit=1", readyUrl), { signal: AbortSignal.timeout(10_000) });
  if (!health.ok) throw new Error(`Integration health request returned HTTP ${health.status}: ${await health.text()}`);
  process.env.URMED_INTEGRATION_BASE_URL = readyUrl.origin;
  globalThis.__URMED_INTEGRATION_SCHEDULED__ = async () => {
    const response = await fetch(new URL("/cdn-cgi/handler/scheduled?cron=%2A%2F5+%2A+%2A+%2A+%2A", readyUrl), { signal: AbortSignal.timeout(20_000) });
    return { status: response.status, text: await response.text() };
  };
  globalThis.__URMED_INTEGRATION_INSPECT__ = async (context) => {
    await runtime.dispose();
    runtime = undefined;
    const database = new DatabaseSync(d1Path);
    const one = (sql, ...parameters) => database.prepare(sql).get(...parameters);
    const all = (sql, ...parameters) => database.prepare(sql).all(...parameters);
    try {
      database.exec("PRAGMA busy_timeout=5000");
      const supplierReturn = one("SELECT id,debit_note_number AS debitNoteNumber,total_paise AS totalPaise FROM supplier_returns WHERE return_number=?", context.supplierReturnNumber);
      const returnedInventoryId = one("SELECT inventory_id AS inventoryId FROM purchase_order_items WHERE id=?", context.purchaseItemId).inventoryId;
      const reservationRows = all("SELECT order_id AS orderId,status FROM inventory_reservations WHERE order_id IN (?,?,?,?,?,?)", context.successfulOrderId, context.failedOrderId, context.cancelledOrderId, context.rejectedOrderId, context.expiredOrderId, context.abandonedOrderId);
      return {
        migrationCount: one("SELECT COUNT(*) AS count FROM d1_migrations").count,
        recoveredProfileCount: one("SELECT COUNT(*) AS count FROM account_profiles WHERE email='recovered-only@urmed.test'").count,
        recoveredTestAccountCount: one("SELECT COUNT(*) AS count FROM test_accounts WHERE email='recovered-only@urmed.test'").count,
        vendorRegistration: one(`SELECT v.id,v.business_name AS businessName,v.address,v.latitude,v.longitude,
          v.approval_status AS approvalStatus,v.compliance_status AS complianceStatus,
          l.licence_number AS licenceNumber,l.verification_status AS licenceStatus
          FROM stored_documents d JOIN vendors v ON v.id=d.vendor_id
          JOIN vendor_licences l ON l.vendor_id=v.id AND l.document_id=d.id WHERE d.id=?`, context.vendorRegistrationDocumentId),
        vendorRegistrationAuditCount: one(`SELECT COUNT(*) AS count FROM audit_events
          WHERE action='vendor.registration.submitted' AND entity_id=CAST((SELECT vendor_id FROM stored_documents WHERE id=?) AS TEXT)`, context.vendorRegistrationDocumentId).count,
        returnedInventoryQuantity: one("SELECT quantity FROM pharmacy_inventory WHERE id=?", returnedInventoryId).quantity,
        supplierReturn,
        supplierReturnLedgerAccounts: all("SELECT account_code AS accountCode FROM ledger_entries WHERE reference_type='supplier_return' AND reference_id=? ORDER BY account_code", supplierReturn.id).map((row) => row.accountCode),
        supplierReturnMovements: all("SELECT movement_type AS movementType,quantity_delta AS quantityDelta,balance_after AS balanceAfter FROM stock_ledger WHERE reference_type='supplier_return' AND reference_id=? ORDER BY id", supplierReturn.id),
        supplierReturnAuditCount: one("SELECT COUNT(*) AS count FROM audit_events WHERE action='supplier_return.completed' AND entity_id=?", String(supplierReturn.id)).count,
        purchaseReturnSummary: one(`SELECT
          (SELECT COUNT(DISTINCT supplier_return_id) FROM supplier_return_items WHERE purchase_order_item_id=?) AS returnCount,
          (SELECT COALESCE(SUM(quantity),0) FROM supplier_return_items WHERE purchase_order_item_id=?) AS returnedQuantity,
          (SELECT COUNT(*) FROM stock_ledger WHERE reference_type='supplier_return' AND reference_id IN
            (SELECT supplier_return_id FROM supplier_return_items WHERE purchase_order_item_id=?)) AS stockMovementCount,
          (SELECT COUNT(*) FROM ledger_entries WHERE reference_type='supplier_return' AND reference_id IN
            (SELECT supplier_return_id FROM supplier_return_items WHERE purchase_order_item_id=?)) AS ledgerEntryCount,
          (SELECT COUNT(*) FROM audit_events WHERE action='supplier_return.completed' AND CAST(entity_id AS INTEGER) IN
            (SELECT supplier_return_id FROM supplier_return_items WHERE purchase_order_item_id=?)) AS auditEventCount`,
          context.purchaseItemId, context.purchaseItemId, context.purchaseItemId, context.purchaseItemId, context.purchaseItemId),
        reservations: Object.fromEntries(reservationRows.map((row) => [row.orderId, row.status])),
        onlineSaleLedgerCount: one("SELECT COUNT(*) AS count FROM stock_ledger WHERE reference_type='order' AND reference_id=? AND movement_type='online_sale'", context.successfulOrderId).count,
        inventory: one("SELECT quantity,reserved_quantity AS reservedQuantity FROM pharmacy_inventory WHERE id=?", context.inventoryId),
        rxInventory: one("SELECT quantity,reserved_quantity AS reservedQuantity FROM pharmacy_inventory WHERE id=900009"),
        recoveryTotals: one("SELECT SUM(orders_released) AS ordersReleased,SUM(reservations_released) AS reservationsReleased FROM inventory_reservation_recovery_runs"),
        document: one("SELECT object_key AS objectKey,mime_type AS mimeType,size_bytes AS sizeBytes,sha256,status FROM stored_documents WHERE id=?", context.documentId),
        documentMetadataFailures: one("SELECT COUNT(*) AS count FROM stored_documents WHERE original_filename='metadata-failure.png'").count,
        r2PayloadCount: await countR2PayloadFiles(path.join(state, "v3", "r2")),
      };
    } finally {
      database.close();
    }
  };
  globalThis.__URMED_INTEGRATION_R2_COUNT__ = () => countR2PayloadFiles(path.join(state, "v3", "r2"));
  process.env.URMED_INTEGRATION_RAZORPAY_SECRET = "urmed-p009-razorpay-secret";
  process.env.URMED_INTEGRATION_WEBHOOK_SECRET = "urmed-p009-webhook-secret";
  process.env.URMED_INTEGRATION_INACTIVE_TOKEN = "urmed_test_p009_inactive_fixed";
  process.env.URMED_INTEGRATION_MIGRATION_COUNT = String(packagedMigrations);
  const { runPhase0IntegrationSuite } = await import(pathToFileURL(integrationTests).href);
  await runPhase0IntegrationSuite();
  console.log("[integration] Phase 0 D1/R2 API integration suite passed");
} catch (error) {
  process.exitCode = 1;
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  const lines = runtimeLog.trim().split(/\r?\n/).slice(-120);
  if (lines.length) console.error(`\n[integration] Worker log tail:\n${lines.join("\n")}`);
} finally {
  delete globalThis.__URMED_INTEGRATION_INSPECT__;
  delete globalThis.__URMED_INTEGRATION_SCHEDULED__;
  delete globalThis.__URMED_INTEGRATION_R2_COUNT__;
  if (!interruptedSignal) await cleanup();
}
