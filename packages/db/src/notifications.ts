import {
  clampCount,
  isQuietHour,
  notificationRecordSchema,
  parseFreebetRequirements,
  parseNotificationTopics,
  type FreebetRequirement,
  type NotificationPreferences,
  type NotificationTopic,
} from '@stakeframe/shared';
import type { PoolClient } from 'pg';
import { createTenantContext, type OrganizationContext } from './tenant-context.js';
import {
  createFreebetService,
  DEFAULT_TIMEZONE,
  FREEBET_EXPIRY_WINDOWS,
  expiresAtFor,
} from './freebets.js';
import type { Database } from './index.js';

// STK-F2-10 — fila de alertas de expiração de freebet.
//
// A fila é durável e fica no PostgreSQL, como a busca de eventos (STK-M4-01) e a
// outbox do Telegram. Três garantias:
//
// 1. DEDUPE: a chave é `freebet_expiring:<freebetId>:<janela>` dentro da
//    organização. Rodar o job N vezes nunca gera N notificações — o `ON CONFLICT
//    DO NOTHING` sobre o índice único é a garantia, não uma checagem em memória.
// 2. QUIET HOURS: um alerta que cairia no silêncio não é descartado nem marcado
//    como entregue — é ADIADO para o primeiro minuto fora da janela, no fuso do
//    usuário. Silêncio adia entrega, não perde informação.
// 3. ISOLAMENTO: todo acesso leva o predicado de organização. A varredura de
//    candidatos e o dedupe carregam o predicado; sem ele o job processaria a
//    freebet de outra organização dentro do contexto errado.

const ORG = `current_setting($$app.organization_id$$, true)::uuid`;

type NotificationRow = {
  id: string;
  topic: string;
  subject_id: string | null;
  window: string;
  state: string;
  scheduled_for: Date;
  created_at: Date;
};

export class NotificationError extends Error {
  constructor(public readonly code: 'NOTIFICATION_TOPIC_DISABLED' | 'NOTIFICATION_INVALID') {
    super(code);
    this.name = 'NotificationError';
  }
}

/** Tentativas de entrega antes de o alerta ficar terminal (`failed`). */
const MAX_DELIVERY_ATTEMPTS = 5;

/** Backoff de reentrega em segundos; a entrega que falha é sempre adiada. */
function backoffSeconds(attempts: number): number {
  return Math.min(15 * 2 ** Math.max(0, attempts - 1), 15 * 60);
}

/**
 * Primeiro instante fora das quiet hours a partir de `from`, no fuso do usuário.
 * Varre no máximo 48 h (o suficiente para atravessar qualquer janela < 24 h);
 * se não sair do silêncio nesse intervalo, mantém o instante original — o job
 * reavalia depois, e adiar indefinidamente seria esconder o alerta.
 */
export function outsideQuietHours(
  from: Date,
  preferences: Pick<NotificationPreferences, 'timezone' | 'quietHoursStart' | 'quietHoursEnd'>,
): Date {
  const step = 15 * 60_000;
  let candidate = from;
  for (let index = 0; index < (48 * (60 * 60_000)) / step; index += 1) {
    if (
      !isQuietHour(
        candidate,
        preferences.timezone,
        preferences.quietHoursStart,
        preferences.quietHoursEnd,
      )
    )
      return candidate;
    candidate = new Date(candidate.getTime() + step);
  }
  return from;
}

function requirementSummary(requirements: FreebetRequirement[]): string {
  if (requirements.length === 0) return 'sem requisitos registrados';
  return requirements.map((item) => item.detail).join(', ');
}

export function createNotificationService(database: Database) {
  const tenant = createTenantContext(database);

  async function preferencesOf(
    client: PoolClient,
    context: OrganizationContext,
    userId: string,
  ): Promise<NotificationPreferences> {
    const row = (
      await client.query<{
        timezone: string;
        quiet_hours_start: number;
        quiet_hours_end: number;
        topics: unknown;
      }>(
        `select timezone,quiet_hours_start,quiet_hours_end,topics
         from notification.preference where organization_id=${ORG} and user_id=$1`,
        [userId],
      )
    ).rows[0];
    if (!row) {
      // Sem preferência gravada vale o padrão do produto — a mesma regra da API.
      const service = createFreebetService(database);
      return service.preferences(context, userId);
    }
    return {
      userId,
      timezone: row.timezone,
      quietHoursStart: row.quiet_hours_start,
      quietHoursEnd: row.quiet_hours_end,
      topics: parseNotificationTopics(row.topics, {
        bet_settled: true,
        review_pending: true,
        freebet_expiring: true,
      }),
      updatedAt: new Date(0).toISOString(),
    };
  }

  return {
    /**
     * Usuário que recebe as notificações da organização: o membro `owner` mais
     * antigo, resolvido do registry de tenancy (nunca de um valor do cliente e
     * nunca do rótulo `system:worker`, que não tem preferência gravada).
     */
    async recipientOf(context: OrganizationContext): Promise<string> {
      return tenant.withOrganizationTransaction(context, async (client) => {
        const row = (
          await client.query<{ user_id: string }>(
            `select user_id from core.membership
             where organization_id=${ORG} and role='owner'
             order by created_at asc, user_id asc limit 1`,
          )
        ).rows[0];
        // Sem owner lido: o job não enfileira nada (fail-closed) em vez de
        // atribuir a fila a um destinatário inventado.
        if (!row) throw new Error('NOTIFICATION_RECIPIENT_MISSING');
        return row.user_id;
      });
    },

    /**
     * Enfileira os alertas de expiração devidos. Idempotente por dedupe: a mesma
     * freebet na mesma janela nunca entra duas vezes, mesmo com execução
     * concorrente (o índice único decide, não a aplicação).
     *
     * `recipientId` é o usuário QUE RECEBE o alerta (com o fuso e o silêncio
     * dele). O worker de infraestrutura passa pelo usuário da organização, nunca
     * pelo rótulo de sistema — a preferência de `system:worker` não existe e
     * faria o alerta sair com o fuso padrão em vez do fuso do dono.
     */
    async enqueueExpiringFreebets(
      context: OrganizationContext,
      recipientId: string,
      now = new Date(),
    ): Promise<{ enqueued: number; deferred: number; skipped: number }> {
      return tenant.withOrganizationTransaction(context, async (client) => {
        const preference = await preferencesOf(client, context, recipientId);
        if (!preference.topics.freebet_expiring) {
          // Tópico desligado pelo usuário: nada é enfileirado nem registrado.
          return { enqueued: 0, deferred: 0, skipped: 0 };
        }
        // A fila referencia a preferência do usuário: garante a linha aqui para
        // que o primeiro alerta de um usuário sem preferência gravada funcione
        // (upsert idempotente, sem tocar nas preferências já configuradas).
        await client.query(
          `insert into notification.preference
             (organization_id,user_id,timezone,quiet_hours_start,quiet_hours_end,topics)
           values(${ORG},$1,$2,$3,$4,$5)
           on conflict (organization_id,user_id) do nothing`,
          [
            recipientId,
            preference.timezone,
            preference.quietHoursStart,
            preference.quietHoursEnd,
            JSON.stringify(preference.topics),
          ],
        );
        let enqueued = 0;
        let deferred = 0;
        let skipped = 0;
        for (const window of FREEBET_EXPIRY_WINDOWS) {
          const days = 'days' in window ? window.days : 0;
          const hours = 'hours' in window ? window.hours : 0;
          // Janela [agora, expiresAt − lead]: a freebet é candidata quando ainda
          // NÃO expirou e o instante do alerta ainda não passou. A comparação é
          // feita no instante (não na data civil), então a janela de 4 h alcança
          // a freebet que expira amanhã cedo — a data civil sozinha erraria aqui.
          const lead = days * 86_400_000 + hours * 3_600_000;
          const candidates = (
            await client.query<{
              id: string;
              amount: string;
              expires_on: string;
              bookmaker: string;
              requirements: unknown;
            }>(
              `select f.id,f.amount,f.expires_on::text as expires_on,c.name as bookmaker,f.requirements
               from finance.freebet f
               join finance.catalog c on c.id=f.bookmaker_id and c.organization_id=f.organization_id
               where f.organization_id=${ORG} and f.used_by is null and f.revoked_at is null
                 and f.expires_on >= (now() at time zone $1::text)::date
                 and ((f.expires_on::date)::timestamp at time zone $1::text) - ($2::int * interval '1 second') <= now()
               order by f.expires_on asc, f.id asc limit 500`,
              [preference.timezone, lead / 1000],
            )
          ).rows;
          for (const candidate of candidates) {
            const expiresAt = expiresAtFor(candidate.expires_on, preference.timezone);
            // Janela já vencida (o job rodou tarde) alerta imediatamente.
            const target = new Date(expiresAt.getTime() - lead);
            const scheduled = target.getTime() < now.getTime() ? now : target;
            const quiet = isQuietHour(
              scheduled,
              preference.timezone,
              preference.quietHoursStart,
              preference.quietHoursEnd,
            );
            const effective = quiet ? outsideQuietHours(scheduled, preference) : scheduled;
            if (quiet) deferred += 1;
            const requirements = parseFreebetRequirements(candidate.requirements);
            const summary = requirementSummary(requirements);
            const title = `Freebet expira em ${candidate.bookmaker}`;
            const body =
              `A freebet de R$ ${candidate.amount} expira em ${candidate.expires_on}. ` +
              `Requisitos: ${summary}.`;
            const inserted = await client.query(
              `insert into notification.outbox
                 ("organization_id","user_id","topic","subject_id","window","dedupe_key","title","body","scheduled_for")
               values(${ORG},$1,'freebet_expiring',$2,$3,$4,$5,$6,$7)
               on conflict ("organization_id","dedupe_key") do nothing
               returning id`,
              [
                recipientId,
                candidate.id,
                window.window,
                `freebet_expiring:${candidate.id}:${window.window}`,
                title,
                body,
                effective,
              ],
            );
            if (inserted.rows[0]) enqueued += 1;
            else skipped += 1;
          }
        }
        return { enqueued, deferred, skipped };
      });
    },

    /** Reclama um alerta vencido para entrega (o executor real é o canal). */
    async claimDue(context: OrganizationContext): Promise<NotificationRow | null> {
      return tenant.withOrganizationTransaction(context, async (client) => {
        const row = (
          await client.query<NotificationRow>(
            `select id,"topic","subject_id","window","state","scheduled_for","created_at"
             from notification.outbox
             where organization_id=${ORG} and state='pending' and scheduled_for <= now()
             order by scheduled_for asc, id asc limit 1 for update skip locked`,
          )
        ).rows[0];
        if (!row) return null;
        await client.query(
          `update notification.outbox set state='delivered',attempts=attempts+1,delivered_at=now(),updated_at=now()
           where organization_id=${ORG} and id=$1 and state='pending'`,
          [row.id],
        );
        return row;
      });
    },

    /**
     * Devolve um alerta à fila depois que a entrega falhou.
     *
     * O claim marca `delivered` porque a reserva é o que impede dois workers de
     * entregarem o mesmo alerta ao mesmo tempo (o `SKIP LOCKED` já faz isso).
     * Quando o canal recusa, chamar isto é obrigatório: sem isso o alerta seria
     * marcado como entregue sem nunca ter chegado ao usuário.
     */
    async restore(id: string, context: OrganizationContext): Promise<void> {
      await tenant.withOrganizationTransaction(context, async (client) => {
        const row = (
          await client.query<{ attempts: number }>(
            `select attempts from notification.outbox
             where organization_id=${ORG} and id=$1 and state='delivered' and delivered_at > now()-interval '5 minutes'`,
            [id],
          )
        ).rows[0];
        if (!row) return;
        if (row.attempts >= MAX_DELIVERY_ATTEMPTS) {
          // Esgotado: fica terminal para reconciliação, sem loop infinito.
          await client.query(
            `update notification.outbox set state='failed',last_error='NOTIFICATION_CHANNEL_UNAVAILABLE',delivered_at=null,updated_at=now()
             where organization_id=${ORG} and id=$1 and state='delivered'`,
            [id],
          );
          return;
        }
        await client.query(
          `update notification.outbox set state='pending',delivered_at=null,updated_at=now(),
             scheduled_for=now() + ($2::int * interval '1 second')
           where organization_id=${ORG} and id=$1 and state='delivered'`,
          [id, Math.min(backoffSeconds(row.attempts), 900)],
        );
      });
    },

    /** Lista as notificações do usuário (auditoria de quiet hours e dedupe). */
    async list(
      context: OrganizationContext,
      userId: string,
      limit = 50,
    ): Promise<
      {
        id: string;
        topic: NotificationTopic;
        subjectId: string | null;
        state: string;
        scheduledFor: string;
        createdAt: string;
      }[]
    > {
      const bounded = clampCount(limit, 1, 100);
      return tenant.withOrganizationTransaction(
        context,
        async (client) => {
          const rows = (
            await client.query<NotificationRow>(
              `select id,"topic","subject_id","window","state","scheduled_for","created_at"
               from notification.outbox
               where organization_id=${ORG} and user_id=$1
               order by created_at desc, id desc limit $2`,
              [userId, bounded],
            )
          ).rows;
          return rows.map((row) =>
            notificationRecordSchema.parse({
              id: row.id,
              topic: row.topic,
              subjectId: row.subject_id,
              window: row.window,
              state: row.state,
              scheduledFor: row.scheduled_for.toISOString(),
              createdAt: row.created_at.toISOString(),
            }),
          );
        },
        { isolation: 'repeatable read' },
      );
    },
  };
}

export type NotificationService = ReturnType<typeof createNotificationService>;
export { DEFAULT_TIMEZONE };
