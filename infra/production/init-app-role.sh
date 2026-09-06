#!/bin/sh
set -eu
# Official PostgreSQL entrypoint runs this only when initializing a new data volume.
secret_file=/run/secrets/db_password
STAKEFRAME_APP_PASSWORD=$(tr -d '\r\n' < "$secret_file")
case "$STAKEFRAME_APP_PASSWORD" in
  ''|*[!a-f0-9]*) echo 'INVALID_DATABASE_SECRET' >&2; exit 1 ;;
esac
if [ "${#STAKEFRAME_APP_PASSWORD}" -ne 64 ]; then
  echo 'INVALID_DATABASE_SECRET' >&2; exit 1
fi
# Accept exactly the same endings as readSecret(): none, one LF or one CRLF.
# Comparing the original bytes also refuses embedded or repeated line endings.
if ! (
  printf '%s' "$STAKEFRAME_APP_PASSWORD" | cmp -s - "$secret_file" ||
  printf '%s\n' "$STAKEFRAME_APP_PASSWORD" | cmp -s - "$secret_file" ||
  printf '%s\r\n' "$STAKEFRAME_APP_PASSWORD" | cmp -s - "$secret_file"
); then
  echo 'INVALID_DATABASE_SECRET' >&2; exit 1
fi
export STAKEFRAME_APP_PASSWORD
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --no-psqlrc --set ON_ERROR_STOP=1 <<'SQL'
\getenv app_password STAKEFRAME_APP_PASSWORD
SELECT format('CREATE ROLE stakeframe_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'app_password') \gexec
ALTER DATABASE stakeframe OWNER TO stakeframe_app;
REVOKE ALL ON DATABASE stakeframe FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SQL
unset STAKEFRAME_APP_PASSWORD
