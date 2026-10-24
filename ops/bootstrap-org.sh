#!/usr/bin/env bash
# Creates a customer organization and its first administrator.
#   ./ops/bootstrap-org.sh "Organization name" admin@email.com "Admin full name" FIREBASE_USER_UID
# (the admin must already exist in Firebase: Authentication > Users; the UID is in the "User UID" column)
set -euo pipefail
[ $# -eq 4 ] || { echo "usage: $0 \"Organization name\" admin@email.com \"Full name\" FIREBASE_USER_UID" >&2; exit 1; }
cd "$(dirname "$0")/.."
COMPOSE="${COMPOSE_CMD:-docker compose --env-file .env.production -f docker-compose.prod.yml}"

$COMPOSE exec -T api node --disable-warning=ExperimentalWarning scripts/bootstrap-org.ts --org "$1" --email "$2" --name "$3" --uid "$4" \
  | $COMPOSE exec -T postgres psql -U postgres -d mthse -v ON_ERROR_STOP=1
echo "organization created"
