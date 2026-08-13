#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
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
const integrationTestAuthSecret = randomBytes(32).toString("base64url");
const confirmedAt = "2026-08-12T00:00:00.000Z";
const providerUsers = new Map([
  ["p103-email-race-a", { id: "integration:p103-email-a", email: "P103.Email@Example.Test", phone: "+917000000101" }],
  ["p103-email-race-b", { id: "integration:p103-email-b", email: "p103.email@example.test", phone: "+917000000102" }],
  ["p103-phone-race-a", { id: "integration:p103-phone-a", email: "p103-phone-a@example.test", phone: "+917000000103" }],
  ["p103-phone-race-b", { id: "integration:p103-phone-b", email: "p103-phone-b@example.test", phone: "+917000000103" }],
]);
const razorpayOrders = new Map();
const razorpayRefunds = new Map();
const razorpayRefundAttempts = new Map();

let runtime;
let activeCommand;
let interruptedSignal = "";
let runtimeLog = "";
let temporaryRoot = "";

function appendRuntimeLog(value) {
  runtimeLog += `${String(value).trimEnd()}\n`;
  if (runtimeLog.length > 300_000) runtimeLog = runtimeLog.slice(-300_000);
}

async function localProviderResponse(request) {
  const url = new URL(request.url);
  if (url.hostname === "supabase.integration.invalid" && url.pathname === "/auth/v1/user") {
    const authorization = request.headers.get("authorization") ?? "";
    const user = providerUsers.get(authorization.replace(/^Bearer\s+/i, ""));
    if (!user) return Response.json({ message: "Invalid integration provider token" }, { status: 401 });
    return Response.json({
      ...user,
      email_confirmed_at: confirmedAt,
      phone_confirmed_at: confirmedAt,
      user_metadata: {
        role: "vendor",
        name: `P103 ${user.id.endsWith("-a") ? "First" : "Second"} Owner`,
        owner_name: `P103 ${user.id.endsWith("-a") ? "First" : "Second"} Owner`,
        business_name: `P103 ${user.id.endsWith("-a") ? "First" : "Second"} Pharmacy`,
      },
    });
  }
  if (url.hostname !== "api.razorpay.com") {
    return new Response("External network disabled during integration tests", { status: 503 });
  }
  const expectedBasic = `Basic ${Buffer.from("rzp_test_urmed_p009:urmed-p009-razorpay-secret").toString("base64")}`;
  if (request.headers.get("authorization") !== expectedBasic) {
    return Response.json({ error: { description: "Invalid local Razorpay credentials" } }, { status: 401 });
  }

  if (request.method === "POST" && url.pathname === "/v1/orders") {
    const body = await request.json();
    if (!Number.isInteger(body.amount) || body.currency !== "INR" || !body.receipt) {
      return Response.json({ error: { description: "Invalid local payment order" } }, { status: 400 });
    }
    const id = `order_local_${String(body.notes?.urmed_order_id ?? razorpayOrders.size + 1)}`;
    const record = { id, amount: body.amount, currency: body.currency, receipt: body.receipt };
    razorpayOrders.set(id, record);
    return Response.json(record);
  }

  const paymentMatch = url.pathname.match(/^\/v1\/payments\/([^/]+)$/);
  if (request.method === "GET" && paymentMatch) {
    const paymentId = decodeURIComponent(paymentMatch[1]);
    const encoded = paymentId.match(/^pay_p009_(?:success|expired|wrong|refundretry)_(\d+)_(\d+)$/);
    if (!encoded) return Response.json({ error: { description: "Payment not found" } }, { status: 404 });
    return Response.json({
      id: paymentId,
      order_id: `order_local_${encoded[1]}`,
      amount: Number(encoded[2]),
      currency: "INR",
      status: "captured",
    });
  }

  const refundMatch = url.pathname.match(/^\/v1\/payments\/([^/]+)\/refund$/);
  if (request.method === "POST" && refundMatch) {
    const paymentId = decodeURIComponent(refundMatch[1]);
    const body = await request.json();
    const idempotencyKey = request.headers.get("x-refund-idempotency") ?? "";
    if (!idempotencyKey || idempotencyKey !== body.receipt || !Number.isInteger(body.amount)) {
      return Response.json({ error: { description: "Invalid local refund request" } }, { status: 400 });
    }
    const previous = razorpayRefunds.get(idempotencyKey);
    if (previous && JSON.stringify(previous.request) !== JSON.stringify(body)) {
      return Response.json({ error: { description: "Idempotency body changed" } }, { status: 409 });
    }
    const attempts = (razorpayRefundAttempts.get(idempotencyKey) ?? 0) + 1;
    razorpayRefundAttempts.set(idempotencyKey, attempts);
    if (paymentId.includes("refundretry") && attempts === 1) {
      return Response.json({ error: { description: "Deterministic local refund outage" } }, { status: 503 });
    }
    const refund = previous ?? {
      request: body,
      response: {
        id: `rfnd_p009_${String(body.notes?.urmed_order_id ?? razorpayRefunds.size + 1)}`,
        payment_id: paymentId,
        amount: body.amount,
        currency: "INR",
        receipt: body.receipt,
        status: "pending",
      },
    };
    razorpayRefunds.set(idempotencyKey, refund);
    return Response.json(refund.response);
  }
  return new Response("External network disabled during integration tests", { status: 503 });
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
      INTEGRATION_TEST_AUTH_SECRET: integrationTestAuthSecret,
      SUPABASE_URL: "https://supabase.integration.invalid",
      SUPABASE_ANON_KEY: "p103-local-anon-key",
      RAZORPAY_KEY_ID: "rzp_test_urmed_p009",
      RAZORPAY_KEY_SECRET: "urmed-p009-razorpay-secret",
      RAZORPAY_WEBHOOK_SECRET: "urmed-p009-webhook-secret",
    },
    d1Databases: { [databaseBinding]: d1.database_id },
    d1Persist: path.join(state, "v3", "d1"),
    r2Buckets: { BUCKET: "site-creator-r2" },
    r2Persist: path.join(state, "v3", "r2"),
    serviceBindings: { ASSETS: async () => new Response("Not found", { status: 404 }) },
    outboundService: localProviderResponse,
  });
  const readyUrl = await runtime.ready;
  const health = await fetch(new URL("/api/catalog?limit=1", readyUrl), { signal: AbortSignal.timeout(10_000) });
  if (!health.ok) throw new Error(`Integration health request returned HTTP ${health.status}: ${await health.text()}`);
  process.env.URMED_INTEGRATION_BASE_URL = readyUrl.origin;
  const integrationDatabase = await runtime.getD1Database(databaseBinding);
  globalThis.__URMED_INTEGRATION_SET_TEST_CLAIMS__ = async (email, claims) => {
    const normalizedEmail = String(email ?? "").trim().toLowerCase();
    const emailConfirmed = claims?.emailConfirmed === true ? 1 : 0;
    const phoneConfirmed = claims?.phoneConfirmed === true ? 1 : 0;
    const existing = await integrationDatabase.prepare("SELECT id FROM test_accounts WHERE email=? LIMIT 1")
      .bind(normalizedEmail).first();
    if (!existing) throw new Error(`The integration test account ${normalizedEmail} does not exist`);
    await integrationDatabase.prepare("UPDATE test_accounts SET email_confirmed=?,phone_confirmed=? WHERE email=?")
      .bind(emailConfirmed, phoneConfirmed, normalizedEmail).run();
  };
  globalThis.__URMED_INTEGRATION_ENABLE_EMAIL__ = async (email) => {
    const normalizedEmail = String(email ?? "").trim().toLowerCase();
    const profile = await integrationDatabase.prepare("SELECT id FROM account_profiles WHERE email=? AND status='active' LIMIT 1")
      .bind(normalizedEmail).first();
    if (!profile) throw new Error(`The integration email profile ${normalizedEmail} does not exist`);
    const result = await integrationDatabase.prepare(`UPDATE notification_preferences
      SET email_enabled=1,version=version+1,updated_at=CURRENT_TIMESTAMP
      WHERE profile_id=? AND category IN ('transactional','safety','reminder')`).bind(profile.id).run();
    if (Number(result.meta.changes ?? 0) < 3) throw new Error(`Email preferences are incomplete for ${normalizedEmail}`);
    return { profileId: profile.id };
  };
  globalThis.__URMED_INTEGRATION_EMAIL_OUTBOX_INSPECT__ = async () => {
    const rows = await integrationDatabase.prepare(`SELECT id,status,attempt_count AS attemptCount,
      provider_message_id AS providerMessageId,dedupe_key AS dedupeKey FROM transactional_email_outbox ORDER BY id`).all();
    let deleteGuard = false;
    try {
      await integrationDatabase.prepare("DELETE FROM transactional_email_outbox WHERE id=?").bind(rows.results[0]?.id ?? -1).run();
    } catch { deleteGuard = true; }
    return { rows: rows.results, deleteGuard };
  };
  globalThis.__URMED_INTEGRATION_EXPIRE_ORDER__ = async (orderId) => {
    if (!Number.isInteger(orderId) || orderId < 1) throw new Error("Integration order ID is invalid");
    const expiresAt = "2000-01-01T00:00:00.000Z";
    const reservations = await integrationDatabase.prepare(`UPDATE inventory_reservations
      SET expires_at=?,updated_at=CURRENT_TIMESTAMP WHERE order_id=? AND status='active'`)
      .bind(expiresAt, orderId).run();
    await integrationDatabase.prepare(`UPDATE orders SET reservation_expires_at=?,updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND inventory_status='reserved'`).bind(expiresAt, orderId).run();
    if (!reservations.meta.changes) throw new Error(`Order ${orderId} has no active integration reservation to expire`);
  };
  globalThis.__URMED_INTEGRATION_ORDER_EVIDENCE__ = async (orderId) => {
    if (!Number.isInteger(orderId) || orderId < 1) throw new Error("Integration order ID is invalid");
    const [order, inventory, stockLedger, accountingLedger, deliveryEvents, auditEvents, codCollection] = await Promise.all([
      integrationDatabase.prepare(`SELECT order_status AS orderStatus,delivery_status AS deliveryStatus,
        inventory_status AS inventoryStatus,payment_status AS paymentStatus FROM orders WHERE id=?`).bind(orderId).first(),
      integrationDatabase.prepare(`SELECT inventory.id,inventory.quantity,
        inventory.reserved_quantity AS reservedQuantity FROM pharmacy_inventory inventory
        WHERE inventory.id IN (SELECT item.inventory_id FROM order_items item WHERE item.order_id=?)
        ORDER BY inventory.id`).bind(orderId).all(),
      integrationDatabase.prepare("SELECT COUNT(*) AS count FROM stock_ledger WHERE reference_type='order' AND reference_id=?")
        .bind(orderId).first(),
      integrationDatabase.prepare("SELECT COUNT(*) AS count FROM ledger_entries WHERE reference_type='online_order' AND reference_id=?")
        .bind(orderId).first(),
      integrationDatabase.prepare("SELECT COUNT(*) AS count FROM delivery_events WHERE order_id=?").bind(orderId).first(),
      integrationDatabase.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE entity_type='order' AND entity_id=?")
        .bind(String(orderId)).first(),
      integrationDatabase.prepare(`SELECT amount_paise AS amountPaise,tender_mode AS tenderMode,
        receipt_reference AS receiptReference,idempotency_key AS idempotencyKey,custody_status AS custodyStatus
        FROM cod_collection_evidence WHERE order_id=?`).bind(orderId).first(),
    ]);
    if (!order) throw new Error(`Integration order ${orderId} does not exist`);
    return {
      order,
      inventory: inventory.results,
      stockLedgerCount: Number(stockLedger?.count ?? 0),
      accountingLedgerCount: Number(accountingLedger?.count ?? 0),
      deliveryEventCount: Number(deliveryEvents?.count ?? 0),
      auditEventCount: Number(auditEvents?.count ?? 0),
      codCollection: codCollection ?? null,
    };
  };
  globalThis.__URMED_INTEGRATION_DELIVERY_EVIDENCE__ = async (email = "delivery@urmed.test") => {
    const agent = await integrationDatabase.prepare(`SELECT agent.id,agent.availability_status AS availabilityStatus,
      agent.current_latitude AS currentLatitude,agent.current_longitude AS currentLongitude,agent.updated_at AS updatedAt
      FROM delivery_agents agent JOIN account_profiles profile ON profile.id=agent.profile_id
      WHERE profile.email=?`).bind(email).first();
    if (!agent) throw new Error(`Integration delivery agent ${email} does not exist`);
    const availabilityAudits = await integrationDatabase.prepare(`SELECT COUNT(*) AS count FROM audit_events
      WHERE entity_type='delivery_agent' AND entity_id=? AND action='delivery_agent.availability'`)
      .bind(String(agent.id)).first();
    const locationPingAudits = await integrationDatabase.prepare(`SELECT COUNT(*) AS count FROM audit_events
      WHERE entity_type='delivery_agent' AND entity_id=? AND action='delivery_agent.location_ping'`)
      .bind(String(agent.id)).first();
    return {
      agent,
      availabilityAuditCount: Number(availabilityAudits?.count ?? 0),
      locationPingAuditCount: Number(locationPingAudits?.count ?? 0),
    };
  };
  globalThis.__URMED_INTEGRATION_SCHEDULED__ = async (cron = "*/5 * * * *") => {
    const scheduledUrl = new URL("/cdn-cgi/handler/scheduled", readyUrl);
    scheduledUrl.searchParams.set("cron", cron);
    const response = await fetch(scheduledUrl, { signal: AbortSignal.timeout(20_000) });
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
      const inventoryAdjustment = one(`SELECT id,quantity_before AS quantityBefore,
        quantity_delta AS quantityDelta,balance_after AS balanceAfter,reason_code AS reasonCode,
        source_type AS sourceType FROM inventory_adjustments WHERE adjustment_number=?`, context.inventoryAdjustmentNumber);
      const inventoryCount = one(`SELECT session.id,session.line_count AS lineCount,
        session.variance_line_count AS varianceLineCount,session.net_variance_quantity AS netVarianceQuantity,
        line.counted_quantity AS countedQuantity,line.variance_quantity AS varianceQuantity
        FROM inventory_count_sessions session JOIN inventory_count_lines line ON line.count_session_id=session.id
        WHERE session.session_number=?`, context.inventoryCountSessionNumber);
      const rejects = (statement, ...parameters) => {
        try { database.prepare(statement).run(...parameters); return false; } catch { return true; }
      };
      const paymentRefund = one(`SELECT id,status,provider_payment_id AS providerPaymentId,
        provider_refund_id AS providerRefundId,amount_paise AS amountPaise,
        sales_return_id AS salesReturnId FROM payment_refunds WHERE order_id=?`, context.successfulOrderId);
      const refundGuards = {
        mismatchedInsert: rejects(`INSERT INTO payment_refunds
          (order_id,vendor_id,customer_profile_id,provider_payment_id,refund_receipt,amount_paise,reason,requested_by_profile_id)
          SELECT id,vendor_id,customer_profile_id,razorpay_payment_id,'URMED-RF-MISMATCH',total_paise+1,'Invalid mismatch fixture',customer_profile_id
          FROM orders WHERE id=?`, context.successfulOrderId),
        invalidTransition: rejects("UPDATE payment_refunds SET status='failed',failure_reason='Late failure',failed_at=CURRENT_TIMESTAMP WHERE id=?", paymentRefund.id),
        deleteForbidden: rejects("DELETE FROM payment_refunds WHERE id=?", paymentRefund.id),
      };
      const manufacturerGuards = {
        directInsert: rejects("INSERT INTO manufacturers (name,normalized_name) VALUES ('P205 Bypass','p205 bypass')"),
        cyclicState: rejects("UPDATE manufacturer_canonical_state SET status='merged',merged_into_manufacturer_id=?,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE manufacturer_id=?", context.manufacturerId, context.manufacturerTargetId),
        aliasDelete: rejects("DELETE FROM manufacturer_aliases WHERE manufacturer_id=?", context.manufacturerTargetId),
        eventUpdate: rejects("UPDATE manufacturer_governance_events SET detail_json='{}' WHERE request_id=?", context.manufacturerRequestId),
      };
      const onlineInvoice = one(`SELECT invoice.id,invoice.invoice_number AS invoiceNumber,
        invoice.source_number AS sourceNumber,invoice.source_type AS sourceType,invoice.snapshot_version AS snapshotVersion,
        invoice.gross_paise AS grossPaise,invoice.discount_paise AS discountPaise,
        invoice.subtotal_paise AS subtotalPaise,invoice.cgst_paise AS cgstPaise,
        invoice.sgst_paise AS sgstPaise,invoice.igst_paise AS igstPaise,
        invoice.delivery_fee_paise AS deliveryFeePaise,invoice.total_paise AS totalPaise,
        (SELECT COUNT(*) FROM tax_invoice_lines line WHERE line.invoice_id=invoice.id) AS lineCount,
        (SELECT SUM(line.taxable_paise) FROM tax_invoice_lines line WHERE line.invoice_id=invoice.id) AS lineTaxablePaise,
        (SELECT SUM(line.line_total_paise) FROM tax_invoice_lines line WHERE line.invoice_id=invoice.id) AS lineTotalPaise
        FROM tax_invoices invoice WHERE invoice.id=?`, context.invoiceId);
      const invoiceGuards = {
        updateHeader: rejects("UPDATE tax_invoices SET total_paise=1 WHERE id=?", context.invoiceId),
        deleteHeader: rejects("DELETE FROM tax_invoices WHERE id=?", context.invoiceId),
        updateLine: rejects("UPDATE tax_invoice_lines SET quantity=99 WHERE invoice_id=?", context.invoiceId),
        deleteLine: rejects("DELETE FROM tax_invoice_lines WHERE invoice_id=?", context.invoiceId),
        forgedLine: rejects(`INSERT INTO tax_invoice_lines
          (invoice_id,line_number,source_item_id,product_name,quantity,unit_price_paise,gross_paise,taxable_paise,gst_percent,line_total_paise)
          VALUES (?,999,999999,'Forged line',1,1,1,1,0,1)`, context.invoiceId),
      };
      const offlineSale = one(`SELECT sale.id,sale.sale_number AS saleNumber,sale.gross_paise AS grossPaise,
        sale.discount_paise AS discountPaise,sale.subtotal_paise AS subtotalPaise,sale.tax_paise AS taxPaise,
        sale.total_paise AS totalPaise,invoice.id AS invoiceId,invoice.invoice_number AS invoiceNumber,
        (SELECT COUNT(*) FROM tax_invoice_lines line WHERE line.invoice_id=invoice.id) AS invoiceLineCount,
        (SELECT SUM(line.line_total_paise) FROM tax_invoice_lines line WHERE line.invoice_id=invoice.id) AS invoiceLineTotalPaise
        FROM offline_sales sale JOIN tax_invoices invoice ON invoice.source_type='offline_sale' AND invoice.source_id=sale.id
        WHERE sale.id=?`, context.offlineSaleId);
      const offlineRxSale = one(`SELECT id,cgst_paise AS cgstPaise,sgst_paise AS sgstPaise,igst_paise AS igstPaise,
        offline_prescription_id AS offlinePrescriptionId FROM offline_sales WHERE id=?`, context.offlineRxSaleId);
      return {
        migrationCount: one("SELECT COUNT(*) AS count FROM d1_migrations").count,
        recoveredProfileCount: one("SELECT COUNT(*) AS count FROM account_profiles WHERE email='recovered-only@urmed.test'").count,
        recoveredTestAccountCount: one("SELECT COUNT(*) AS count FROM test_accounts WHERE email='recovered-only@urmed.test'").count,
        identityRaceProfileCount: one("SELECT COUNT(*) AS count FROM account_profiles WHERE auth_user_id LIKE 'integration:p103-%'").count,
        identityRaceVendorCount: one(`SELECT COUNT(*) AS count FROM vendors
          WHERE profile_id IN (SELECT id FROM account_profiles WHERE auth_user_id LIKE 'integration:p103-%')`).count,
        identityRaceAuthUsers: all("SELECT auth_user_id AS authUserId FROM account_profiles WHERE auth_user_id LIKE 'integration:p103-%' ORDER BY auth_user_id").map((row) => row.authUserId),
        vendorRegistration: one(`SELECT v.id,v.business_name AS businessName,v.address,v.latitude,v.longitude,
          v.approval_status AS approvalStatus,v.compliance_status AS complianceStatus,
          l.licence_number AS licenceNumber,l.verification_status AS licenceStatus
          FROM stored_documents d JOIN vendors v ON v.id=d.vendor_id
          JOIN vendor_licences l ON l.vendor_id=v.id AND l.document_id=d.id WHERE d.id=?`, context.vendorRegistrationDocumentId),
        vendorRegistrationAuditCount: one(`SELECT COUNT(*) AS count FROM audit_events
          WHERE action='vendor.registration.submitted' AND entity_id=CAST((SELECT vendor_id FROM stored_documents WHERE id=?) AS TEXT)`, context.vendorRegistrationDocumentId).count,
        vendorDraftAuditCount: one("SELECT COUNT(*) AS count FROM audit_events WHERE action='vendor.registration.draft.saved'").count,
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
        inventoryAdjustment,
        inventoryCount,
        inventoryReconciliationMovements: all(`SELECT movement_type AS movementType,
          quantity_delta AS quantityDelta,balance_after AS balanceAfter FROM stock_ledger
          WHERE reference_type='inventory_adjustment'
            AND reference_id IN (SELECT id FROM inventory_adjustments
              WHERE adjustment_number=? OR source_id=(SELECT id FROM inventory_count_sessions WHERE session_number=?))
          ORDER BY id`, context.inventoryAdjustmentNumber, context.inventoryCountSessionNumber),
        inventoryReconciliationAuditActions: all(`SELECT action FROM audit_events
          WHERE (action='inventory.adjustment.completed' AND entity_id=?)
            OR (action='inventory.count.completed' AND entity_id=?)
          ORDER BY id`, String(inventoryAdjustment.id), String(inventoryCount.id)).map((row) => row.action),
        inventoryEvidenceImmutability: one(`SELECT
          SUM(name='inventory_adjustments_no_update') AS adjustmentUpdateGuard,
          SUM(name='inventory_adjustments_no_delete') AS adjustmentDeleteGuard,
          SUM(name='inventory_count_sessions_no_update') AS countSessionUpdateGuard,
          SUM(name='inventory_count_sessions_no_delete') AS countSessionDeleteGuard,
          SUM(name='inventory_count_lines_no_update') AS countLineUpdateGuard,
          SUM(name='inventory_count_lines_no_delete') AS countLineDeleteGuard
          FROM sqlite_master WHERE type='trigger' AND name IN (
            'inventory_adjustments_no_update','inventory_adjustments_no_delete',
            'inventory_count_sessions_no_update','inventory_count_sessions_no_delete',
            'inventory_count_lines_no_update','inventory_count_lines_no_delete')`),
        reservations: Object.fromEntries(reservationRows.map((row) => [row.orderId, row.status])),
        onlineSaleLedgerCount: one("SELECT COUNT(*) AS count FROM stock_ledger WHERE reference_type='order' AND reference_id=? AND movement_type='online_sale'", context.successfulOrderId).count,
        paymentRefund,
        refundGuards,
        refundSalesReturn: one(`SELECT status,credit_note_number AS creditNoteNumber,refund_paise AS refundPaise
          FROM sales_returns WHERE id=?`, paymentRefund.salesReturnId),
        refundItemSummary: one("SELECT COUNT(*) AS lineCount,SUM(quantity) AS quantity,SUM(amount_paise) AS amountPaise FROM sales_return_items WHERE sales_return_id=?", paymentRefund.salesReturnId),
        refundLedgerAccounts: all("SELECT account_code AS accountCode,debit_paise AS debitPaise,credit_paise AS creditPaise FROM ledger_entries WHERE reference_type='payment_refund' AND reference_id=? ORDER BY account_code", paymentRefund.id),
        refundStockMovements: all("SELECT movement_type AS movementType,quantity_delta AS quantityDelta FROM stock_ledger WHERE reference_type='payment_refund' AND reference_id=?", paymentRefund.id),
        refundDeliveryEvents: all("SELECT status FROM delivery_events WHERE order_id=? AND status LIKE 'refund_%' ORDER BY id", context.successfulOrderId).map((row) => row.status),
        refundAuditActions: all("SELECT action FROM audit_events WHERE entity_type='payment_refund' AND entity_id=? ORDER BY id", String(paymentRefund.id)).map((row) => row.action),
        refundNotificationCount: one("SELECT COUNT(*) AS count FROM notifications WHERE reference_type='payment_refund' AND reference_id=? AND notification_type='refund_processed'", paymentRefund.id).count,
        refundTriggerCount: one("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='trigger' AND name LIKE 'payment_refunds_%' ").count,
        vendorNotificationLifecycle: one(`SELECT lifecycle_status AS lifecycleStatus,
          lifecycle_version AS version,read_at AS readAt,acknowledged_at AS acknowledgedAt,
          snoozed_until AS snoozedUntil,resolved_at AS resolvedAt,resolution_reason AS resolutionReason
          FROM notifications WHERE id=?`, context.vendorNotificationId),
        vendorNotificationReplacement: one(`SELECT COUNT(*) AS totalCount,
          SUM(lifecycle_status='resolved') AS resolvedCount,
          SUM(lifecycle_status<>'resolved') AS activeCount,
          MAX(CASE WHEN lifecycle_status<>'resolved' THEN id END) AS activeId
          FROM notifications
          WHERE vendor_id=(SELECT vendor_id FROM notifications WHERE id=?)
            AND notification_type='inventory_near_expiry'
            AND reference_type='inventory_batch' AND reference_id=900040`, context.vendorNotificationId),
        vendorNotificationAuditActions: all(`SELECT action FROM audit_events
          WHERE entity_type='notification' AND entity_id=? ORDER BY id`, String(context.vendorNotificationId))
          .map((row) => row.action),
        manufacturerMigrationAudit: one("SELECT source_rows AS sourceRows,imported_rows AS importedRows,rejected_rows AS rejectedRows FROM migration_audit WHERE entity='manufacturer_governance_backfill'"),
        manufacturerState: one("SELECT status,merged_into_manufacturer_id AS mergedIntoManufacturerId FROM manufacturer_canonical_state WHERE manufacturer_id=?", context.manufacturerId),
        manufacturerProduct: one("SELECT manufacturer_id AS manufacturerId,manufacturer FROM products WHERE id=?", context.manufacturerProductId),
        manufacturerAliases: all("SELECT alias_name AS aliasName,provenance,source_manufacturer_id AS sourceManufacturerId FROM manufacturer_aliases WHERE manufacturer_id=? AND normalized_alias LIKE 'p205%' ORDER BY normalized_alias", context.manufacturerTargetId),
        manufacturerRequests: all("SELECT request_type AS requestType,status FROM manufacturer_change_requests WHERE submitted_vendor_id=? AND (id=? OR manufacturer_id=? OR target_manufacturer_id=?) ORDER BY id", context.vendorId, context.manufacturerRequestId, context.manufacturerId, context.manufacturerId),
        manufacturerEventCount: one("SELECT COUNT(*) AS count FROM manufacturer_governance_events WHERE request_id IN (SELECT id FROM manufacturer_change_requests WHERE submitted_vendor_id=? AND (id=? OR manufacturer_id=? OR target_manufacturer_id=?))", context.vendorId, context.manufacturerRequestId, context.manufacturerId, context.manufacturerId).count,
        manufacturerAuditCount: one("SELECT COUNT(*) AS count FROM audit_events WHERE entity_type='manufacturer_change_request' AND vendor_id=? AND action LIKE '%manufacturer%'", context.vendorId).count,
        manufacturerGuards,
        onlineInvoice,
        invoiceGuards,
        offlineSale,
        offlineSaleItems: all(`SELECT inventory_id AS inventoryId,batch_number AS batchNumber,quantity,
          discount_paise AS discountPaise,line_total_paise AS lineTotalPaise FROM offline_sale_items
          WHERE offline_sale_id=? ORDER BY id`, context.offlineSaleId),
        offlineSaleStock: all("SELECT id,quantity,reserved_quantity AS reservedQuantity FROM pharmacy_inventory WHERE id IN (900030,900031,900033) ORDER BY id"),
        offlineSaleMovements: all("SELECT inventory_id AS inventoryId,quantity_delta AS quantityDelta,balance_after AS balanceAfter FROM stock_ledger WHERE reference_type='offline_sale' AND reference_id=? ORDER BY id", context.offlineSaleId),
        offlineSaleLedger: all("SELECT account_code AS accountCode,debit_paise AS debitPaise,credit_paise AS creditPaise FROM ledger_entries WHERE reference_type='offline_sale' AND reference_id=? ORDER BY account_code", context.offlineSaleId),
        offlineSaleEventCount: one("SELECT COUNT(*) AS count FROM offline_sale_events WHERE offline_sale_id=? AND event_type='completed'", context.offlineSaleId).count,
        offlineRxSale,
        offlineRxInventory: one("SELECT quantity,reserved_quantity AS reservedQuantity FROM pharmacy_inventory WHERE id=900032"),
        offlineRxEvidence: one(`SELECT
          (SELECT COUNT(*) FROM statutory_register_entries WHERE source_type='offline_sale' AND source_id=?) AS statutoryCount,
          (SELECT COUNT(*) FROM offline_sale_events WHERE offline_sale_id=? AND event_type='completed') AS eventCount,
          (SELECT COUNT(*) FROM audit_events WHERE entity_type='offline_prescription'
            AND action IN ('offline_prescription.captured','offline_prescription.approved')) AS prescriptionAuditCount,
          (SELECT COUNT(*) FROM offline_prescriptions WHERE patient_name='P304 Audit Rollback') AS failedCaptureCount,
          (SELECT COUNT(*) FROM offline_sales WHERE vendor_id=900020) AS expiredVendorSaleCount`,
          context.offlineRxSaleId, context.offlineRxSaleId),
        offlinePrescriptionDocument: one("SELECT vendor_id AS vendorId,purpose,size_bytes AS sizeBytes,status FROM stored_documents WHERE id=?", context.offlinePrescriptionDocumentId),
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
  process.env.URMED_INTEGRATION_TEST_AUTH_SECRET = integrationTestAuthSecret;
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
  delete globalThis.__URMED_INTEGRATION_SET_TEST_CLAIMS__;
  delete globalThis.__URMED_INTEGRATION_ENABLE_EMAIL__;
  delete globalThis.__URMED_INTEGRATION_EMAIL_OUTBOX_INSPECT__;
  delete globalThis.__URMED_INTEGRATION_EXPIRE_ORDER__;
  delete globalThis.__URMED_INTEGRATION_ORDER_EVIDENCE__;
  delete globalThis.__URMED_INTEGRATION_DELIVERY_EVIDENCE__;
  delete globalThis.__URMED_INTEGRATION_R2_COUNT__;
  if (!interruptedSignal) await cleanup();
}
