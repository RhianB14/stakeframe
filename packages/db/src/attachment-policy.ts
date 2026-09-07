// Shared by live retention and recovery. Unknown/open references always keep the image.
import type { PoolClient } from 'pg';

export const attachmentExpiredSql = `
  exists(select 1 from integration.inbox i where i.attachment_id=a.id)
  and not exists(
    select 1 from integration.inbox i left join finance.bet b on b.id=i.imported_bet_id
    where i.attachment_id=a.id and (
      i.state not in ('discarded','imported') or i.updated_at>now()-interval '30 days'
      or (i.state='imported' and (b.id is null or b.state='open'
        or exists(select 1 from finance.settlement s where s.bet_id=b.id and greatest(s.created_at,s.settled_at)>now()-interval '30 days')
        or exists(select 1 from finance.audit audit where audit.entity_id=b.id::text and audit.created_at>now()-interval '30 days')
      ))
    )
  )`;

// Caller owns the attachment session lock (782341095). Mark before exporting
// recovery metadata so a new reference cannot revive an object whose old copies
// are about to be purged. The worker completes the remote deletion normally.
export async function claimExpiredAttachmentsForBackup(client: PoolClient) {
  try {
    await client.query('begin');
    await client.query('select id from finance.settings where id=1 for update');
    await client.query('select pg_advisory_xact_lock(782341092)');
    await client.query(`with expired as (
      update integration.attachment a set state='deleting',updated_at=now()
      where a.state in ('local','remote') and (${attachmentExpiredSql}) returning a.id
    ) insert into finance.audit(type,actor,entity_id,after)
      select 'attachment.expiry_claimed','system',id::text,
        '{"policy":"30_days_after_all_references_closed","source":"recovery_copy_retention"}'::jsonb from expired`);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}
