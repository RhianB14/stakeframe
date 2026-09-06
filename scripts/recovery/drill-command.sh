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
    [ "$STAKEFRAME_RUNTIME" = recovery-test ] || fail RECOVERY_COMMAND_REFUSED
    # A fixture marker must not be visible in repository files; integrity and
    # wrong-password checks additionally exercise Restic's authenticated encryption.
    if grep -r -l 'RECOVERY_FIXTURE_PRIVATE_PAYLOAD' /repository >/dev/null; then fail RECOVERY_PLAINTEXT_FOUND; fi
    echo RECOVERY_NO_PLAINTEXT_MARKER
    ;;
  corrupt-repository)
    [ "$STAKEFRAME_RUNTIME" = recovery-test ] || fail RECOVERY_COMMAND_REFUSED
    # Fault injection is confined to this drill's disposable named volume.
    pack=$(find /repository/data -type f | head -n 1)
    [ -n "$pack" ] || fail RECOVERY_PACK_MISSING
    chmod u+w "$pack"
    printf 'CORRUPTED_PACK' | dd of="$pack" bs=1 conv=notrunc 2>/dev/null
    echo RECOVERY_PACK_CORRUPTED
    ;;
  r2-assert-encrypted)
    [ "$STAKEFRAME_RUNTIME" = recovery-r2-test ] || fail RECOVERY_COMMAND_REFUSED
    # cat pack returns LoadRaw bytes in pinned Restic 0.19.1, not decrypted blobs.
    restic list packs >/work/packs 2>/work/command-error || fail RECOVERY_R2_READ_FAILED
    [ -s /work/packs ] || fail RECOVERY_PACK_MISSING
    while IFS= read -r pack; do
      snapshot_id "$pack"
      restic cat pack "$pack" >/work/raw-pack 2>/work/command-error || fail RECOVERY_R2_READ_FAILED
      [ "$(sha256sum /work/raw-pack | cut -d ' ' -f 1)" = "$pack" ] || fail RECOVERY_CHECKSUM_FAILED
      if grep -a -q 'RECOVERY_FIXTURE_PRIVATE_PAYLOAD' /work/raw-pack; then fail RECOVERY_PLAINTEXT_FOUND; fi
    done </work/packs
    echo RECOVERY_R2_ENCRYPTED_PACKS_VERIFIED
    ;;
  r2-refuse-other-bucket)
    [ "$STAKEFRAME_RUNTIME" = recovery-r2-test ] || fail RECOVERY_COMMAND_REFUSED
    # Read only; never initialize or write to the attachments bucket.
    if restic -r "s3:$RECOVERY_R2_ENDPOINT/stakeframe-attachments/m0-rehearsals/$RECOVERY_RUN_ID" \
      --no-lock snapshots >/work/probe-result 2>/work/command-error; then fail RECOVERY_R2_SCOPE_TOO_BROAD; fi
    grep -E -q 'Access Denied|AccessDenied|[Ss]tatus[Cc]ode: 403|403 Forbidden' /work/command-error || fail RECOVERY_R2_SCOPE_UNPROVEN
    echo RECOVERY_R2_OTHER_BUCKET_REFUSED
    ;;
  *) fail RECOVERY_COMMAND_REFUSED ;;
esac
