#!/bin/sh
set -eu

fail() {
    printf 'KEYHUNTER: %s\n' "$1" >&2
    exit 1
}

run_unprivileged() {
    exec setpriv --reuid=10001 --regid=10001 --clear-groups --no-new-privs \
        --inh-caps=-all --ambient-caps=-all --bounding-set=-all "$@"
}

if [ "${1:-}" = "--healthcheck" ]; then
    set -- curl --fail --silent --output /dev/null http://127.0.0.1:3000/health/ready
    if [ "$(id -u)" = 0 ]; then
        run_unprivileged "$@"
    fi
    exec "$@"
fi

if [ "${1:-}" != "--init-unraid-data" ]; then
    [ "$(id -u)" != 0 ] || fail 'refusing to run the web app as root'
    exec /app/keyhunter "$@"
fi
shift

[ "$(id -u)" = 0 ] || fail 'data initialization requires the current Unraid template'
[ "${KEYHUNTER_DATA_DIR:-/data}" = /data ] || fail 'Unraid data initialization requires KEYHUNTER_DATA_DIR=/data'
[ ! -L /data ] && mountpoint -q /data || fail 'attach a dedicated writable mount at /data'

files='keyhunter.db keyhunter.db-wal keyhunter.db-shm keyhunter.db-journal bootstrap-token igdb-credentials.json'
for name in $files; do
    file="/data/$name"
    [ ! -L "$file" ] || fail "cannot initialize a symbolic link: $name"
    [ -e "$file" ] || continue
    [ -f "$file" ] && [ "$(stat -c %h -- "$file")" = 1 ] || fail "expected a regular, singly linked file: $name"
done

chmod u+rwx,go-w -- /data || fail 'cannot set owner permissions on /data; check the data mount and template'
for name in $files; do
    file="/data/$name"
    [ -f "$file" ] || continue
    chmod 0600 -- "$file" && chown -h 10001:10001 -- "$file" || fail "cannot prepare $name"
done
chown 10001:10001 -- /data || fail 'cannot set ownership on /data; check the data mount and template'

run_unprivileged /app/keyhunter "$@"
