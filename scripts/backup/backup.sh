#!/usr/bin/env bash
set -euo pipefail

: "${BACKUP_DIR:?BACKUP_DIR is required}"
: "${AVATAR_ROOT:?AVATAR_ROOT is required}"
: "${MYSQL_HOST:?MYSQL_HOST is required}"
: "${MYSQL_PORT:?MYSQL_PORT is required}"
: "${MYSQL_USER:?MYSQL_USER is required}"
: "${MYSQL_PASSWORD:?MYSQL_PASSWORD is required}"
: "${MYSQL_DATABASE:?MYSQL_DATABASE is required}"

die() {
  printf '%s\n' "$1" >&2
  exit 2
}

[[ "$MYSQL_PORT" =~ ^[0-9]{1,5}$ ]] || die 'invalid mysql port'
(( MYSQL_PORT >= 1 && MYSQL_PORT <= 65535 )) || die 'invalid mysql port'
[[ "$MYSQL_DATABASE" =~ ^[a-z][a-z0-9_]{2,63}$ ]] || die 'invalid database name'
[[ ! -L "$BACKUP_DIR" ]] || die 'backup directory must not be a symlink'
mkdir -p -- "$BACKUP_DIR"
backup_dir="$(cd -- "$BACKUP_DIR" && pwd -P)"
[[ "$backup_dir" != / ]] || die 'backup directory must not be filesystem root'
[[ -d "$AVATAR_ROOT" && ! -L "$AVATAR_ROOT" ]] || die 'avatar root must be a real directory'
avatar_root="$(cd -- "$AVATAR_ROOT" && pwd -P)"
[[ "$avatar_root" != / ]] || die 'avatar root must not be filesystem root'

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
[[ "$stamp" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || die 'invalid backup timestamp'
mysql_name="mysql-${stamp}.sql.gz"
avatar_name="avatars-${stamp}.tar.gz"
manifest_name="manifest-${stamp}.txt"
checksum_name="checksums-${stamp}.txt"
stage="$(mktemp -d "$backup_dir/.backup-${stamp}.XXXXXX")"
published=0

cleanup() {
  status=$?
  set +e
  rm -rf -- "$stage"
  if (( status != 0 && published == 0 )); then
    rm -f -- \
      "$backup_dir/$mysql_name" \
      "$backup_dir/$avatar_name" \
      "$backup_dir/$manifest_name" \
      "$backup_dir/$checksum_name" \
      "$backup_dir/.latest-stamp-${stamp}.tmp"
  fi
  return "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

MYSQL_PWD="$MYSQL_PASSWORD" mysqldump \
  --single-transaction \
  --quick \
  --skip-lock-tables \
  --no-tablespaces \
  --default-character-set=utf8mb4 \
  --host="$MYSQL_HOST" \
  --port="$MYSQL_PORT" \
  --user="$MYSQL_USER" \
  "$MYSQL_DATABASE" | gzip > "$stage/$mysql_name"

avatar_parent="${avatar_root%/*}"
avatar_base="${avatar_root##*/}"
[[ -n "$avatar_parent" && -n "$avatar_base" ]] || die 'invalid avatar root'
tar -C "$avatar_parent" -czf "$stage/$avatar_name" "$avatar_base"

{
  printf 'stamp=%s\n' "$stamp"
  printf 'database=%s\n' "$MYSQL_DATABASE"
  printf 'avatar_directory=%s\n' "$avatar_base"
  printf 'format_version=1\n'
} > "$stage/$manifest_name"

(
  cd -- "$stage"
  sha256sum "$mysql_name" "$avatar_name" "$manifest_name" > "$checksum_name"
)

for name in "$mysql_name" "$avatar_name" "$manifest_name" "$checksum_name"; do
  [[ ! -e "$backup_dir/$name" ]] || die 'backup timestamp collision'
done
mv -- "$stage/$mysql_name" "$backup_dir/$mysql_name"
mv -- "$stage/$avatar_name" "$backup_dir/$avatar_name"
mv -- "$stage/$manifest_name" "$backup_dir/$manifest_name"
# The checksum is published last; its presence marks the set as complete.
mv -- "$stage/$checksum_name" "$backup_dir/$checksum_name"
printf '%s\n' "$stamp" > "$backup_dir/.latest-stamp-${stamp}.tmp"
mv -f -- "$backup_dir/.latest-stamp-${stamp}.tmp" "$backup_dir/latest-stamp"
published=1

find "$backup_dir" -maxdepth 1 -type f \( \
  -name 'mysql-????????T??????Z.sql.gz' -o \
  -name 'avatars-????????T??????Z.tar.gz' -o \
  -name 'manifest-????????T??????Z.txt' -o \
  -name 'checksums-????????T??????Z.txt' \
\) -mtime +14 -exec rm -f -- {} +

printf 'backup complete: %s\n' "$stamp"
