#!/usr/bin/env bash
set -euo pipefail
umask 077

: "${MYSQL_HOST:?MYSQL_HOST is required}"
: "${MYSQL_PORT:?MYSQL_PORT is required}"
: "${MYSQL_USER:?MYSQL_USER is required}"
: "${MYSQL_PASSWORD:?MYSQL_PASSWORD is required}"
: "${RESTORE_DATABASE:?RESTORE_DATABASE is required}"
: "${CONFIRM_RESTORE_DATABASE:?CONFIRM_RESTORE_DATABASE is required}"
: "${CONFIRM_RESTORE_ACTION:?CONFIRM_RESTORE_ACTION is required}"

die() {
  printf '%s\n' "$1" >&2
  exit 2
}

[[ "$MYSQL_PORT" =~ ^[0-9]{1,5}$ ]] || die 'invalid mysql port'
(( MYSQL_PORT >= 1 && MYSQL_PORT <= 65535 )) || die 'invalid mysql port'
[[ "$RESTORE_DATABASE" =~ ^[a-z][a-z0-9_]{2,63}$ ]] || die 'invalid restore database'
[[ "$RESTORE_DATABASE" =~ (_test|_restore(_[a-z0-9]+)?)$ ]] || \
  die 'restore target must be a new isolated test or restore database'
[[ "$CONFIRM_RESTORE_DATABASE" == "$RESTORE_DATABASE" ]] || \
  die 'database confirmation mismatch'
[[ "$CONFIRM_RESTORE_ACTION" == "RESTORE $RESTORE_DATABASE" ]] || \
  die 'restore action confirmation mismatch'

: "${SQL_ARCHIVE:?SQL_ARCHIVE is required}"
: "${AVATAR_ARCHIVE:?AVATAR_ARCHIVE is required}"
: "${MANIFEST_FILE:?MANIFEST_FILE is required}"
: "${CHECKSUM_FILE:?CHECKSUM_FILE is required}"
: "${RESTORE_AVATAR_PARENT:?RESTORE_AVATAR_PARENT is required}"
: "${RESTORE_AVATAR_ROOT:?RESTORE_AVATAR_ROOT is required}"

validate_limit() {
  local name="$1"
  local value="$2"
  local hard_max="$3"
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || die "invalid $name"
  (( value <= hard_max )) || die "$name exceeds hard limit"
}

max_sql_bytes="${RESTORE_MAX_SQL_BYTES:-1073741824}"
max_sql_expanded_bytes="${RESTORE_MAX_SQL_EXPANDED_BYTES:-4294967296}"
max_avatar_archive_bytes="${RESTORE_MAX_AVATAR_ARCHIVE_BYTES:-268435456}"
max_avatar_entries="${RESTORE_MAX_AVATAR_ENTRIES:-10000}"
max_avatar_file_bytes="${RESTORE_MAX_AVATAR_FILE_BYTES:-8388608}"
max_avatar_total_bytes="${RESTORE_MAX_AVATAR_TOTAL_BYTES:-536870912}"
validate_limit RESTORE_MAX_SQL_BYTES "$max_sql_bytes" 4294967296
validate_limit RESTORE_MAX_SQL_EXPANDED_BYTES "$max_sql_expanded_bytes" 17179869184
validate_limit RESTORE_MAX_AVATAR_ARCHIVE_BYTES "$max_avatar_archive_bytes" 1073741824
validate_limit RESTORE_MAX_AVATAR_ENTRIES "$max_avatar_entries" 100000
validate_limit RESTORE_MAX_AVATAR_FILE_BYTES "$max_avatar_file_bytes" 16777216
validate_limit RESTORE_MAX_AVATAR_TOTAL_BYTES "$max_avatar_total_bytes" 4294967296

snapshot_dir=''
stage=''
restore_parent=''
restore_avatar_root=''
db_created=0
completed=0
restore_lock_dir=''
restore_lock_acquired=0
restore_token=''
ownership_marker='.poker-restore-owner'
create_in_progress=0
pending_signal_status=0

handle_signal() {
  local signal_status="$1"
  if (( ${create_in_progress:-0} == 1 )); then
    if (( ${pending_signal_status:-0} == 0 )); then
      pending_signal_status="$signal_status"
    fi
    return 0
  fi
  exit "$signal_status"
}

cleanup() {
  status=$?
  set +e
  set +u
  if (( completed == 0 )) && [[ -n "${restore_avatar_root:-}" && -n "${restore_token:-}" ]]; then
    marker="$restore_avatar_root/$ownership_marker"
    marker_token=''
    if [[ -d "$restore_avatar_root" && ! -L "$restore_avatar_root" && \
      -f "$marker" && ! -L "$marker" ]]; then
      IFS= read -r marker_token < "$marker" || true
    fi
    if [[ "$marker_token" == "$restore_token" ]]; then
      rm -rf -- "$restore_avatar_root"
      mkdir -m 700 -- "$restore_avatar_root" || \
        printf '%s\n' 'restore cleanup failed: avatar target could not be reset' >&2
    elif [[ ! -e "$restore_avatar_root" && ! -L "$restore_avatar_root" ]]; then
      mkdir -m 700 -- "$restore_avatar_root" || \
        printf '%s\n' 'restore cleanup failed: avatar target could not be recreated' >&2
    fi
  fi
  if (( ${completed:-0} == 0 && ${db_created:-0} == 1 )); then
    MYSQL_PWD="$MYSQL_PASSWORD" mysql \
      --host="$MYSQL_HOST" --port="$MYSQL_PORT" --user="$MYSQL_USER" \
      --execute="DROP DATABASE IF EXISTS \`$RESTORE_DATABASE\`" >/dev/null 2>&1 || \
      printf '%s\n' 'restore cleanup failed: new database could not be dropped' >&2
  fi
  if [[ -n "$stage" && -d "$stage" ]]; then rm -rf -- "$stage"; fi
  if [[ -n "$snapshot_dir" && -d "$snapshot_dir" ]]; then rm -rf -- "$snapshot_dir"; fi
  if (( ${restore_lock_acquired:-0} == 1 )) && [[ -n "${restore_lock_dir:-}" ]]; then
    rm -f -- "$restore_lock_dir/target-claim"
    rmdir -- "$restore_lock_dir" || \
      printf '%s\n' 'restore cleanup failed: restore lock could not be removed' >&2
  fi
  return "$status"
}
trap cleanup EXIT
trap 'handle_signal 129' HUP
trap 'handle_signal 130' INT
trap 'handle_signal 143' TERM

input_dir="$(cd -- "$(dirname -- "$SQL_ARCHIVE")" && pwd -P)"
for file in "$AVATAR_ARCHIVE" "$MANIFEST_FILE" "$CHECKSUM_FILE"; do
  file_dir="$(cd -- "$(dirname -- "$file")" && pwd -P)"
  [[ "$file_dir" == "$input_dir" ]] || die 'restore files must share one controlled directory'
done

sql_name="$(basename -- "$SQL_ARCHIVE")"
[[ "$sql_name" =~ ^mysql-([0-9]{8}T[0-9]{6}Z)\.sql\.gz$ ]] || die 'invalid SQL archive name'
stamp="${BASH_REMATCH[1]}"
avatar_name="avatars-${stamp}.tar.gz"
manifest_name="manifest-${stamp}.txt"
checksum_name="checksums-${stamp}.txt"
[[ "$(basename -- "$AVATAR_ARCHIVE")" == "$avatar_name" ]] || die 'backup stamp mismatch'
[[ "$(basename -- "$MANIFEST_FILE")" == "$manifest_name" ]] || die 'backup stamp mismatch'
[[ "$(basename -- "$CHECKSUM_FILE")" == "$checksum_name" ]] || die 'backup stamp mismatch'

[[ -d "$RESTORE_AVATAR_PARENT" && ! -L "$RESTORE_AVATAR_PARENT" ]] || \
  die 'avatar restore parent must be a real directory'
restore_parent="$(cd -- "$RESTORE_AVATAR_PARENT" && pwd -P)"
[[ "$restore_parent" != / ]] || die 'avatar restore parent must not be filesystem root'

node_binary="${NODE_BINARY:-node}"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
restore_input_guard="${RESTORE_INPUT_GUARD:-$script_dir/restore-input-guard.mjs}"
[[ -f "$restore_input_guard" && ! -L "$restore_input_guard" ]] || \
  die 'restore input guard is unavailable'

restore_lock_dir="$restore_parent/.restore.lock"
mkdir -- "$restore_lock_dir" 2>/dev/null || die 'another restore is already running'
restore_lock_acquired=1
restore_token="${stamp}-$$-${RANDOM}-${RANDOM}"
printf '%s\n' "$restore_token" > "$restore_lock_dir/target-claim"

# Snapshot all inputs immediately; validation and import never reopen the originals.
snapshot_dir="$(mktemp -d "$restore_parent/.restore-input-${stamp}.XXXXXX")"
"$node_binary" "$restore_input_guard" snapshot \
  "$SQL_ARCHIVE" "$snapshot_dir/$sql_name" "$max_sql_bytes" || die 'SQL snapshot failed'
"$node_binary" "$restore_input_guard" snapshot \
  "$AVATAR_ARCHIVE" "$snapshot_dir/$avatar_name" "$max_avatar_archive_bytes" || \
  die 'avatar snapshot failed'
"$node_binary" "$restore_input_guard" snapshot \
  "$MANIFEST_FILE" "$snapshot_dir/$manifest_name" 65536 || die 'manifest snapshot failed'
"$node_binary" "$restore_input_guard" snapshot \
  "$CHECKSUM_FILE" "$snapshot_dir/$checksum_name" 65536 || die 'checksum snapshot failed'
SQL_ARCHIVE="$snapshot_dir/$sql_name"
AVATAR_ARCHIVE="$snapshot_dir/$avatar_name"
MANIFEST_FILE="$snapshot_dir/$manifest_name"
CHECKSUM_FILE="$snapshot_dir/$checksum_name"

mapfile -t checksum_lines < "$CHECKSUM_FILE"
[[ "${#checksum_lines[@]}" -eq 3 ]] || die 'invalid checksum manifest'
for required in "$sql_name" "$avatar_name" "$manifest_name"; do
  matches=0
  for line in "${checksum_lines[@]}"; do
    digest="${line:0:64}"
    separator="${line:64:2}"
    filename="${line:66}"
    if [[ "$digest" =~ ^[0-9a-fA-F]{64}$ && "$separator" == '  ' && "$filename" == "$required" ]]; then
      matches=$((matches + 1))
    fi
  done
  [[ "$matches" -eq 1 ]] || die 'invalid checksum manifest'
done
(
  cd -- "$snapshot_dir"
  sha256sum -c "$checksum_name"
) || die 'checksum verification failed'

declare -A manifest_values=()
manifest_lines=0
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ "$line" =~ ^([a-z_]+)=(.*)$ ]] || die 'invalid backup manifest'
  key="${BASH_REMATCH[1]}"
  value="${BASH_REMATCH[2]}"
  case "$key" in
    format_version|stamp|database|avatar_directory) ;;
    *) die 'unknown backup manifest field' ;;
  esac
  [[ ! -v "manifest_values[$key]" ]] || die 'duplicate backup manifest field'
  manifest_values["$key"]="$value"
  manifest_lines=$((manifest_lines + 1))
done < "$MANIFEST_FILE"
[[ "$manifest_lines" -eq 4 ]] || die 'incomplete backup manifest'
[[ "${manifest_values[format_version]:-}" == 1 ]] || die 'unsupported backup format'
[[ "${manifest_values[stamp]:-}" == "$stamp" ]] || die 'manifest stamp mismatch'
[[ "${manifest_values[database]:-}" =~ ^[a-z][a-z0-9_]{2,63}$ ]] || die 'invalid backup manifest'
[[ "${manifest_values[avatar_directory]:-}" == avatars ]] || die 'invalid avatar manifest root'
gzip -dc "$SQL_ARCHIVE" | \
  "$node_binary" "$restore_input_guard" limit-stream "$max_sql_expanded_bytes" \
  >/dev/null || die 'invalid or over-expanded SQL gzip stream'

target_parent="$(cd -- "$(dirname -- "$RESTORE_AVATAR_ROOT")" && pwd -P)"
target_base="$(basename -- "$RESTORE_AVATAR_ROOT")"
[[ "$target_parent" == "$restore_parent" ]] || die 'avatar restore target must be a direct child of parent'
[[ "$target_base" =~ ^[a-z][a-z0-9_-]{0,63}$ ]] || die 'invalid avatar restore target name'
[[ ! -L "$RESTORE_AVATAR_ROOT" ]] || die 'avatar restore target must not be a symlink'
mkdir -p -- "$RESTORE_AVATAR_ROOT"
restore_avatar_root="$(cd -- "$RESTORE_AVATAR_ROOT" && pwd -P)"
[[ "$restore_avatar_root" == "$restore_parent/$target_base" ]] || die 'invalid avatar restore target'
[[ -z "$(find "$restore_avatar_root" -mindepth 1 -print -quit)" ]] || \
  die 'avatar restore directory is not empty'

stage="$(mktemp -d "$restore_parent/.avatar-restore-${stamp}.XXXXXX")"
archive_file_count="$("$node_binary" "$restore_input_guard" validate-avatar-tar \
  "$AVATAR_ARCHIVE" "$max_avatar_entries" "$max_avatar_file_bytes" \
  "$max_avatar_total_bytes" 160)" || die 'avatar archive validation failed'
[[ "$archive_file_count" =~ ^[0-9]+$ ]] || die 'invalid avatar archive validation result'

tar -C "$stage" --strip-components=1 --no-same-owner --no-same-permissions \
  -xzf "$AVATAR_ARCHIVE" || die 'cannot extract avatar archive'
[[ -z "$(find "$stage" -type l -print -quit)" ]] || die 'avatar archive extracted a symlink'
[[ -z "$(find "$stage" -mindepth 1 ! -type f -print -quit)" ]] || \
  die 'avatar archive extracted a directory or special file'
extracted_count=0
while IFS= read -r -d '' file; do
  name="${file##*/}"
  [[ "$name" =~ ^[a-z0-9]{3,30}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$ ]] || \
    die 'extracted avatar has an uncontrolled filename'
  extracted_count=$((extracted_count + 1))
done < <(find "$stage" -mindepth 1 -maxdepth 1 -type f -print0)
(( extracted_count == archive_file_count )) || die 'avatar extraction count mismatch'
printf '%s\n' "$restore_token" > "$stage/$ownership_marker"

existing="$(MYSQL_PWD="$MYSQL_PASSWORD" mysql \
  --host="$MYSQL_HOST" --port="$MYSQL_PORT" --user="$MYSQL_USER" \
  --batch --skip-column-names \
  --execute="SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = '$RESTORE_DATABASE'")"
[[ -z "$existing" ]] || die 'restore database already exists'
create_in_progress=1
(
  trap '' HUP INT TERM
  export MYSQL_PWD="$MYSQL_PASSWORD"
  exec mysql \
    --host="$MYSQL_HOST" --port="$MYSQL_PORT" --user="$MYSQL_USER" \
    --execute="CREATE DATABASE \`$RESTORE_DATABASE\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
) &
create_pid=$!
while true; do
  if wait "$create_pid"; then
    create_status=0
  else
    create_status=$?
  fi
  if (( pending_signal_status != 0 && create_status >= 128 )); then
    continue
  fi
  break
done
if (( create_status != 0 )); then
  create_in_progress=0
  if (( pending_signal_status != 0 )); then exit "$pending_signal_status"; fi
  exit "$create_status"
fi
db_created=1
create_in_progress=0
if (( pending_signal_status != 0 )); then exit "$pending_signal_status"; fi
gzip -dc "$SQL_ARCHIVE" | \
  "$node_binary" "$restore_input_guard" limit-stream "$max_sql_expanded_bytes" | \
  MYSQL_PWD="$MYSQL_PASSWORD" mysql \
  --host="$MYSQL_HOST" --port="$MYSQL_PORT" --user="$MYSQL_USER" "$RESTORE_DATABASE"

[[ -d "$restore_avatar_root" && ! -L "$restore_avatar_root" ]] || \
  die 'avatar restore target changed before publication'
[[ -z "$(find "$restore_avatar_root" -mindepth 1 -print -quit)" ]] || \
  die 'avatar restore directory changed before publication'
rmdir -- "$restore_avatar_root"
mv -- "$stage" "$restore_avatar_root"
stage=''
printf 'restore complete: %s into %s\n' "$stamp" "$RESTORE_DATABASE"
completed=1
