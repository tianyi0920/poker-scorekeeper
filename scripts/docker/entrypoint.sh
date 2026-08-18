#!/usr/bin/env bash
set -euo pipefail

migration_pid=''

forward_migration_signal() {
  signal="$1"
  exit_code="$2"
  trap - HUP INT TERM
  if [[ -n "$migration_pid" ]]; then
    kill -s "$signal" "$migration_pid" 2>/dev/null || true
    wait "$migration_pid" 2>/dev/null || true
  fi
  exit "$exit_code"
}

trap 'forward_migration_signal HUP 129' HUP
trap 'forward_migration_signal INT 130' INT
trap 'forward_migration_signal TERM 143' TERM

pnpm --dir apps/api exec prisma migrate deploy &
migration_pid=$!
set +e
wait "$migration_pid"
migration_status=$?
set -e
if (( migration_status != 0 )); then exit "$migration_status"; fi
migration_pid=''
trap - HUP INT TERM
exec node apps/api/dist/main.js
