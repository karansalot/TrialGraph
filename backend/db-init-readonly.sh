#!/bin/sh
# Runs once when the compose database is first created: a least-privilege role for the API.
# The pipeline connects as the owner; the API connects as trialgraph_ro (SELECT only, set by `trialgraph load`).
set -e
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<SQL
CREATE ROLE trialgraph_ro LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${TG_RO_PASSWORD:-trialgraph_ro}';
GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO trialgraph_ro;
SQL
