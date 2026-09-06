#!/bin/sh
. /tools/common.sh
snapshot_id "${1:-}"
target_connection

# Never drop, clean or overwrite an existing database. A failed restore is left
# for inspection; its caller must use a newly provisioned target on a later attempt.
occupied=$(sql --command="SELECT count(*) FROM pg_database WHERE datname = 'stakeframe_recovery'" 2>/work/command-error) || fail RECOVERY_TARGET_UNAVAILABLE
[ "$occupied" = 0 ] || fail RECOVERY_TARGET_OCCUPIED
restic check --read-data >/work/check-result 2>/work/command-error || fail RECOVERY_REPOSITORY_INVALID
mkdir /work/restore
restic restore "$1" --target /work/restore --verify \
  >/work/restore-result 2>/work/command-error || fail RECOVERY_DECRYPT_FAILED
cd /work/restore
sha256sum -c SHA256SUMS >/work/hash-result 2>/work/command-error || fail RECOVERY_CHECKSUM_FAILED
pg_restore --list database.dump >/dev/null 2>/work/command-error || fail RECOVERY_ARCHIVE_INVALID
manifest_valid=$(sql --set=manifest="$(cat manifest.json)" 2>/work/command-error <<'SQL'
SELECT (:'manifest'::json->>'formatVersion' = '1'
  AND :'manifest'::json->>'database' = 'stakeframe_recovery'
  AND (:'manifest'::json->>'serverVersion')::integer BETWEEN 180000 AND 189999)::text;
SQL
) || fail RECOVERY_MANIFEST_INVALID
[ "$manifest_valid" = true ] || fail RECOVERY_MANIFEST_INVALID

# PostgreSQL 18 preserves membership grantors. Both clusters therefore use the
# same bootstrap role name, with distinct generated passwords. Remove only that
# exact CREATE statement; replay all attributes and grants without password hashes.
[ "$(grep -c '^CREATE ROLE stk_recovery_admin;$' roles.sql)" = 1 ] || fail RECOVERY_BOOTSTRAP_ROLE_MISMATCH
sed '/^CREATE ROLE stk_recovery_admin;$/d' roles.sql >roles.restore.sql
sql --single-transaction --file=roles.restore.sql >/work/roles-result 2>/work/command-error || fail RECOVERY_ROLES_RESTORE_FAILED
sql --command="CREATE DATABASE stakeframe_recovery OWNER stk_recovery_admin TEMPLATE template0" \
  >/work/database-result 2>/work/command-error || fail RECOVERY_DATABASE_CREATE_FAILED
export PGDATABASE=stakeframe_recovery
pg_restore --no-password --exit-on-error --single-transaction --dbname=stakeframe_recovery database.dump \
  >/work/database-result 2>/work/command-error || fail RECOVERY_DATABASE_RESTORE_FAILED
echo RECOVERY_RESTORED
