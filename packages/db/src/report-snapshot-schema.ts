import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// STK-F2-08 — espelho Drizzle das duas tabelas da 0027.
//
// Este arquivo é a DESCRIÇÃO do que a migração cria, no mesmo papel que
// `notification-schema.ts` tem para a 0021: o SQL é a fonte (é ele que o
// drizzle-kit compara e que o migrador executa), e este arquivo existe para
// que o modelo TypeScript conheça as colunas com tipo.
//
// Duas coisas NÃO são espelhadas aqui, de propósito:
//
//  - A IMUTABILIDADE. Ela é um TRIGGER do banco
//    (`integration.immutable_report_snapshot`), não um hook do ORM. Modelar
//    "imutável" em TypeScript seria uma propriedade que só existe enquanto o
//    código que a lê estiver em execução — a garantia real é o banco recusando
//    o UPDATE, e ela é testada contra o PostgreSQL real.
//
//  - A RLS. Ela é a política `organization_isolation` criada na migração,
//    idêntica à de `core.organization_entitlement` (0025) e
//    `notification.outbox` (0021): predicado por organização, recusa
//    fail-closed sem contexto.

export const integration = pgSchema('integration');

const organizationId = () => uuid('organization_id').notNull();

/**
 * Snapshot IMUTÁVEL de um relatório, por versão.
 *
 * `version` é a revisão DENTRO do mesmo par (período, janela): 1 é a emissão
 * original e 2+ são revisões sob demanda (o card: "correção cria versão
 * revisada"). `financialVersion` amarra o número mostrado ao estado de
 * `finance.settings` — é o que faz uma correção de aposta virar um relatório
 * novo em vez de um relatório reescrito.
 */
export const reportSnapshot = integration.table(
  'report_snapshot',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: organizationId(),
    version: integer('version').notNull().default(1),
    period: text('period').notNull(),
    from: date('from').notNull(),
    to: date('to').notNull(),
    financialVersion: integer('financial_version').notNull(),
    /** Métricas congeladas no formato do contrato de relatório. */
    metrics: jsonb('metrics').notNull(),
    /** Relatório completo: dashboard, splits e narrativa determinística. */
    payload: jsonb('payload').notNull(),
    contentSha256: text('content_sha256').notNull(),
    /** NULL quando a emissão veio do job de cadência, não de um usuário. */
    requestedBy: text('requested_by'),
    revisionReason: text('revision_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Chave de REVISÃO: uma versão por (organização, período, janela, versão).
    // A dedupe de ENVIO não mora aqui: ela vive em `report_delivery`, cuja
    // chave carrega a versão financeira. Um índice único por versão financeira
    // recusaria a revisão, que nasce por definição do mesmo estado do
    // financeiro que a versão anterior (é o DADO que mudou, não o saldo).
    uniqueIndex('report_snapshot_revision_idx').on(
      table.organizationId,
      table.period,
      table.from,
      table.to,
      table.version,
    ),
    index('report_snapshot_org_idx').on(table.organizationId, table.createdAt),
    index('report_snapshot_financial_version_idx').on(table.organizationId, table.financialVersion),
    check('report_snapshot_period_check', sql`${table.period} in ('daily','weekly','monthly')`),
    check('report_snapshot_version_positive', sql`${table.version} >= 1`),
    check('report_snapshot_window_ordered', sql`${table.from} <= ${table.to}`),
    check('report_snapshot_financial_version_positive', sql`${table.financialVersion} >= 1`),
    check('report_snapshot_sha256_check', sql`${table.contentSha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

/**
 * Registro do ENVIO, separado do snapshot porque a entrega é o que falha e
 * repete. Um relatório que o Telegram recusou continua existindo para a
 * página privada; a linha aqui diz se ele chegou a ser enviado.
 *
 * `channel` tem CHECK 'telegram': o card exclui e-mail, PDF, PNG e imagem
 * compartilhável, e a restrição é o que impede um segundo canal de nascer por
 * conveniência.
 */
export const reportDelivery = integration.table(
  'report_delivery',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: organizationId(),
    snapshotId: uuid('snapshot_id')
      .notNull()
      .references(() => reportSnapshot.id, { onDelete: 'restrict' }),
    period: text('period').notNull(),
    from: date('from').notNull(),
    to: date('to').notNull(),
    financialVersion: integer('financial_version').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    userId: text('user_id').notNull(),
    channel: text('channel').notNull().default('telegram'),
    state: text('state').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('report_delivery_dedupe_idx').on(table.organizationId, table.dedupeKey),
    index('report_delivery_due_idx').on(table.state, table.scheduledFor),
    index('report_delivery_snapshot_idx').on(table.organizationId, table.snapshotId),
    index('report_delivery_user_idx').on(table.organizationId, table.userId, table.createdAt),
    check('report_delivery_period_check', sql`${table.period} in ('daily','weekly','monthly')`),
    check('report_delivery_channel_check', sql`${table.channel} = 'telegram'`),
    check(
      'report_delivery_state_check',
      sql`${table.state} in ('pending','delivered','skipped_no_data','failed')`,
    ),
    check('report_delivery_attempts_check', sql`${table.attempts} >= 0`),
    check('report_delivery_window_ordered', sql`${table.from} <= ${table.to}`),
    check('report_delivery_financial_version_positive', sql`${table.financialVersion} >= 1`),
    check('report_delivery_dedupe_key_not_empty', sql`btrim(${table.dedupeKey}) <> ''`),
  ],
);
