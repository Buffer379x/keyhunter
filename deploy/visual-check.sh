#!/bin/sh
# Visual regression of the core views. Usage: sh deploy/visual-check.sh [--update]
# The fixture server runs on the host (like browser-check.sh); the Playwright runner runs in the pinned
# official image so fonts and rendering are identical on every machine. --update rewrites the baselines.
set -eu
cd "$(dirname "$0")/.."
image=mcr.microsoft.com/playwright:v1.65.1-noble
update=
case "${1:-}" in
  --update) update=--update-snapshots=all ;; # all, not only those above the threshold (else old pixels survive)
  '') ;;
  *) echo "usage: $0 [--update]" >&2; exit 2 ;;
esac
mkdir -p work/check
data_dir=$(mktemp -d "$PWD/work/check/visual.XXXXXXXX")
port=${KEYHUNTER_TEST_PORT:-38761}
host=127.0.0.1
origin=http://$host:$port
unset KEYHUNTER_ORIGIN KEYHUNTER_ALLOW_INSECURE_HTTP
KEYHUNTER_BIND=$host:$port KEYHUNTER_DATA_DIR="$data_dir" \
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
# Same absolute path inside the container, so the bootstrap-token path matches. Host user, so files stay owned by you.
docker run --rm --network host --user "$(id -u):$(id -g)" -e HOME=/tmp -e CI \
  -e KEYHUNTER_E2E_BASE_URL="$origin" -e KEYHUNTER_TEST_DATA_DIR="$data_dir" \
  -v "$PWD":"$PWD" -w "$PWD/frontend" "$image" \
  npx playwright test --project=visual $update
