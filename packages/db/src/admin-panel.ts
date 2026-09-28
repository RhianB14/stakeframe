/**
 * STK-F2-11 — painel interno mínimo do superadmin (Plano Master §7.2, §15).
 *
 * Quatro visões de METADADOS e nada mais: contas (rótulo, papel, estado),
 * uso (cotas globais e contagens de fila), flags de rollout e erros recentes
 * (código por origem + contagem). Cada leitura é agregada no próprio SQL: o
 * serviço nunca devolve uma linha de conteúdo de tenant (nada de apostas,
 * journal, posting, saldo, resultado, imagem, e-mail, token, legenda ou
 * checkpoint de extração) — apenas contagens e códigos de erro.
 *
 * Isolamento (F1-13): este é o ÚNICO serviço do produto que, por desenho,
 * atravessa organizações. Por isso cada leitura de tabela org-scoped é feita
 * dentro de `withOrganizationTransaction` de uma organização por vez, com o
 * predicado explícito `organization_id = current_setting($$app.organization_id$$,
 * true)::uuid` — nunca um `count` sem escopo. As tabelas de infra
 * (`integration.ai_usage_day`, `integration.cursor`) são GLOBAIS e não levam
 * predicado: a cota do provedor de IA protege a infraestrutura inteira e
 * escopá-la por tenant faria cada organização multiplicar o limite em silêncio.
 *
 * Auditoria: `audit` grava cada tentativa (permitida ou negada) em
 * `core.admin_panel_access`, antes de qualquer leitura. Uma falha de auditoria
 * NUNCA abre a superfície — o acesso permitido sem registro é fail-closed.
 *
 * Impersonação é PROIBIDA (Plano §7.2): nenhuma função deste módulo recebe
 * usuário ou organização de destino; o ator vem sempre da sessão autenticada.
 */

import type { PoolClient } from 'pg';
import {
  AI_DAILY_REQUEST_LIMIT,
  AI_MONTHLY_REQUEST_LIMIT,
  type AdminAccount,
  type AdminAccounts,
  type AdminAuditTrail,
  type AdminErrorKind,
  type AdminErrors,
  type AdminFlags,
  type AdminPanelView,
  type AdminQueue,
  type AdminUsage,
} from '@stakeframe/shared';
import { createTenantContext, type Database, type OrganizationContext } from './index.js';

/**
 * Chaves de rollout realmente consultadas pelo produto hoje. Vazia de propósito:
 * o painel informa o que existe, nunca o que se imagina. Um produto que leia
 * uma flag real passa a lê-la do mesmo catálogo que o painel publica.
 */
const ROLLOUT_FLAG_KEYS: readonly string[] = [];

export type AdminPanelErrorCode =
  'ADMIN_AUDIT_FAILED' | 'ADMIN_VIEW_UNAVAILABLE' | 'ADMIN_ROLE_MISMATCH';

/** Erro interno sanitizado: o nome da classe e a mensagem são o próprio código. */
export class AdminPanelError extends Error {
  constructor(public readonly code: AdminPanelErrorCode) {
    super(code);
    this.name = 'AdminPanelError';
  }
}

export type TelemetryState = {
  sentry: { enabled: boolean; environment: string };
  posthog: { enabled: boolean };
  betterStack: { enabled: boolean };
  debug: { enabled: boolean };
};

export type AdminPanelServiceOptions = {
  telemetry?: TelemetryState;
  /** Teto de linhas por visão; o payload declara `truncated` quando corta. */
  maxRows?: number;
};

const DEFAULT_MAX_ROWS = 200;

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

type AccountRow = {
  organization_id: string;
  organization_name: string;
  organization_created_at: Date;
  user_id: string;
  role: 'owner' | 'superadmin';
  member_since: Date;
  onboarding_completed_at: Date | null;
  first_bet_deferred_at: Date | null;
  consents_accepted: number;
  deletion_state: 'pending' | 'cancelled' | 'purged' | null;
  last_session_at: Date | null;
  active_sessions: number;
};

type QueueRow = {
  organization_name: string;
  import_pending: number;
  import_processing: number;
  import_failed: number;
  import_review: number;
  event_pending: number;
  event_processing: number;
  event_failed: number;
  outbox_pending: number;
  outbox_failed: number;
};

type ErrorRow = {
  source: AdminErrorKind['source'];
  code: string;
  occurrences: number;
  last_seen_at: Date | null;
};

export function createAdminPanelService(
  database: Database,
  options: AdminPanelServiceOptions = {},
) {
  const tenant = createTenantContext(database);
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const telemetry: TelemetryState = options.telemetry ?? {
    sentry: { enabled: false, environment: 'unknown' },
    posthog: { enabled: false },
    betterStack: { enabled: false },
    debug: { enabled: false },
  };
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 1_000)
    throw new Error('INVALID_ADMIN_PANEL_LIMIT');
  /** Reads one extra row per organization to detect truncation honestly. */
  const probe = maxRows + 1;
  const context = `current_setting($$app.organization_id$$, true)::uuid`;

  /**
   * One audit row, committed on its own connection so the trail survives the
   * view that produced it (including a view that then failed). The connection
   * is always released, including on the failure path.
   */
  async function audit(
    actorUserId: string,
    view: AdminPanelView,
    outcome: 'allowed' | 'denied',
    requestId: string | null,
  ): Promise<void> {
    const client = await database.pool.connect();
    try {
      await client.query(
        'insert into core.admin_panel_access(actor_user_id, view, outcome, request_id) values($1,$2,$3,$4)',
        [actorUserId, view, outcome, requestId],
      );
    } catch {
      // Sanitized by omission: the audit failure never carries SQL or row data.
      throw new AdminPanelError('ADMIN_AUDIT_FAILED');
    } finally {
      client.release();
    }
  }

  /** Deny and record: the refusal stands even when the audit cannot be written. */
  async function deny(
    actorUserId: string,
    view: AdminPanelView,
    requestId: string | null,
  ): Promise<never> {
    try {
      await audit(actorUserId, view, 'denied', requestId);
    } catch {
      // The caller only ever learns `denied`.
    }
    throw new AdminPanelError('ADMIN_ROLE_MISMATCH');
  }

  async function accounts(
    actorUserId: string,
    requestId: string | null,
    query: { limit: number; offset: number },
  ): Promise<AdminAccounts> {
    await audit(actorUserId, 'accounts', 'allowed', requestId);
    // `core.*` is registry data, not tenant-private content: the panel is the
    // sanctioned cross-tenant surface and returns metadata only (label, role,
    // state). No tenant context here — it would hide the very rows to show.
    const client = await database.pool.connect();
    try {
      const total = Number(
        (await client.query<{ n: string }>('select count(*)::text as n from core.organization'))
          .rows[0]!.n,
      );
      const rows = (
        await client.query<AccountRow>(
          `select o.id as organization_id,
                  o.name as organization_name,
                  o.created_at as organization_created_at,
                  m.user_id,
                  m.role,
                  m.created_at as member_since,
                  s.completed_at as onboarding_completed_at,
                  s.first_bet_deferred_at,
                  (select count(*)::int from core.consent_record c
                    where c.user_id = m.user_id) as consents_accepted,
                  d.state as deletion_state,
                  (select max(sess.created_at) from auth.session sess
                    where sess.user_id = m.user_id) as last_session_at,
                  (select count(*)::int from auth.session sess
                    where sess.user_id = m.user_id and sess.expires_at > now()) as active_sessions
             from core.organization o
             join core.membership m on m.organization_id = o.id
             left join core.onboarding_state s on s.user_id = m.user_id
             left join core.account_deletion d on d.user_id = m.user_id
            order by o.created_at asc, o.id asc
            limit $1 offset $2`,
          [query.limit + 1, query.offset],
        )
      ).rows;
      const truncated = rows.length > query.limit;
      const page = truncated ? rows.slice(0, query.limit) : rows;
      return {
        generatedAt: new Date().toISOString(),
        total,
        truncated,
        accounts: page.map((row): AdminAccount => ({
          organizationId: row.organization_id,
          organizationName: row.organization_name,
          organizationCreatedAt: row.organization_created_at.toISOString(),
          userId: row.user_id,
          role: row.role,
          memberSince: row.member_since.toISOString(),
          onboardingCompletedAt: iso(row.onboarding_completed_at),
          firstBetDeferredAt: iso(row.first_bet_deferred_at),
          consentsAccepted: Number(row.consents_accepted),
          deletionState: row.deletion_state,
          lastSessionAt: iso(row.last_session_at),
          activeSessions: Number(row.active_sessions),
        })),
      };
    } finally {
      client.release();
    }
  }

  /**
   * Queue counts for ONE organization, inside its own transaction. Every table
   * read here is org-scoped, so the predicate is explicit in each sub-select.
   */
  async function readQueues(
    client: PoolClient,
    organization: OrganizationContext,
  ): Promise<AdminQueue | undefined> {
    const row = (
      await client.query<QueueRow>(
        `select o.name as organization_name,
                (select count(*)::int from integration.inbox i
                  where i.organization_id = ${context} and i.state = 'pending') as import_pending,
                (select count(*)::int from integration.inbox i
                  where i.organization_id = ${context} and i.state = 'processing') as import_processing,
                (select count(*)::int from integration.inbox i
                  where i.organization_id = ${context} and i.state = 'failed') as import_failed,
                (select count(*)::int from integration.inbox i
                  where i.organization_id = ${context} and i.state = 'review') as import_review,
                (select count(*)::int from integration.event_search e
                  where e.organization_id = ${context} and e.state = 'pending') as event_pending,
                (select count(*)::int from integration.event_search e
                  where e.organization_id = ${context} and e.state = 'processing') as event_processing,
                (select count(*)::int from integration.event_search e
                  where e.organization_id = ${context} and e.state = 'failed') as event_failed,
                (select count(*)::int from integration.telegram_outbox t
                  where t.organization_id = ${context} and t.state = 'pending') as outbox_pending,
                (select count(*)::int from integration.telegram_outbox t
                  where t.organization_id = ${context} and t.state = 'failed') as outbox_failed
           from core.organization o
          where o.id = $1`,
        [organization.organizationId],
      )
    ).rows[0];
    if (!row) return undefined;
    return {
      organizationId: organization.organizationId,
      organizationName: row.organization_name,
      importPending: Number(row.import_pending),
      importProcessing: Number(row.import_processing),
      importFailed: Number(row.import_failed),
      importReview: Number(row.import_review),
      eventPending: Number(row.event_pending),
      eventProcessing: Number(row.event_processing),
      eventFailed: Number(row.event_failed),
      outboxPending: Number(row.outbox_pending),
      outboxFailed: Number(row.outbox_failed),
    };
  }

  async function usage(actorUserId: string, requestId: string | null): Promise<AdminUsage> {
    await audit(actorUserId, 'usage', 'allowed', requestId);
    // Global infrastructure (no organization predicate, on purpose): the
    // provider quota is shared by every tenant — see the module header.
    const ai = (
      await database.pool.query<{ daily: string; monthly: string }>(
        `select coalesce(sum(requests) filter(where day = to_char(now() at time zone 'UTC','YYYY-MM-DD')), 0)::text as daily,
                coalesce(sum(requests) filter(where day >= to_char(now() at time zone 'UTC','YYYY-MM') || '-01'), 0)::text as monthly
           from integration.ai_usage_day`,
      )
    ).rows[0]!;
    const requestsToday = Number(ai.daily);
    const requestsMonth = Number(ai.monthly);
    const ratio = Math.max(
      requestsToday / AI_DAILY_REQUEST_LIMIT,
      requestsMonth / AI_MONTHLY_REQUEST_LIMIT,
    );
    const organizations = Number(
      (
        await database.pool.query<{ n: string }>(
          'select count(*)::text as n from core.organization',
        )
      ).rows[0]!.n,
    );
    // One transaction per organization, in that organization's own context.
    const queues: AdminQueue[] = [];
    let truncated = false;
    for (const organization of await tenant.listOrganizations()) {
      if (queues.length >= maxRows) {
        truncated = true;
        break;
      }
      const row = await tenant.withOrganizationTransaction(organization, (transaction) =>
        readQueues(transaction, organization),
      );
      if (row) queues.push(row);
    }
    return {
      generatedAt: new Date().toISOString(),
      ai: {
        requestsToday,
        requestsMonth,
        dailyLimit: AI_DAILY_REQUEST_LIMIT,
        monthlyLimit: AI_MONTHLY_REQUEST_LIMIT,
        state: ratio >= 1 ? 'exhausted' : ratio >= 0.8 ? 'warning' : 'ready',
      },
      organizations,
      truncated,
      queues,
    };
  }

  async function flags(actorUserId: string, requestId: string | null): Promise<AdminFlags> {
    await audit(actorUserId, 'flags', 'allowed', requestId);
    return {
      generatedAt: new Date().toISOString(),
      rollout: {
        source: telemetry.posthog.enabled ? 'posthog' : 'none',
        keys: [...ROLLOUT_FLAG_KEYS],
      },
      toggles: [
        { key: 'TELEMETRY_SENTRY_ENABLED', enabled: telemetry.sentry.enabled },
        { key: 'TELEMETRY_POSTHOG_ENABLED', enabled: telemetry.posthog.enabled },
        { key: 'TELEMETRY_BETTER_STACK_ENABLED', enabled: telemetry.betterStack.enabled },
        { key: 'TELEMETRY_DEBUG_ENABLED', enabled: telemetry.debug.enabled },
      ],
    };
  }

  async function errors(actorUserId: string, requestId: string | null): Promise<AdminErrors> {
    await audit(actorUserId, 'errors', 'allowed', requestId);
    // Only sanitized failure CODES, grouped per origin. The message, the caption,
    // the payload, the image and the user never leave the queue rows.
    const rows: ErrorRow[] = [];
    let truncated = false;
    for (const organization of await tenant.listOrganizations()) {
      if (rows.length >= maxRows) {
        truncated = true;
        break;
      }
      const found = await tenant.withOrganizationTransaction(organization, (transaction) =>
        transaction.query<ErrorRow>(
          `select 'import' as source, i.error_code as code, count(*)::int as occurrences,
                  max(i.updated_at) as last_seen_at
             from integration.inbox i
            where i.organization_id = ${context}
              and i.error_code is not null
            group by i.error_code
           union all
           select 'event_search' as source, e.error_code, count(*)::int, max(e.created_at)
             from integration.event_search e
            where e.organization_id = ${context}
              and e.error_code is not null
            group by e.error_code
           union all
           select 'telegram_outbox' as source, t.last_error, count(*)::int, max(t.updated_at)
             from integration.telegram_outbox t
            where t.organization_id = ${context}
              and t.last_error is not null
            group by t.last_error
           order by occurrences desc
           limit $1`,
          [probe],
        ),
      );
      for (const row of found.rows) {
        if (rows.length >= maxRows) {
          truncated = true;
          break;
        }
        rows.push(row);
      }
    }
    return {
      generatedAt: new Date().toISOString(),
      telemetry: {
        sentry: {
          enabled: telemetry.sentry.enabled,
          environment: telemetry.sentry.environment,
        },
        posthog: { enabled: telemetry.posthog.enabled },
        betterStack: { enabled: telemetry.betterStack.enabled },
        debug: { enabled: telemetry.debug.enabled },
      },
      truncated,
      kinds: rows.map((row) => ({
        source: row.source,
        code: row.code,
        occurrences: Number(row.occurrences),
        lastSeenAt: iso(row.last_seen_at),
      })),
    };
  }

  /** The panel's own audit trail — metadata about access, never about content. */
  async function auditTrail(
    actorUserId: string,
    requestId: string | null,
    limitRows: number,
  ): Promise<AdminAuditTrail> {
    await audit(actorUserId, 'audit', 'allowed', requestId);
    const rows = (
      await database.pool.query<{
        id: string;
        actor_user_id: string;
        view: AdminPanelView;
        outcome: 'allowed' | 'denied';
        request_id: string | null;
        created_at: Date;
      }>(
        `select id, actor_user_id, view, outcome, request_id, created_at
           from core.admin_panel_access
          order by created_at desc, id desc
          limit $1`,
        [limitRows],
      )
    ).rows;
    return {
      generatedAt: new Date().toISOString(),
      entries: rows.map((row) => ({
        id: row.id,
        actorUserId: row.actor_user_id,
        view: row.view,
        outcome: row.outcome,
        requestId: row.request_id,
        createdAt: row.created_at.toISOString(),
      })),
    };
  }

  return {
    accounts,
    usage,
    flags,
    errors,
    auditTrail,
    deny,
    audit,
  };
}

export type AdminPanelService = ReturnType<typeof createAdminPanelService>;
