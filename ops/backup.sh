#!/usr/bin/env bash
# Daily database backup: compressed dump, integrity check, 14-day retention, optional copy to a remote (rclone).
# A backup that stays on the same server does NOT protect you from losing the server: set RCLONE_REMOTE as well.
set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSE="${COMPOSE_CMD:-docker compose --env-file .env.production -f docker-compose.prod.yml}"
OUT_DIR="${BACKUP_DIR:-./backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
mkdir -p "$OUT_DIR"

STAMP="$(date -u +%Y%m%d-%H%M%S)"
FILE="$OUT_DIR/mthse-$STAMP.sql.gz"
trap 'rm -f "$FILE.partial"' EXIT

# pipefail makes a failing pg_dump fail the whole backup (no silent empty file)
$COMPOSE exec -T postgres pg_dump -U postgres -d mthse --no-owner | gzip > "$FILE.partial"
gzip -t "$FILE.partial"
if [ "$(stat -c %s "$FILE.partial")" -lt 2000 ]; then
  echo "backup is suspiciously small: aborting" >&2
  exit 1
fi
mv "$FILE.partial" "$FILE"
trap - EXIT

# Uploaded files (photos, signatures, PDFs): an archive of the media volume, taken right after the dump.
# (Files are only ever added, never changed, so an archive taken a moment later is consistent with the dump.)
MEDIA_FILE="$OUT_DIR/media-$STAMP.tar.gz"
trap 'rm -f "$FILE.partial" "$MEDIA_FILE.partial"' EXIT
$COMPOSE exec -T api tar -C /data/media -czf - . > "$MEDIA_FILE.partial"
gzip -t "$MEDIA_FILE.partial"
mv "$MEDIA_FILE.partial" "$MEDIA_FILE"
trap - EXIT

find "$OUT_DIR" -maxdepth 1 \( -name 'mthse-*.sql.gz' -o -name 'media-*.tar.gz' \) -mtime +"$KEEP_DAYS" -delete

if [ -n "${RCLONE_REMOTE:-}" ]; then
  rclone copy "$FILE" "$RCLONE_REMOTE"
  rclone copy "$MEDIA_FILE" "$RCLONE_REMOTE"
  echo "copied to $RCLONE_REMOTE"
fi
echo "backup ok: $FILE and $MEDIA_FILE"
