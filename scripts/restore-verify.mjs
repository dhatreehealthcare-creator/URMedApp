#!/usr/bin/env node
import { parseCliArgs, verifyLocalRestore } from "./backup-recovery-lib.mjs";

try {
  const args = parseCliArgs(process.argv.slice(2));
  if (!args.backup || !args.out) throw new Error("Usage: npm run restore:verify -- --backup <backup-directory> --out <empty-restore-directory>");
  const report = await verifyLocalRestore({ backupDir: args.backup, outputDir: args.out, migrationsDir: args.migrations ?? "drizzle" });
  console.log(JSON.stringify(report));
  if (report.status !== "verified") process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ status: "failed", code: error?.code ?? "restore_failed", error: String(error?.message ?? "Restore verification failed").slice(0, 240) }));
  process.exitCode = 1;
}
