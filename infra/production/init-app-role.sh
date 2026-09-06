#!/bin/sh
set -eu
# Official PostgreSQL entrypoint runs this only when initializing a new data volume.
STAKEFRAME_APP_PASSWORD=$(cat /run/secrets/db_password)
export STAKEFRAME_APP_PASSWORD
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --no-psqlrc --set ON_ERROR_STOP=1 <<'SQL'
\getenv app_password STAKEFRAME_APP_PASSWORD
SELECT format('CREATE ROLE stakeframe_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'app_password') \gexec
ALTER DATABASE stakeframe OWNER TO stakeframe_app;
REVOKE ALL ON DATABASE stakeframe FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SQL
unset STAKEFRAME_APP_PASSWORD
