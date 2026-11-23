#!/bin/sh
# Browser checks: the e2e suite in the host Chromium, then (1.0) a short WebKit run of the responsive checks
# (release094-responsive.spec.ts) in the pinned Playwright image, each against a fresh fixture server.
# Arguments go to the Chromium run. KEYHUNTER_SKIP_WEBKIT=1 skips the WebKit run (for example without Docker).
set -eu
cd "$(dirname "$0")/.."
mkdir -p work/check
host=${KEYHUNTER_TEST_HOST:-127.0.0.1}
unset KEYHUNTER_ORIGIN KEYHUNTER_ALLOW_INSECURE_HTTP
pid=
data_dir=
stop() {
  if [ -n "$pid" ]; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  pid=
}
trap stop EXIT
# start <port>: a fixture server with its own data directory; sets $origin and $data_dir.
start() {
  data_dir=$(mktemp -d "$PWD/work/check/browser.XXXXXXXX")
  origin=http://$host:$1
  KEYHUNTER_BIND=$host:$1 KEYHUNTER_DATA_DIR="$data_dir" \
    KEYHUNTER_FRONTEND_DIR=frontend/dist work/check/target/debug/examples/catalog_fixture &
  pid=$!
  attempt=0
  until curl --silent --fail "$origin/health/ready" >/dev/null; do
    attempt=$((attempt+1))
    kill -0 "$pid"
    test "$attempt" -lt 50
    sleep 1
  done
}
port=${KEYHUNTER_TEST_PORT:-38751}
start "$port"
(cd frontend && KEYHUNTER_E2E_BASE_URL="$origin" KEYHUNTER_TEST_DATA_DIR="$data_dir" npm run test:e2e -- "$@")
stop
if [ "${KEYHUNTER_SKIP_WEBKIT:-}" = 1 ]; then
  echo "WebKit run skipped (KEYHUNTER_SKIP_WEBKIT=1)."
  exit 0
fi
start $((port + 1))
# Same absolute path inside the container, so the bootstrap-token path matches. Host user, so files stay owned by you.
docker run --rm --network host --user "$(id -u):$(id -g)" -e HOME=/tmp -e CI \
  -e KEYHUNTER_E2E_BASE_URL="$origin" -e KEYHUNTER_TEST_DATA_DIR="$data_dir" \
  -v "$PWD":"$PWD" -w "$PWD/frontend" mcr.microsoft.com/playwright:v1.65.1-noble \
  npx playwright test --project=webkit --reporter=line
