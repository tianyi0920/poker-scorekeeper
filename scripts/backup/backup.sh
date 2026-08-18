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

stage=''
lock_dir="$backup_dir/.backup.lock"
lock_acquired=0
completed=0
published_paths=()

cleanup() {
  status=$?
  set +e
  if [[ -n "$stage" && -d "$stage" ]]; then rm -rf -- "$stage"; fi
  if (( status != 0 && completed == 0 )); then
    for path in "${published_paths[@]}"; do rm -f -- "$path"; done
  fi
  if (( lock_acquired == 1 )); then rmdir -- "$lock_dir"; fi
  return "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -- "$lock_dir" 2>/dev/null || die 'another backup is already running'
lock_acquired=1

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
[[ "$stamp" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || die 'invalid backup timestamp'
mysql_name="mysql-${stamp}.sql.gz"
avatar_name="avatars-${stamp}.tar.gz"
manifest_name="manifest-${stamp}.txt"
checksum_name="checksums-${stamp}.txt"
stage="$(mktemp -d "$backup_dir/.backup-${stamp}.XXXXXX")"

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
avatar_list="$stage/avatar-files.list"
printf '%s/\n' "$avatar_base" > "$avatar_list"
while IFS= read -r -d '' path; do
  name="${path##*/}"
  if [[ "$name" =~ ^[a-z0-9]{3,30}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$ ]]; then
    printf '%s/%s\n' "$avatar_base" "$name" >> "$avatar_list"
  fi
done < <(find "$avatar_root" -mindepth 1 -maxdepth 1 -type f -print0 | sort -z)
tar -C "$avatar_parent" -czf "$stage/$avatar_name" \
  --no-recursion --verbatim-files-from --files-from="$avatar_list"

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

publish_file() {
  name="$1"
  source_path="$stage/$name"
  target_path="$backup_dir/$name"
  [[ ! -e "$target_path" && ! -L "$target_path" ]] || die 'backup timestamp collision'
  mv -n -- "$source_path" "$target_path"
  [[ ! -e "$source_path" && -f "$target_path" ]] || die 'backup publish collision'
  published_paths+=("$target_path")
}

publish_file "$mysql_name"
publish_file "$avatar_name"
publish_file "$manifest_name"
# The checksum is published last; its presence marks the set as complete.
publish_file "$checksum_name"

latest_stamp=''
if [[ -f "$backup_dir/latest-stamp" && ! -L "$backup_dir/latest-stamp" ]]; then
  IFS= read -r latest_stamp < "$backup_dir/latest-stamp" || true
fi
if [[ ! "$latest_stamp" =~ ^[0-9]{8}T[0-9]{6}Z$ || "$stamp" > "$latest_stamp" ]]; then
  printf '%s\n' "$stamp" > "$stage/latest-stamp"
  mv -f -- "$stage/latest-stamp" "$backup_dir/latest-stamp"
fi
completed=1

while IFS= read -r -d '' expired; do
  expired_name="${expired##*/}"
  if [[ "$expired_name" =~ ^(mysql-[0-9]{8}T[0-9]{6}Z\.sql\.gz|avatars-[0-9]{8}T[0-9]{6}Z\.tar\.gz|manifest-[0-9]{8}T[0-9]{6}Z\.txt|checksums-[0-9]{8}T[0-9]{6}Z\.txt)$ ]]; then
    rm -f -- "$expired"
  fi
done < <(find "$backup_dir" -mindepth 1 -maxdepth 1 -type f -mtime +14 -print0)

printf 'backup complete: %s\n' "$stamp"
