#!/bin/sh
. /tools/common.sh
source_connection
mkdir /work/bundle
cd /work/bundle

# All plaintext exists only in this container's private tmpfs. Nothing is published
# unless both PostgreSQL commands and the archive inspection finish successfully.
pg_dump --no-password --format=custom --compress=0 --lock-wait-timeout=5s \
  --file=database.dump 2>/work/command-error || fail RECOVERY_DUMP_FAILED
pg_restore --list database.dump >/dev/null 2>/work/command-error || fail RECOVERY_ARCHIVE_INVALID
pg_dumpall --no-password --roles-only --no-role-passwords \
  --file=roles.sql 2>/work/command-error || fail RECOVERY_ROLES_FAILED
sql --command="SELECT json_build_object('formatVersion', 1, 'serverVersion', current_setting('server_version_num'), 'database', current_database(), 'completedAt', clock_timestamp())" \
  >manifest.json 2>/work/command-error || fail RECOVERY_MANIFEST_FAILED
sha256sum database.dump roles.sql manifest.json >SHA256SUMS
restic backup --json --host recovery-drill --tag postgres-full . \
  2>/work/command-error || fail RECOVERY_BACKUP_FAILED
