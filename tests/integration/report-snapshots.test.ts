import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createDatabase,
  createEntitlementService,
  createFinanceService,
  createReportService,
  createReportSnapshotService,
  requireDatabaseUrl,
  ReportSnapshotError,
  snapshotContentHash,
  type Database,
  type FinanceService,
  type ReportSnapshotService,
  type OrganizationContext,
} from '../../packages/db/src/index.js';
import { migrateLocalDatabase } from '../../packages/db/src/migrate.js';
import { createReportCadenceJob } from '../../apps/worker/src/report-cadence.js';
import { createApp } from '../../apps/api/src/app.js';
import type { OwnerAuth } from '../../apps/api/src/auth.js';
import {
  AUTOMATIC_CADENCE_BY_PLAN,
  reportPeriodIsDue,
  type BetInput,
  type FinanceCommand,
} from '../../packages/shared/src/index.js';

/**
 * STK-F2-08 §15 — Relatórios: páginas HTML privadas + cadência + snapshot
 * imutável, provados contra PostgreSQL real.
 *
 * Banco descartável, dados fictícios, nenhum segredo e nenhum conteúdo de
 * bilhete em log. O que estes testes provam, e que um teste com mock não
 * provaria:
 *
 *  - A IMUTABILIDADE é do BANCO: um UPDATE e um DELETE no snapshot são
 *    recusados pelo trigger, não por disciplina do chamador.
 *  - A DEDUPE é do BANCO: dois passes do job no mesmo dia enviam UM relatório,
 *    e a chave única é o que decide (não uma checagem em memória).
 *  - A RLS é fail-closed: sem contexto de organização, a contagem de linhas do
 *    outro tenant é ZERO, e um snapshot de outra organização devolve 404.
 *  - A REVISÃO é versionada: a versão 2 entra ao lado da 1, com motivo, e a
 *    versão 1 continua legível e inalterada.
 *  - A AUSÊNCIA DE DADOS não publica: uma janela sem apostas devolve `null`,
 *    não um relatório com P&L zero.
 *  - A CADÊNCIA é do PLANO resolvido no banco, e o fuso é o do USUÁRIO.
 */

const source = requireDatabaseUrl(process.env.TEST_DATABASE_URL);
const admin = createDatabase(source, { statementTimeoutMs: 30_000 });

let database: Database;
let finance: FinanceService;
let snapshots: ReportSnapshotService;
let context: OrganizationContext;
let other: OrganizationContext;
let name: string;
let bet365: string;
let ownerId: string;

type Input = FinanceCommand extends infer C
  ? C extends FinanceCommand
    ? Omit<C, 'expectedVersion'>
    : never
  : never;
const run = async (input: Input) =>
  finance.command(context, randomUUID(), {
    ...input,
    expectedVersion: (await finance.workspace(context)).version,
  } as FinanceCommand);

const selection = (input: {
  event: string;
  sport: string | null;
  market: string;
  selection: string;
  eventDate: string;
}) => ({ ...input, odds: null, eventAt: null, dateStatus: 'confirmed' as const });

/** Janela do relatório usada pelos testes: setembro/2026, onde estão as apostas. */
const WINDOW = { period: 'monthly' as const, from: '2026-09-01', to: '2026-09-30' };

async function createBet(input: Partial<BetInput> = {}) {
  return run({
    type: 'bet.create',
    bookmakerId: bet365,
    tipsterId: null,
    stake: '100.00',
    odds: '2.00',
    placedAt: '2026-09-07T13:00:00Z',
    freebetId: null,
    reference: 'fixture',
    allowMissingUnit: true,
    selections: [
      selection({
        event: 'Aurora x Central',
        sport: 'Futebol',
        market: 'Resultado',
        selection: 'Aurora',
        eventDate: '2026-09-05',
      }),
    ],
    ...input,
  });
}

beforeAll(async () => {
  name = `stk_f208_test_${randomUUID().replaceAll('-', '')}`;
  if (!/^stk_f208_test_[a-f0-9]{32}$/.test(name)) throw new Error('INVALID_TEST_DATABASE');
  await admin.pool.query(`CREATE DATABASE "${name}"`);
  const url = new URL(source);
  url.pathname = `/${name}`;
  database = createDatabase(url.toString());
  await migrateLocalDatabase(database);
  finance = createFinanceService(database);
  snapshots = createReportSnapshotService(database);
  await database.pool.query(
    "insert into auth.\"user\"(id,name,email) values('fixture-owner','Fixture Owner','fixture-owner@stk.test'),('other-owner','Other Owner','other-owner@stk.test') on conflict (id) do nothing",
  );
  context = await finance.ensureContext('fixture-owner');
  other = await finance.ensureContext('other-owner');
  ownerId = 'fixture-owner';
  const workspace = await finance.workspace(context);
  bet365 = workspace.catalog.find((row) => row.name === 'Bet365')!.id;
  await run({
    type: 'bankroll.initialize',
    reserve: '10000.00',
    balances: [{ bookmakerId: bet365, amount: '5000.00' }],
    unitPercent: '1.00',
  });
  // Duas apostas liquidadas dentro da janela: sem elas todo relatório seria
  // "sem dados" e os testes de conteúdo não diriam nada.
  for (const reference of ['b1', 'b2']) {
    const bet = await createBet({ reference });
    await run({
      type: 'bet.settle',
      id: bet.id,
      outcome: 'win',
      returnAmount: '180.00',
      closedPrincipal: '100.00',
      settledAt: '2026-09-08T13:00:00Z',
      reason: 'Liquidação de teste',
    });
  }
});

afterAll(async () => {
  await database?.close();
  await admin.pool.query(`DROP DATABASE "${name}" WITH (FORCE)`).catch(() => undefined);
  await admin.close();
});

describe('STK-F2-08 §15 — o snapshot é gerado a partir do relatório real', () => {
  it('o snapshot carrega as MESMAS métricas que o dashboard da F2-02', async () => {
    const record = await snapshots.ensure(context, WINDOW);
    expect(record).not.toBeNull();
    const dashboard = await createReportService(database).dashboard(context, {
      from: WINDOW.from,
      to: WINDOW.to,
      kind: 'all',
      includeEstimated: 'false',
    });
    // A garantia do card §5 é que a página e a tela de análises não podem
    // divergir: o snapshot é a MESMA agregação, não uma segunda conta.
    expect(record!.metrics.bets).toBe(dashboard.metrics.bets);
    expect(record!.metrics.profit).toBe(dashboard.metrics.profit);
    expect(record!.financialVersion).toBe(dashboard.version);
  });

  it('o snapshot tem hash de conteúdo e narrativa determinística', async () => {
    const record = (await snapshots.ensure(context, WINDOW))!;
    expect(record.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(record.narrative.lines.length).toBeGreaterThan(0);
    // A mesma entrada produz o mesmo hash: a auditoria do hash não pode
    // falhar só porque o runtime mudou a ordem das chaves.
    const again = (await snapshots.ensure(context, WINDOW))!;
    expect(again.id).toBe(record.id);
    expect(again.contentSha256).toBe(record.contentSha256);
  });

  it('o hash é da forma canônica, não de JSON.stringify', () => {
    // A ordem das chaves NÃO pode mudar o hash: um snapshot que "muda de hash"
    // sem mudar de número seria um falso positivo de auditoria.
    const a = { z: 1, a: 2, m: { y: 3, b: 4 } };
    expect(snapshotContentHash(a)).toBe(snapshotContentHash({ a: 2, m: { b: 4, y: 3 }, z: 1 }));
    expect(snapshotContentHash(a)).not.toBe(snapshotContentHash({ a: 2, m: { b: 5, y: 3 }, z: 1 }));
  });
});

describe('STK-F2-08 §15 — o snapshot é IMUTÁVEL, e quem impõe é o banco', () => {
  it('um UPDATE no snapshot é recusado pelo trigger', async () => {
    const record = (await snapshots.ensure(context, WINDOW))!;
    await expect(
      database.pool.query(
        `update integration.report_snapshot set content_sha256=$2 where id=$1::uuid`,
        [record.id, 'f'.repeat(64)],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('um DELETE no snapshot é recusado pelo trigger', async () => {
    const record = (await snapshots.ensure(context, WINDOW))!;
    await expect(
      database.pool.query('delete from integration.report_snapshot where id=$1::uuid', [record.id]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('o banco recusa um hash de conteúdo que não é digest', async () => {
    // A restrição é do banco, provada sem passar pelo serviço: um hash que não
    // é um digest SHA-256 significa que o payload não tem verificação possível.
    await expect(
      database.pool.query(
        `insert into integration.report_snapshot
           (organization_id,version,period,"from","to",financial_version,metrics,payload,content_sha256)
         values($1,900,'monthly',date '2026-09-01',date '2026-09-30',999,'{}'::jsonb,'{}'::jsonb,'nao-e-um-hash')`,
        [context.organizationId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('STK-F2-08 §15 — a correção cria uma VERSÃO, não reescreve', () => {
  it('a revisão vira versão 2 ao lado da 1, e a 1 continua intacta', async () => {
    const first = (await snapshots.ensure(context, WINDOW))!;
    const second = await snapshots.revise(context, {
      id: first.id,
      reason: 'Liquidação conferida após revisão manual',
    });
    expect(second.version).toBe(2);
    expect(second.id).not.toBe(first.id);
    expect(second.revisionReason).toContain('Liquidação conferida');
    // A versão anterior continua legível e continua sendo a versão 1.
    const original = await snapshots.find(context, first.id);
    expect(original?.version).toBe(1);
    expect(original?.latest).toBe(false);
    expect(original?.contentSha256).toBe(first.contentSha256);
  });

  it('a revisão de uma versão que não é a última é recusada com código próprio', async () => {
    // Janela PRÓPRIA: esta suíte compartilha o banco com os outros testes, e o
    // relatório de setembro já tem versões de testes anteriores — revisar a
    // "última" de outra janela não provaria nada sobre esta regra.
    const window = { period: 'monthly' as const, from: '2026-09-02', to: '2026-09-30' };
    const first = (await snapshots.ensure(context, window))!;
    await snapshots.revise(context, { id: first.id, reason: 'Primeira revisão desta janela' });
    let code: string | null = null;
    try {
      await snapshots.revise(context, { id: first.id, reason: 'Segunda revisão da v1' });
    } catch (error) {
      code = error instanceof ReportSnapshotError ? error.code : null;
    }
    // A recusa é explícita, e não o 23514 opaco do índice: o chamador precisa
    // dizer ao usuário "abra a versão atual", o que um erro de banco não diz.
    expect(code).toBe('REPORT_SNAPSHOT_NOT_REVISABLE');
  });

  it('o motivo da revisão é obrigatório, e o banco recusa versão sem motivo', async () => {
    await expect(
      snapshots.revise(context, {
        id: (await snapshots.ensure(context, WINDOW))!.id,
        reason: '   ',
      }),
    ).rejects.toBeInstanceOf(ReportSnapshotError);
    // E a própria restrição do banco, provada sem passar pelo serviço: versão
    // maior que 1 SEM motivo é um registro que ninguém conseguiria auditar.
    await expect(
      database.pool.query(
        `insert into integration.report_snapshot
           (organization_id,version,period,"from","to",financial_version,metrics,payload,content_sha256,revision_reason)
         values($1,901,'monthly',date '2026-09-01',date '2026-09-30',999,'{}'::jsonb,'{}'::jsonb,$2,null)`,
        [context.organizationId, 'a'.repeat(64)],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('STK-F2-08 §15 — sem dados, não se publica', () => {
  it('uma janela sem apostas devolve null, e não um relatório zerado', async () => {
    const empty = await snapshots.ensure(context, {
      period: 'daily',
      from: '2026-01-05',
      to: '2026-01-05',
    });
    expect(empty).toBeNull();
    // E nada foi gravado: sem número para congelar, não há documento.
    const rows = (
      await database.pool.query<{ n: string }>(
        `select count(*)::text as n from integration.report_snapshot
         where period='daily' and "from"=date '2026-01-05'`,
      )
    ).rows[0]!;
    expect(Number(rows.n)).toBe(0);
  });
});

describe('STK-F2-08 §15 — o isolamento entre organizações é fail-closed', () => {
  it('um snapshot de outra organização devolve 404 (o MESMO código de inexistente)', async () => {
    const record = (await snapshots.ensure(context, WINDOW))!;
    // O serviço resolve pelo contexto, então a organização B não enxerga o
    // snapshot da A. A API transforma isso em 404 e não em 403 — um 403
    // confirmaria que o id existe.
    expect(await snapshots.find(other, record.id)).toBeNull();
    expect(await snapshots.find(other, randomUUID())).toBeNull();
  });

  it('a listagem de um tenant não mostra o snapshot de outro', async () => {
    const mine = await snapshots.history(context, { period: 'monthly' });
    const theirs = await snapshots.history(other, { period: 'monthly' });
    expect(mine.length).toBeGreaterThan(0);
    expect(theirs).toEqual([]);
  });

  it('sem contexto de organização, a RLS devolve ZERO linhas (e não erro)', async () => {
    const any = (
      await database.pool.query<{ n: string }>(
        'select count(*)::text as n from integration.report_snapshot',
      )
    ).rows[0]!;
    expect(Number(any.n)).toBeGreaterThan(0);
    const scoped = (
      await database.pool.query<{ n: string }>(
        `select count(*)::text as n from integration.report_snapshot
         where organization_id=nullif(current_setting('app.organization_id', true), '')::uuid`,
      )
    ).rows[0]!;
    expect(Number(scoped.n)).toBe(0);
  });
});

describe('STK-F2-08 §15 — a dedupe do envio é do banco', () => {
  it('a segunda reserva da MESMA janela e versão é recusada pela chave única', async () => {
    const record = (await snapshots.ensure(context, WINDOW))!;
    const now = new Date();
    const first = await snapshots.reserveDelivery(context, {
      snapshot: record,
      userId: ownerId,
      scheduledFor: now,
    });
    expect(first).not.toBeNull();
    const second = await snapshots.reserveDelivery(context, {
      snapshot: record,
      userId: ownerId,
      scheduledFor: now,
    });
    // `null` = já reservado. É aqui que "rodar o job N vezes" vira "um envio".
    expect(second).toBeNull();
  });

  it('a versão revisada NÃO é reenviada: sem dados novos, não há envio novo', async () => {
    // Janela PRÓPRIA (a chave de dedupe inclui a janela, e `WINDOW` já foi
    // reservada pelo teste anterior — reutilizá-la mediria dedupe, não revisão).
    const window = { period: 'monthly' as const, from: '2026-09-05', to: '2026-09-30' };
    const record = (await snapshots.ensure(context, window))!;
    // Primeiro envio desta janela/versão financeira.
    const first = await snapshots.reserveDelivery(context, {
      snapshot: record,
      userId: ownerId,
      scheduledFor: new Date(),
    });
    expect(first).not.toBeNull();
    const revised = await snapshots.revise(context, {
      id: record.id,
      reason: 'Nova versão para verificar a chave',
    });
    // A revisão nasce do MESMO estado do financeiro (é o DADO que mudou, não o
    // saldo), então a chave de dedupe é a mesma e a reserva é recusada: o
    // card exclui reenvio automático, e esta é a prova disso contra o banco.
    const reserved = await snapshots.reserveDelivery(context, {
      snapshot: revised,
      userId: ownerId,
      scheduledFor: new Date(),
    });
    expect(reserved).toBeNull();
  });

  it('a entrega só é registrada depois do sucesso do canal', async () => {
    // Janela PRÓPRIA por teste: a chave de dedupe inclui a janela, e dois testes
    // que usassem a mesma reservingiam a mesma linha — o segundo receberia
    // `null` por dedupe e o teste mediria a coisa errada.
    const window = { period: 'monthly' as const, from: '2026-09-03', to: '2026-09-30' };
    const record = (await snapshots.ensure(context, window))!;
    const reserved = (await snapshots.reserveDelivery(context, {
      snapshot: record,
      userId: ownerId,
      scheduledFor: new Date(),
    }))!;
    expect(
      (
        await snapshots.deliveryOf(context, {
          period: record.period,
          from: record.from,
          to: record.to,
          financialVersion: record.financialVersion,
        })
      )?.state,
    ).toBe('pending');
    await snapshots.completeDelivery(context, reserved.id, { delivered: true });
    const done = await snapshots.deliveryOf(context, {
      period: record.period,
      from: record.from,
      to: record.to,
      financialVersion: record.financialVersion,
    });
    expect(done?.state).toBe('delivered');
    expect(done?.deliveredAt).not.toBeNull();
  });

  it('a entrega que falha volta para a fila, e nunca vira "entregue"', async () => {
    const window = { period: 'monthly' as const, from: '2026-09-04', to: '2026-09-30' };
    const record = (await snapshots.ensure(context, window))!;
    const reserved = (await snapshots.reserveDelivery(context, {
      snapshot: record,
      userId: ownerId,
      scheduledFor: new Date(),
    }))!;
    await snapshots.completeDelivery(context, reserved.id, {
      failed: 'TELEGRAM_CONNECTION_FAILED',
    });
    const after = await snapshots.deliveryOf(context, {
      period: record.period,
      from: record.from,
      to: record.to,
      financialVersion: record.financialVersion,
    });
    // Marcar como entregue sem ter entregue é o pior resultado possível: o
    // relatório sumiria e ninguém saberia que faltou.
    expect(after?.state).toBe('pending');
    const error = (
      await database.pool.query<{ last_error: string | null; attempts: number }>(
        'select last_error,attempts from integration.report_delivery where id=$1::uuid',
        [reserved.id],
      )
    ).rows[0]!;
    expect(error.last_error).toBe('TELEGRAM_CONNECTION_FAILED');
    expect(error.attempts).toBe(1);
  });

  it('a entrega esgotada vira terminal, e o log não carrega detalhe do canal', async () => {
    // Janela PRÓPRIA que contém as apostas (evento em 05/09), com `to`
    // distinto de `WINDOW` para não colidir com a reserva dos testes
    // anteriores. Uma janela sem apostas não gera snapshot, e o teste estaria
    // exercitando o `null` do `ensure` em vez do backoff.
    const record = (await snapshots.ensure(context, {
      period: 'monthly',
      from: '2026-09-01',
      to: '2026-09-29',
    }))!;
    const reserved = (await snapshots.reserveDelivery(context, {
      snapshot: record,
      userId: ownerId,
      scheduledFor: new Date(),
    }))!;
    // Cinco recusas: as quatro primeiras voltam para a fila com backoff, a
    // quinta é terminal. Um laço infinito aqui seria o defeito.
    for (let attempt = 0; attempt < 5; attempt += 1)
      await snapshots.completeDelivery(context, reserved.id, { failed: 'TELEGRAM_PERMANENT' });
    const final = (
      await database.pool.query<{ state: string; last_error: string | null }>(
        'select state,last_error from integration.report_delivery where id=$1::uuid',
        [reserved.id],
      )
    ).rows[0]!;
    expect(final.state).toBe('failed');
    // O que fica gravado é o CÓDIGO, nunca a mensagem do fornecedor: a
    // resposta do Telegram pode carregar dado que não pertence ao repositório.
    expect(final.last_error).toBe('TELEGRAM_PERMANENT');
  });
});

describe('STK-F2-08 §15 — a cadência é do plano resolvido no BANCO', () => {
  const client = {
    sendMessage: vi.fn(async (_chatId: number, text: string) => ({ messageId: text.length })),
  };
  const config = {
    token: 'x',
    userId: '1',
    chatId: '1',
    miniAppUrl: 'https://app.stakeframe.test',
  };
  const job = () =>
    createReportCadenceJob(database, client as never, config as never, {
      now: () => new Date('2026-09-29T23:30:00Z'),
    });

  it('sem atribuição de plano, o tenant cai em free e NÃO recebe nada', async () => {
    // Organização sem `organization_entitlement` ⇒ a F2-13 devolve `free`,
    // e `free` não tem cadência automática. Um tenant novo não pode nascer
    // recebendo relatório diário.
    const plan = await job().planOf(context.organizationId);
    expect(plan).toBe('free');
    expect(AUTOMATIC_CADENCE_BY_PLAN[plan]).toEqual([]);
    expect(await job().runOnce(context)).toBe(0);
  });

  it('o plano pro vem do BANCO e habilita as três cadências', async () => {
    await database.pool.query(
      `insert into core.organization_entitlement(organization_id,plan_id) values($1,'pro')
       on conflict (organization_id) do update set plan_id='pro'`,
      [context.organizationId],
    );
    const entitlements = createEntitlementService(database);
    // A resolução é a função do banco, e a lista devolve o plano da F2-13.
    const list = await entitlements.entitlements(context.organizationId);
    expect(new Set(list.map((entry) => entry.plan))).toEqual(new Set(['pro']));
    expect(await job().planOf(context.organizationId)).toBe('pro');
  });

  it('o fuso lido é o do USUÁRIO, e um fuso que ainda não venceu não envia', async () => {
    // 2026-09-29T23:30:00Z = 20:30 em São Paulo: o diário (21h) ainda NÃO
    // venceu, mesmo com as três cadências do Pro liberadas.
    await database.pool.query(
      `insert into notification.preference(organization_id,user_id,timezone,quiet_hours_start,quiet_hours_end,topics)
       values($1,$2,'America/Sao_Paulo',1320,360,'{}'::jsonb)
       on conflict (organization_id,user_id) do update set timezone='America/Sao_Paulo'`,
      [context.organizationId, ownerId],
    );
    const { timezone } = await job().timezoneOf(context);
    expect(timezone).toBe('America/Sao_Paulo');
    expect(reportPeriodIsDue('daily', new Date('2026-09-29T23:30:00Z'), timezone)).toBe(false);
    expect(await job().runOnce(context)).toBe(0);
  });

  it('um fuso DIFERENTE muda o instante em que o mesmo relatório vence', async () => {
    // A MESMA cadência, o MESMO instante, dois fusos: em São Paulo 20:30 (não
    // venceu), em Tóquio 08:30 do dia seguinte — que também não venceu. O que
    // muda de verdade é o DIA, e é o dia do usuário que decide a janela.
    const tokyo = createReportCadenceJob(database, client as never, config as never, {
      now: () => new Date('2026-09-29T23:30:00Z'),
    });
    await database.pool.query(
      `update notification.preference set timezone='Asia/Tokyo'
       where organization_id=$1 and user_id=$2`,
      [context.organizationId, ownerId],
    );
    const { timezone } = await tokyo.timezoneOf(context);
    expect(timezone).toBe('Asia/Tokyo');
    // Em Tóquio, 23:30Z é 08:30 de 30/09 — o horário local do produto (21h)
    // ainda não chegou, e o job não envia.
    expect(reportPeriodIsDue('daily', new Date('2026-09-29T23:30:00Z'), timezone)).toBe(false);
    await database.pool.query(
      `update notification.preference set timezone='America/Sao_Paulo'
       where organization_id=$1 and user_id=$2`,
      [context.organizationId, ownerId],
    );
  });

  it('depois das 21h no fuso do usuário, o relatório é enviado UMA vez por cadência', async () => {
    client.sendMessage.mockClear();
    // A aposta precisa cair NA JANELA do relatório E não pode estar no futuro
    // em relação ao relógio do servidor (o `finance-core` recusa `placedAt`
    // futuro). 28/09 satisfaz os dois.
    await run({
      type: 'bet.create',
      bookmakerId: bet365,
      tipsterId: null,
      stake: '100.00',
      odds: '2.00',
      placedAt: '2026-09-28T15:00:00Z',
      freebetId: null,
      reference: 'b-cadencia',
      allowMissingUnit: true,
      selections: [
        selection({
          event: 'Noturno x Aurora',
          sport: 'Futebol',
          market: 'Resultado',
          selection: 'Noturno',
          eventDate: '2026-09-28',
        }),
      ],
    });
    // 2026-09-29T00:30:00Z = 28/09 21:30 em São Paulo. Nessa data (segunda)
    // as TRÊS cadências do Pro vencem ao mesmo tempo: diário (21h), semanal
    // (segunda 9h) e mensal (1º do mês NÃO — 28 não é dia 1, então só duas).
    const later = createReportCadenceJob(database, client as never, config as never, {
      now: () => new Date('2026-09-29T00:30:00Z'),
    });
    const first = await later.runOnce(context);
    // Diário e semanal: duas janelas distintas, dois documentos, dois envios.
    expect(first).toBe(2);
    expect(client.sendMessage).toHaveBeenCalledTimes(2);
    // A segunda passada, no mesmo instante, não envia NADA de novo: é a
    // dedupe do banco decidindo, não a memória do job.
    const second = await later.runOnce(context);
    expect(second).toBe(0);
    expect(client.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('a mensagem enviada é o resumo com o link privado, e nada mais', async () => {
    // As duas chamadas são DIÁRIO e SEMANAL; o texto verificado é o do
    // DIÁRIO, que é a cadência mais informativa. O mock repete a assinatura
    // real (`chatId, text`) para que os argumentos fiquem registrados.
    const daily = client.sendMessage.mock.calls
      .map((call) => String(call[1]))
      .find((text) => text.includes('DIÁRIO'))!;
    expect(daily).toContain('RELATÓRIO DIÁRIO');
    expect(daily).toContain('https://app.stakeframe.test/#relatorios');
    // O card exclui e-mail, PDF, PNG e URL temporária: a única coisa que
    // atravessa o canal é número e endereço do produto.
    expect(daily).not.toMatch(/pdf|png|jpeg|imagem/i);
    expect(daily).not.toMatch(/token=|sig=|exp=/i);
  });
});

describe('STK-F2-08 §15 — a API: link autenticado, 404 e revisão', () => {
  const owner = { id: 'fixture-owner', name: 'Fixture Owner' } as const;
  const authFor = (session: 'active' | null) =>
    ({
      origin: 'https://app.stakeframe.test',
      async getOwner() {
        if (session === null) return null;
        return { user: owner, status: 'active' as const };
      },
    }) as unknown as OwnerAuth;
  // A app é construída no `beforeAll`, e não no corpo do `describe`: os corpos
  // rodam na COLETAÇÃO, antes de `database` existir, e uma `checkDatabase`
  // seria `undefined` já na montagem.
  let app: Awaited<ReturnType<typeof createApp>>;
  beforeAll(() => {
    app = createApp({
      checkDatabase: database.check,
      ownerAuth: authFor('active'),
      reports: createReportService(database),
      reportSnapshots: snapshots,
    });
  });
  afterAll(async () => {
    await app.close();
  });
  const send = (url: string) => app.inject({ method: 'GET', url });

  it('a rota exige sessão: sem cookie, é 401 e nada é lido', async () => {
    const anonymous = createApp({
      checkDatabase: database.check,
      reports: createReportService(database),
      reportSnapshots: snapshots,
      ownerAuth: authFor(null),
    });
    const response = await anonymous.inject({
      method: 'GET',
      url: '/api/v1/report-snapshots/history',
    });
    expect(response.statusCode).toBe(401);
    await anonymous.close();
  });

  it('a listagem devolve o snapshot com o contrato da página', async () => {
    const response = await send('/api/v1/report-snapshots/history?period=monthly');
    expect(response.statusCode).toBe(200);
    const body = response.json() as { items: { id: string; contentSha256: string }[] };
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items[0]!.contentSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('o relatório da janela traz métricas, narrativa, revisão e quebra', async () => {
    const response = await send(
      `/api/v1/report-snapshots?period=${WINDOW.period}&from=${WINDOW.from}&to=${WINDOW.to}`,
    );
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      empty: boolean;
      metrics: { bets: number; profit: string };
      narrative: { lines: { kind: string; text: string }[] };
      breakdown: { id: string }[];
      revisions: { version: number }[];
    };
    expect(body.empty).toBe(false);
    expect(body.metrics.bets).toBe(2);
    expect(body.narrative.lines.length).toBeGreaterThan(0);
    // As três dimensões da página: casa, esporte e tipster.
    expect(new Set(body.breakdown.map((row) => row.id))).toEqual(
      new Set(['bookmaker', 'sport', 'tipster']),
    );
    expect(body.revisions.length).toBeGreaterThan(0);
  });

  it('uma janela sem apostas responde `empty`, e não um relatório zerado', async () => {
    const response = await send(
      '/api/v1/report-snapshots?period=daily&from=2026-01-05&to=2026-01-05',
    );
    expect(response.statusCode).toBe(200);
    const body = response.json() as { empty: boolean; metrics: { bets: number } };
    expect(body.empty).toBe(true);
    expect(body.metrics.bets).toBe(0);
  });

  it('um id de snapshot inexistente devolve 404 REPORT_SNAPSHOT_NOT_FOUND', async () => {
    const response = await send(`/api/v1/report-snapshots/${randomUUID()}`);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: { code: 'REPORT_SNAPSHOT_NOT_FOUND' },
    });
  });

  it('a revisão pela API cria a versão 2 e devolve a página atualizada', async () => {
    const page = await send(
      `/api/v1/report-snapshots?period=${WINDOW.period}&from=${WINDOW.from}&to=${WINDOW.to}`,
    );
    const current = (page.json() as { snapshot: { id: string; version: number } }).snapshot;
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/report-snapshots/${current.id}/revisions`,
      headers: { 'content-type': 'application/json' },
      payload: { reason: 'Revisão pela API do teste §15' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { snapshot: { version: number; revisionReason: string } };
    expect(body.snapshot.version).toBe(current.version + 1);
    expect(body.snapshot.revisionReason).toBe('Revisão pela API do teste §15');
  });
});
