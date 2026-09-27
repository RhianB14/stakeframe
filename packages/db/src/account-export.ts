/**
 * STK-F1-08 account export (Plano §7.3/§15): the authenticated user's own file.
 *
 * - `json` streams the account envelope (user, organization, membership, sessions and
 *   providers — never tokens, passwords or credentials) followed by the same portability
 *   tables the report export ships, so nothing the organization holds is missing.
 * - `betsCsv` streams every bet using the STK-BETS-02 columns and semantics: game date and
 *   time come from the selections, the market collapses to the ticket kind for non-simple
 *   tickets, the returned amount is the realized one ('—' while nothing was realized) and
 *   the result uses the canonical outcome labels.
 * - Both share the report-export discipline: one long-lived repeatable-read snapshot per
 *   service, an explicit organization predicate on every query and a hard 120s cap.
 */
import { Readable } from 'node:stream';
import type { PoolClient } from 'pg';
import { betResultLabel, betResultQualifier, betTablePresentation } from '@stakeframe/shared';
import type { Database } from './index.js';
import { ORGANIZATION_CONTEXT_SETTING, type OrganizationContext } from './tenant-context.js';
import { exportPortabilityJson } from './report-export.js';
import { betDtos } from './finance-read.js';
import { csvCell } from './reports.js';
import type { BetRow } from './finance-core.js';

/** STK-BETS-02 columns, owner-approved order. */
const BET_COLUMNS = [
  'Nº do bilhete',
  'Data do jogo',
  'Hora do jogo',
  'Evento',
  'Aposta/seleção',
  'Mercado',
  'Tipo da aposta',
  'Tipster',
  'Casa de aposta',
  'Valor apostado',
  'Odd',
  'Retorno recebido',
  'Resultado/status',
  'ID técnico',
] as const;

const ORGANIZATION = 'current_setting($$app.organization_id$$, true)::uuid';

type BetExportRow = BetRow & { bookmaker_name: string | null; tipster_name: string };

export function createAccountExportService(database: Database) {
  let activeExports = 0;
  /**
   * One long-lived repeatable-read snapshot per process (reports.ts discipline):
   * deliberately NOT read only — a read-only transaction rejects `set_config`, and every
   * statement must see the organization context.
   */
  async function stream(
    context: OrganizationContext,
    content: (client: PoolClient) => AsyncGenerator<string>,
  ): Promise<Readable> {
    if (activeExports >= 1) throw new Error('EXPORT_BUSY');
    activeExports++;
    let client: PoolClient;
    try {
      client = await database.pool.connect();
    } catch (error) {
      activeExports--;
      throw error;
    }
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      activeExports--;
      try {
        await client.query('rollback');
        client.release();
      } catch {
        client.release(true);
      }
    };
    try {
      await client.query('begin isolation level repeatable read');
      await client.query('SELECT set_config($1, $2, true)', [
        ORGANIZATION_CONTEXT_SETTING,
        context.organizationId,
      ]);
    } catch (error) {
      await release();
      throw error;
    }
    const readable = Readable.from(
      (async function* () {
        try {
          yield* content(client);
        } finally {
          await release();
        }
      })(),
    );
    const timer = setTimeout(() => readable.destroy(new Error('EXPORT_TIMEOUT')), 120_000);
    timer.unref();
    readable.once('close', () => {
      clearTimeout(timer);
      void release();
    });
    return readable;
  }

  async function* jsonContent(client: PoolClient, userId: string): AsyncGenerator<string> {
    const user = (
      await client.query(
        `select id,name,email,email_verified as "emailVerified",created_at as "createdAt"
           from auth."user" where id = $1`,
        [userId],
      )
    ).rows[0];
    const organization = (
      await client.query(
        `select id,name,created_at as "createdAt" from core.organization where id = ${ORGANIZATION}`,
      )
    ).rows[0];
    const membership = (
      await client.query(
        `select role,created_at as "createdAt" from core.membership
          where organization_id = ${ORGANIZATION} and user_id = $1`,
        [userId],
      )
    ).rows[0];
    // Sessions and providers never carry tokens or credentials: ids, dates and metadata only.
    const sessions = (
      await client.query(
        `select id,created_at as "createdAt",expires_at as "expiresAt",
                ip_address as "ipAddress",user_agent as "userAgent"
           from auth.session where user_id = $1 order by created_at`,
        [userId],
      )
    ).rows;
    const providers = (
      await client.query(
        `select provider_id as "providerId",created_at as "createdAt"
           from auth.account where user_id = $1 order by created_at`,
        [userId],
      )
    ).rows;
    yield JSON.stringify({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      account: { user, organization, membership, sessions, providers },
    }).slice(0, -1);
    yield ',"history":{';
    yield* exportPortabilityJson(client, '');
    yield '}}';
  }

  async function* betsCsvContent(client: PoolClient): AsyncGenerator<string> {
    yield '\uFEFF' + BET_COLUMNS.map((column) => csvCell(column)).join(',') + '\r\n';
    let cursor: [Date, string] | undefined;
    for (;;) {
      const after = cursor ? `and (b.placed_at,b.id) < ($1,$2)` : '';
      const rows = (
        await client.query<BetExportRow>(
          `select b.*,c.name as bookmaker_name,coalesce(t.name,'Sem tipster') as tipster_name
             from finance.bet b
             left join finance.catalog c on c.id=b.bookmaker_id and c.organization_id=b.organization_id
             left join finance.catalog t on t.id=b.tipster_id and t.organization_id=b.organization_id
            where b.organization_id=${ORGANIZATION} ${after}
            order by b.placed_at desc,b.id desc limit 500`,
          cursor,
        )
      ).rows;
      const bets = await betDtos(client, rows);
      for (const [index, bet] of bets.entries()) {
        const row = rows[index]!;
        const presentation = betTablePresentation(bet);
        const realized = bet.state !== 'open' || Number(bet.returnAmount) !== 0;
        const qualifier = betResultQualifier(bet);
        const status = `${betResultLabel(bet)}${qualifier ? ` (${qualifier})` : ''}`;
        const cells: (string | number)[] = [
          bet.ticketNumber,
          presentation.gameDate,
          presentation.gameTime,
          presentation.event,
          presentation.selection,
          presentation.market,
          presentation.ticketKind,
          row.tipster_name,
          row.bookmaker_name ?? '',
          bet.stake ?? '',
          bet.odds ?? '',
          realized ? bet.returnAmount : '—',
          status,
          bet.id,
        ];
        yield cells.map((cell, column) => csvCell(cell, column === 0)).join(',') + '\r\n';
      }
      if (rows.length < 500) break;
      const last = rows.at(-1)!;
      cursor = [last.placed_at, last.id];
    }
  }

  return {
    async json(context: OrganizationContext, userId: string) {
      // Audit trail of the export event (ttrail, no payloads): written outside the
      // read-only snapshot transaction so the rollback on release cannot erase it.
      await database.pool.query(
        'insert into finance.audit(organization_id,type,actor,entity_id,after) values($1,\'account.export\',$2,$2,\'{"kind":"json"}\')',
        [context.organizationId, userId],
      );
      return stream(context, (client) => jsonContent(client, userId));
    },
    async betsCsv(context: OrganizationContext, userId: string) {
      await database.pool.query(
        'insert into finance.audit(organization_id,type,actor,entity_id,after) values($1,\'account.export\',$2,$2,\'{"kind":"bets.csv"}\')',
        [context.organizationId, userId],
      );
      return stream(context, (client) => betsCsvContent(client));
    },
  };
}

export type AccountExportService = ReturnType<typeof createAccountExportService>;
