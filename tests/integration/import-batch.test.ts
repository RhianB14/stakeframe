import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
// IMPORTANTE: a rota resolve '@stakeframe/db' pelo exports do pacote (dist).
// O harness importa o MESMO arquivo dist para que `instanceof ImportBatchError`
// se comporte como em produção (src × dist são classes diferentes).
import {
  ImportBatchError,
  createDatabase,
  createEntitlementService,
  createFinanceService,
  createImportBatchService,
  requireDatabaseUrl,
  type Database,
  type FinanceService,
  type ImportBatchService,
  type OrganizationContext,
} from '../../packages/db/dist/index.js';
import { migrateLocalDatabase } from '../../packages/db/src/migrate.js';
import { executeFinancialCommand } from '../../packages/db/src/finance-transaction.js';
import { createApp } from '../../apps/api/src/app.js';
import type { OwnerAuth } from '../../apps/api/src/auth.js';
import { IMPORT_COLUMNS, type ImportMapping } from '../../packages/shared/src/index.js';

// STK-F2-09 §15 — a importação por arquivo contra o PostgreSQL REAL: CSV válido,
// inválido, duplicado, parcial e rollback, mais a idempotência na repetição.
//
// O banco é descartável (CREATE DATABASE + migrate + DROP) e os fixtures são
// FICTÍCIOS. Nenhuma chamada paga, nenhum fornecedor, nenhuma API de casa: o
// que se prova é o comportamento do SQL e da fronteira financeira.

const source = requireDatabaseUrl(process.env.TEST_DATABASE_URL);
const admin = createDatabase(source, { statementTimeoutMs: 30_000 });
const name = `stk_f209_test_${randomUUID().replaceAll('-', '')}`;

let database: Database;
let finance: FinanceService;
let batches: ImportBatchService;
let context: OrganizationContext;
let app: ReturnType<typeof createApp>;
let created = false;
let houseId = '';
let freebetId = '';

const session = { cookie: 'session=fake', origin: 'https://stakeframe.test' };

/**
 * Uma data no passado distante, no formato que o template documenta
 * (DD/MM/AAAA HH:MM, fuso de São Paulo). O `bet.create` recusa registro futuro,
 * por isso a data é fixa e antiga — um instante derivado de `Date.now()`
 * deixaria o teste passar ou falhar conforme o dia em que ele roda.
 */
const PAST = '10/03/2026 20:30';

const TEMPLATE_HEADERS = [...IMPORT_COLUMNS];

/** Uma linha do template Stakeframe, na ordem das colunas canônicas. */
function templateRow(
  overrides: Partial<Record<(typeof IMPORT_COLUMNS)[number], string>> = {},
): string[] {
  const base: Record<(typeof IMPORT_COLUMNS)[number], string> = {
    reference: 'F209-0001',
    bookmaker: 'Bet365',
    tipster: '',
    stake: '50.00',
    odds: '1.85',
    placed_at: PAST,
    sport: 'Futebol',
    event: 'Alfa x Beta',
    market: 'Resultado da partida',
    selection: 'Alfa',
    bet_origin: 'real',
    freebet_id: '',
  };
  const merged = { ...base, ...overrides };
  return IMPORT_COLUMNS.map((column) => merged[column] ?? '');
}

const csv = (headers: string[], rows: string[][]): string =>
  [headers.join(','), ...rows.map((row) => row.map(csvCell).join(','))].join('\n');

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

const count = async (query: string, params: unknown[] = []) =>
  Number((await database.pool.query<{ n: string }>(query, params)).rows[0]!.n);

/**
 * As contagens de APOSTAS e de ESTORNOS são POR LOTE, e não do banco inteiro.
 *
 * A limpeza entre casos REVERTE pelo caminho canônico (`bet.cancel`), então a
 * aposta e o seu journal de reversão permanecem no histórico — que é o
 * comportamento correto do produto, e por isso o total do banco só cresce. O
 * que o teste precisa é do que AQUELA operação fez, e a aposta revertida
 * anterior é de outro lote.
 */
const betsOfBatch = (batchId: string) =>
  count('select count(*)::text as n from finance.bet where import_batch_id=$1', [batchId]);
const reversalsOfBatch = (batchId: string) =>
  count(
    "select count(*)::text as n from finance.journal j where j.kind='reversal' and j.reversal_of in (select stake_journal_id from finance.bet where import_batch_id=$1)",
    [batchId],
  );

const betCount = () => count('select count(*)::text as n from finance.bet');
const openBets = () => count("select count(*)::text as n from finance.bet where state='open'");
const exposure = async () =>
  (
    await database.pool.query<{ n: string }>(
      "select coalesce(sum(p.amount),0)::text as n from finance.posting p join finance.account a on a.id=p.account_id where a.kind='exposure'",
    )
  ).rows[0]!.n;

const preview = (content: string, mapping: ImportMapping | null = null) =>
  batches.preview(context, { content, filename: 'f209.csv', mapping });

beforeAll(async () => {
  if (!/^stk_f209_test_[a-f0-9]{32}$/.test(name)) throw new Error('INVALID_TEST_DATABASE');
  await admin.pool.query(`CREATE DATABASE "${name}"`);
  created = true;
  const url = new URL(source);
  url.pathname = `/${name}`;
  database = createDatabase(url.toString(), { statementTimeoutMs: 30_000 });
  await migrateLocalDatabase(database);
  await database.pool.query(
    "insert into auth.\"user\"(id,name,email) values('fixture-owner','Owner F209','owner-f209@stk.test') on conflict (id) do nothing",
  );
  context = await createFinanceService(database).ensureContext('fixture-owner');
  finance = createFinanceService(database);
  batches = createImportBatchService(database);
  const workspace = await finance.workspace(context);
  houseId = workspace.catalog.find((item) => item.name === 'Bet365')!.id;
  await finance.command(context, randomUUID(), {
    type: 'bankroll.initialize',
    reserve: '5000.00',
    balances: [{ bookmakerId: houseId, amount: '5000.00' }],
    unitPercent: '2.00',
    expectedVersion: workspace.version,
  });
  const freebet = await finance.command(context, randomUUID(), {
    type: 'freebet.create',
    bookmakerId: houseId,
    amount: '20.00',
    expiresOn: '2030-01-01',
    stakeReturned: true,
    note: 'f209 fixture',
    expectedVersion: (await finance.workspace(context)).version,
  });
  freebetId = freebet.id;
  const getOwner = vi.fn(async (headers: Headers) =>
    headers.get('cookie')?.includes('session=fake')
      ? { user: { id: 'fixture-owner' }, status: 'active' }
      : null,
  );
  const ownerAuth = { origin: session.origin, getOwner } as unknown as OwnerAuth;
  app = createApp({
    checkDatabase: database.check,
    ownerAuth,
    finance,
    // A importação por arquivo é um serviço PRÓPRIO: a `imports` (foto) e a
    // `importBatches` (arquivo) são rotas diferentes, com contrato e estados
    // diferentes, e uma não pode servir a outra.
    importBatches: batches,
    entitlements: createEntitlementService(database),
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  try {
    await database?.close();
    if (created && /^stk_f209_test_[a-f0-9]{32}$/.test(name))
      await admin.pool.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  } finally {
    await admin.close();
  }
});

// Cada caso parte de um estado limpo: a exposição é a verdade que o rollback
// precisa devolver, e uma aposta de um teste anterior a contaminaria.
//
// A limpeza usa o id da organização DIRETO, e não `current_setting`: fora de
// uma transação com contexto, o setting não existe e o cast para uuid falha —
// o que é a fronteira fail-closed do produto funcionando, e não um bug do
// teste. A organização aqui é a do fixture, e o isolamento continua sendo
// provado pelos testes de RLS.
/**
 * O estado limpo entre os casos.
 *
 * `finance.journal` e `finance.posting` são IMUTÁVEIS por trigger (a 0002), e
 * a checagem de exposição do `executeFinancialCommand` compara a soma das
 * apostas abertas com o saldo da conta. Apagar a aposta e deixaria o posting
 * órfão, e a próxima confirmação falharia por uma divergência que o teste
 * criou — não um defeito do produto.
 *
 * Por isso a limpeza REVERTE pelo MESMO caminho canônico (`bet.cancel`), que
 * escreve o journal de reversão e mantém a verdade contábil fechada. É a
 * operação de negócio, e não um atalho de teste.
 */
async function resetFinancials() {
  const open = await database.pool.query<{ id: string }>(
    "select id from finance.bet where organization_id=$1 and state='open'",
    [context.organizationId],
  );
  let version = (
    await database.pool.query<{ version: number }>(
      'select version from finance.settings where organization_id=$1',
      [context.organizationId],
    )
  ).rows[0]!.version;
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("select set_config('app.organization_id', $1, true)", [
      context.organizationId,
    ]);
    const settings = (await client.query('select * from finance.settings for update')).rows[0]!;
    for (const bet of open.rows) {
      await executeFinancialCommand(
        client,
        context.userId,
        randomUUID(),
        {
          type: 'bet.cancel',
          expectedVersion: version,
          id: bet.id,
          effectiveAt: new Date().toISOString(),
          reason: 'Limpeza do teste de importacao por arquivo',
        },
        { ...settings, version },
      );
      version += 1;
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

beforeEach(async () => {
  await resetFinancials();
  await database.pool.query('update finance.freebet set used_by=null where organization_id=$1', [
    context.organizationId,
  ]);
  await database.pool.query(
    'delete from integration.import_batch_receipt where organization_id=$1',
    [context.organizationId],
  );
  await database.pool.query('delete from integration.import_batch where organization_id=$1', [
    context.organizationId,
  ]);
});

describe('STK-F2-09 §15 — o template do Stakeframe entra pelo caminho do template', () => {
  it('o template é reconhecido pelo cabeçalho e o preview não escreve aposta', async () => {
    const content = csv(TEMPLATE_HEADERS, [
      templateRow(),
      templateRow({ reference: 'F209-0002', selection: 'Empate' }),
    ]);
    const { preview: view } = await preview(content);
    expect(view.source).toBe('stakeframe_template');
    expect(view.total).toBe(2);
    expect(view.valid).toBe(2);
    expect(view.invalid).toBe(0);
    expect(view.confirmable).toBe(true);
    // A fronteira financeira do card: preview é LEITURA.
    expect(await betCount()).toBe(0);
    expect(Number(await exposure())).toBe(0);
  });

  it('as duas linhas da mesma referência formam UMA aposta (múltipla)', async () => {
    const content = csv(TEMPLATE_HEADERS, [
      templateRow({ reference: 'F209-M', selection: 'Alfa' }),
      templateRow({ reference: 'F209-M', selection: 'Empate', event: 'Gama x Delta' }),
    ]);
    const { preview: view, batchId, version } = await preview(content);
    expect(view.valid).toBe(2);
    expect(view.groups).toBe(1);
    const result = await batches.commit(context, randomUUID(), batchId, {
      version,
      reason: 'importacao f209 de teste',
    });
    expect(result.bets).toHaveLength(1);
    expect(result.bets[0]!.lines).toEqual([2, 3]);
    expect(await betCount()).toBe(1);
    expect(
      await count('select count(*)::text as n from finance.selection where bet_id=$1', [
        result.bets[0]!.betId,
      ]),
    ).toBe(2);
  });

  it('a aposta gravada carrega a marcação de origem do lançamento', async () => {
    const content = csv(TEMPLATE_HEADERS, [templateRow()]);
    const { batchId, version } = await preview(content);
    const result = await batches.commit(context, randomUUID(), batchId, {
      version,
      reason: 'importacao f209 de teste',
    });
    const row = (
      await database.pool.query<{ import_origin: string; import_batch_id: string }>(
        'select import_origin, import_batch_id from finance.bet where id=$1',
        [result.bets[0]!.betId],
      )
    ).rows[0]!;
    expect(row.import_origin).toBe('stakeframe_template');
    expect(row.import_batch_id).toBe(batchId);
  });
});

describe('STK-F2-09 §15 — o CSV genérico entra pelo mapeamento declarado', () => {
  const genericHeaders = [
    'quando',
    'quanto',
    'casa',
    'coeficiente',
    'evento',
    'mercado',
    'palpite',
  ];
  const mapping: ImportMapping = {
    headers: genericHeaders,
    mapping: [
      { header: 'quando', column: 'placed_at' },
      { header: 'quanto', column: 'stake' },
      { header: 'casa', column: 'bookmaker' },
      { header: 'coeficiente', column: 'odds' },
      { header: 'evento', column: 'event' },
      { header: 'mercado', column: 'market' },
      { header: 'palpite', column: 'selection' },
    ],
    defaultBookmaker: null,
    defaultTipster: null,
    defaultBetOrigin: null,
  };
  const genericRow = (overrides: Record<string, string> = {}) => {
    const base: Record<string, string> = {
      quando: PAST,
      quanto: '25.00',
      casa: 'Superbet',
      coeficiente: '2.10',
      evento: 'Epsilon x Zeta',
      mercado: 'Mais de 2,5 gols',
      palpite: 'Mais de 2,5',
    };
    return genericHeaders.map((header) => (overrides[header] ?? base[header] ?? '') as string);
  };

  it('sem mapeamento declarado, um CSV genérico é RECUSADO', async () => {
    await expect(preview(csv(genericHeaders, [genericRow()]))).rejects.toMatchObject({
      code: 'IMPORT_MAPPING_CONFLICT',
    });
  });

  it('com o mapeamento declarado, o mesmo arquivo vira aposta', async () => {
    const {
      preview: view,
      batchId,
      version,
    } = await preview(csv(genericHeaders, [genericRow()]), mapping);
    expect(view.source).toBe('csv_generic');
    expect(view.valid).toBe(1);
    const result = await batches.commit(context, randomUUID(), batchId, {
      version,
      reason: 'importacao generica de teste',
    });
    expect(result.state).toBe('committed');
    const origin = (
      await database.pool.query<{ import_origin: string }>(
        'select import_origin from finance.bet where id=$1',
        [result.bets[0]!.betId],
      )
    ).rows[0]!;
    expect(origin.import_origin).toBe('csv_generic');
  });

  it('duas colunas para o mesmo campo é conflito, e nada é gravado', async () => {
    await expect(
      preview(csv(genericHeaders, [genericRow()]), {
        ...mapping,
        mapping: [...mapping.mapping, { header: 'quanto', column: 'stake' }],
      }),
    ).rejects.toMatchObject({ code: 'IMPORT_MAPPING_CONFLICT' });
    // Nada foi criado: a recusa acontece ANTES de qualquer escrita.
    expect(await openBets()).toBe(0);
  });
});

describe('STK-F2-09 §15 — CSV inválido: a linha é recusada, o arquivo continua', () => {
  it('casa inexistente, valor inválido e data futura recusam só as próprias linhas', async () => {
    const content = csv(TEMPLATE_HEADERS, [
      templateRow({ reference: 'OK-1' }),
      templateRow({ reference: 'BAD-CASA', bookmaker: 'Casa Que Nao Existe' }),
      templateRow({ reference: 'BAD-STAKE', stake: 'cinquenta' }),
      templateRow({ reference: 'BAD-ODDS', odds: '0.10' }),
      templateRow({ reference: 'BAD-FUTURO', placed_at: '01/01/2099 10:00' }),
      templateRow({ reference: 'BAD-DATA', placed_at: '31/02/2026 10:00' }),
    ]);
    const { preview: view } = await preview(content);
    expect(view.total).toBe(6);
    expect(view.valid).toBe(1);
    expect(view.invalid).toBe(5);
    const byLine = new Map(view.rows.map((row) => [row.line, row.errors]));
    expect(byLine.get(3)).toEqual(['IMPORT_BOOKMAKER_UNRESOLVED']);
    expect(byLine.get(4)).toEqual(['IMPORT_STAKE_INVALID']);
    expect(byLine.get(5)).toEqual(['IMPORT_ODDS_INVALID']);
    expect(byLine.get(6)).toEqual(['IMPORT_PLACED_AT_FUTURE']);
    expect(byLine.get(7)).toEqual(['IMPORT_PLACED_AT_INVALID']);
    // Nenhuma mensagem carrega o valor que falhou.
    expect(JSON.stringify(view)).not.toMatch(/cinquenta|Casa Que Nao Existe/);
  });

  it('linha vazia é contada, não ignorada', async () => {
    const content = `${csv(TEMPLATE_HEADERS, [templateRow()])}\n`;
    const { preview: view } = await preview(content);
    expect(view.total).toBe(1);
    expect(view.valid).toBe(1);
  });
});

describe('STK-F2-09 §15 — CSV duplicado', () => {
  it('a linha repetida DENTRO do arquivo é marcada duplicata e não entra', async () => {
    const content = csv(TEMPLATE_HEADERS, [
      templateRow({ reference: 'DUP-1' }),
      templateRow({ reference: 'DUP-1' }),
    ]);
    const { preview: view, batchId, version } = await preview(content);
    expect(view.valid).toBe(1);
    expect(view.duplicates).toBe(1);
    const result = await batches.commit(context, randomUUID(), batchId, {
      version,
      reason: 'importacao com duplicata de teste',
    });
    expect(result.committed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.partial).toBe(true);
    expect(await openBets()).toBe(1);
  });

  it('a MESMA aposta em outro upload é o MESMO lote: identidade por conteúdo', async () => {
    const content = csv(TEMPLATE_HEADERS, [templateRow()]);
    const first = await preview(content);
    const second = await preview(content);
    expect(second.batchId).toBe(first.batchId);
    expect(await count('select count(*)::text as n from integration.import_batch')).toBe(1);
  });
});

describe('STK-F2-09 §15 — resultado parcial explícito', () => {
  it('committed + skipped fecha com o total, e o estado diz PARCIAL', async () => {
    const content = csv(TEMPLATE_HEADERS, [
      templateRow({ reference: 'P-1' }),
      templateRow({ reference: 'P-2', bookmaker: 'Casa Inexistente' }),
      templateRow({ reference: 'P-3' }),
    ]);
    const { batchId, version } = await preview(content);
    const result = await batches.commit(context, randomUUID(), batchId, {
      version,
      reason: 'importacao parcial de teste',
    });
    expect(result.state).toBe('partially_committed');
    expect(result.partial).toBe(true);
    expect(result.total).toBe(3);
    expect(result.committed + result.skipped).toBe(result.total);
    expect(result.committed).toBe(2);
    expect(result.skippedRows).toEqual([{ line: 3, code: 'IMPORT_BOOKMAKER_UNRESOLVED' }]);
    // As duas linhas válidas viraram apostas REAIS de verdade: R$ 100 de
    // exposição, que é a soma das duas stakes de R$ 50.
    expect(await betsOfBatch(batchId)).toBe(2);
    expect(await openBets()).toBe(2);
    expect(await exposure()).toBe('100.00');
  });

  it('o usuário pode escolher só um subconjunto, e o resto conta como pulado', async () => {
    const content = csv(TEMPLATE_HEADERS, [
      templateRow({ reference: 'S-1' }),
      templateRow({ reference: 'S-2' }),
      templateRow({ reference: 'S-3' }),
    ]);
    const { batchId, version } = await preview(content);
    const result = await batches.commit(context, randomUUID(), batchId, {
      version,
      lines: [2],
      reason: 'importacao parcial escolhida',
    });
    expect(result.committed).toBe(1);
    expect(result.committed + result.skipped).toBe(result.total);
    expect(await openBets()).toBe(1);
  });
});

describe('STK-F2-09 §15 — idempotência na repetição', () => {
  it('a MESMA chave de confirmação devolve o MESMO resultado, sem duplicar', async () => {
    const content = csv(TEMPLATE_HEADERS, [templateRow({ reference: 'I-1' })]);
    const { batchId, version } = await preview(content);
    const key = randomUUID();
    const first = await batches.commit(context, key, batchId, {
      version,
      reason: 'importacao idempotente de teste',
    });
    const second = await batches.commit(context, key, batchId, {
      version,
      reason: 'importacao idempotente de teste',
    });
    expect(second).toEqual(first);
    // UMA aposta, e um lançamento de exposição: a repetição não duplicou nada.
    // A aposta do LOTE é a prova: se o segundo commit tivesse gravado, existiria
    // uma segunda linha para o mesmo `import_batch_id`.
    expect(await betsOfBatch(batchId)).toBe(1);
    expect(await openBets()).toBe(1);
    // E o recibo do lote existe uma vez só, com a chave da confirmação.
    expect(
      await count(
        'select count(*)::text as n from integration.import_batch_receipt where batch_id=$1',
        [batchId],
      ),
    ).toBe(1);
  });

  it('a MESMA chave com outro conteúdo é conflito, não um segundo lançamento', async () => {
    const content = csv(TEMPLATE_HEADERS, [templateRow({ reference: 'I-2' })]);
    const { batchId, version } = await preview(content);
    const key = randomUUID();
    await batches.commit(context, key, batchId, { version, reason: 'primeira confirmacao' });
    await expect(
      batches.commit(context, key, batchId, { version, reason: 'outra confirmacao' }),
    ).rejects.toMatchObject({ code: 'IMPORT_BATCH_ALREADY_COMMITTED' });
    expect(await openBets()).toBe(1);
  });

  it('a versão desatualizada recusa, e o lote não muda de estado', async () => {
    const content = csv(TEMPLATE_HEADERS, [templateRow({ reference: 'V-1' })]);
    const { batchId, version } = await preview(content);
    await expect(
      batches.commit(context, randomUUID(), batchId, {
        version: version + 1,
        reason: 'versao desatualizada',
      }),
    ).rejects.toMatchObject({ code: 'IMPORT_BATCH_STATE_CONFLICT' });
    const state = await batches.detail(context, batchId);
    expect(state.state).toBe('preview');
  });
});

describe('STK-F2-09 §15 — rollback do lote', () => {
  it('reverte as apostas pelo caminho canônico e devolve a exposição', async () => {
    const content = csv(TEMPLATE_HEADERS, [
      templateRow({ reference: 'R-1' }),
      templateRow({ reference: 'R-2' }),
    ]);
    const { batchId, version } = await preview(content);
    const result = await batches.commit(context, randomUUID(), batchId, {
      version,
      reason: 'importacao para reverter',
    });
    expect(result.bets).toHaveLength(2);
    expect(await openBets()).toBe(2);
    const exposed = await exposure();

    const reverted = await batches.rollback(context, randomUUID(), batchId, { version });
    expect(reverted.state).toBe('rolled_back');
    expect(reverted.committed).toBe(0);
    expect(reverted.rolledBackAt).not.toBeNull();
    // A aposta NÃO some: ela fica cancelada, e o estorno existe no histórico.
    expect(await betsOfBatch(batchId)).toBe(2);
    expect(await openBets()).toBe(0);
    expect(await exposure()).toBe('0.00');
    expect(Number(exposed)).toBeGreaterThan(0);
    // O journal de reversão é o que mantém a verdade contábil, e é UM por
    // aposta do lote — nunca dois para a mesma.
    expect(await reversalsOfBatch(batchId)).toBe(2);
    // E as apostas continuam marcadas com a origem do lançamento, mesmo
    // depois de revertidas: a marcação é do fato, não do estado.
    expect(
      await count(
        "select count(*)::text as n from finance.bet where import_batch_id=$1 and import_origin='stakeframe_template'",
        [batchId],
      ),
    ).toBe(2);
  });

  it('reverter duas vezes NÃO estorna duas vezes', async () => {
    const content = csv(TEMPLATE_HEADERS, [templateRow({ reference: 'R-3' })]);
    const { batchId, version } = await preview(content);
    await batches.commit(context, randomUUID(), batchId, {
      version,
      reason: 'importacao para reverter duas vezes',
    });
    const first = await batches.rollback(context, randomUUID(), batchId, { version });
    const second = await batches.rollback(context, randomUUID(), batchId, { version });
    expect(second.state).toBe(first.state);
    expect(await reversalsOfBatch(batchId)).toBe(1);
  });

  it('reverter um lote em preview não toca em nada — nada foi gravado', async () => {
    const content = csv(TEMPLATE_HEADERS, [templateRow({ reference: 'R-4' })]);
    const { batchId, version } = await preview(content);
    const reverted = await batches.rollback(context, randomUUID(), batchId, { version });
    expect(reverted.state).toBe('rolled_back');
    expect(await betsOfBatch(batchId)).toBe(0);
    expect(await reversalsOfBatch(batchId)).toBe(0);
  });
});

describe('STK-F2-09 §15 — a origem financeira é declarada no arquivo', () => {
  it('freebet SEM crédito declarado é recusada: nenhum caixa exposto por palpite', async () => {
    const content = csv(TEMPLATE_HEADERS, [
      templateRow({ reference: 'F-1', bet_origin: 'freebet' }),
    ]);
    const { preview: view } = await preview(content);
    expect(view.invalid).toBe(1);
    expect(view.rows[0]!.errors).toEqual(['IMPORT_FREEBET_REQUIRED']);
  });

  it('freebet COM crédito válido da casa entra, e consome o crédito', async () => {
    const content = csv(TEMPLATE_HEADERS, [
      templateRow({
        reference: 'F-2',
        bet_origin: 'freebet',
        freebet_id: freebetId,
        stake: '20.00',
      }),
    ]);
    const { preview: view, batchId, version } = await preview(content);
    expect(view.valid).toBe(1);
    const result = await batches.commit(context, randomUUID(), batchId, {
      version,
      reason: 'importacao de freebet',
    });
    expect(result.state).toBe('committed');
    // Freebet pura não expõe o caixa — a regra é a mesma do formulário.
    expect(await exposure()).toBe('0.00');
    expect(
      await count('select count(*)::text as n from finance.freebet where used_by is not null'),
    ).toBe(1);
  });

  it('dinheiro real COM crédito declarado é contradição, e a linha é recusada', async () => {
    const content = csv(TEMPLATE_HEADERS, [
      templateRow({ reference: 'F-3', bet_origin: 'real', freebet_id: freebetId }),
    ]);
    const { preview: view } = await preview(content);
    expect(view.rows[0]!.errors).toEqual(['IMPORT_ROW_INCOMPATIBLE']);
  });

  it('origem fora do vocabulário fechado é recusada, nunca achatada', async () => {
    const content = csv(TEMPLATE_HEADERS, [
      templateRow({ reference: 'F-4', bet_origin: 'talvez seja promo' }),
    ]);
    const { preview: view } = await preview(content);
    expect(view.rows[0]!.errors).toEqual(['IMPORT_ORIGIN_INVALID']);
  });
});

describe('STK-F2-09 §15 — a API recusa com o código certo e orienta o fluxo', () => {
  it('o template responde com os cabeçalhos canônicos do produto', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/import-batches/template',
      headers: session,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().headers).toEqual([...IMPORT_COLUMNS]);
  });

  it('mapeamento ambíguo responde 409 IMPORT_MAPPING_CONFLICT', async () => {
    const headers = ['a', 'b'];
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/import-batches/preview',
      headers: { ...session, 'content-type': 'application/json' },
      payload: {
        content: csv(headers, [['x', 'y']]),
        filename: 'f209.csv',
        mapping: {
          headers,
          mapping: [
            { header: 'a', column: 'stake' },
            { header: 'b', column: 'stake' },
          ],
          defaultBookmaker: null,
          defaultTipster: null,
          defaultBetOrigin: null,
        },
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('IMPORT_MAPPING_CONFLICT');
  });

  it('lote inexistente responde 404 IMPORT_BATCH_NOT_FOUND', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/import-batches/${randomUUID()}`,
      headers: session,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('IMPORT_BATCH_NOT_FOUND');
  });

  it('sem sessão, nada da importação por arquivo é exposto', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/import-batches/template',
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('STK-F2-09 §15 — o banco recusa incoerência e o estado é o do job', () => {
  it('origem sem lote é recusado, e a origem fora do vocabulário também', async () => {
    const content = csv(TEMPLATE_HEADERS, [templateRow({ reference: 'B-1' })]);
    const { batchId, version } = await preview(content);
    const result = await batches.commit(context, randomUUID(), batchId, {
      version,
      reason: 'importacao para checar a coerencia',
    });
    const betId = result.bets[0]!.betId;
    // Apontar a origem para um lote INEXISTENTE viola a FK: origem e lote
    // nascem juntos, e a aposta não pode declarar uma origem órfã.
    await expect(
      database.pool.query('update finance.bet set import_batch_id=$2 where id=$1', [
        betId,
        '00000000-0000-4000-8000-0000000000ff',
      ]),
    ).rejects.toMatchObject({ code: '23503' });
    // E a origem fora do vocabulário fechado é recusada pelo CHECK.
    await expect(
      database.pool.query('update finance.bet set import_origin=$2 where id=$1', [
        betId,
        'concorrente_x',
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('apagar o lote desvincula, e a aposta revertida continua com a origem', async () => {
    const content = csv(TEMPLATE_HEADERS, [templateRow({ reference: 'B-4' })]);
    const { batchId, version } = await preview(content);
    const result = await batches.commit(context, randomUUID(), batchId, {
      version,
      reason: 'importacao para desvincular o lote',
    });
    const betId = result.bets[0]!.betId;
    // Desvincular uma aposta ABERTA é recusado: ninguém conseguiria mais
    // revertê-la, porque o caminho de volta é o próprio lote.
    await expect(
      database.pool.query(
        'delete from integration.import_batch where organization_id=$1 and id=$2',
        [context.organizationId, batchId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    // Depois de revertida, apagar o lote desvincula e a origem PERMANECE: é
    // ela que responde "de onde veio este lançamento" para sempre.
    await batches.rollback(context, randomUUID(), batchId, { version });
    await database.pool.query(
      'delete from integration.import_batch where organization_id=$1 and id=$2',
      [context.organizationId, batchId],
    );
    const row = (
      await database.pool.query<{ import_origin: string | null; import_batch_id: string | null }>(
        'select import_origin, import_batch_id from finance.bet where id=$1',
        [betId],
      )
    ).rows[0]!;
    expect(row.import_batch_id).toBeNull();
    expect(row.import_origin).toBe('stakeframe_template');
  });

  it('committed + skipped fecha com total, e o banco recusa a divergência', async () => {
    const content = csv(TEMPLATE_HEADERS, [templateRow({ reference: 'B-2' })]);
    const { batchId, version } = await preview(content);
    await batches.commit(context, randomUUID(), batchId, {
      version,
      reason: 'importacao para a particao do lote',
    });
    await expect(
      database.pool.query(
        'update integration.import_batch set committed=99 where organization_id=$1 and id=$2',
        [context.organizationId, batchId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('o estado do lote é lido por recurso: committed, e o progresso fecha', async () => {
    const content = csv(TEMPLATE_HEADERS, [templateRow({ reference: 'B-3' })]);
    const { batchId, version } = await preview(content);
    await batches.commit(context, randomUUID(), batchId, {
      version,
      reason: 'importacao para o estado do job',
    });
    const detail = await batches.detail(context, batchId);
    expect(detail.state).toBe('committed');
    expect(detail.committed).toBe(1);
    expect(detail.skipped).toBe(0);
    const list = await batches.list(context);
    expect(list.items[0]!.id).toBe(batchId);
    expect(list.items[0]!.state).toBe('committed');
  });
});

describe('STK-F2-09 §15 — a 0026 está no journal e é replay-safe', () => {
  it('a 0026 está no journal, em ordem e com índice contíguo', () => {
    const journal = JSON.parse(
      readFileSync(
        new URL('../../packages/db/migrations/meta/_journal.json', import.meta.url),
        'utf8',
      ),
    ) as { entries: { idx: number; tag: string }[] };
    // A 0026 NÃO é mais a última: a STK-F2-08 acrescenta a 0027 depois dela.
    // "Última entrada do journal" é um relógio, não uma propriedade do
    // arquivo — fixá-la aqui quebraria com a PR de migração seguinte. O que a
    // 0026 pediu continua garantido: ela está no journal, com índice
    // contíguo, e o que veio depois não a desordena.
    const index = journal.entries.findIndex((entry) => entry.tag === '0026_import_batches');
    expect(index).toBe(26);
    expect(journal.entries[index]!.idx).toBe(index);
    // Nenhuma entrada fora da sua posição: é o que torna confiável o replay de
    // prefixo do migrador.
    expect(journal.entries.every((entry, position) => entry.idx === position)).toBe(true);
  });

  it('os objetos da 0026 existem e a RLS é fail-closed sem contexto', async () => {
    const tables = (
      await database.pool.query<{ n: string }>(
        `select count(*)::text as n from information_schema.tables
          where table_schema='integration' and table_name in ('import_batch','import_batch_receipt')`,
      )
    ).rows[0]!;
    expect(Number(tables.n)).toBe(2);
    const policies = await database.pool.query(
      "select count(*)::text as n from pg_policies where schemaname='integration' and tablename in ('import_batch','import_batch_receipt')",
    );
    expect(Number(policies.rows[0]!.n)).toBe(2);
    // Sem contexto, o predicado devolve NULL e não casa linha nenhuma.
    const scoped = (
      await database.pool.query<{ n: string }>(
        "select count(*)::text as n from integration.import_batch where organization_id=nullif(current_setting('app.organization_id', true), '')::uuid",
      )
    ).rows[0]!;
    expect(Number(scoped.n)).toBe(0);
  });

  it('aplicar a 0026 de novo é no-op: o estado fica idêntico', async () => {
    const sql = readFileSync(
      new URL('../../packages/db/migrations/0026_import_batches.sql', import.meta.url),
      'utf8',
    );
    const statements = sql
      .split('--> statement-breakpoint')
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
    const snapshot = async () =>
      (
        await database.pool.query<{ label: string; n: string }>(
          `select 'batch' as label, count(*)::text as n from integration.import_batch
           union all select 'receipt', count(*)::text from integration.import_batch_receipt
           union all select 'batches_com_origem', count(*)::text from finance.bet where import_origin is not null`,
        )
      ).rows
        .map((row) => `${row.label}=${row.n}`)
        .join(',');
    const before = await snapshot();
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      for (const statement of statements) await client.query(statement);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    expect(await snapshot()).toBe(before);
  });
});

describe('STK-F2-09 §15 — o erro é sanitizado e a classe é estável', () => {
  it('a mensagem do erro É o código, sem valor do arquivo', async () => {
    let failure: unknown = null;
    try {
      await batches.detail(context, randomUUID());
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ImportBatchError);
    expect((failure as Error).message).toBe('IMPORT_BATCH_NOT_FOUND');
    expect((failure as Error).message).not.toMatch(/select|from|@stk\.test/);
  });
});
