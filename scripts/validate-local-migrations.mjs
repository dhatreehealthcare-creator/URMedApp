import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const files = readdirSync("drizzle").filter((name) => /^\d{4}.*\.sql$/.test(name)).sort();
const database = new DatabaseSync(":memory:");
database.exec("CREATE TABLE local_migration_ledger (tag TEXT PRIMARY KEY)");

function applyPending() {
  let applied = 0;
  for (const file of files) {
    if (database.prepare("SELECT 1 FROM local_migration_ledger WHERE tag=?").get(file)) continue;
    database.exec(readFileSync(`drizzle/${file}`, "utf8").replaceAll("--> statement-breakpoint", ""));
    database.prepare("INSERT INTO local_migration_ledger(tag) VALUES(?)").run(file);
    applied += 1;
  }
  return applied;
}

try {
  const firstApplied = applyPending();
  const secondApplied = applyPending();
  const manufacturerState = database.prepare("SELECT count(*) AS count FROM manufacturer_canonical_state").get().count;
  const manufacturerAliases = database.prepare("SELECT count(*) AS count FROM manufacturer_aliases").get().count;
  const manufacturerAudit = database.prepare("SELECT count(*) AS count FROM migration_audit WHERE entity='manufacturer_governance_backfill'").get().count;
  if (firstApplied !== files.length || secondApplied !== 0 || manufacturerAudit !== 1 || manufacturerState !== manufacturerAliases) {
    throw new Error(`Migration validation mismatch: ${JSON.stringify({ files: files.length, firstApplied, secondApplied, manufacturerState, manufacturerAliases, manufacturerAudit })}`);
  }
  console.log(JSON.stringify({ migrations: files.length, firstApplied, repeatApplied: secondApplied, manufacturerState, manufacturerAliases, manufacturerAudit }));
} finally {
  database.close();
}
