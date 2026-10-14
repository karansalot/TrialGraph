#!/usr/bin/env bash
# Start/stop the project-local PostgreSQL+PostGIS (no Docker). Usage: dev_db.sh start|stop|status|psql
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/.tools/env/bin"; PGDATA="$ROOT/.tools/pgdata"; PORT="${TG_PG_PORT:-5433}"
case "${1:-start}" in
  start)
    if [ ! -d "$PGDATA" ]; then
      "$BIN/initdb" -D "$PGDATA" -U postgres --auth=trust -E UTF8 >/dev/null
    fi
    "$BIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1 || \
      "$BIN/pg_ctl" -D "$PGDATA" -l "$ROOT/.tools/pg.log" -o "-p $PORT -c listen_addresses=localhost" -w start >/dev/null
    "$BIN/psql" -p "$PORT" -U postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='trialgraph'" | grep -q 1 || \
      "$BIN/psql" -p "$PORT" -U postgres -qc "CREATE ROLE trialgraph LOGIN SUPERUSER PASSWORD 'trialgraph'"
    for db in trialgraph trialgraph_test; do
      "$BIN/psql" -p "$PORT" -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$db'" | grep -q 1 || \
        "$BIN/createdb" -p "$PORT" -U postgres -O trialgraph "$db"
      "$BIN/psql" -p "$PORT" -U postgres -d "$db" -qc "CREATE EXTENSION IF NOT EXISTS postgis" 
    done
    echo "postgres up on localhost:$PORT" ;;
  stop) "$BIN/pg_ctl" -D "$PGDATA" -m fast stop ;;
  status) "$BIN/pg_ctl" -D "$PGDATA" status ;;
  psql) shift; exec "$BIN/psql" -p "$PORT" -U trialgraph -d trialgraph "$@" ;;
esac
