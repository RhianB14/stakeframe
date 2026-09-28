import {
  computeEffectiveValue,
  freebetEvaluationInputSchema,
  freebetInputSchema,
  freebetListQuerySchema,
  freebetPatchSchema,
  freebetRecordSchema,
  isValidTimezone,
  notificationPreferencesInputSchema,
  notificationPreferencesSchema,
  parseFreebetRequirements,
  parseNotificationTopics,
  DEFAULT_TOPIC_FLAGS,
  type EffectiveValue,
  type FreebetEvaluationInput,
  type FreebetInput,
  type FreebetListQuery,
  type FreebetPatch,
  type FreebetRecord,
  type FreebetStatus,
  type NotificationPreferences,
  type NotificationPreferencesInput,
} from '@stakeframe/shared';
import type { PoolClient } from 'pg';
import { createTenantContext, type OrganizationContext } from './tenant-context.js';
import type { Database } from './index.js';

// STK-F2-10 — freebets: registro, consulta, revogação e valor efetivo.
//
// Isolamento: TODO acesso leva o predicado explícito
// `organization_id = current_setting($$app.organization_id$$, true)::uuid` dentro
// de `withOrganizationTransaction`. O RLS não é a defesa (o papel de conexão é
// dono/superusuário do banco e o ignora); o predicado explícito é. Cache, dedupe
// e "registro existente" também o carregam, senão um tenant reusa registro alheio.

/** Fuso padrão do produto (§3.7: exibição em São Paulo). */
export const DEFAULT_TIMEZONE = 'America/Sao_Paulo';

/** Janelas do alerta de expiração, da mais ampla para a mais próxima. */
export const FREEBET_EXPIRY_WINDOWS = [
  { window: '3d', days: 3 },
  { window: '1d', days: 1 },
  { window: '4h', hours: 4 },
] as const;

export type FreebetErrorCode =
  'FREEBET_NOT_FOUND' | 'FREEBET_ALREADY_USED' | 'FREEBET_REVOKED' | 'FREEBET_INVALID';

/** Erro sanitizado: a mensagem é o próprio código, sem dado do usuário. */
export class FreebetError extends Error {
  constructor(public readonly code: FreebetErrorCode) {
    super(code);
    this.name = 'FreebetError';
  }
}

type FreebetRow = {
  id: string;
  bookmaker_id: string;
  bookmaker: string;
  amount: string;
  expires_on: string;
  stake_returned: boolean;
  used_by: string | null;
  revoked_at: Date | null;
  requirements: unknown;
  note: string;
  created_at: Date;
  updated_at: Date;
};

const ORG = `current_setting($$app.organization_id$$, true)::uuid`;

const SELECT_FREEBET = `
  select f.id,f.bookmaker_id,c.name as bookmaker,f.amount,f.expires_on::text as expires_on,
    f.stake_returned,f.used_by,f.revoked_at,f.requirements,f.note,f.created_at,f.updated_at
  from finance.freebet f
  join finance.catalog c on c.id=f.bookmaker_id and c.organization_id=f.organization_id
  where f.organization_id=${ORG}`;

/** Deslocamento da zona em minutos (positivo a leste de UTC). */
function offsetMinutesFor(timezone: string, instant: Date): number {
  const name = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    timeZoneName: 'longOffset',
  })
    .formatToParts(instant)
    .find((part) => part.type === 'timeZoneName')!.value; // "GMT-03:00"
  const match = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
  if (!match) return 0;
  return (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3] ?? 0));
}

/**
 * Instante de expiração efetiva: o FIM do dia da validade no fuzo informado.
 * A validade é uma data civil (§3.7) e a freebet vale durante todo aquele dia;
 * expirar à meia-noite do próprio dia seria errado.
 */
export function expiresAtFor(expiresOn: string, timezone: string): Date {
  const zone = isValidTimezone(timezone) ? timezone : DEFAULT_TIMEZONE;
  // Deslocamento medido no próprio dia da validade, a meio-dia UTC: evita a
  // fronteira de meia-noite em fusos de meia hora e na virada do horário de verão.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(`${expiresOn}T12:00:00Z`));
  const pick = (type: string) => parts.find((part) => part.type === type)!.value;
  const civil = `${pick('year')}-${pick('month')}-${pick('day')}`;
  const offset = offsetMinutesFor(zone, new Date(`${civil}T12:00:00Z`));
  return new Date(Date.parse(`${civil}T23:59:59.999Z`) - offset * 60_000);
}

/**
 * Situação canônica: revogada (decisão do usuário) > usada (crédito consumido
 * por uma aposta) > expirada (passou o fim da validade) > disponível.
 */
export function statusOf(row: FreebetRow, now: Date, timezone: string): FreebetStatus {
  if (row.revoked_at) return 'revoked';
  if (row.used_by) return 'used';
  if (expiresAtFor(row.expires_on, timezone) <= now) return 'expired';
  return 'available';
}

function recordOf(row: FreebetRow, now: Date, timezone: string): FreebetRecord {
  return freebetRecordSchema.parse({
    id: row.id,
    bookmakerId: row.bookmaker_id,
    bookmaker: row.bookmaker,
    amount: row.amount,
    expiresOn: row.expires_on,
    expiresAt: expiresAtFor(row.expires_on, timezone).toISOString(),
    stakeReturned: row.stake_returned,
    usedBy: row.used_by,
    status: statusOf(row, now, timezone),
    requirements: parseFreebetRequirements(row.requirements),
    note: row.note,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

export function createFreebetService(database: Database) {
  const tenant = createTenantContext(database);
  const read = <T>(context: OrganizationContext, action: (client: PoolClient) => Promise<T>) =>
    tenant.withOrganizationTransaction(context, action, { isolation: 'repeatable read' });
  const write = <T>(context: OrganizationContext, action: (client: PoolClient) => Promise<T>) =>
    tenant.withOrganizationTransaction(context, action);

  /** A casa precisa ser entrada ATIVA do catálogo da organização. */
  async function assertBookmaker(client: PoolClient, bookmakerId: string) {
    const row = (
      await client.query<{ id: string }>(
        `select id from finance.catalog where organization_id=${ORG} and id=$1 and kind='bookmaker' and active`,
        [bookmakerId],
      )
    ).rows[0];
    if (!row) throw new FreebetError('FREEBET_INVALID');
  }

  async function load(client: PoolClient, id: string, lock = false): Promise<FreebetRow> {
    const row = (
      await client.query<FreebetRow>(
        `${SELECT_FREEBET} and f.id=$1${lock ? ' for update of f' : ''}`,
        [id],
      )
    ).rows[0];
    if (!row) throw new FreebetError('FREEBET_NOT_FOUND');
    return row;
  }

  return {
    /** Contexto da organização do usuário autenticado (provisiona no primeiro uso). */
    ensureContext(userId: string) {
      return tenant.ensureOrganizationMembership(userId);
    },

    /** Fuso configurado do usuário: as regras de dia e silêncio usam ESTE fuso. */
    async timezoneOf(context: OrganizationContext, userId: string): Promise<string> {
      return (await this.preferences(context, userId)).timezone;
    },

    /**
     * Lista as freebets da organização. O filtro de situação usa a MESMA regra do
     * registro isolado: `expires_on` anterior ao dia local = expirada; o próprio
     * dia da validade continua disponível.
     */
    async list(context: OrganizationContext, query: FreebetListQuery): Promise<FreebetRecord[]> {
      const parsed = freebetListQuerySchema.parse(query);
      const timezone = await this.preferences(context, context.userId).then(
        (value) => value.timezone,
      );
      const now = new Date();
      return read(context, async (client) => {
        const values: unknown[] = [];
        const conditions = [`f.organization_id=${ORG}`];
        if (parsed.status !== 'all') {
          // O fuso entra só quando é usado: parâmetro declarado e nunca
          // referenciado faria o PostgreSQL recusar ("could not determine data
          // type of parameter $1").
          values.push(timezone);
          const zone = `$${values.length}::text`;
          values.push(parsed.status);
          conditions.push(
            `case when f.revoked_at is not null then 'revoked'
                 when f.used_by is not null then 'used'
                 when f.expires_on < (now() at time zone ${zone})::date then 'expired'
                 else 'available' end = $${values.length}::text`,
          );
        }
        if (parsed.bookmakerId) {
          values.push(parsed.bookmakerId);
          conditions.push(`f.bookmaker_id=$${values.length}`);
        }
        values.push(parsed.limit);
        const rows = (
          await client.query<FreebetRow>(
            `${SELECT_FREEBET} and ${conditions.join(' and ')}
             order by f.expires_on asc, f.id asc limit $${values.length}`,
            values,
          )
        ).rows;
        return rows.map((row) => recordOf(row, now, timezone));
      });
    },

    async get(context: OrganizationContext, id: string): Promise<FreebetRecord> {
      const timezone = await this.preferences(context, context.userId).then(
        (value) => value.timezone,
      );
      const now = new Date();
      return read(context, (client) =>
        load(client, id).then((row) => recordOf(row, now, timezone)),
      );
    },

    /** Registro: casa, valor, validade, devolução da stake, nota e requisitos. */
    async create(context: OrganizationContext, input: FreebetInput): Promise<FreebetRecord> {
      const parsed = freebetInputSchema.parse(input);
      const timezone = await this.preferences(context, context.userId).then(
        (value) => value.timezone,
      );
      return write(context, async (client) => {
        await assertBookmaker(client, parsed.bookmakerId);
        const row = (
          await client.query<{ id: string }>(
            `insert into finance.freebet(bookmaker_id,amount,expires_on,stake_returned,note,requirements)
             values($1,$2,$3,$4,$5,$6) returning id`,
            [
              parsed.bookmakerId,
              parsed.amount,
              parsed.expiresOn,
              parsed.stakeReturned,
              parsed.note,
              JSON.stringify(parsed.requirements),
            ],
          )
        ).rows[0]!;
        return recordOf(await load(client, row.id), new Date(), timezone);
      });
    },

    /**
     * Alteração parcial. Freebet CONSUMIDA, EXPIRADA ou REVOGADA é imutável: o
     * crédito já entrou no cálculo financeiro e mexer no valor apagaria a
     * verdade do histórico. Alterar a casa também valida o catálogo ativo.
     */
    async update(
      context: OrganizationContext,
      id: string,
      patch: FreebetPatch,
    ): Promise<FreebetRecord> {
      const parsed = freebetPatchSchema.parse(patch);
      const timezone = await this.preferences(context, context.userId).then(
        (value) => value.timezone,
      );
      return write(context, async (client) => {
        const before = await load(client, id, true);
        const status = statusOf(before, new Date(), timezone);
        if (status === 'used') throw new FreebetError('FREEBET_ALREADY_USED');
        if (status === 'revoked') throw new FreebetError('FREEBET_REVOKED');
        if (status === 'expired') throw new FreebetError('FREEBET_INVALID');
        if (parsed.bookmakerId !== undefined) await assertBookmaker(client, parsed.bookmakerId);
        const sets: string[] = [];
        const values: unknown[] = [id];
        for (const [column, value] of [
          ['bookmaker_id', parsed.bookmakerId],
          ['amount', parsed.amount],
          ['expires_on', parsed.expiresOn],
          ['stake_returned', parsed.stakeReturned],
          ['note', parsed.note],
          ['requirements', parsed.requirements ? JSON.stringify(parsed.requirements) : undefined],
        ] as const) {
          if (value === undefined) continue;
          values.push(value);
          sets.push(`${column}=$${values.length}`);
        }
        if (sets.length > 0)
          await client.query(
            `update finance.freebet set ${sets.join(',')},updated_at=now()
             where organization_id=${ORG} and id=$1`,
            values,
          );
        return recordOf(await load(client, id), new Date(), timezone);
      });
    },

    /**
     * Revogação: soft-delete com `revoked_at`. A linha sai da lista e do alerta,
     * mas permanece para a auditoria — e por isso é irreversível por escolha:
     * revogar é intenção do usuário, não correção de erro.
     */
    async revoke(context: OrganizationContext, id: string): Promise<FreebetRecord> {
      const timezone = await this.preferences(context, context.userId).then(
        (value) => value.timezone,
      );
      return write(context, async (client) => {
        const before = await load(client, id, true);
        if (before.used_by) throw new FreebetError('FREEBET_ALREADY_USED');
        await client.query(
          `update finance.freebet set revoked_at=now(),updated_at=now()
           where organization_id=${ORG} and id=$1 and revoked_at is null`,
          [id],
        );
        return recordOf(await load(client, id), new Date(), timezone);
      });
    },

    /**
     * Calculadora de valor efetivo (§8.7): transparente — devolve cada parcela
     * com a regra que a produziu, o que bloqueia o uso e a diferença para o
     * valor de face. Não recomenda nada: só mostra a conta.
     */
    async evaluate(
      context: OrganizationContext,
      input: FreebetEvaluationInput,
    ): Promise<EffectiveValue> {
      const parsed = freebetEvaluationInputSchema.parse(input);
      const timezone = await this.preferences(context, context.userId).then(
        (value) => value.timezone,
      );
      return read(context, async (client) => {
        const row = await load(client, parsed.freebetId);
        const status = statusOf(row, new Date(), timezone);
        const result = computeEffectiveValue({
          amount: row.amount,
          stakeReturned: row.stake_returned,
          requirements: parseFreebetRequirements(row.requirements),
          odds: parsed.odds,
          selections: parsed.selections,
          single: parsed.single,
          minOddsPerSelection: parsed.minOddsPerSelection,
          sports: parsed.sports,
          realStake: parsed.realStake,
        });
        const blockers = [...result.blockers];
        if (status === 'used') blockers.unshift('Freebet já utilizada.');
        if (status === 'expired') blockers.unshift('Freebet expirada.');
        if (status === 'revoked') blockers.unshift('Freebet revogada.');
        return {
          freebetId: row.id,
          status,
          faceValue: result.faceValue,
          effectiveValue: result.effectiveValue,
          totalReturn: result.totalReturn,
          effectiveLoss: result.effectiveLoss,
          blockers,
          eligible: blockers.length === 0,
          requirements: result.requirements,
          lines: result.lines,
        };
      });
    },

    // ------------------------------------------------------------ preferências

    /**
     * Preferências do usuário. Ausente = padrão explícito (São Paulo, 22:00–06:00,
     * todos os tópicos ligados) — o cliente sempre recebe um objeto completo.
     */
    async preferences(
      context: OrganizationContext,
      userId: string,
    ): Promise<NotificationPreferences> {
      return read(context, async (client) => {
        const row = (
          await client.query<{
            user_id: string;
            timezone: string;
            quiet_hours_start: number;
            quiet_hours_end: number;
            topics: unknown;
            updated_at: Date;
          }>(
            `select user_id,timezone,quiet_hours_start,quiet_hours_end,topics,updated_at
             from notification.preference where organization_id=${ORG} and user_id=$1`,
            [userId],
          )
        ).rows[0];
        if (!row)
          return notificationPreferencesSchema.parse({
            userId,
            timezone: DEFAULT_TIMEZONE,
            quietHoursStart: 1320,
            quietHoursEnd: 360,
            topics: { ...DEFAULT_TOPIC_FLAGS },
            updatedAt: new Date(0).toISOString(),
          });
        return notificationPreferencesSchema.parse({
          userId: row.user_id,
          timezone: row.timezone,
          quietHoursStart: row.quiet_hours_start,
          quietHoursEnd: row.quiet_hours_end,
          topics: parseNotificationTopics(row.topics, DEFAULT_TOPIC_FLAGS),
          updatedAt: row.updated_at.toISOString(),
        });
      });
    },

    /**
     * Grava as preferências. O usuário vem do contexto autenticado — nunca do
     * corpo. Fuso inválido é recusado (fail-closed: silenciaria tudo sempre) e
     * quiet hours ficam dentro de 0–1439.
     */
    async savePreferences(
      context: OrganizationContext,
      userId: string,
      input: NotificationPreferencesInput,
    ): Promise<NotificationPreferences> {
      const parsed = notificationPreferencesInputSchema.parse(input);
      if (!isValidTimezone(parsed.timezone)) throw new FreebetError('FREEBET_INVALID');
      return write(context, async (client) => {
        const row = (
          await client.query<{
            user_id: string;
            timezone: string;
            quiet_hours_start: number;
            quiet_hours_end: number;
            topics: unknown;
            updated_at: Date;
          }>(
            `insert into notification.preference
               (organization_id,user_id,timezone,quiet_hours_start,quiet_hours_end,topics)
             values(${ORG},$1,$2,$3,$4,$5)
             on conflict (organization_id,user_id) do update set
               timezone=excluded.timezone,quiet_hours_start=excluded.quiet_hours_start,
               quiet_hours_end=excluded.quiet_hours_end,topics=excluded.topics,updated_at=now()
             returning user_id,timezone,quiet_hours_start,quiet_hours_end,topics,updated_at`,
            [
              userId,
              parsed.timezone,
              parsed.quietHoursStart,
              parsed.quietHoursEnd,
              JSON.stringify(parseNotificationTopics(parsed.topics, DEFAULT_TOPIC_FLAGS)),
            ],
          )
        ).rows[0]!;
        return notificationPreferencesSchema.parse({
          userId: row.user_id,
          timezone: row.timezone,
          quietHoursStart: row.quiet_hours_start,
          quietHoursEnd: row.quiet_hours_end,
          topics: parseNotificationTopics(row.topics, DEFAULT_TOPIC_FLAGS),
          updatedAt: row.updated_at.toISOString(),
        });
      });
    },
  };
}

export type FreebetService = ReturnType<typeof createFreebetService>;
export { DEFAULT_TOPIC_FLAGS };
