#!/bin/sh
# These commands only support the isolated compose.recovery.yml drill.
set -eu
umask 077
[ "${STAKEFRAME_RUNTIME:-}" = recovery-test ] || { echo RECOVERY_RUNTIME_REFUSED >&2; exit 1; }
[ "${RESTIC_REPOSITORY:-}" = /repository ] || { echo RECOVERY_REPOSITORY_REFUSED >&2; exit 1; }

fail() { echo "$1" >&2; exit 1; }
source_connection() {
  export PGHOST=source PGUSER=stk_recovery_admin PGDATABASE=stakeframe_recovery
  PGPASSWORD=$(cat /run/secrets/source_password)
  export PGPASSWORD
}
target_connection() {
  export PGHOST=target PGUSER=stk_recovery_admin PGDATABASE=postgres
  PGPASSWORD=$(cat /run/secrets/target_password)
  export PGPASSWORD
}
sql() { psql -X --no-password --set=ON_ERROR_STOP=1 --tuples-only --no-align "$@"; }
snapshot_id() {
  [ "${#1}" -eq 64 ] || fail RECOVERY_SNAPSHOT_REFUSED
  case "$1" in *[!a-f0-9]*) fail RECOVERY_SNAPSHOT_REFUSED ;; esac
}
