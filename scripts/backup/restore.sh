#!/usr/bin/env bash
set -euo pipefail

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
: "${RESTORE_AVATAR_ROOT:?RESTORE_AVATAR_ROOT is required}"

for file in "$SQL_ARCHIVE" "$AVATAR_ARCHIVE" "$MANIFEST_FILE" "$CHECKSUM_FILE"; do
  [[ -f "$file" && ! -L "$file" ]] || die 'restore input must be a regular non-symlink file'
done

sql_dir="$(cd -- "$(dirname -- "$SQL_ARCHIVE")" && pwd -P)"
for file in "$AVATAR_ARCHIVE" "$MANIFEST_FILE" "$CHECKSUM_FILE"; do
  file_dir="$(cd -- "$(dirname -- "$file")" && pwd -P)"
  [[ "$file_dir" == "$sql_dir" ]] || die 'restore files must share one controlled directory'
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
  cd -- "$sql_dir"
  sha256sum -c "$checksum_name"
) || die 'checksum verification failed'

grep -Fxq "stamp=$stamp" "$MANIFEST_FILE" || die 'manifest stamp mismatch'
grep -Eq '^database=[a-z][a-z0-9_]{2,63}$' "$MANIFEST_FILE" || die 'invalid backup manifest'

[[ ! -L "$RESTORE_AVATAR_ROOT" ]] || die 'avatar restore target must not be a symlink'
mkdir -p -- "$RESTORE_AVATAR_ROOT"
restore_avatar_root="$(cd -- "$RESTORE_AVATAR_ROOT" && pwd -P)"
[[ "$restore_avatar_root" != / ]] || die 'avatar restore target must not be filesystem root'
[[ -z "$(find "$restore_avatar_root" -mindepth 1 -print -quit)" ]] || \
  die 'avatar restore directory is not empty'
restore_parent="${restore_avatar_root%/*}"
[[ -n "$restore_parent" ]] || die 'invalid avatar restore target'
stage="$(mktemp -d "$restore_parent/.avatar-restore-${stamp}.XXXXXX")"
list_file="$stage/.archive-list"
verbose_file="$stage/.archive-verbose"
db_created=0
target_removed=0

cleanup() {
  status=$?
  set +e
  if (( status != 0 && db_created == 1 )); then
    MYSQL_PWD="$MYSQL_PASSWORD" mysql \
      --host="$MYSQL_HOST" --port="$MYSQL_PORT" --user="$MYSQL_USER" \
      --execute="DROP DATABASE IF EXISTS \`$RESTORE_DATABASE\`"
  fi
  if [[ -n "$stage" ]]; then rm -rf -- "$stage"; fi
  if (( status != 0 && target_removed == 1 )); then mkdir -p -- "$restore_avatar_root"; fi
  return "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

tar -tzf "$AVATAR_ARCHIVE" > "$list_file" || die 'cannot list avatar archive'
while IFS= read -r entry || [[ -n "$entry" ]]; do
  [[ -n "$entry" && "$entry" != /* && "$entry" != *\\* ]] || die 'unsafe avatar archive path'
  case "$entry" in
    avatars|avatars/) continue ;;
    avatars/*) relative="${entry#avatars/}" ;;
    *) die 'avatar archive has an unexpected root' ;;
  esac
  IFS='/' read -r -a components <<< "$relative"
  for component in "${components[@]}"; do
    [[ -n "$component" && "$component" != . && "$component" != .. && "$component" != .* ]] || \
      die 'unsafe avatar archive path'
  done
done < "$list_file"

tar -tvzf "$AVATAR_ARCHIVE" > "$verbose_file" || die 'cannot inspect avatar archive'
awk 'NF > 0 && substr($1,1,1) !~ /^[-d]$/ { exit 1 }' "$verbose_file" || \
  die 'avatar archive contains links or special files'
tar -C "$stage" --strip-components=1 --no-same-owner --no-same-permissions \
  -xzf "$AVATAR_ARCHIVE" || die 'cannot extract avatar archive'
rm -f -- "$list_file" "$verbose_file"
[[ -z "$(find "$stage" -type l -print -quit)" ]] || die 'avatar archive extracted a symlink'
[[ -z "$(find "$stage" ! -type f ! -type d -print -quit)" ]] || \
  die 'avatar archive extracted a special file'

existing="$(MYSQL_PWD="$MYSQL_PASSWORD" mysql \
  --host="$MYSQL_HOST" --port="$MYSQL_PORT" --user="$MYSQL_USER" \
  --batch --skip-column-names \
  --execute="SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = '$RESTORE_DATABASE'")"
[[ -z "$existing" ]] || die 'restore database already exists'

MYSQL_PWD="$MYSQL_PASSWORD" mysql \
  --host="$MYSQL_HOST" --port="$MYSQL_PORT" --user="$MYSQL_USER" \
  --execute="CREATE DATABASE \`$RESTORE_DATABASE\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
db_created=1
gzip -dc "$SQL_ARCHIVE" | MYSQL_PWD="$MYSQL_PASSWORD" mysql \
  --host="$MYSQL_HOST" --port="$MYSQL_PORT" --user="$MYSQL_USER" "$RESTORE_DATABASE"

rmdir -- "$restore_avatar_root"
target_removed=1
mv -- "$stage" "$restore_avatar_root"
stage=''
target_removed=0
db_created=0
printf 'restore complete: %s into %s\n' "$stamp" "$RESTORE_DATABASE"
