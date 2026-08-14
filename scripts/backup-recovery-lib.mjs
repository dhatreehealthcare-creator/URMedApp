import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

export const BACKUP_FORMAT = "urmed-local-backup";
export const BACKUP_FORMAT_VERSION = 1;

const REQUIRED_TABLES = [
  "account_profiles",
  "vendors",
  "products",
  "pharmacy_inventory",
  "stored_documents",
  "audit_events",
  "tax_invoices",
  "transactional_email_outbox",
  "payment_events",
  "inventory_reservations",
  "prescriptions",
  "offline_sales",
];

const TENANT_TABLES = [
  "pharmacy_inventory",
  "orders",
  "offline_sales",
  "expenses",
  "ledger_entries",
  "stored_documents",
  "notifications",
  "audit_events",
];

export class BackupRecoveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BackupRecoveryError";
    this.code = code;
  }
}

export function canonicalJson(value) {
  return JSON.stringify(value, (_key, nested) => {
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) return nested;
    return Object.fromEntries(Object.entries(nested).sort(([left], [right]) => left.localeCompare(right)));
  });
}

export function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function sha256File(filePath) {
  return sha256Bytes(await readFile(filePath));
}

async function ensureDirectory(path, label) {
  if (!path) throw new BackupRecoveryError("missing_path", `${label} is required`);
  const details = await lstat(path).catch((error) => {
    if (error?.code === "ENOENT") throw new BackupRecoveryError("missing_path", `${label} does not exist`);
    throw error;
  });
  if (!details.isDirectory()) throw new BackupRecoveryError("invalid_path", `${label} must be a directory`);
}

async function ensureFile(path, label) {
  if (!path) throw new BackupRecoveryError("missing_path", `${label} is required`);
  const details = await lstat(path).catch((error) => {
    if (error?.code === "ENOENT") throw new BackupRecoveryError("missing_path", `${label} does not exist`);
    throw error;
  });
  if (!details.isFile()) throw new BackupRecoveryError("invalid_path", `${label} must be a file`);
}

function safeRelativePath(value) {
  const normalized = String(value).replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..") || /^[A-Za-z]:/.test(normalized)) {
    throw new BackupRecoveryError("unsafe_path", "Backup contains an unsafe relative path");
  }
  return normalized;
}

function inside(root, candidate) {
  const rootResolved = resolve(root);
  const candidateResolved = resolve(candidate);
  return candidateResolved === rootResolved || candidateResolved.startsWith(`${rootResolved}${sep}`);
}

async function listFiles(root, prefix = "") {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = join(root, entry.name);
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new BackupRecoveryError("symlink_rejected", "Backup inputs may not contain symbolic links");
    if (entry.isDirectory()) files.push(...await listFiles(absolute, relativePath));
    else if (entry.isFile()) files.push({ absolute, relative: relativePath.replaceAll(sep, "/") });
    else throw new BackupRecoveryError("unsupported_file", "Backup inputs may contain only regular files and directories");
  }
  return files;
}

async function migrationCatalog(migrationsDir) {
  await ensureDirectory(migrationsDir, "migrations directory");
  const files = (await readdir(migrationsDir)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
  if (!files.length) throw new BackupRecoveryError("missing_migrations", "No ordered SQL migrations were found");
  const entries = [];
  for (const name of files) {
    const bytes = await readFile(join(migrationsDir, name));
    entries.push({ name, sha256: sha256Bytes(bytes), sizeBytes: bytes.byteLength });
  }
  return {
    count: entries.length,
    firstTag: entries[0].name.replace(/\.sql$/, ""),
    lastTag: entries.at(-1).name.replace(/\.sql$/, ""),
    catalogSha256: sha256Bytes(Buffer.from(canonicalJson(entries))),
    entries,
  };
}

function tableNames(database) {
  return database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => String(row.name));
}

function tableCounts(database, names = tableNames(database)) {
  const result = {};
  for (const table of names) {
    if (!/^[A-Za-z0-9_]+$/.test(table)) continue;
    result[table] = Number(database.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get().count);
  }
  return result;
}

function migrationLedger(database) {
  if (!tableNames(database).includes("d1_migrations")) return { present: false, count: null, lastTag: null };
  const columns = database.prepare("PRAGMA table_info(d1_migrations)").all().map((row) => String(row.name));
  const tagColumn = columns.find((column) => ["name", "tag", "migration_name"].includes(column));
  const count = Number(database.prepare("SELECT COUNT(*) AS count FROM d1_migrations").get().count);
  if (!tagColumn) return { present: true, count, lastTag: null };
  const row = database.prepare(`SELECT "${tagColumn}" AS tag FROM d1_migrations ORDER BY rowid DESC LIMIT 1`).get();
  return { present: true, count, lastTag: row?.tag ? String(row.tag) : null };
}

function tenantIntegrity(database) {
  const tables = new Set(tableNames(database));
  const checks = [];
  for (const table of TENANT_TABLES) {
    if (!tables.has(table)) continue;
    const columns = database.prepare(`PRAGMA table_info("${table}")`).all().map((row) => String(row.name));
    if (!columns.includes("vendor_id")) continue;
    if (!tables.has("vendors")) throw new BackupRecoveryError("tenant_schema_invalid", `${table} has vendor_id but vendors is missing`);
    const orphanCount = Number(database.prepare(`SELECT COUNT(*) AS count FROM "${table}" row WHERE row.vendor_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM vendors vendor WHERE vendor.id=row.vendor_id)`).get().count);
    checks.push({ table, orphanVendorRows: orphanCount });
    if (orphanCount) throw new BackupRecoveryError("tenant_integrity_failed", `${table} contains orphan tenant rows`);
  }
  return checks;
}

function evidenceSummary(database) {
  const counts = tableCounts(database);
  const count = (table) => counts[table] ?? 0;
  const documentColumns = new Set(database.prepare("PRAGMA table_info(stored_documents)").all().map((row) => String(row.name)));
  const r2ObjectMetadata = documentColumns.has("object_key")
    ? database.prepare("SELECT object_key AS objectKey,size_bytes AS sizeBytes,sha256,status FROM stored_documents WHERE object_key <> '' ORDER BY object_key").all()
      .map((row) => ({ objectKey: String(row.objectKey), sizeBytes: Number(row.sizeBytes), sha256: String(row.sha256), status: String(row.status) }))
    : [];
  return {
    vendors: count("vendors"),
    profiles: count("account_profiles"),
    inventoryRows: count("pharmacy_inventory"),
    invoices: count("tax_invoices"),
    payments: count("payment_events") + count("payment_refunds"),
    prescriptions: count("prescriptions") + count("offline_prescriptions"),
    quarantineDocuments: database.prepare("SELECT COUNT(*) AS count FROM stored_documents WHERE status='quarantined'").get().count,
    auditEvents: count("audit_events"),
    outboxRows: count("transactional_email_outbox"),
    r2ObjectMetadata,
  };
}

function validateDatabase(database, migrationInfo, requiredTables = REQUIRED_TABLES) {
  const integrity = String(database.prepare("PRAGMA integrity_check").get().integrity_check);
  if (integrity !== "ok") throw new BackupRecoveryError("database_integrity_failed", "D1 integrity check failed");
  const foreignKeys = database.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeys.length) throw new BackupRecoveryError("foreign_key_integrity_failed", "D1 foreign-key integrity check failed");
  const names = new Set(tableNames(database));
  const missing = requiredTables.filter((table) => !names.has(table));
  if (missing.length) throw new BackupRecoveryError("schema_incompatible", `D1 backup is missing required tables: ${missing.join(",")}`);
  const ledger = migrationLedger(database);
  if (ledger.present && ledger.count > migrationInfo.count) throw new BackupRecoveryError("migration_incompatible", "D1 migration ledger is newer than the supplied migration catalog");
  const tenants = tenantIntegrity(database);
  return {
    integrity,
    foreignKeys: "ok",
    tableCount: names.size,
    tableCounts: tableCounts(database),
    migrationLedger: ledger,
    tenantIntegrity: tenants,
    evidence: evidenceSummary(database),
  };
}

function artifactRecord(root, relativePath, kind, sizeBytes, sha256) {
  return { path: safeRelativePath(relativePath), kind, sizeBytes, sha256 };
}

async function copyDirectoryContents(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const file of await listFiles(source)) {
    const target = join(destination, file.relative);
    if (!inside(destination, target)) throw new BackupRecoveryError("unsafe_path", "R2 restore path escaped its root");
    await mkdir(dirname(target), { recursive: true });
    await copyFile(file.absolute, target);
  }
}

async function artifactFilesForBackup(backupDir) {
  const files = [];
  await ensureFile(join(backupDir, "d1.sqlite"), "D1 backup artifact");
  files.push({ absolute: join(backupDir, "d1.sqlite"), relative: "d1.sqlite", kind: "d1" });
  const r2Root = join(backupDir, "r2");
  if (existsSync(r2Root)) {
    for (const file of await listFiles(r2Root)) files.push({ absolute: file.absolute, relative: `r2/${file.relative}`, kind: file.relative.endsWith(".sqlite") || /\.sqlite-(?:wal|shm)$/.test(file.relative) ? "r2-internal" : "r2-object" });
  }
  return files;
}

export async function createLocalBackup({ d1Path, r2Path, outputDir, migrationsDir = "drizzle", timestamp = new Date().toISOString() }) {
  await ensureFile(d1Path, "D1 SQLite path");
  await ensureDirectory(r2Path, "R2 local persistence directory");
  if (!outputDir) throw new BackupRecoveryError("missing_path", "output directory is required");
  const output = resolve(outputDir);
  if (inside(resolve(r2Path), output)) throw new BackupRecoveryError("unsafe_path", "Backup output may not be inside an R2 source directory");
  await mkdir(output, { recursive: true });
  const existing = await readdir(output);
  if (existing.length) throw new BackupRecoveryError("output_not_empty", "Backup output directory must be empty");
  const migrationInfo = await migrationCatalog(migrationsDir);
  const tempD1 = join(output, `.d1-${randomUUID()}.sqlite`);
  const source = new DatabaseSync(d1Path);
  try {
    source.exec(`VACUUM INTO '${tempD1.replaceAll("'", "''")}'`);
  } finally {
    source.close();
  }
  await rename(tempD1, join(output, "d1.sqlite"));
  await copyDirectoryContents(r2Path, join(output, "r2"));
  const restoredDatabase = new DatabaseSync(join(output, "d1.sqlite"));
  let validation;
  try {
    validation = validateDatabase(restoredDatabase, migrationInfo);
  } finally {
    restoredDatabase.close();
  }
  const artifacts = [];
  for (const artifact of await artifactFilesForBackup(output)) {
    const details = await stat(artifact.absolute);
    artifacts.push(artifactRecord(output, artifact.relative, artifact.kind, details.size, await sha256File(artifact.absolute)));
  }
  artifacts.sort((left, right) => left.path.localeCompare(right.path));
  const contentSha256 = sha256Bytes(Buffer.from(canonicalJson(artifacts)));
  const manifest = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt: timestamp,
    source: { kind: "local-d1-r2", secretsIncluded: false },
    migration: migrationInfo,
    database: { artifact: "d1.sqlite", ...validation },
    r2: {
      root: "r2",
      objectCount: artifacts.filter((artifact) => artifact.kind === "r2-object").length,
      internalFileCount: artifacts.filter((artifact) => artifact.kind === "r2-internal").length,
      objectKeys: validation.evidence.r2ObjectMetadata,
    },
    artifacts,
    contentSha256,
  };
  const manifestBytes = Buffer.from(`${canonicalJson(manifest)}\n`);
  await writeFile(join(output, "manifest.json"), manifestBytes, { flag: "wx" });
  const report = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    status: "created",
    createdAt: timestamp,
    contentSha256,
    manifestSha256: sha256Bytes(manifestBytes),
    migration: { count: migrationInfo.count, lastTag: migrationInfo.lastTag, catalogSha256: migrationInfo.catalogSha256 },
    validation: { tableCount: validation.tableCount, evidence: validation.evidence, r2ObjectCount: manifest.r2.objectCount },
    retention: { policy: "caller-managed", expiresAt: null },
  };
  await writeFile(join(output, "backup-report.json"), `${canonicalJson(report)}\n`, { flag: "wx" });
  return { manifest, report };
}

async function readManifest(backupDir) {
  const manifestPath = join(backupDir, "manifest.json");
  await ensureFile(manifestPath, "backup manifest");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    throw new BackupRecoveryError("manifest_invalid", "Backup manifest is not valid JSON");
  }
  if (manifest.format !== BACKUP_FORMAT || manifest.formatVersion !== BACKUP_FORMAT_VERSION || !Array.isArray(manifest.artifacts)) {
    throw new BackupRecoveryError("manifest_incompatible", "Backup format or version is unsupported");
  }
  const expectedContent = sha256Bytes(Buffer.from(canonicalJson(manifest.artifacts)));
  if (expectedContent !== manifest.contentSha256) throw new BackupRecoveryError("manifest_checksum_mismatch", "Backup manifest content checksum does not match");
  return manifest;
}

async function verifyBackupArtifacts(backupDir, manifest) {
  const allowedRootFiles = new Set(["d1.sqlite", "r2", "manifest.json", "backup-report.json"]);
  for (const entry of await readdir(backupDir, { withFileTypes: true })) {
    if (!allowedRootFiles.has(entry.name)) throw new BackupRecoveryError("unexpected_artifact", `Unexpected backup artifact: ${entry.name}`);
    if (entry.name === "r2" && !entry.isDirectory()) throw new BackupRecoveryError("artifact_invalid", "The R2 backup root must be a directory");
    if (entry.name !== "r2" && entry.name !== "manifest.json" && entry.name !== "backup-report.json" && !entry.isFile()) throw new BackupRecoveryError("artifact_invalid", `Backup artifact is not a regular file: ${entry.name}`);
  }
  const expected = new Map(manifest.artifacts.map((artifact) => [safeRelativePath(artifact.path), artifact]));
  if (expected.size !== manifest.artifacts.length) throw new BackupRecoveryError("manifest_duplicate_artifact", "Backup manifest contains duplicate artifacts");
  const actual = await artifactFilesForBackup(backupDir);
  const actualPaths = new Set(actual.map((artifact) => artifact.relative));
  for (const artifact of manifest.artifacts) {
    const path = safeRelativePath(artifact.path);
    if (!actualPaths.has(path)) throw new BackupRecoveryError("artifact_missing", `Backup artifact is missing: ${path}`);
    const absolute = join(backupDir, path);
    const details = await stat(absolute);
    if (details.size !== Number(artifact.sizeBytes)) throw new BackupRecoveryError("artifact_size_mismatch", `Backup artifact size mismatch: ${path}`);
    if (await sha256File(absolute) !== artifact.sha256) throw new BackupRecoveryError("artifact_checksum_mismatch", `Backup artifact checksum mismatch: ${path}`);
  }
  for (const path of actualPaths) if (!expected.has(path)) throw new BackupRecoveryError("unexpected_artifact", `Unexpected backup artifact: ${path}`);
}

async function writeFailureReport(outputDir, error, startedAt) {
  await mkdir(outputDir, { recursive: true });
  const report = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    status: "failed",
    startedAt,
    completedAt: new Date().toISOString(),
    failure: { code: error?.code ?? "restore_failed", message: String(error?.message ?? "Restore verification failed").slice(0, 240) },
  };
  await writeFile(join(outputDir, "recovery-report.json"), `${canonicalJson(report)}\n`);
  return report;
}

export async function verifyLocalRestore({ backupDir, outputDir, migrationsDir = "drizzle" }) {
  const startedAt = new Date().toISOString();
  const output = resolve(outputDir);
  try {
    await ensureDirectory(backupDir, "backup directory");
    const manifest = await readManifest(backupDir);
    const migrationInfo = await migrationCatalog(migrationsDir);
    if (migrationInfo.catalogSha256 !== manifest.migration.catalogSha256) throw new BackupRecoveryError("migration_mismatch", "Backup migration catalog does not match the current migration set");
    if (existsSync(output)) {
      const existingReportPath = join(output, "recovery-report.json");
      if (existsSync(existingReportPath)) {
        const existing = JSON.parse(await readFile(existingReportPath, "utf8"));
        if (existing.status === "verified" && existing.contentSha256 === manifest.contentSha256) return existing;
      }
      for (const entry of await readdir(output, { withFileTypes: true })) {
        if (entry.name.startsWith(".restore-") && entry.isDirectory()) await rm(join(output, entry.name), { recursive: true, force: true });
      }
      if ((await readdir(output)).length) throw new BackupRecoveryError("restore_output_not_empty", "Restore output is not empty and is not a matching verified restore");
    } else await mkdir(output, { recursive: true });
    await verifyBackupArtifacts(backupDir, manifest);
    const staging = join(output, `.restore-${randomUUID()}`);
    await mkdir(staging, { recursive: true });
    try {
      await copyFile(join(backupDir, "d1.sqlite"), join(staging, "d1.sqlite"));
      if (existsSync(join(backupDir, "r2"))) await cp(join(backupDir, "r2"), join(staging, "r2"), { recursive: true, errorOnExist: false });
      const database = new DatabaseSync(join(staging, "d1.sqlite"));
      let validation;
      try {
        validation = validateDatabase(database, migrationInfo);
      } finally {
        database.close();
      }
      const finalRestore = join(output, "restored");
      if (existsSync(finalRestore)) await rm(finalRestore, { recursive: true, force: true });
      await rename(staging, finalRestore);
      const report = {
        format: BACKUP_FORMAT,
        formatVersion: BACKUP_FORMAT_VERSION,
        status: "verified",
        startedAt,
        completedAt: new Date().toISOString(),
        contentSha256: manifest.contentSha256,
        migration: { count: migrationInfo.count, lastTag: migrationInfo.lastTag, catalogSha256: migrationInfo.catalogSha256 },
        database: { ...validation, restoredArtifact: "restored/d1.sqlite" },
        r2: { objectCount: manifest.r2.objectCount, objectKeys: manifest.r2.objectKeys, restoredRoot: "restored/r2" },
        evidence: validation.evidence,
        failure: null,
      };
      const reportTemp = join(output, `.recovery-report-${randomUUID()}.tmp`);
      await writeFile(reportTemp, `${canonicalJson(report)}\n`, { flag: "wx" });
      await rename(reportTemp, join(output, "recovery-report.json"));
      return report;
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  } catch (error) {
    if (error instanceof BackupRecoveryError) return writeFailureReport(output, error, startedAt);
    return writeFailureReport(output, new BackupRecoveryError("restore_failed", "Restore verification failed"), startedAt);
  }
}

export function parseCliArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new BackupRecoveryError("invalid_argument", `Unexpected argument: ${argument}`);
    const key = argument.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new BackupRecoveryError("invalid_argument", `Missing value for --${key}`);
    values[key] = value;
    index += 1;
  }
  return values;
}
