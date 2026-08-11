import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const source = process.argv[2];
if (!source || !fs.existsSync(source)) {
  console.error("Usage: node scripts/import-urmed-backup.mjs <urmedin_urmeddb.sql>");
  process.exit(1);
}

const outputDir = path.resolve("drizzle");
const sourceSha256 = "66625403c7e5130354e504611df0dc8b2a1542b0c3fee000b426dafa0640394d";

function decodeSqlString(value) {
  return value.replace(/\\([0nrbtZ'"\\])/g, (_, code) => ({
    "0": "\0", n: "\n", r: "\r", b: "\b", t: "\t", Z: "\x1a", "'": "'", '"': '"', "\\": "\\",
  })[code]);
}

function parseValue(raw) {
  const value = raw.trim();
  if (/^NULL$/i.test(value)) return null;
  if (value.startsWith("'") && value.endsWith("'")) return decodeSqlString(value.slice(1, -1));
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function parseTuples(statement) {
  const valuesAt = statement.indexOf(" VALUES");
  if (valuesAt < 0) return [];
  const input = statement.slice(valuesAt + 7);
  const rows = [];
  let row = [];
  let token = "";
  let inString = false;
  let escaped = false;
  let depth = 0;
  for (const char of input) {
    if (inString) {
      token += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "'") inString = false;
      continue;
    }
    if (char === "'") { inString = true; token += char; }
    else if (char === "(") { if (depth > 0) token += char; depth += 1; }
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) { row.push(parseValue(token)); rows.push(row); row = []; token = ""; }
      else token += char;
    } else if (char === "," && depth === 1) { row.push(parseValue(token)); token = ""; }
    else if (depth > 0) token += char;
  }
  return rows;
}

function clean(value, maxLength) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function normalize(value) {
  return clean(value, 260).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function sql(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

const wanted = new Set(["categories", "customers", "products"]);
const tables = new Map([...wanted].map((name) => [name, []]));
const reader = readline.createInterface({ input: fs.createReadStream(source, { encoding: "utf8" }), crlfDelay: Infinity });
let currentTable = null;
let statement = "";
for await (const line of reader) {
  if (!currentTable) {
    const match = line.match(/^INSERT INTO `([^`]+)`/);
    if (!match || !wanted.has(match[1])) continue;
    currentTable = match[1];
    statement = line;
  } else statement += `\n${line}`;
  if (line.endsWith(";")) {
    tables.get(currentTable).push(...parseTuples(statement));
    currentTable = null;
    statement = "";
  }
}

const categoryRows = tables.get("categories").map(([id, name]) => [Number(id), clean(name, 80), "active"]);
const sourceCustomers = tables.get("customers");
const customerRows = [];
for (const row of sourceCustomers) {
  const [legacyId, nameRaw, emailRaw, , mobileRaw, registeredAt, address, city, state, pincode, mobileVerify, emailVerify] = row;
  const name = clean(nameRaw, 100);
  const email = clean(emailRaw, 180).toLowerCase();
  const mobile = String(mobileRaw ?? "").replace(/\D/g, "");
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) continue;
  if (!/^[6-9]\d{9}$/.test(mobile)) continue;
  if (String(mobileVerify).toLowerCase() !== "verified" || String(emailVerify).toLowerCase() !== "verified") continue;
  if (name.length < 2 || !/[a-z]/i.test(name)) continue;
  customerRows.push([Number(legacyId), name, email, mobile, clean(registeredAt, 32), clean(address, 500), clean(city, 100), clean(state, 100), clean(pincode, 12), 1, 1, 1, "legacy_backup"]);
}

const productRows = tables.get("products").filter((row) => Number.isInteger(row[0]) && clean(row[3], 240)).map((row) => [
  Number(row[0]), Number(row[1]) || null, Number(row[2]) || null, clean(row[3], 240), normalize(row[3]), clean(row[4], 650), clean(row[9], 180), /^yes$/i.test(clean(row[10], 20)) ? 1 : 0, Number(row[11]) || 0, clean(row[20], 30), clean(row[22], 180), "legacy_backup",
]);
const manufacturerMap = new Map();
for (const name of productRows.map((row) => row[6]).filter(Boolean)) {
  const normalizedName = normalize(name);
  if (normalizedName && !manufacturerMap.has(normalizedName)) manufacturerMap.set(normalizedName, name);
}
const manufacturers = [...manufacturerMap].map(([normalizedName, name]) => [name, normalizedName]).sort((a, b) => a[0].localeCompare(b[0]));

const seedPattern = /^\d{4}_urmed_seed_.*\.sql$/;
for (const file of fs.readdirSync(outputDir)) if (seedPattern.test(file)) fs.rmSync(path.join(outputDir, file));

const delimiter = "\n--> statement-breakpoint\n";
function insertSql(table, columns, rows, batchSize = 100) {
  const statements = [];
  for (let index = 0; index < rows.length; index += batchSize) {
    const values = rows.slice(index, index + batchSize).map((row) => `(${row.map(sql).join(",")})`).join(",\n");
    statements.push(`INSERT OR IGNORE INTO ${table} (${columns.join(",")}) VALUES\n${values};`);
  }
  return statements.join(delimiter) + delimiter;
}

const supportStatements = [
  insertSql("categories", ["id", "name", "status"], categoryRows),
  insertSql("manufacturers", ["name", "normalized_name"], manufacturers),
  insertSql("customers", ["legacy_id", "name", "email", "mobile", "registered_at", "address", "city", "state", "pincode", "email_verified", "mobile_verified", "password_reset_required", "source"], customerRows),
  insertSql("migration_audit", ["source_file", "source_sha256", "entity", "source_rows", "imported_rows", "rejected_rows", "notes"], [
    [path.basename(source), sourceSha256, "products", productRows.length, productRows.length, 0, "Core catalogue fields recovered; long HTML medicine descriptions and legacy images excluded."],
    [path.basename(source), sourceSha256, "customers", sourceCustomers.length, customerRows.length, sourceCustomers.length - customerRows.length, "Only fully phone- and email-verified customers imported. Legacy password hashes were deliberately excluded; password reset is required."],
    [path.basename(source), sourceSha256, "categories", categoryRows.length, categoryRows.length, 0, "All legacy product categories imported."],
    [path.basename(source), sourceSha256, "manufacturers", manufacturers.length, manufacturers.length, 0, "Distinct manufacturer names derived from recovered products."],
  ]),
].join("\n");
fs.writeFileSync(path.join(outputDir, "0001_urmed_seed_support.sql"), supportStatements);

const productColumns = ["legacy_id", "category_id", "display_category_id", "name", "normalized_name", "composition", "manufacturer", "prescription_required", "gst_percent", "hsn_code", "packaging", "source"];
const productsPerFile = 5000;
const journalPath = path.join(outputDir, "meta", "_journal.json");
const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
journal.entries = journal.entries.filter((entry) => !String(entry.tag).includes("urmed_seed_"));
const baseWhen = Date.now();
const tags = ["0001_urmed_seed_support"];
for (let start = 0, fileIndex = 2; start < productRows.length; start += productsPerFile, fileIndex += 1) {
  const tag = `${String(fileIndex).padStart(4, "0")}_urmed_seed_products_${String(start + 1).padStart(6, "0")}_${String(Math.min(start + productsPerFile, productRows.length)).padStart(6, "0")}`;
  const rows = productRows.slice(start, start + productsPerFile);
  fs.writeFileSync(path.join(outputDir, `${tag}.sql`), insertSql("products", productColumns, rows, 50));
  tags.push(tag);
}
for (const [index, tag] of tags.entries()) journal.entries.push({ idx: journal.entries.length, version: "6", when: baseWhen + index, tag, breakpoints: true });
fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);

const bytes = fs.readdirSync(outputDir).filter((file) => seedPattern.test(file)).reduce((sum, file) => sum + fs.statSync(path.join(outputDir, file)).size, 0);
console.log(JSON.stringify({ sourceProducts: tables.get("products").length, importedProducts: productRows.length, sourceCustomers: sourceCustomers.length, importedCustomers: customerRows.length, rejectedCustomers: sourceCustomers.length - customerRows.length, categories: categoryRows.length, manufacturers: manufacturers.length, seedFiles: tags.length, seedSizeMB: Number((bytes / 1024 / 1024).toFixed(2)) }, null, 2));
