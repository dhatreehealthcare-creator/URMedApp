#!/usr/bin/env node
import { createLocalBackup, parseCliArgs } from "./backup-recovery-lib.mjs";

try {
  const args = parseCliArgs(process.argv.slice(2));
  if (!args.d1 || !args.r2 || !args.out) throw new Error("Usage: npm run backup:local -- --d1 <sqlite-file> --r2 <r2-directory> --out <empty-output-directory> [--timestamp <ISO-8601>]");
  const result = await createLocalBackup({
    d1Path: args.d1,
    r2Path: args.r2,
    outputDir: args.out,
    migrationsDir: args.migrations ?? "drizzle",
    timestamp: args.timestamp ?? new Date().toISOString(),
  });
  console.log(JSON.stringify({ status: "created", ...result.report }));
} catch (error) {
  console.error(JSON.stringify({ status: "failed", code: error?.code ?? "backup_failed", error: String(error?.message ?? "Backup failed").slice(0, 240) }));
  process.exitCode = 1;
}
