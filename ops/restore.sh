#!/usr/bin/env bash
# Restores a backup into a SEPARATE database (default: mthse_restore) so you can inspect it safely.
# Restoring over the live database "mthse" needs the explicit --force flag.
#   ./ops/restore.sh backups/mthse-20261004-020000.sql.gz [database] [--force]
set -euo pipefail
cd "$(dirname "$0")/.."

FILE="${1:?usage: $0 backup.sql.gz [database] [--force]}"
DB="${2:-mthse_restore}"
FORCE="${3:-}"
COMPOSE="${COMPOSE_CMD:-docker compose --env-file .env.production -f docker-compose.prod.yml}"

[ -f "$FILE" ] || { echo "file not found: $FILE" >&2; exit 1; }
gzip -t "$FILE"
if [ "$DB" = "mthse" ] && [ "$FORCE" != "--force" ]; then
  echo "Refusing to overwrite the live database. Restore into another name, or add --force." >&2
  exit 2
fi
case "$DB" in *[!a-zA-Z0-9_]*) echo "invalid database name" >&2; exit 2;; esac

$COMPOSE exec -T postgres psql -U postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $DB"
$COMPOSE exec -T postgres psql -U postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE $DB"
gunzip -c "$FILE" | $COMPOSE exec -T postgres psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -q
echo "restored into database: $DB"
