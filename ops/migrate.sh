#!/bin/sh
# Applies db/migrations/*.sql in order, once each, and sets the application role's password.
# Safe to run on every start: finished migrations are skipped (recorded in schema_migrations).
# Uses the standard PG* environment variables (PGHOST, PGUSER, PGPASSWORD, PGDATABASE).
set -eu

DIR="${MIGRATIONS_DIR:-/migrations}"
PSQL="psql -X -q -v ON_ERROR_STOP=1"

$PSQL -c "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"

for f in $(ls "$DIR"/*.sql | sort); do
  name=$(basename "$f")
  applied=$($PSQL -At -c "SELECT 1 FROM schema_migrations WHERE name = '$name'")
  if [ "$applied" = "1" ]; then
    echo "skip   $name"
    continue
  fi
  echo "apply  $name"
  $PSQL -f "$f"
  $PSQL -c "INSERT INTO schema_migrations (name) VALUES ('$name')"
done

if [ -n "${APP_DB_PASSWORD:-}" ]; then
  # the password is passed as a psql variable and quoted by psql itself (never pasted into the SQL text)
  echo "ALTER ROLE app_user LOGIN PASSWORD :'pw';" | $PSQL -v "pw=$APP_DB_PASSWORD"
  echo "app_user password set"
fi
echo "migrations complete"
