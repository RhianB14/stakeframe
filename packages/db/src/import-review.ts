import { createHash } from 'node:crypto';
import { parseCaption, ticketExtractionSchema, type BetInput } from '@stakeframe/shared';
import type { PoolClient } from 'pg';
import type { Database } from './index.js';
import { createInboxStore } from './inbox.js';
import { createAttachmentStore, type ObjectStorage } from './attachments.js';
import { FinanceError } from './finance-core.js';

export async function findDuplicates(
  client: Pick<PoolClient, 'query'>,
  importId: string,
  bet?: Pick<BetInput, 'bookmakerId' | 'reference' | 'stake' | 'odds' | 'placedAt'>,
) {
  const rows = (
    await client.query<{
      bet_id: string;
      reference: string;
      bookmaker_id: string;
      stake: string;
      placed_at: Date;
      image: boolean;
      ref: boolean;
      similar: boolean;
    }>(
      `select b.id as bet_id,b.reference,b.bookmaker_id,b.stake,b.placed_at,
    exists(select 1 from integration.inbox other join integration.inbox current on current.id=$1 where other.sha256=current.sha256 and other.imported_bet_id=b.id) as image,
    ($3::text<>'' and b.bookmaker_id=$2 and lower(trim(b.reference))=lower(trim($3))) as ref,
    (b.bookmaker_id=$2 and b.stake=$4::numeric and b.odds=$5::numeric and (b.placed_at at time zone 'America/Sao_Paulo')::date=($6::timestamptz at time zone 'America/Sao_Paulo')::date) as similar
    from finance.bet b where
    exists(select 1 from integration.inbox other join integration.inbox current on current.id=$1 where other.sha256=current.sha256 and other.imported_bet_id=b.id)
    or ($3::text<>'' and b.bookmaker_id=$2 and lower(trim(b.reference))=lower(trim($3)))
    or (b.bookmaker_id=$2 and b.stake=$4::numeric and b.odds=$5::numeric and (b.placed_at at time zone 'America/Sao_Paulo')::date=($6::timestamptz at time zone 'America/Sao_Paulo')::date)
    order by b.created_at desc limit 101`,
      [
        importId,
        bet?.bookmakerId ?? null,
        bet?.reference ?? '',
        bet?.stake ?? null,
        bet?.odds ?? null,
        bet?.placedAt ?? null,
      ],
    )
  ).rows;
  return rows.map((row) => ({
    betId: row.bet_id,
    reference: row.reference,
    bookmakerId: row.bookmaker_id,
    stake: row.stake,
    placedAt: row.placed_at.toISOString(),
    reasons: [
      ...(row.image ? ['image' as const] : []),
      ...(row.ref ? ['reference' as const] : []),
      ...(row.similar ? ['similar' as const] : []),
    ],
  }));
}
type InboxRow = {
  id: string;
  source_key: string;
  caption: string;
  state: string;
  version: number;
  attempts: number;
  created_at: Date;
  updated_at: Date;
  error_code: string | null;
  imported_bet_id: string | null;
  attachment_id: string;
  attachment_state: string;
  extraction: unknown;
};
const columns = 'i.*,a.state as attachment_state';
function item(row: InboxRow) {
  return {
    id: row.id,
    source: row.source_key.startsWith('web:') ? ('web' as const) : ('telegram' as const),
    caption: row.caption,
    state: row.state,
    version: row.version,
    attempts: row.attempts,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    errorCode: row.error_code,
    betId: row.imported_bet_id,
    imageAvailable: !['deleting', 'deleted'].includes(row.attachment_state),
  };
}
function normalized(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLocaleLowerCase('pt-BR')
    .replace(/\s+/g, ' ');
}
export function createImportService(database: Database, storage?: ObjectStorage) {
  const inbox = createInboxStore(database, undefined, storage);
  const attachments = createAttachmentStore(database, storage);
  return {
    async upload(actor: string, key: string, input: { image: string; caption: string }) {
      const bytes = Buffer.from(input.image, 'base64');
      if (bytes.toString('base64') !== input.image) throw new Error('INVALID_INBOX_IMAGE');
      const requestHash = createHash('sha256')
        .update(bytes)
        .update('\0')
        .update(input.caption)
        .digest('hex');
      const id = await inbox.accept(
        {
          sourceKey: `web:${actor}:${key}`,
          caption: input.caption,
          requestHash,
          metadata: { source: 'web' },
        },
        async () => bytes,
      );
      return { id };
    },
    async list(query: {
      page: number;
      pageSize: number;
      state?: string | undefined;
      betId?: string | undefined;
    }) {
      const rows = await database.pool.query<InboxRow & { total: string }>(
        `select ${columns},count(*) over() as total from integration.inbox i join integration.attachment a on a.id=i.attachment_id where ($1::text is null or i.state=$1) and ($4::uuid is null or i.imported_bet_id=$4) order by i.created_at desc,i.id desc limit $2 offset $3`,
        [
          query.state ?? null,
          query.pageSize,
          (query.page - 1) * query.pageSize,
          query.betId ?? null,
        ],
      );
      const total =
        rows.rows[0]?.total ??
        (
          await database.pool.query<{ total: string }>(
            'select count(*) as total from integration.inbox where ($1::text is null or state=$1) and ($2::uuid is null or imported_bet_id=$2)',
            [query.state ?? null, query.betId ?? null],
          )
        ).rows[0]!.total;
      return {
        items: rows.rows.map(item),
        total: Number(total),
        page: query.page,
        pageSize: query.pageSize,
      };
    },
    async detail(id: string) {
      const client = await database.pool.connect();
      try {
        await client.query('begin isolation level repeatable read read only');
        const row = (
          await client.query<InboxRow>(
            `select ${columns} from integration.inbox i join integration.attachment a on a.id=i.attachment_id where i.id=$1`,
            [id],
          )
        ).rows[0];
        if (!row) throw new FinanceError('NOT_FOUND');
        const labels = parseCaption(row.caption);
        const evidence =
          row.extraction && typeof row.extraction === 'object' && 'extraction' in row.extraction
            ? row.extraction.extraction
            : row.extraction;
        const parsed = ticketExtractionSchema.safeParse(evidence);
        const extraction = parsed.success ? parsed.data : null;
        const aliases = (
          await client.query<{ catalog_id: string; kind: string; label: string }>(
            'select a.catalog_id,a.kind,a.label from finance.catalog_alias a join finance.catalog c on c.id=a.catalog_id where c.active',
          )
        ).rows;
        const match = (kind: string, label: string | null) =>
          label
            ? (aliases.find((a) => a.kind === kind && normalized(a.label) === normalized(label))
                ?.catalog_id ?? null)
            : null;
        const captionBookmakerId = match('bookmaker', labels.bookmaker);
        const extractedBookmakerId = match('bookmaker', extraction?.bookmaker ?? null);
        const duplicates = await findDuplicates(client, id, {
          bookmakerId:
            captionBookmakerId ?? extractedBookmakerId ?? '00000000-0000-0000-0000-000000000000',
          reference: extraction?.reference ?? '',
          stake: '0',
          odds: '1',
          placedAt: new Date(0).toISOString(),
        });
        await client.query('commit');
        return {
          item: item(row),
          extraction,
          labels,
          matches: {
            tipsterId: match('tipster', labels.tipster),
            captionBookmakerId,
            extractedBookmakerId,
            conflict:
              !!labels.bookmaker &&
              !!extraction?.bookmaker &&
              (captionBookmakerId && extractedBookmakerId
                ? captionBookmakerId !== extractedBookmakerId
                : normalized(labels.bookmaker) !== normalized(extraction.bookmaker)),
          },
          duplicates: duplicates.slice(0, 100),
          duplicateCount: duplicates.length,
          automatic: false as const,
          automaticReason: 'LAYOUT_NOT_VALIDATED' as const,
        };
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },
    async image(id: string) {
      const row = (
        await database.pool.query<{ attachment_id: string }>(
          'select attachment_id from integration.inbox where id=$1',
          [id],
        )
      ).rows[0];
      if (!row) throw new FinanceError('NOT_FOUND');
      return attachments.read(row.attachment_id);
    },
  };
}
export type ImportService = ReturnType<typeof createImportService>;
