import { createHash } from 'node:crypto';
import {
  calendarPageSchema,
  eventSearchSchema,
  eventSearchInputSchema,
  eventCandidateSchema,
  eventSearchStatusSchema,
  saoPauloDate,
  type CalendarQuery,
  type EventSearchInput,
  type EventProvider,
  type EventCandidate,
  type FinanceCommand,
} from '@stakeframe/shared';
import type { PoolClient } from 'pg';
import type { Database } from './index.js';
import { FinanceError, validateEventDate } from './finance-core.js';

export const EVENT_LIMITS = {
  thesportsdb: { daily: 60, monthly: 1500, minute: 10 },
  tavily: { daily: 20, monthly: 600, minute: 10 },
} as const;
export type EventSearchConfig = Record<EventProvider, boolean>;
export function readEventSearchConfig(env: NodeJS.ProcessEnv): EventSearchConfig {
  function flag(name: string) {
    if (env[name] !== undefined && !['true', 'false'].includes(env[name]!))
      throw new Error('INVALID_EVENT_SEARCH_CONFIGURATION');
    return env[name] === 'true';
  }
  return { thesportsdb: flag('THESPORTSDB_ENABLED'), tavily: flag('TAVILY_ENABLED') };
}
export function eventFingerprint(event: string, sport: string | null) {
  return createHash('sha256')
    .update(JSON.stringify([event.trim(), sport?.trim() ?? null]))
    .digest('hex');
}
type SearchRow = {
  id: string;
  actor: string;
  hash: string;
  selection_id: string;
  provider: EventProvider;
  query: string;
  event_fingerprint: string;
  date_hint: string | null;
  state: string;
  candidates: unknown;
  error_code: string | null;
  cached_from: string | null;
  created_at: Date;
};
function searchDto(row: SearchRow) {
  return eventSearchSchema.parse({
    id: row.id,
    selectionId: row.selection_id,
    provider: row.provider,
    query: row.query,
    dateHint: row.date_hint,
    state: row.state,
    candidates: row.candidates,
    errorCode: row.error_code,
    cached: !!row.cached_from,
    createdAt: row.created_at.toISOString(),
  });
}
type SelectionRow = {
  id: string;
  bet_id: string;
  event: string;
  sport: string | null;
  market: string;
  selection: string;
  odds: string | null;
  event_date: string | null;
  event_at: Date | null;
  date_status: string;
  date_source: string;
  date_evidence: unknown;
  schedule_status: string;
  reference: string;
  bookmaker: string;
  bet_state: string;
};
function calendarDto(row: SelectionRow) {
  return {
    selection: {
      id: row.id,
      event: row.event,
      sport: row.sport,
      market: row.market,
      selection: row.selection,
      odds: row.odds,
      eventDate: row.event_date,
      eventAt: row.event_at?.toISOString() ?? null,
      dateStatus: row.date_status,
    },
    betId: row.bet_id,
    betReference: row.reference,
    bookmaker: row.bookmaker,
    betState: row.bet_state,
    dateSource: row.date_source,
    dateEvidence: row.date_evidence,
    scheduleStatus: row.schedule_status,
  };
}
async function usage(client: Pick<PoolClient, 'query'>, provider: EventProvider) {
  return (
    await client.query<{ daily: number; monthly: number; minute: number }>(
      `
    select count(*) filter(where started_at >= date_trunc('day',now() at time zone 'UTC') at time zone 'UTC')::int as daily,
      count(*)::int as monthly,
      count(*) filter(where started_at > now()-interval '1 minute')::int as minute
    from integration.event_search where provider=$1 and started_at >= date_trunc('month',now() at time zone 'UTC') at time zone 'UTC'`,
      [provider],
    )
  ).rows[0]!;
}
export function createEventService(
  database: Database,
  config: EventSearchConfig = { thesportsdb: false, tavily: false },
) {
  async function transaction<T>(action: (client: PoolClient) => Promise<T>, readonly = false) {
    const client = await database.pool.connect();
    try {
      await client.query(readonly ? 'begin isolation level repeatable read read only' : 'begin');
      const value = await action(client);
      await client.query('commit');
      return value;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
  return {
    calendar(query: CalendarQuery) {
      if (
        query.from > query.to ||
        (Date.parse(query.to) - Date.parse(query.from)) / 86_400_000 > 366
      )
        throw new FinanceError('INVALID_FINANCIAL_OPERATION');
      return transaction(async (client) => {
        const args = [query.from, query.to, query.view, query.betState ?? null];
        const filter = `where ($4::text is null or b.state=$4) and
          (case when $3='pending' then s.event_date is null or s.schedule_status='postponed'
            else s.event_date between $1::date and $2::date and s.schedule_status<>'postponed' end)`;
        const totals = (
          await client.query<{ total: number; bets: number }>(
            `
          select count(*)::int as total,count(distinct b.id)::int as bets
          from finance.selection s join finance.bet b on b.id=s.bet_id ${filter}`,
            args,
          )
        ).rows[0]!;
        const pending = (
          await client.query<{ count: number }>(
            `select count(*)::int as count
          from finance.selection s join finance.bet b on b.id=s.bet_id
          where (s.event_date is null or s.schedule_status='postponed') and ($1::text is null or b.state=$1)`,
            [query.betState ?? null],
          )
        ).rows[0]!.count;
        const rows = (
          await client.query<SelectionRow>(
            `
          select s.*,s.event_date::text as event_date,b.reference,b.state as bet_state,c.name as bookmaker
          from finance.selection s join finance.bet b on b.id=s.bet_id join finance.catalog c on c.id=b.bookmaker_id
          ${filter} order by s.event_date nulls last,s.event_at nulls last,s.event,b.id,s.position,s.id limit $5 offset $6`,
            [...args, query.pageSize, (query.page - 1) * query.pageSize],
          )
        ).rows;
        return calendarPageSchema.parse({
          items: rows.map(calendarDto),
          total: totals.total,
          distinctBets: totals.bets,
          pendingSelections: pending,
          page: query.page,
          pageSize: query.pageSize,
        });
      }, true);
    },
    async selection(id: string) {
      const row = (
        await database.pool.query<SelectionRow>(
          `select s.*,s.event_date::text as event_date,
        b.reference,b.state as bet_state,c.name as bookmaker from finance.selection s
        join finance.bet b on b.id=s.bet_id join finance.catalog c on c.id=b.bookmaker_id where s.id=$1`,
          [id],
        )
      ).rows[0];
      if (!row) throw new FinanceError('NOT_FOUND');
      return calendarDto(row);
    },
    async status() {
      return transaction(async (client) => {
        const providers = [];
        for (const provider of ['thesportsdb', 'tavily'] as const) {
          const used = await usage(client, provider);
          providers.push({
            provider,
            enabled: config[provider],
            dailyUsed: used.daily,
            dailyLimit: EVENT_LIMITS[provider].daily,
            monthlyUsed: used.monthly,
            monthlyLimit: EVENT_LIMITS[provider].monthly,
          });
        }
        return eventSearchStatusSchema.parse({ providers });
      }, true);
    },
    async search(id: string) {
      const row = (
        await database.pool.query<SearchRow>('select * from integration.event_search where id=$1', [
          id,
        ])
      ).rows[0];
      if (!row) throw new FinanceError('NOT_FOUND');
      return searchDto(row);
    },
    async searches(selectionId: string) {
      const rows = (
        await database.pool.query<SearchRow>(
          'select * from integration.event_search where selection_id=$1 order by created_at desc,id desc limit 20',
          [selectionId],
        )
      ).rows;
      return rows.map(searchDto);
    },
    request(actor: string, key: string, input: EventSearchInput) {
      const command = eventSearchInputSchema.parse(input);
      const hash = createHash('sha256').update(JSON.stringify(command)).digest('hex');
      return transaction(async (client) => {
        await client.query('select pg_advisory_xact_lock(783420096)');
        const previous = (
          await client.query<SearchRow>('select * from integration.event_search where id=$1', [key])
        ).rows[0];
        if (previous) {
          if (previous.actor !== actor || previous.hash !== hash)
            throw new FinanceError('IDEMPOTENCY_CONFLICT');
          return searchDto(previous);
        }
        if (!config[command.provider]) throw new Error('EVENT_PROVIDER_DISABLED');
        const selection = (
          await client.query<{ event: string; sport: string | null }>(
            'select event,sport from finance.selection where id=$1',
            [command.selectionId],
          )
        ).rows[0];
        if (!selection) throw new FinanceError('NOT_FOUND');
        const fingerprint = eventFingerprint(selection.event, selection.sport);
        const cached = command.refresh
          ? undefined
          : (
              await client.query<SearchRow>(
                `select * from integration.event_search
          where provider=$1 and event_fingerprint=$2 and date_hint is not distinct from $3::text
          and state='complete' and cached_from is null and completed_at > now()-interval '24 hours'
          order by completed_at desc limit 1`,
                [command.provider, fingerprint, command.dateHint],
              )
            ).rows[0];
        if (!cached) {
          const active = (
            await client.query<{ count: number }>(
              "select count(*)::int as count from integration.event_search where state in ('pending','processing')",
            )
          ).rows[0]!.count;
          if (active >= 100) throw new Error('EVENT_QUEUE_FULL');
        }
        const query = selection.event;
        const row = (
          await client.query<SearchRow>(
            `insert into integration.event_search
          (id,actor,hash,selection_id,provider,query,event_fingerprint,date_hint,state,candidates,cached_from,completed_at)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,case when $11::uuid is null then null else now() end) returning *`,
            [
              key,
              actor,
              hash,
              command.selectionId,
              command.provider,
              query,
              fingerprint,
              command.dateHint,
              cached ? 'complete' : 'pending',
              JSON.stringify(cached?.candidates ?? []),
              cached?.id ?? null,
            ],
          )
        ).rows[0]!;
        return searchDto(row);
      });
    },
    claim() {
      return transaction(async (client) => {
        await client.query('select pg_advisory_xact_lock(783420096)');
        // An interrupted external call is never retried automatically or charged again.
        await client.query(
          "update integration.event_search set state='failed',error_code='EVENT_OUTCOME_UNCERTAIN',completed_at=now() where state='processing' and started_at < now()-interval '5 minutes'",
        );
        const enabled = (['thesportsdb', 'tavily'] as const).filter((provider) => config[provider]);
        for (const provider of enabled) {
          const used = await usage(client, provider);
          if (used.minute >= EVENT_LIMITS[provider].minute) continue;
          const row = (
            await client.query<SearchRow>(
              "select * from integration.event_search where state='pending' and provider=$1 order by created_at,id for update skip locked limit 1",
              [provider],
            )
          ).rows[0];
          if (!row) continue;
          if (
            used.daily >= EVENT_LIMITS[provider].daily ||
            used.monthly >= EVENT_LIMITS[provider].monthly
          ) {
            await client.query(
              "update integration.event_search set state='failed',error_code='EVENT_QUOTA_REACHED',completed_at=now() where id=$1",
              [row.id],
            );
            continue;
          }
          await client.query(
            "update integration.event_search set state='processing',started_at=now() where id=$1",
            [row.id],
          );
          return searchDto({ ...row, state: 'processing' });
        }
        return null;
      });
    },
    async complete(id: string, candidates: EventCandidate[]) {
      if (candidates.length > 5) throw new Error('INVALID_EVENT_CANDIDATES');
      const parsed = candidates.map((item) => eventCandidateSchema.parse(item));
      await database.pool.query(
        "update integration.event_search set state='complete',candidates=$2,completed_at=now() where id=$1 and state='processing'",
        [id, JSON.stringify(parsed)],
      );
    },
    async fail(id: string, code: string) {
      const allowed = [
        'EVENT_RATE_LIMITED',
        'EVENT_CONNECTION_FAILED',
        'EVENT_INVALID_RESPONSE',
        'EVENT_PROVIDER_UNAVAILABLE',
      ];
      await database.pool.query(
        "update integration.event_search set state='failed',error_code=$2,completed_at=now() where id=$1 and state='processing'",
        [id, allowed.includes(code) ? code : 'EVENT_CONNECTION_FAILED'],
      );
    },
  };
}
export type EventService = ReturnType<typeof createEventService>;

export async function updateEvent(
  client: PoolClient,
  command: Extract<FinanceCommand, { type: 'event.update' }>,
) {
  validateEventDate(command);
  if (
    command.scheduleStatus === 'postponed' &&
    (command.eventDate || command.eventAt || command.dateStatus !== 'pending')
  )
    throw new FinanceError('INVALID_FINANCIAL_OPERATION');
  const before = (
    await client.query<SelectionRow>(
      'select *,event_date::text as event_date from finance.selection where id=$1 for update',
      [command.selectionId],
    )
  ).rows[0];
  if (!before) throw new FinanceError('NOT_FOUND');
  let evidence: EventCandidate | null = null;
  if (command.candidateId) {
    const row = (
      await client.query<{ candidate: unknown }>(
        `select candidate from integration.event_search s,
      lateral jsonb_array_elements(s.candidates) candidate where s.selection_id=$1 and s.state='complete'
      and s.event_fingerprint=$2 and candidate->>'id'=$3 order by s.created_at desc limit 1`,
        [before.id, eventFingerprint(before.event, before.sport), command.candidateId],
      )
    ).rows[0];
    if (!row) throw new FinanceError('STATE_CONFLICT');
    evidence = eventCandidateSchema.parse(row.candidate);
  }
  await client.query(
    `update finance.selection set event_date=$2,event_at=$3,date_status=$4,
    schedule_status=$5,date_source=$6,date_evidence=$7 where id=$1`,
    [
      before.id,
      command.eventDate ?? (command.eventAt ? saoPauloDate(new Date(command.eventAt)) : null),
      command.eventAt,
      command.dateStatus,
      command.scheduleStatus,
      evidence?.provider ?? 'manual',
      JSON.stringify(evidence),
    ],
  );
  // Use the bet entity for the append-only audit and the attachment retention grace period.
  return { id: before.bet_id, before };
}
