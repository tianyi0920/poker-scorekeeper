#!/usr/bin/env bash
set -euo pipefail

: "${POKER_TEST_IMAGE:?POKER_TEST_IMAGE must name the already-built candidate image}"
: "${EXPECTED_COMMIT:?EXPECTED_COMMIT must name the candidate source commit}"
: "${COMPOSE_PROJECT_NAME:?COMPOSE_PROJECT_NAME must be a unique candidate project}"

if [[ ! "$EXPECTED_COMMIT" =~ ^[a-f0-9]{40}$ ]]; then
  printf 'Unsafe expected commit: %s\n' "$EXPECTED_COMMIT" >&2
  exit 64
fi

candidate_image_pattern="^poker-scorekeeper:candidate-${EXPECTED_COMMIT}-[a-f0-9]{8}$"
if [[ ! "$POKER_TEST_IMAGE" =~ $candidate_image_pattern ]]; then
  printf 'Unsafe candidate image: %s\n' "$POKER_TEST_IMAGE" >&2
  exit 64
fi

if [[ ! "$COMPOSE_PROJECT_NAME" =~ ^poker-candidate-[a-f0-9]{12}$ ]]; then
  printf 'Unsafe Compose project name: %s\n' "$COMPOSE_PROJECT_NAME" >&2
  exit 64
fi

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repository_root"

image_revision="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$POKER_TEST_IMAGE")"
[[ "$image_revision" == "$EXPECTED_COMMIT" ]] || {
  printf 'Candidate image revision does not match EXPECTED_COMMIT\n' >&2
  exit 65
}

export POKER_TEST_IMAGE
compose=(docker compose -p "$COMPOSE_PROJECT_NAME" -f docker-compose.test.yml)
base_url='http://127.0.0.1:3000'
invalid_database_url='mysql://poker_invalid:poker_invalid@mysql:3306/poker_scorekeeper_test'
marker="$(date -u +%s)-$$-${RANDOM}"

cleanup() {
  status=$?
  "${compose[@]}" down -v --remove-orphans || true
  exit "$status"
}
trap cleanup EXIT

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

assert_port_unused() {
  if timeout 2s bash -c 'exec 3<>/dev/tcp/127.0.0.1/3000' >/dev/null 2>&1; then
    fail '127.0.0.1:3000 is already in use'
  fi
}

assert_app_absent() {
  if "${compose[@]}" ps -q app | grep -q .; then
    fail 'App service container exists after negative migration probe'
  fi
  if curl --fail --silent --show-error --connect-timeout 1 "$base_url/api/health/live" >/dev/null; then
    fail 'API health port became ready after the negative migration probe'
  fi
}

wait_for_health() {
  path="$1"
  for _ in $(seq 1 60); do
    if curl --fail --silent --show-error --connect-timeout 1 "$base_url$path" >/dev/null; then
      return 0
    fi
    sleep 1
  done
  fail "Timed out waiting for $path"
}

wait_for_mysql() {
  for _ in $(seq 1 60); do
    if "${compose[@]}" exec -T mysql mysqladmin ping -h 127.0.0.1 -u poker_test -ppoker_test --silent >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  fail 'Timed out waiting for isolated MySQL'
}

assert_port_unused
"${compose[@]}" up -d --pull never --no-build mysql
wait_for_mysql

migration_status=0
timeout 30s "${compose[@]}" run --rm --no-deps \
  -e "DATABASE_URL=$invalid_database_url" \
  app /app/apps/api/node_modules/.bin/prisma migrate deploy || migration_status=$?
if (( migration_status == 0 )); then
  fail 'Migration unexpectedly succeeded with test-only invalid credentials'
fi
if (( migration_status == 124 )); then
  fail 'Negative migration probe timed out'
fi
assert_app_absent

"${compose[@]}" up -d --pull never --no-build
wait_for_health '/api/health/live'
wait_for_health '/api/health/ready'

app_container="$("${compose[@]}" ps -q app)"
[[ -n "$app_container" ]] || fail 'Candidate app container was not created'
[[ "$(docker exec "$app_container" id -u)" != '0' ]] || fail 'Candidate app runs as root'
[[ "$(docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$app_container")" == 'true' ]] \
  || fail 'Candidate app root filesystem is writable'

"${compose[@]}" exec -T app sh -c "printf '%s\\n' '$marker' > /data/avatars/avatar-marker-${marker}"
"${compose[@]}" exec -T app sh -c "printf '%s\\n' '$marker' > /data/backups/backup-marker-${marker}"
"${compose[@]}" restart app
wait_for_health '/api/health/live'
wait_for_health '/api/health/ready'
"${compose[@]}" exec -T app sh -c "test \"\$(cat /data/avatars/avatar-marker-${marker})\" = '$marker'"
"${compose[@]}" exec -T app sh -c "test \"\$(cat /data/backups/backup-marker-${marker})\" = '$marker'"

printf 'Candidate image smoke gate passed for %s\n' "$POKER_TEST_IMAGE"
