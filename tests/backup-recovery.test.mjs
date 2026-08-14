import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createLocalBackup, verifyLocalRestore } from "../scripts/backup-recovery-lib.mjs";

async function fixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), "urmed-backup-test-"));
  const source = join(root, "source.sqlite");
  const r2 = join(root, "r2");
  await mkdir(join(r2, "clean"), { recursive: true });
  await mkdir(join(r2, "quarantine"), { recursive: true });
  await writeFile(join(r2, "metadata.sqlite"), "local-r2-metadata");
  await writeFile(join(r2, "clean", "000001.bin"), Buffer.from([0, 1, 2, 255]));
  await writeFile(join(r2, "quarantine", "000002.bin"), Buffer.from("quarantine-bytes"));
  const database = new DatabaseSync(source);
  database.exec(`
    CREATE TABLE account_profiles (id INTEGER PRIMARY KEY, role TEXT, status TEXT);
    CREATE TABLE vendors (id INTEGER PRIMARY KEY, business_name TEXT);
    CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE pharmacy_inventory (id INTEGER PRIMARY KEY, vendor_id INTEGER, quantity INTEGER);
    CREATE TABLE stored_documents (id INTEGER PRIMARY KEY, vendor_id INTEGER, status TEXT, malware_status TEXT);
    CREATE TABLE audit_events (id INTEGER PRIMARY KEY, vendor_id INTEGER, action TEXT);
    CREATE TABLE tax_invoices (id INTEGER PRIMARY KEY, vendor_id INTEGER, total_paise INTEGER);
    CREATE TABLE transactional_email_outbox (id INTEGER PRIMARY KEY, profile_id INTEGER, status TEXT);
    CREATE TABLE payment_events (id INTEGER PRIMARY KEY, order_id INTEGER, event_type TEXT);
    CREATE TABLE inventory_reservations (id INTEGER PRIMARY KEY, vendor_id INTEGER, status TEXT);
    CREATE TABLE prescriptions (id INTEGER PRIMARY KEY, customer_profile_id INTEGER, status TEXT);
    CREATE TABLE offline_sales (id INTEGER PRIMARY KEY, vendor_id INTEGER, total_paise INTEGER);
    INSERT INTO account_profiles VALUES (1,'customer','active'),(2,'vendor','active');
    INSERT INTO vendors VALUES (10,'P10 Backup Pharmacy');
    INSERT INTO products VALUES (20,'Leading-zero product');
    INSERT INTO pharmacy_inventory VALUES (30,10,12);
    INSERT INTO stored_documents VALUES (40,10,'active','clean'),(41,10,'quarantined','quarantined');
    INSERT INTO audit_events VALUES (50,10,'backup.fixture');
    INSERT INTO tax_invoices VALUES (60,10,1234);
    INSERT INTO transactional_email_outbox VALUES (70,1,'sent');
    INSERT INTO payment_events VALUES (80,100,'captured');
    INSERT INTO inventory_reservations VALUES (90,10,'committed');
    INSERT INTO prescriptions VALUES (100,1,'approved');
    INSERT INTO offline_sales VALUES (110,10,5678);
  `);
  database.close();
  return { root, source, r2 };
}

test("local backup is deterministic, checksummed, and restores D1/R2 evidence", async () => {
  const fixture = await fixtureRoot();
  try {
    const first = await createLocalBackup({
      d1Path: fixture.source,
      r2Path: fixture.r2,
      outputDir: join(fixture.root, "backup-one"),
      timestamp: "2026-08-14T12:00:00.000Z",
    });
    const second = await createLocalBackup({
      d1Path: fixture.source,
      r2Path: fixture.r2,
      outputDir: join(fixture.root, "backup-two"),
      timestamp: "2026-08-14T12:00:00.000Z",
    });
    assert.equal(first.manifest.contentSha256, second.manifest.contentSha256);
    assert.equal(first.report.manifestSha256, second.report.manifestSha256);
    assert.equal(first.manifest.r2.objectCount, 2);
    assert.equal(first.manifest.database.evidence.invoices, 1);
    assert.equal(first.manifest.database.evidence.quarantineDocuments, 1);

    const restoreDir = join(fixture.root, "restore");
    const restored = await verifyLocalRestore({ backupDir: join(fixture.root, "backup-one"), outputDir: restoreDir });
    assert.equal(restored.status, "verified");
    assert.equal(restored.database.evidence.auditEvents, 1);
    assert.equal(restored.database.evidence.outboxRows, 1);
    assert.equal(restored.r2.objectCount, 2);
    const repeated = await verifyLocalRestore({ backupDir: join(fixture.root, "backup-one"), outputDir: restoreDir });
    assert.equal(repeated.status, "verified");
    assert.equal(repeated.contentSha256, restored.contentSha256);
    const restoredDb = new DatabaseSync(join(restoreDir, "restored", "d1.sqlite"));
    assert.equal(restoredDb.prepare("SELECT quantity FROM pharmacy_inventory WHERE id=30").get().quantity, 12);
    restoredDb.close();
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("restore rejects corruption, unexpected files, incomplete manifests, and tenant or schema failures", async () => {
  const fixture = await fixtureRoot();
  try {
    const backupDir = join(fixture.root, "backup");
    await createLocalBackup({ d1Path: fixture.source, r2Path: fixture.r2, outputDir: backupDir, timestamp: "2026-08-14T12:00:00.000Z" });
    await writeFile(join(backupDir, "r2", "clean", "000001.bin"), Buffer.from("tampered"));
    const failed = await verifyLocalRestore({ backupDir, outputDir: join(fixture.root, "corrupt-restore") });
    assert.equal(failed.status, "failed");
    assert.equal(failed.failure.code, "artifact_size_mismatch");
    const files = await readFile(join(fixture.root, "corrupt-restore", "recovery-report.json"), "utf8");
    assert.match(files, /"status":"failed"/);

    await writeFile(join(backupDir, "r2", "clean", "000001.bin"), Buffer.from([0, 1, 2, 255]));
    await rm(join(backupDir, "r2", "quarantine", "000002.bin"));
    const missing = await verifyLocalRestore({ backupDir, outputDir: join(fixture.root, "missing-restore") });
    assert.equal(missing.status, "failed");
    assert.equal(missing.failure.code, "artifact_missing");
    await writeFile(join(backupDir, "r2", "quarantine", "000002.bin"), Buffer.from("quarantine-bytes"));

    const incompleteDir = join(fixture.root, "incomplete-backup");
    await cp(backupDir, incompleteDir, { recursive: true });
    const incompleteManifest = JSON.parse(await readFile(join(incompleteDir, "manifest.json"), "utf8"));
    incompleteManifest.artifacts.pop();
    await writeFile(join(incompleteDir, "manifest.json"), `${JSON.stringify(incompleteManifest)}\n`);
    const incomplete = await verifyLocalRestore({ backupDir: incompleteDir, outputDir: join(fixture.root, "incomplete-restore") });
    assert.equal(incomplete.status, "failed");
    assert.equal(incomplete.failure.code, "manifest_checksum_mismatch");

    const mismatchedMigrations = join(fixture.root, "migrations-mismatch");
    await cp("drizzle", mismatchedMigrations, { recursive: true });
    const firstMigrationName = (await readdir(mismatchedMigrations)).filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort()[0];
    await writeFile(join(mismatchedMigrations, firstMigrationName), `${await readFile(join(mismatchedMigrations, firstMigrationName), "utf8")}\n-- mismatch\n`);
    const mismatch = await verifyLocalRestore({ backupDir, outputDir: join(fixture.root, "migration-restore"), migrationsDir: mismatchedMigrations });
    assert.equal(mismatch.status, "failed");
    assert.equal(mismatch.failure.code, "migration_mismatch");

    await writeFile(join(backupDir, "unexpected.bin"), "unexpected");
    const unexpected = await verifyLocalRestore({ backupDir, outputDir: join(fixture.root, "unexpected-restore") });
    assert.equal(unexpected.status, "failed");
    assert.equal(unexpected.failure.code, "unexpected_artifact");

    await rm(join(backupDir, "unexpected.bin"));
    const interruptedOutput = join(fixture.root, "interrupted-restore");
    await mkdir(join(interruptedOutput, ".restore-interrupted"), { recursive: true });
    await writeFile(join(interruptedOutput, ".restore-interrupted", "partial.sqlite"), "partial");
    const retried = await verifyLocalRestore({ backupDir, outputDir: interruptedOutput });
    assert.equal(retried.status, "verified");

    const orphanDb = new DatabaseSync(fixture.source);
    orphanDb.exec("INSERT INTO pharmacy_inventory VALUES (999,9999,1)");
    orphanDb.close();
    await assert.rejects(
      createLocalBackup({ d1Path: fixture.source, r2Path: fixture.r2, outputDir: join(fixture.root, "orphan-backup"), timestamp: "2026-08-14T12:00:00.000Z" }),
      (error) => error.code === "tenant_integrity_failed",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
