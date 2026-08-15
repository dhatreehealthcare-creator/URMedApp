#!/usr/bin/env bash
set -euo pipefail

# Vite's Cloudflare environment persists a local D1 database under this root,
# but it does not run D1 migrations automatically.  Keep `npm run dev` binding-
# aware and fail closed if the local schema cannot be prepared.
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runtime_root="${project_root}/.wrangler/state"
config_file="$(mktemp "${TMPDIR:-/tmp}/urmed-dev-wrangler.XXXXXX.json")"
cleanup() { rm -f "${config_file}"; }
trap cleanup EXIT INT TERM

cat >"${config_file}" <<JSON
{
  "compatibility_flags": ["nodejs_compat"],
  "d1_databases": [{
    "binding": "DB",
    "database_name": "site-creator-d1",
    "database_id": "00000000-0000-4000-8000-000000000000",
    "migrations_dir": "${project_root}/drizzle"
  }]
}
JSON

echo "Preparing local D1 migrations for Vite development..."
CI=1 "${project_root}/node_modules/.bin/wrangler" d1 migrations apply DB \
  --local \
  --persist-to "${runtime_root}" \
  --config "${config_file}"

cd "${project_root}"
exec env \
  WRANGLER_LOG_PATH="${WRANGLER_LOG_PATH:-.wrangler/wrangler.log}" \
  vite "$@"
