import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  primaryKey,
  pgSchema,
  text,
  timestamp,
  uuid,
  uniqueIndex,
  boolean,
  unique,
} from 'drizzle-orm/pg-core';
import { bet, catalog, freebet } from './finance-schema.js';

export const integrationNamespace = pgSchema('integration');
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

/**
 * Multi-tenant isolation (STK-F1-13): private import artifacts carry their organization the same
 * way the financial tables do — DEFAULT from the transaction-local setting, fail-closed without
 * context. `cursor` and `ai_usage_day` stay global infrastructure of the workers.
 */
const organizationId = () =>
  uuid('organization_id')
    .notNull()
    .default(sql`current_setting('app.organization_id', true)::uuid`);

export const attachment = integrationNamespace.table(
  'attachment',
  {
    id: uuid('id').primaryKey(),
    organizationId: organizationId(),
    sha256: text('sha256').notNull(),
    image: bytea('image'),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    width: integer('width'),
    height: integer('height'),
    state: text('state').notNull().default('local'),
    objectKey: text('object_key').notNull().unique(),
    remoteAttempted: boolean('remote_attempted').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('attachment_organization_id_id_idx').on(table.organizationId, table.id),
    uniqueIndex('attachment_live_hash_idx')
      .on(table.organizationId, table.sha256)
      .where(sql`${table.state} not in ('deleting','deleted')`),
    check('attachment_state_check', sql`${table.state} in ('local','remote','deleting','deleted')`),
    check('attachment_size_check', sql`${table.size} between 1 and 8388608`),
  ],
);
export const inbox = integrationNamespace.table(
  'inbox',
  {
    id: uuid('id').primaryKey(),
    organizationId: organizationId(),
    sourceKey: text('source_key').notNull(),
    image: bytea('image'),
    attachmentId: uuid('attachment_id'),
    importedBetId: uuid('imported_bet_id'),
    requestHash: text('request_hash'),
    sha256: text('sha256').notNull(),
    caption: text('caption').notNull(),
    metadata: jsonb('metadata').notNull(),
    state: text('state').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    version: integer('version').notNull().default(1),
    extraction: jsonb('extraction'),
    errorCode: text('error_code'),
    // STK-G0-19-R5: origem financeira declarada pelo usuário (real|freebet) e o
    // crédito escolhido explicitamente; null = ainda não informada (fail-closed).
    betOrigin: text('bet_origin'),
    freebetId: uuid('freebet_id'),
    // Data/hora real do evento, confirmada pelo usuário; o rascunho nasce pendente.
    eventAt: timestamp('event_at', { withTimezone: true }),
    eventDateStatus: text('event_date_status').notNull().default('pending'),
    // Vínculo privado com o Telegram; nunca exposto em logs ou respostas públicas
    // sem necessidade (o proprietário autenticado pode ler a data de recebimento).
    telegramChatId: bigint('telegram_chat_id', { mode: 'number' }),
    telegramSourceMessageId: bigint('telegram_source_message_id', { mode: 'number' }),
    // STK-F2-05: fila de UMA foto por vez e identidade determinística da imagem
    // + contexto. `placedAt` é `telegramReceivedAt` (a MENSAGEM ORIGINAL) e a
    // data do evento é `eventAt`, que nasce pendente e nunca é inferida do envio.
    telegramIdentity: text('telegram_identity'),
    telegramDuplicateOf: uuid('telegram_duplicate_of'),
    telegramQueueState: text('telegram_queue_state').notNull().default('none'),
    telegramQueuedAt: timestamp('telegram_queued_at', { withTimezone: true }),
    telegramAdmittedAt: timestamp('telegram_admitted_at', { withTimezone: true }),
    telegramPreviewAt: timestamp('telegram_preview_at', { withTimezone: true }),
    telegramProcessingMessageId: bigint('telegram_processing_message_id', { mode: 'number' }),
    telegramResultMessageId: bigint('telegram_result_message_id', { mode: 'number' }),
    telegramReceivedAt: timestamp('telegram_received_at', { withTimezone: true }),
    telegramSyncState: text('telegram_sync_state').notNull().default('none'),
    telegramSyncedVersion: integer('telegram_synced_version'),
    telegramEditedAt: timestamp('telegram_edited_at', { withTimezone: true }),
    telegramDeletedAt: timestamp('telegram_deleted_at', { withTimezone: true }),
    // STK-G0-19-R7: casa declarada pelo usuário no rascunho (seção "Alterar
    // Casa" do Mini App); validada sob lock contra o catálogo ativo da
    // organização e sempre revalidada junto do crédito freebet associado.
    bookmakerOverrideId: uuid('bookmaker_override_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('inbox_organization_id_id_idx').on(table.organizationId, table.id),
    // Deduplication is per organization: the same source key may exist once in each tenant.
    uniqueIndex('inbox_organization_id_source_key_idx').on(table.organizationId, table.sourceKey),
    check(
      'inbox_state_check',
      sql`${table.state} in ('pending', 'processing', 'review', 'failed', 'discarded', 'imported')`,
    ),
    check('inbox_image_size_check', sql`octet_length(${table.image}) between 1 and 8388608`),
    check('inbox_attempts_check', sql`${table.attempts} >= 0 and ${table.version} > 0`),
    check(
      'inbox_bet_origin_check',
      sql`${table.betOrigin} is null or ${table.betOrigin} in ('real', 'freebet', 'hibrida')`,
    ),
    check(
      'inbox_event_date_check',
      sql`${table.eventDateStatus} in ('pending', 'confirmed') and (${table.eventDateStatus} = 'pending' or ${table.eventAt} is not null)`,
    ),
    check(
      'inbox_telegram_sync_state_check',
      sql`${table.telegramSyncState} in ('none', 'pending', 'synced', 'failed', 'deleted')`,
    ),
    // STK-F2-05: a fila do worker é serial (uma foto por vez) e a identidade
    // determinística decide duplicata sem depender de timestamp.
    check(
      'inbox_telegram_queue_state_check',
      sql`${table.telegramQueueState} in ('none', 'queued', 'admitted', 'preview', 'duplicate', 'archived')`,
    ),
    check(
      'inbox_telegram_identity_check',
      sql`${table.telegramIdentity} is null or ${table.telegramIdentity} ~ '^[a-f0-9]{64}$'`,
    ),
    index('inbox_telegram_identity_idx')
      .on(table.organizationId, table.telegramIdentity)
      .where(sql`${table.telegramIdentity} is not null`),
    index('inbox_telegram_queue_idx')
      .on(table.telegramQueueState, table.telegramQueuedAt, table.id)
      .where(sql`${table.telegramQueueState} in ('queued','admitted')`),
    index('inbox_telegram_source_idx')
      .on(table.organizationId, table.telegramSourceMessageId)
      .where(sql`${table.telegramSourceMessageId} is not null`),
    index('inbox_telegram_result_idx')
      .on(table.organizationId, table.telegramResultMessageId)
      .where(sql`${table.telegramResultMessageId} is not null`),
    index('inbox_state_created_idx').on(table.state, table.createdAt),
    index('inbox_image_hash_idx').on(table.sha256),
    index('inbox_attachment_idx').on(table.attachmentId),
    index('inbox_imported_bet_idx').on(table.importedBetId),
    foreignKey({
      name: 'inbox_attachment_fk',
      columns: [table.organizationId, table.attachmentId],
      foreignColumns: [attachment.organizationId, attachment.id],
    }),
    foreignKey({
      name: 'inbox_imported_bet_fk',
      columns: [table.organizationId, table.importedBetId],
      foreignColumns: [bet.organizationId, bet.id],
    }),
    foreignKey({
      name: 'inbox_freebet_fk',
      columns: [table.organizationId, table.freebetId],
      foreignColumns: [freebet.organizationId, freebet.id],
    }),
    foreignKey({
      name: 'inbox_bookmaker_override_fk',
      columns: [table.organizationId, table.bookmakerOverrideId],
      foreignColumns: [catalog.organizationId, catalog.id],
    }),
  ],
);
export const telegramOutbox = integrationNamespace.table(
  'telegram_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: organizationId(),
    inboxId: uuid('inbox_id').notNull(),
    operation: text('operation').notNull(),
    version: integer('version').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    state: text('state').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    unique('telegram_outbox_organization_id_id_idx').on(table.organizationId, table.id),
    uniqueIndex('telegram_outbox_idempotency_idx').on(table.organizationId, table.idempotencyKey),
    check(
      'telegram_outbox_operation_check',
      sql`${table.operation} in ('send_processing_message', 'send_result_message', 'edit_result_message', 'delete_processing_message', 'delete_source_message', 'delete_result_message')`,
    ),
    check(
      'telegram_outbox_state_check',
      sql`${table.state} in ('pending', 'processing', 'done', 'failed', 'skipped')`,
    ),
    check('telegram_outbox_attempts_check', sql`${table.attempts} >= 0 and ${table.version} > 0`),
    index('telegram_outbox_due_idx').on(table.state, table.nextAttemptAt),
    index('telegram_outbox_inbox_idx').on(table.organizationId, table.inboxId),
    foreignKey({
      name: 'telegram_outbox_inbox_fk',
      columns: [table.organizationId, table.inboxId],
      foreignColumns: [inbox.organizationId, inbox.id],
    }),
  ],
);
// STK-G0-19-R10 — recibos idempotentes das ações de importação (por
// organização+chave do cliente): hash SHA-256 do pedido, ação declarada e
// resultado sanitizado em jsonb, validado pelo schema da ação no replay.
// RLS habilitada na migração 0013 (isolamento por organização).
export const importActionReceipt = integrationNamespace.table(
  'import_action_receipt',
  {
    organizationId: organizationId(),
    key: uuid('key').notNull(),
    action: text('action').notNull(),
    actor: text('actor').notNull(),
    hash: text('hash').notNull(),
    result: jsonb('result').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'import_action_receipt_pk',
      columns: [table.organizationId, table.key],
    }),
    check(
      'import_action_receipt_action_check',
      sql`${table.action} in ('bookmaker', 'origin', 'event', 'tipster')`,
    ),
    check('import_action_receipt_hash_check', sql`${table.hash} ~ '^[a-f0-9]{64}$'`),
    check('import_action_receipt_actor_check', sql`char_length(${table.actor}) between 1 and 200`),
  ],
);
// STK-F2-05 — arquivo recuperável do bilhete do Telegram. Descartar NÃO apaga:
// a linha continua endereçável por 30 dias e pode ser restaurada nesse período.
// Não existe `/undo` temporizado — a recuperabilidade é uma janela do REGISTRO,
// não um prazo de resposta do bot. RLS fail-closed (migration 0023).
export const telegramTicketArchive = integrationNamespace.table(
  'telegram_ticket_archive',
  {
    id: uuid('id').primaryKey(),
    organizationId: organizationId(),
    inboxId: uuid('inbox_id').notNull(),
    // Identidade determinística (imagem + contexto) do bilhete arquivado.
    identity: text('identity').notNull(),
    reason: text('reason').notNull(),
    state: text('state').notNull().default('archived'),
    archivedAt: timestamp('archived_at', { withTimezone: true }).notNull().defaultNow(),
    // Verdade do prazo de recuperação: a retenção do anexo nunca expira antes.
    recoverableUntil: timestamp('recoverable_until', { withTimezone: true }).notNull(),
    restoredAt: timestamp('restored_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('telegram_ticket_archive_organization_id_id_idx').on(table.organizationId, table.id),
    check('telegram_ticket_archive_identity_check', sql`${table.identity} ~ '^[a-f0-9]{64}$'`),
    check(
      'telegram_ticket_archive_reason_check',
      sql`${table.reason} in ('discarded','duplicate','superseded')`,
    ),
    check(
      'telegram_ticket_archive_state_check',
      sql`${table.state} in ('archived','restored','expired')`,
    ),
    check(
      'telegram_ticket_archive_window_check',
      sql`${table.recoverableUntil} > ${table.archivedAt}`,
    ),
    check(
      'telegram_ticket_archive_restored_check',
      sql`(${table.state} = 'restored') = (${table.restoredAt} is not null)`,
    ),
    // No máximo um arquivo VIVO por bilhete: rearquivar atualiza a linha.
    uniqueIndex('telegram_ticket_archive_live_idx')
      .on(table.organizationId, table.inboxId)
      .where(sql`${table.state} = 'archived'`),
    index('telegram_ticket_archive_identity_idx').on(
      table.organizationId,
      table.identity,
      table.archivedAt,
    ),
    index('telegram_ticket_archive_due_idx')
      .on(table.state, table.recoverableUntil)
      .where(sql`${table.state} = 'archived'`),
    foreignKey({
      name: 'telegram_ticket_archive_inbox_fk',
      columns: [table.organizationId, table.inboxId],
      foreignColumns: [inbox.organizationId, inbox.id],
    }),
  ],
);
export const extractionRequest = integrationNamespace.table(
  'extraction_request',
  {
    id: uuid('id').primaryKey(),
    organizationId: organizationId(),
    inboxId: uuid('inbox_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'extraction_request_inbox_fk',
      columns: [table.organizationId, table.inboxId],
      foreignColumns: [inbox.organizationId, inbox.id],
    }),
  ],
);
export const integrationCursor = integrationNamespace.table('cursor', {
  name: text('name').primaryKey(),
  nextOffset: bigint('next_offset', { mode: 'number' }).notNull().default(0),
});
// STK-F2-09 — o LOTE de importação por arquivo. Uma linha por upload; a
// identidade é `content_sha256` (conteúdo + mapeamento efetivo), então
// reenviar o MESMO arquivo devolve o MESMO lote. As LINHAS do preview e o
// RESULTADO do commit vivem em jsonb, sanitizados: o arquivo em si nunca é
// gravado. RLS fail-closed (migration 0026).
export const importBatch = integrationNamespace.table(
  'import_batch',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: organizationId(),
    version: integer('version').notNull().default(1),
    state: text('state').notNull(),
    origin: text('origin').notNull(),
    filename: text('filename').notNull(),
    contentSha256: text('content_sha256').notNull(),
    mapping: jsonb('mapping'),
    total: integer('total').notNull().default(0),
    valid: integer('valid').notNull().default(0),
    invalid: integer('invalid').notNull().default(0),
    duplicates: integer('duplicates').notNull().default(0),
    // Linhas GRAVADAS e linhas PULADAS do commit. Somados, fecham com `total`.
    committed: integer('committed').notNull().default(0),
    skippedCount: integer('skipped').notNull().default(0),
    rows: jsonb('rows')
      .notNull()
      .default(sql`'[]'::jsonb`),
    skippedRows: jsonb('skipped_rows')
      .notNull()
      .default(sql`'[]'::jsonb`),
    result: jsonb('result'),
    committedAt: timestamp('committed_at', { withTimezone: true }),
    rolledBackAt: timestamp('rolled_back_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('import_batch_organization_id_id_idx').on(table.organizationId, table.id),
    unique('import_batch_organization_id_content_sha256_idx').on(
      table.organizationId,
      table.contentSha256,
    ),
    check(
      'import_batch_state_check',
      sql`${table.state} in ('preview','committed','partially_committed','rolled_back')`,
    ),
    check(
      'import_batch_origin_check',
      sql`${table.origin} in ('stakeframe_template','csv_generic')`,
    ),
    check('import_batch_sha256_check', sql`${table.contentSha256} ~ '^[a-f0-9]{64}$'`),
    check('import_batch_filename_check', sql`char_length(${table.filename}) between 1 and 200`),
    check(
      'import_batch_counts_check',
      sql`${table.valid} >= 0 and ${table.invalid} >= 0 and ${table.duplicates} >= 0 and ${table.total} >= 0`,
    ),
    // committed + skipped fecha com total: nunca há linha que desapareça entre
    // o que o usuário leu e o que foi gravado.
    check(
      'import_batch_partition_check',
      sql`${table.state} in ('preview','rolled_back') or ${table.committed} + ${table.skippedCount} = ${table.total}`,
    ),
  ],
);
// STK-F2-09 — recibo idempotente da CONFIRMAÇÃO do lote, mesma forma de
// `finance.command_receipt` e da 0013. RLS fail-closed (migration 0026).
export const importBatchReceipt = integrationNamespace.table(
  'import_batch_receipt',
  {
    organizationId: organizationId(),
    key: uuid('key').notNull(),
    batchId: uuid('batch_id').notNull(),
    hash: text('hash').notNull(),
    result: jsonb('result').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'import_batch_receipt_pk',
      columns: [table.organizationId, table.key],
    }),
    check('import_batch_receipt_hash_check', sql`${table.hash} ~ '^[a-f0-9]{64}$'`),
    foreignKey({
      name: 'import_batch_receipt_batch_fk',
      columns: [table.organizationId, table.batchId],
      foreignColumns: [importBatch.organizationId, importBatch.id],
    }),
  ],
);
export const aiUsageDay = integrationNamespace.table(
  'ai_usage_day',
  {
    day: text('day').primaryKey(),
    requests: integer('requests').notNull().default(0),
    /**
     * STK-F2-13 — custo ESTIMADO do dia em microreais (1 BRL = 1.000.000), por
     * preço de referência do fornecedor. É o que NÓS pagamos, nunca o que o
     * usuário paga: o beta não cobra (Plano §4.7). Vive na MESMA linha da
     * quota de propósito — nenhuma contabilidade foi duplicada, e o teto global
     * de R$200/mês é lido da mesma agregação diária.
     */
    costMicros: bigint('cost_micros', { mode: 'number' }).notNull().default(0),
  },
  (table) => [
    check('ai_usage_nonnegative', sql`${table.requests} >= 0`),
    check('ai_usage_cost_nonnegative', sql`${table.costMicros} >= 0`),
  ],
);
