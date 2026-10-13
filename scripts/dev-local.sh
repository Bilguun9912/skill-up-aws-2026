#!/usr/bin/env bash
# Run the whole app locally (docs/local-dev.md).
#
#   ./scripts/dev-local.sh          # fake Bedrock: canned answers + sample citations, no AWS needed
#   ./scripts/dev-local.sh --real   # real Bedrock with your AWS credentials (needs MODEL_ID; KNOWLEDGE_BASE_ID optional)
#
# Starts DynamoDB Local (docker), the local api server (:3001) and the Vite dev server (:5173).
# Ctrl-C stops the api + Vite; DynamoDB Local keeps running (data persists). Stop it with:
#   docker compose -f docker-compose.local.yml down
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODE=fake
for arg in "$@"; do
  case "$arg" in
    --real) MODE=real ;;
    --fake) MODE=fake ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 1 ;;
  esac
done

if [ "$MODE" = real ] && [ -z "${MODEL_ID:-}" ]; then
  echo "--real needs MODEL_ID, e.g.:  MODEL_ID=<inference-profile-id> ./scripts/dev-local.sh --real" >&2
  exit 1
fi

for port in 3001 5173; do
  if lsof -ti "tcp:$port" >/dev/null 2>&1; then
    echo "Port $port is already in use (another dev server?). Stop it first." >&2
    exit 1
  fi
done

for pkg in backend frontend; do
  [ -d "$ROOT/$pkg/node_modules" ] || { echo "Installing $pkg dependencies…"; (cd "$ROOT/$pkg" && npm ci); }
done

echo "Starting DynamoDB Local…"
docker compose -f "$ROOT/docker-compose.local.yml" up -d

pids=()
cleanup() {
  trap - INT TERM EXIT
  for pid in "${pids[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

(cd "$ROOT/backend" && BEDROCK_MODE="$MODE" npm run --silent dev:local) &
pids+=($!)
(cd "$ROOT/frontend" && npm run --silent dev:local) &
pids+=($!)

echo
echo "  App:  http://localhost:5173   (signed in automatically as local-user)"
echo "  API:  http://localhost:3001   (bedrock=$MODE)"
echo "  Ctrl-C to stop"
echo
wait
