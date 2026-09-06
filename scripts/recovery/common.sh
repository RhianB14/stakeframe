#!/bin/sh
# These commands only support the isolated recovery drill and its explicit R2 overlay.
set -eu
umask 077
fail() { echo "$1" >&2; exit 1; }
read_r2_secret() {
  secret_value=$(tr -d '\r\n' <"$1") || fail RECOVERY_R2_CREDENTIAL_REFUSED
  [ "${#secret_value}" -eq "$2" ] || fail RECOVERY_R2_CREDENTIAL_REFUSED
  case "$secret_value" in *[!a-f0-9]*) fail RECOVERY_R2_CREDENTIAL_REFUSED ;; esac
  if ! (
    printf '%s' "$secret_value" | cmp -s - "$1" ||
    printf '%s\n' "$secret_value" | cmp -s - "$1" ||
    printf '%s\r\n' "$secret_value" | cmp -s - "$1"
  ); then fail RECOVERY_R2_CREDENTIAL_REFUSED; fi
  printf '%s' "$secret_value"
}
case "${STAKEFRAME_RUNTIME:-}" in
  recovery-test)
    [ "${RESTIC_REPOSITORY:-}" = /repository ] || fail RECOVERY_REPOSITORY_REFUSED
    ;;
  recovery-r2-test)
    endpoint=${RECOVERY_R2_ENDPOINT:-}
    account=${endpoint#https://}
    account=${account%.r2.cloudflarestorage.com}
    [ "${#account}" -eq 32 ] || fail RECOVERY_R2_ENDPOINT_REFUSED
    case "$account" in *[!a-f0-9]*) fail RECOVERY_R2_ENDPOINT_REFUSED ;; esac
    [ "$endpoint" = "https://$account.r2.cloudflarestorage.com" ] || fail RECOVERY_R2_ENDPOINT_REFUSED
    run_id=${RECOVERY_RUN_ID:-}
    run_suffix=${run_id#stk-recovery-}
    [ "${#run_suffix}" -eq 32 ] || fail RECOVERY_PROJECT_REFUSED
    case "$run_suffix" in *[!a-f0-9]*) fail RECOVERY_PROJECT_REFUSED ;; esac
    [ "$run_id" = "stk-recovery-$run_suffix" ] || fail RECOVERY_PROJECT_REFUSED
    [ "${RESTIC_REPOSITORY:-}" = "s3:$RECOVERY_R2_ENDPOINT/stakeframe-backups/m0-rehearsals/$RECOVERY_RUN_ID" ] || fail RECOVERY_REPOSITORY_REFUSED
    AWS_ACCESS_KEY_ID=$(read_r2_secret /run/secrets/r2_access_key_id 32)
    AWS_SECRET_ACCESS_KEY=$(read_r2_secret /run/secrets/r2_secret_access_key 64)
    export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION=auto
    ;;
  *) fail RECOVERY_RUNTIME_REFUSED ;;
esac
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
