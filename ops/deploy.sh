#!/usr/bin/env bash
# Update the running system to the latest code on GitHub:  ./ops/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env.production ] || { echo "Missing .env.production (copy .env.production.example and edit it)" >&2; exit 1; }
COMPOSE="docker compose --env-file .env.production -f docker-compose.prod.yml"

git pull --ff-only
$COMPOSE up -d --build
docker image prune -f >/dev/null
$COMPOSE ps
echo "Deployed. Check:  curl -s https://\$(grep ^DOMAIN= .env.production | cut -d= -f2)/api/health"
