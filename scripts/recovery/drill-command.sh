#!/bin/sh
. /tools/common.sh
case "${1:-}" in
  init) restic init --repository-version 2 --json ;;
  seed)
    source_connection
    for migration in /migrations/*.sql; do sql --file="$migration" >/dev/null; done
    sql --file=/fixtures/seed.sql >/dev/null
    echo RECOVERY_FIXTURE_CREATED
    ;;
  backup) sh /tools/backup.sh ;;
  failed-dump)
    export PATH=/fixtures/failing-bin:$PATH
    sh /tools/backup.sh
    ;;
  snapshots) restic snapshots --json ;;
  check) restic check --read-data ;;
  wrong-key)
    export RESTIC_PASSWORD_FILE=/run/secrets/wrong_password
    sh /tools/restore.sh "${2:-}"
    ;;
  restore) sh /tools/restore.sh "${2:-}" ;;
  inspect-source) source_connection; sql --file=/fixtures/inspect.sql ;;
  inspect-target) target_connection; export PGDATABASE=stakeframe_recovery; sql --file=/fixtures/inspect.sql ;;
  target-empty)
    target_connection
    sql --command="SELECT count(*) FROM pg_database WHERE datname = 'stakeframe_recovery'"
    ;;
  target-passwords)
    target_connection
    sql --command="SELECT count(*) FROM pg_authid WHERE rolname <> current_user AND rolpassword IS NOT NULL"
    ;;
  assert-permissions)
    target_connection
    export PGDATABASE=stakeframe_recovery
    sql --file=/fixtures/assert-permissions.sql >/dev/null
    echo RECOVERY_PERMISSIONS_VERIFIED
    ;;
  assert-encrypted)
    # A fixture marker must not be visible in repository files; integrity and
    # wrong-password checks additionally exercise Restic's authenticated encryption.
    if grep -r -l 'RECOVERY_FIXTURE_PRIVATE_PAYLOAD' /repository >/dev/null; then fail RECOVERY_PLAINTEXT_FOUND; fi
    echo RECOVERY_NO_PLAINTEXT_MARKER
    ;;
  corrupt-repository)
    # Fault injection is confined to this drill's disposable named volume.
    pack=$(find /repository/data -type f | head -n 1)
    [ -n "$pack" ] || fail RECOVERY_PACK_MISSING
    chmod u+w "$pack"
    printf 'CORRUPTED_PACK' | dd of="$pack" bs=1 conv=notrunc 2>/dev/null
    echo RECOVERY_PACK_CORRUPTED
    ;;
  *) fail RECOVERY_COMMAND_REFUSED ;;
esac
