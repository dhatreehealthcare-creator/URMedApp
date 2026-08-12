#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${SITES_ENV_READY:-}" != "1" ]]; then
  exec "${script_dir}/sites-env.sh" -- "$0" "$@"
fi

worker="${SITES_PROJECT_ROOT}/dist/server/index.js"
config="${SITES_PROJECT_ROOT}/dist/server/wrangler.json"
migrations="${SITES_PROJECT_ROOT}/dist/.openai/drizzle"
wrangler="${SITES_PROJECT_ROOT}/node_modules/.bin/wrangler"
state="${SITES_PREVIEW_STATE:-${SITES_PROJECT_ROOT}/.sites-runtime/preview-state}"
host="${HOST:-127.0.0.1}"
port="${PORT:-3000}"

[[ -f "${worker}" && -f "${config}" && -d "${migrations}" ]] || {
  echo "The production artifact is missing. Run npm run build before npm run start." >&2
  exit 66
}
[[ -x "${wrangler}" ]] || {
  echo "Wrangler is unavailable. Install the locked dependencies before previewing." >&2
  exit 69
}

"${script_dir}/validate-artifact.sh"
mkdir -p "${state}"

d1_binding="$(node --input-type=module - "${SITES_PROJECT_ROOT}/dist/.openai/hosting.json" <<'NODE'
import { readFile } from "node:fs/promises";
const hosting = JSON.parse(await readFile(process.argv[2], "utf8"));
if (!hosting.d1) throw new Error("The Sites manifest does not declare a D1 binding");
process.stdout.write(hosting.d1);
NODE
)"

if [[ "${SITES_PREVIEW_SKIP_MIGRATIONS:-0}" != "1" ]]; then
  echo "Applying pending migrations to the local preview database..."
  CI=1 "${wrangler}" d1 migrations apply "${d1_binding}" \
    --local \
    --persist-to "${state}" \
    --config "${config}"
fi

wrangler_args=(
  dev
  --config "${config}"
  --local
  --persist-to "${state}"
  --ip "${host}"
  --port "${port}"
  --inspector-port 0
  --test-scheduled
  --show-interactive-dev-session false
)

if [[ -n "${SITES_PREVIEW_ENV_FILE:-}" ]]; then
  [[ -f "${SITES_PREVIEW_ENV_FILE}" ]] || {
    echo "SITES_PREVIEW_ENV_FILE does not exist: ${SITES_PREVIEW_ENV_FILE}" >&2
    exit 66
  }
  wrangler_args+=(--env-file "${SITES_PREVIEW_ENV_FILE}")
else
  for env_file in "${SITES_PROJECT_ROOT}/.env" "${SITES_PROJECT_ROOT}/.env.local" "${SITES_PROJECT_ROOT}/.dev.vars"; do
    [[ -f "${env_file}" ]] && wrangler_args+=(--env-file "${env_file}")
  done
fi

echo "Starting binding-aware production preview at http://${host}:${port}"
exec "${wrangler}" "${wrangler_args[@]}" "$@"
