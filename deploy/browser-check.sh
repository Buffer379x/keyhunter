#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p work/check
data_dir=$(mktemp -d "$PWD/work/check/browser.XXXXXXXX")
port=${KEYHUNTER_TEST_PORT:-38751}
origin=http://localhost:$port
KEYHUNTER_BIND=127.0.0.1:$port KEYHUNTER_ORIGIN="$origin" \
  KEYHUNTER_ALLOW_INSECURE_HTTP=true KEYHUNTER_DATA_DIR="$data_dir" \
  KEYHUNTER_FRONTEND_DIR=frontend/dist work/check/target/debug/examples/catalog_fixture &
pid=$!
trap 'kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true' EXIT
attempt=0
until curl --silent --fail "$origin/health/ready" >/dev/null; do
  attempt=$((attempt+1))
  kill -0 "$pid"
  test "$attempt" -lt 50
  sleep 1
done
cd frontend
KEYHUNTER_E2E_BASE_URL="$origin" KEYHUNTER_TEST_DATA_DIR="$data_dir" npm run test:e2e
