#!/bin/sh
# Cold backup and restore, proven (K15): a populated data directory is written by the real app (the browser-check
# fixture server: real database, migrations, login; synthetic catalog and prices, no network), copied while the app is
# stopped, and a fresh instance on the copy must show the same wishes, prices and settings and accept the same passphrase.
# Steps and the Unraid variant: docs/operations.md, "Kaltbackup und Wiederherstellung". Needs the fixture binary
# (cargo build --examples, done by deploy/check.sh) and curl.
set -eu
cd "$(dirname "$0")/.."
bin=work/check/target/debug/examples/catalog_fixture
[ -x "$bin" ] || { echo "Missing $bin: run deploy/check.sh first." >&2; exit 1; }
mkdir -p work/check
host=127.0.0.1
port=${KEYHUNTER_TEST_PORT:-38871}
root=$(mktemp -d "$PWD/work/check/restore.XXXXXXXX")
password='cold backup passphrase only'
pid=
stop() {
  if [ -n "$pid" ]; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  pid=
}
trap 'stop; rm -rf "$root"' EXIT
fail() { echo "FAILED: $1" >&2; exit 1; }
# start <port> <data dir> <prices 0|1>
start() {
  KEYHUNTER_BIND=$host:$1 KEYHUNTER_DATA_DIR=$2 KEYHUNTER_FIXTURE_PRICES=$3 KEYHUNTER_FRONTEND_DIR=frontend/dist "$bin" >"$root/server.log" 2>&1 &
  pid=$!
  attempt=0
  until curl --silent --fail "http://$host:$1/health/ready" >/dev/null; do
    attempt=$((attempt + 1))
    kill -0 "$pid" || fail "the server stopped: $(cat "$root/server.log")"
    [ "$attempt" -lt 50 ] || fail 'the server did not become ready'
    sleep 0.2
  done
}
# api <port> <method> <path> [json body]: the answer on stdout; the session cookie in $root/cookies, the token in $root/csrf.
api() {
  csrf=$(cat "$root/csrf" 2>/dev/null || true)
  curl --silent --show-error --max-time 20 -X "$2" "http://$host:$1/api/v1$3" -H "Origin: http://$host:$1" \
    -H 'Content-Type: application/json' -H "X-CSRF-Token: $csrf" -b "$root/cookies" -c "$root/cookies" ${4:+--data "$4"}
}
session_token() { sed 's/.*"csrf_token":"\([^"]*\)".*/\1/'; }

# 1. The first instance: set up (target country Austria), add a catalog wish and a manual one.
mkdir "$root/data"
start "$port" "$root/data" 1
token=$(cat "$root/data/bootstrap-token")
api "$port" POST /setup "{\"token\":\"$token\",\"password\":\"$password\",\"target_country\":\"AT\"}" | session_token >"$root/csrf"
api "$port" POST /wishlist '{"igdb_id":1002,"platform_id":169}' >/dev/null
api "$port" POST /wishlist '{"manual_title":"Handgeschriebener Wunsch","platform_id":12}' >/dev/null
api "$port" GET /wishlist >"$root/wishlist.before"
api "$port" GET /wishlist/price-badges >"$root/badges.before"
api "$port" GET /settings >"$root/settings.before"
grep -q 'Handgeschriebener Wunsch' "$root/wishlist.before" || fail 'the first instance lost a wish'
grep -q '"target_country":"AT"' "$root/settings.before" || fail 'the target country was not saved'
[ "$(grep -o '"game_id":' "$root/wishlist.before" | wc -l)" -gt 2 ] || fail 'the seeded wishes are missing'

# 2. Cold backup: stop the app, copy the whole data directory (database with WAL and SHM, token files, backups).
stop
cp -a "$root/data" "$root/cold-copy"
rm -f "$root/cookies" "$root/csrf"

# 3. Restore: a fresh instance on the copy (the first one is gone), no seeding.
start "$((port + 1))" "$root/cold-copy" 0
p=$((port + 1))
[ "$(api "$p" GET /setup)" = '{"required":false}' ] || fail 'the restored instance asks for a new setup'
code=$(curl --silent --output /dev/null --write-out '%{http_code}' -X POST "http://$host:$p/api/v1/session" -H "Origin: http://$host:$p" \
  -H 'Content-Type: application/json' --data '{"password":"wrong passphrase entirely"}')
[ "$code" = 401 ] || fail "a wrong passphrase answered $code, not 401"
api "$p" POST /session "{\"password\":\"$password\"}" | session_token >"$root/csrf"
[ -s "$root/csrf" ] || fail 'the passphrase from before the backup does not log in'
api "$p" GET /wishlist >"$root/wishlist.after"
api "$p" GET /wishlist/price-badges >"$root/badges.after"
api "$p" GET /settings >"$root/settings.after"
cmp -s "$root/wishlist.before" "$root/wishlist.after" || fail 'the wishlist differs after the restore'
cmp -s "$root/badges.before" "$root/badges.after" || fail 'the prices differ after the restore'
cmp -s "$root/settings.before" "$root/settings.after" || fail 'the settings differ after the restore'
stop
echo "OK: the cold backup restored $(grep -o '"game_id":' "$root/wishlist.after" | wc -l) wishes with prices, the settings and the login."
