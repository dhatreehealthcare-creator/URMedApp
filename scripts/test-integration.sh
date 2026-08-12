#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${SITES_ENV_READY:-}" != "1" ]]; then
  exec "${script_dir}/sites-env.sh" -- "$0" "$@"
fi

exec node "${script_dir}/run-with-timeout.mjs" \
  --timeout "${SITES_INTEGRATION_TIMEOUT:-10m}" \
  --kill-after "${SITES_INTEGRATION_KILL_AFTER:-10s}" \
  -- \
  node "${script_dir}/test-integration.mjs" "$@"
