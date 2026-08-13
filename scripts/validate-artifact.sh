#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${SITES_ENV_READY:-}" != "1" ]]; then
  exec "${script_dir}/sites-env.sh" -- "$0" "$@"
fi

worker="${SITES_PROJECT_ROOT}/dist/server/index.js"
hosting="${SITES_PROJECT_ROOT}/dist/.openai/hosting.json"
wrangler="${SITES_PROJECT_ROOT}/dist/server/wrangler.json"

[[ -f "${worker}" ]] || {
  echo "Missing Sites Worker entry: dist/server/index.js" >&2
  exit 66
}
[[ -f "${hosting}" ]] || {
  echo "Missing packaged Sites manifest: dist/.openai/hosting.json" >&2
  exit 66
}
[[ -f "${wrangler}" ]] || {
  echo "Missing generated Worker configuration: dist/server/wrangler.json" >&2
  exit 66
}

node --input-type=module - "${worker}" "${hosting}" "${wrangler}" <<'NODE'
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const [workerPath, hostingPath, wranglerPath] = process.argv.slice(2);
const hosting = JSON.parse(await readFile(hostingPath, "utf8"));
const wrangler = JSON.parse(await readFile(wranglerPath, "utf8"));

if (hosting.d1 !== "DB" || hosting.r2 !== "BUCKET") {
  throw new Error("URMED requires the Sites D1 binding DB and R2 binding BUCKET");
}
const d1 = wrangler.d1_databases?.find((binding) => binding.binding === hosting.d1);
if (!d1) throw new Error(`Generated Worker configuration is missing D1 binding ${hosting.d1}`);
if (d1.migrations_dir !== "../.openai/drizzle") {
  throw new Error("Generated D1 binding must point to the packaged Sites migrations");
}
if (!wrangler.r2_buckets?.some((binding) => binding.binding === hosting.r2)) {
  throw new Error(`Generated Worker configuration is missing R2 binding ${hosting.r2}`);
}
if (wrangler.assets?.directory !== "../client") {
  throw new Error("Generated Worker configuration must serve the production client artifact");
}

const workerUrl = pathToFileURL(workerPath);
workerUrl.searchParams.set("sites-validation", `${process.pid}-${Date.now()}`);
const worker = await import(workerUrl.href);
if (!worker.default || typeof worker.default.fetch !== "function") {
  throw new Error("dist/server/index.js must have an ESM default export with fetch(request, env, ctx)");
}
if (typeof worker.default.scheduled !== "function") {
  throw new Error("dist/server/index.js must expose the scheduled reservation-recovery handler");
}
if (!wrangler.triggers?.crons?.includes("*/5 * * * *")) {
  throw new Error("dist/server/wrangler.json must schedule reservation recovery every five minutes");
}
if (!wrangler.triggers?.crons?.includes("*/15 * * * *")) {
  throw new Error("dist/server/wrangler.json must schedule customer reminder processing every fifteen minutes");
}
if (!wrangler.triggers?.crons?.includes("30 0 * * *")) {
  throw new Error("dist/server/wrangler.json must schedule vendor inventory alerts daily");
}
if (!wrangler.triggers?.crons?.includes("7,17,27,37,47,57 * * * *")) {
  throw new Error("dist/server/wrangler.json must schedule transactional email outbox processing");
}
NODE

echo "Validated Sites artifact: Worker handlers, D1 migrations, R2, client assets, scheduled jobs, and hosting bindings are aligned."
