import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createDatabase,
  createExtractionPolicyService,
  createFinanceService,
  requireDatabaseUrl,
  type Database,
  type OrganizationContext,
} from '../../packages/db/src/index.js';
import { migrateLocalDatabase } from '../../packages/db/src/migrate.js';
import { createTelegramClient, type TelegramConfig } from '../../apps/worker/src/telegram.js';
import {
  createTelegramTextRegistration,
  telegramTextIdentity,
} from '../../apps/worker/src/telegram-text-registration.js';
import { createTelegramTextHandler } from '../../apps/worker/src/telegram-text-handler.js';
import { createTelegramCommands } from '../../apps/worker/src/telegram-commands.js';
import { TELEGRAM_COMMANDS, OPENROUTER_MODEL } from '../../packages/shared/src/index.js';

/**
 * STK-F2-07 §15 — registro por texto em PT-BR, confirmação humana e os onze
 * comandos, em PostgreSQL real.
 *
 * Banco descartável, dados fictícios, nenhuma chamada real ao OpenRouter (o
 * `fetch` é injetado) e nenhum conteúdo de bilhete em log.
 *
 * O que estes testes provam, e que nenhum teste unitário poderia:
 *
 *  - NENHUMA escrita financeira na leitura: entre o texto e o preview,
 *    `finance.bet`, `finance.journal` e `finance.posting` estão como estavam;
 *  - a escrita acontece SÓ depois do toque em Confirmar, e pelo comando
 *    financeiro canônico;
 *  - confirmar duas vezes não duplica o lançamento;
 *  - falha de IA (confirmada e incerta) NÃO consome cota e NÃO repete a
 *    chamada — a prova é a CONTAGEM de chamadas, não o estado final;
 *  - teto de cota recusa ANTES de qualquer chamada paga;
 *  - o mesmo texto é reconhecível como duplicata, sem depender de carimbo;
 *  - casa declarada em texto resolve por alias contra o catálogo ATIVO, e
 *    nome desconhecido fica pendente em vez de virar cadastro;
 *  - nenhum dos onze comandos escreve, e todos respondem com dado da
 *    organização do dono — nada de outra organização vaza.
 */

const source = requireDatabaseUrl(process.env.TEST_DATABASE_URL);
const admin = createDatabase(source, { statementTimeoutMs: 30_000 });
const name = `stk_f207_test_${randomUUID().replaceAll('-', '')}`;

const API_KEY = `sk-or-v1-${'a'.repeat(64)}`;
const chatId = '999';
const config: TelegramConfig = {
  token: '123456:synthetic-token-not-a-real-credential',
  userId: chatId,
  chatId,
  miniAppUrl: 'https://app.stakeframe.test',
};

let database: Database;
let context: OrganizationContext;
let other: OrganizationContext;
let created = false;

/**
 * O rascunho sintético. A referência é ÚNICA por caso de propósito: o comando
 * financeiro detecta duplicata por (casa, referência), e dois casos que
 * dividissem a referência mediriam o detector de duplicata em vez da regra que
 * o caso pretende provar.
 */
const draft = (reference: string, over: Record<string, unknown> = {}) => ({
  reference,
  stake: '50.00',
  odds: '2.50',
  bookmakerName: 'Bet365',
  tipsterName: null,
  selections: [{ event: null, sport: null, market: 'Vitória', selection: 'Alfa', odds: null }],
  warnings: [],
  ...over,
});

/**
 * Resposta sintética do OpenRouter. `content` é o JSON do rascunho, e a
 * referência é ÚNICA por chamada: o comando financeiro detecta duplicata por
 * (casa, referência), e dois casos que dividissem a referência mediriam o
 * detector em vez da regra que o caso pretende provar.
 */
let references = 0;
const completion = (over: Record<string, unknown> = {}) =>
  Response.json({
    id: 'f2-07-completion',
    model: OPENROUTER_MODEL,
    provider: 'Google AI Studio',
    choices: [
      {
        finish_reason: 'stop',
        message: {
          content: JSON.stringify(
            draft(`F2-07-REF-${String(++references).padStart(3, '0')}`, over),
          ),
        },
      },
    ],
    usage: { prompt_tokens: 120, completion_tokens: 60, total_tokens: 180 },
  });

/** Cliente do Telegram que registra o que foi enviado, sem rede. */
const telegramSpy = () => {
  const sent: { chatId: number; text: string; buttons?: unknown }[] = [];
  const client = createTelegramClient(config, vi.fn<typeof fetch>());
  return {
    sent,
    sendMessage: async (chat: number, text: string, options: { buttons?: unknown } = {}) => {
      sent.push({ chatId: chat, text, ...(options.buttons ? { buttons: options.buttons } : {}) });
      return { messageId: 5000 + sent.length };
    },
    answerCallbackQuery: async () => undefined,
    deleteMessage: async () => ({ missing: false }),
    editMessageText: async () => undefined,
    editMessageReplyMarkup: async () => undefined,
    download: async () => Buffer.alloc(0),
    updates: async () => [],
    client,
  };
};

let sequence = 0;
const text = (salt: string) =>
  `aposta ${++sequence} ${salt} de cinquenta reais na bet365 odd dois e meio`;

/** Estados financeiros observáveis: a prova de que nada foi lançado. */
async function financialState() {
  const row = (
    await database.pool.query<{ bets: string; journals: string; postings: string }>(
      `select (select count(*) from finance.bet)::text as bets,
              (select count(*) from finance.journal)::text as journals,
              (select count(*) from finance.posting)::text as postings`,
    )
  ).rows[0]!;
  return {
    bets: Number(row.bets),
    journals: Number(row.journals),
    postings: Number(row.postings),
  };
}

async function quotaToday(): Promise<number> {
  const row = (
    await database.pool.query<{ presented: string }>(
      'select coalesce(sum(presented),0)::text as presented from integration.ai_usage_day where day=to_char(now() at time zone $$UTC$$,$$YYYY-MM-DD$$)',
    )
  ).rows[0]!;
  return Number(row.presented);
}

beforeAll(async () => {
  if (!/^stk_f207_test_[a-f0-9]{32}$/.test(name)) throw new Error('INVALID_TEST_DATABASE');
  await admin.pool.query(`CREATE DATABASE "${name}"`);
  created = true;
  const url = new URL(source);
  url.pathname = `/${name}`;
  database = createDatabase(url.toString(), { statementTimeoutMs: 30_000 });
  await migrateLocalDatabase(database);
  for (const user of ['f207-owner', 'f207-other'])
    await database.pool.query(
      `insert into auth."user"(id,name,email) values($1,$2,$3) on conflict (id) do nothing`,
      [user, user, `${user}@stk.test`],
    );
  const finance = createFinanceService(database);
  context = await finance.ensureContext('f207-owner');
  other = await finance.ensureContext('f207-other');
  const bookmaker = (await finance.workspace(context)).catalog.find(
    (entry) => entry.kind === 'bookmaker' && entry.name === 'Bet365',
  )!;
  // A confirmação é o único caminho que escreve no financeiro, e o serviço
  // financeiro exige a banca inicializada. Espaço e unidade são fictícios.
  await finance.command(context, randomUUID(), {
    type: 'bankroll.initialize',
    reserve: '5000.00',
    balances: [{ bookmakerId: bookmaker.id, amount: '5000.00' }],
    unitPercent: '1.00',
    expectedVersion: (await finance.workspace(context)).version,
  });
  // A unidade é devida no mês da aposta (finance-commands.ts:56) e só o mês
  // corrente nasce sozinho, em ensureCurrentUnit. Neste arquivo o placedAt nasce
  // do instante da mensagem (telegram-text-registration.ts:407) e asfixtures usam
  // receivedAt de setembro, então setembro precisa da unidade declarada — senão
  // allowMissingUnit:false esbarra em UNIT_REQUIRED. O valor é 1% da reserva,
  // igual à unidade inicial; nenhum assert daqui lê o valor.
  await finance.command(context, randomUUID(), {
    type: 'unit.set',
    month: '2026-09',
    amount: '50.00',
    reason: 'Unidade de setembro conferida pelo cenário de texto',
    expectedVersion: (await finance.workspace(context)).version,
  });
});

afterAll(async () => {
  try {
    await database?.close();
    if (created && /^stk_f207_test_[a-f0-9]{32}$/.test(name))
      await admin.pool.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  } finally {
    await admin.close();
  }
});

describe('STK-F2-07 — o texto vira PREVIEW, nunca lançamento', () => {
  it('apresenta o rascunho sem tocar no financeiro e sem aposta criada', async () => {
    const before = await financialState();
    const spy = telegramSpy();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(completion());
    const registration = createTelegramTextRegistration(database, spy as never, config, {
      apiKey: API_KEY,
      fetchImpl,
    });
    const message = text('preview');
    const outcome = await registration.register({
      context,
      text: message,
      chatId: Number(chatId),
      messageId: 4242,
      receivedAt: new Date('2026-09-20T10:00:00Z'),
    });
    expect(outcome.kind).toBe('presented');
    expect(outcome).toMatchObject({ delivered: true });

    // A prova: a aposta, o journal e os postings são os de antes. Ler um texto
    // NUNCA escreve no financeiro — a escrita nasce do toque em Confirmar.
    expect(await financialState()).toEqual(before);

    // O preview diz, na primeira linha, que nada foi lançado.
    const preview = spy.sent.at(-1)!.text;
    expect(preview).toContain('nada foi lançado ainda');
    expect(preview).toContain('R$ 50,00');
    expect(preview).toContain('2,50');
    expect(preview).toContain('Confirmar registra a aposta');
    // O texto do usuário NÃO volta na resposta: o preview mostra o que foi
    // lido, nunca o que foi digitado.
    expect(preview).not.toContain(message);
  });

  it('resolve a casa declarada por alias contra o catálogo ATIVO da organização', async () => {
    const spy = telegramSpy();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(completion());
    const registration = createTelegramTextRegistration(database, spy as never, config, {
      apiKey: API_KEY,
      fetchImpl,
    });
    const outcome = await registration.register({
      context,
      // Grafia diferente da casa: a resolução é por alias normalizado.
      text: text('casa'),
      chatId: Number(chatId),
      messageId: 4243,
      receivedAt: new Date('2026-09-20T10:01:00Z'),
    });
    expect(outcome.kind).toBe('presented');
    if (outcome.kind !== 'presented') return;
    const row = (
      await database.pool.query<{ name: string | null }>(
        `select (select name from finance.catalog c where c.id=i.bookmaker_override_id
                   and c.organization_id=i.organization_id) as name
           from integration.inbox i where id=$1`,
        [outcome.inboxId],
      )
    ).rows[0]!;
    expect(row.name).toBe('Bet365');
  });

  it('casa desconhecida fica PENDENTE e não cria cadastro', async () => {
    const spy = telegramSpy();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(completion({ bookmakerName: 'Casa Que Nao Existe' }));
    const registration = createTelegramTextRegistration(database, spy as never, config, {
      apiKey: API_KEY,
      fetchImpl,
    });
    const before = (
      await database.pool.query<{ count: string }>(
        'select count(*)::text as count from finance.catalog',
      )
    ).rows[0]!;
    const outcome = await registration.register({
      context,
      text: text('casa-desconhecida'),
      chatId: Number(chatId),
      messageId: 4244,
      receivedAt: new Date('2026-09-20T10:02:00Z'),
    });
    expect(outcome.kind).toBe('presented');
    const after = (
      await database.pool.query<{ count: string }>(
        'select count(*)::text as count from finance.catalog',
      )
    ).rows[0]!;
    // Nenhum cadastro nasce de texto livre: a casa é escolha do usuário.
    expect(after.count).toBe(before.count);
    expect(spy.sent.at(-1)!.text).toContain('Casa: pendente');
  });

  it('só o toque em Confirmar cria a aposta, e pelo comando canônico', async () => {
    const spy = telegramSpy();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(completion());
    const registration = createTelegramTextRegistration(database, spy as never, config, {
      apiKey: API_KEY,
      fetchImpl,
    });
    const before = await financialState();
    const outcome = await registration.register({
      context,
      text: text('confirmar'),
      chatId: Number(chatId),
      messageId: 4245,
      receivedAt: new Date('2026-09-20T10:03:00Z'),
    });
    expect(outcome.kind).toBe('presented');
    if (outcome.kind !== 'presented') return;
    expect(await financialState()).toEqual(before);

    const draft = await registration.preview(context, outcome.inboxId);
    expect(draft?.state).toBe('review');
    const confirmed = await registration.confirm(context, outcome.inboxId, draft!.version);
    expect(confirmed.state).toBe('confirmed');
    const after = await financialState();
    expect(after.bets).toBe(before.bets + 1);
    // A aposta nasce pelo comando financeiro: sem comando, sem lançamento, e
    // o journal existe porque a aposta existe.
    expect(after.journals).toBeGreaterThan(before.journals);
  });

  it('confirmar de novo NÃO duplica o lançamento', async () => {
    const spy = telegramSpy();
    // Valor e odd PRÓPRIOS: o detector de duplicata do comando financeiro
    // também compara (casa, stake, odd, dia) como "similar", e um rascunho com
    // os mesmos números de outro caso colidiria por coincidência — medindo o
    // detector em vez da idempotência, que é o que este caso prova.
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(completion({ stake: '73.00', odds: '3.75' }));
    const registration = createTelegramTextRegistration(database, spy as never, config, {
      apiKey: API_KEY,
      fetchImpl,
    });
    const outcome = await registration.register({
      context,
      text: text('idempotente'),
      chatId: Number(chatId),
      messageId: 4246,
      receivedAt: new Date('2026-09-20T10:04:00Z'),
    });
    if (outcome.kind !== 'presented') throw new Error('expected presented');
    const draft = await registration.preview(context, outcome.inboxId);
    await registration.confirm(context, outcome.inboxId, draft!.version);
    const afterFirst = await financialState();
    // O segundo toque cai no estado terminal, não no caminho de criação.
    const again = await registration.confirm(context, outcome.inboxId, draft!.version);
    expect(again.state).toBe('already');
    expect(await financialState()).toEqual(afterFirst);
  });

  it('o mesmo texto é duplicata, sem depender de carimbo de tempo', async () => {
    const spy = telegramSpy();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(completion());
    const registration = createTelegramTextRegistration(database, spy as never, config, {
      apiKey: API_KEY,
      fetchImpl,
    });
    const message = text('duplicata');
    const first = await registration.register({
      context,
      text: message,
      chatId: Number(chatId),
      messageId: 4247,
      receivedAt: new Date('2026-09-20T10:05:00Z'),
    });
    expect(first.kind).toBe('presented');
    // Mesmo texto, outra mensagem, MINUTOS DEPOIS: a identidade é o texto
    // normalizado, então a segunda é reconhecível.
    const second = await registration.register({
      context,
      text: message,
      chatId: Number(chatId),
      messageId: 9999,
      receivedAt: new Date('2026-09-20T11:47:00Z'),
    });
    expect(second.kind).toBe('duplicate');
    if (first.kind === 'presented' && second.kind === 'duplicate')
      expect(second.duplicateOf).toBe(first.inboxId);
  });

  it('a identidade do texto ignora a forma da digitação', () => {
    // Duas grafias do mesmo texto são o mesmo bilhete — é o que a F2-05 faz com
    // a legenda, e a regra é a mesma por escolha de produto.
    expect(telegramTextIdentity('  Apostei   50 REAIS  ')).toBe(
      telegramTextIdentity('apostei 50 reais'),
    );
  });

  it('descartar arquiva por 30 dias e não apaga nada', async () => {
    const spy = telegramSpy();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(completion());
    const registration = createTelegramTextRegistration(database, spy as never, config, {
      apiKey: API_KEY,
      fetchImpl,
    });
    const outcome = await registration.register({
      context,
      text: text('descartar'),
      chatId: Number(chatId),
      messageId: 4248,
      receivedAt: new Date('2026-09-20T10:06:00Z'),
    });
    if (outcome.kind !== 'presented') throw new Error('expected presented');
    const archived = await registration.discard(context, outcome.inboxId);
    const until = Date.parse(archived.recoverableUntil);
    const now = Date.now();
    expect(until).toBeGreaterThan(now + 29 * 86400_000);
    expect(until).toBeLessThanOrEqual(now + 31 * 86400_000);
    // O registro continua endereçável: descarte é arquivamento, não exclusão.
    const draft = await registration.preview(context, outcome.inboxId);
    expect(draft?.state).toBe('discarded');
  });
});

describe('STK-F2-07 — a política fail-closed da STK-F2-06 aplicada ao texto', () => {
  it('falha INCERTA não consome cota e NÃO repete a chamada', async () => {
    const before = await quotaToday();
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('conexão perdida'));
    const registration = createTelegramTextRegistration(database, telegramSpy() as never, config, {
      apiKey: API_KEY,
      fetchImpl,
    });
    const outcome = await registration.register({
      context,
      text: text('incerta'),
      chatId: Number(chatId),
      messageId: 4249,
      receivedAt: new Date('2026-09-20T10:07:00Z'),
    });
    expect(outcome.kind).toBe('uncertain');
    // A prova de que a resposta incerta não virou uma segunda chamada é a
    // CONTAGEM de chamadas, não o estado final.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // E a de que ela não consumiu cota é a contagem apresentada do dia.
    expect(await quotaToday()).toBe(before);
  });

  it('falha CONFIRMADA também não consome cota, e alimenta o circuito', async () => {
    const before = await quotaToday();
    // 401 é "credencial recusada": a resposta CHEGOU, então é falha confirmada —
    // e é o caminho que alimenta o circuit breaker da F2-06. A resposta é
    // construída sem `Response.json` porque o init de status dele recusa 4xx no
    // runtime de teste, e o que importa aqui é o código, não o corpo.
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'provedor' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const registration = createTelegramTextRegistration(database, telegramSpy() as never, config, {
      apiKey: API_KEY,
      fetchImpl,
    });
    const outcome = await registration.register({
      context,
      text: text('confirmada'),
      chatId: Number(chatId),
      messageId: 4250,
      receivedAt: new Date('2026-09-20T10:08:00Z'),
    });
    expect(outcome.kind).toBe('uncertain');
    expect(outcome).toMatchObject({ category: 'confirmed_auth' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await quotaToday()).toBe(before);
    // O circuito é infraestrutura global da STK-F2-06 e o texto o alimenta pela
    // MESMA porta — nenhuma contagem nova foi criada para isto.
    const policy = createExtractionPolicyService(database);
    const breakers = await policy.breakers(null);
    expect(breakers.some((breaker) => breaker.failures > 0)).toBe(true);
  });

  it('resposta fora do contrato é recusada sem gravar rascunho e sem cota', async () => {
    const before = await quotaToday();
    // `recommendation` é um campo que NÃO EXISTE no contrato. O `readTextBet` o
    // rejeita na borda e lança `AI_EXTRACTION_INVALID`, que é a categoria
    // `confirmed_response`: a resposta chegou e não serviu. O item vai para
    // ação manual e a cota é zero — o mesmo destino de uma falha confirmada.
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(completion({ recommendation: 'vale a pena apostar' }));
    const registration = createTelegramTextRegistration(database, telegramSpy() as never, config, {
      apiKey: API_KEY,
      fetchImpl,
    });
    const outcome = await registration.register({
      context,
      text: text('fora-do-contrato'),
      chatId: Number(chatId),
      messageId: 4251,
      receivedAt: new Date('2026-09-20T10:09:00Z'),
    });
    expect(outcome.kind).toBe('uncertain');
    expect(outcome).toMatchObject({ category: 'confirmed_response' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await quotaToday()).toBe(before);
  });

  it('sem chave de IA o texto vai para ação manual, sem chamada nenhuma', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const registration = createTelegramTextRegistration(database, telegramSpy() as never, config, {
      apiKey: null,
      fetchImpl,
    });
    const outcome = await registration.register({
      context,
      text: text('sem-chave'),
      chatId: Number(chatId),
      messageId: 4252,
      receivedAt: new Date('2026-09-20T10:10:00Z'),
    });
    expect(outcome.kind).toBe('refused');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('teto de cota recusa ANTES de qualquer chamada paga', async () => {
    const today = new Date().toISOString().slice(0, 10);
    await database.pool.query(
      `insert into integration.ai_usage_day(day,requests,presented)
       values($1,9999,9999) on conflict(day) do update set presented=9999`,
      [today],
    );
    try {
      const fetchImpl = vi.fn<typeof fetch>();
      const registration = createTelegramTextRegistration(
        database,
        telegramSpy() as never,
        config,
        { apiKey: API_KEY, fetchImpl },
      );
      const outcome = await registration.register({
        context,
        text: text('cota'),
        chatId: Number(chatId),
        messageId: 4253,
        receivedAt: new Date('2026-09-20T10:11:00Z'),
      });
      expect(outcome).toMatchObject({ kind: 'refused', reason: 'quota' });
      // A porta foi consultada ANTES da chamada: nenhuma chamada foi feita.
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      await database.pool.query('delete from integration.ai_usage_day where day=$1', [today]);
    }
  });

  it('texto fora da janela é recusado sem chamar o fornecedor', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const registration = createTelegramTextRegistration(database, telegramSpy() as never, config, {
      apiKey: API_KEY,
      fetchImpl,
    });
    const outcome = await registration.register({
      context,
      text: 'curto',
      chatId: Number(chatId),
      messageId: 4254,
      receivedAt: new Date('2026-09-20T10:12:00Z'),
    });
    expect(outcome).toMatchObject({ kind: 'refused', reason: 'bounds' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('STK-F2-07 — a cobrança da quota é por apresentação', () => {
  it('apresentar debita UMA unidade; o descarte do usuário não devolve', async () => {
    const today = new Date().toISOString().slice(0, 10);
    await database.pool.query(
      `insert into integration.ai_usage_day(day,requests,presented)
       values($1,0,0) on conflict(day) do update set presented=0,requests=0`,
      [today],
    );
    const spy = telegramSpy();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(completion());
    const registration = createTelegramTextRegistration(database, spy as never, config, {
      apiKey: API_KEY,
      fetchImpl,
    });
    const outcome = await registration.register({
      context,
      text: text('cota-apresentacao'),
      chatId: Number(chatId),
      messageId: 4255,
      receivedAt: new Date('2026-09-20T10:13:00Z'),
    });
    expect(outcome.kind).toBe('presented');
    // Apresentar já é consumir: a unidade foi debitada pela apresentação.
    expect(await quotaToday()).toBe(1);
    if (outcome.kind === 'presented') await registration.discard(context, outcome.inboxId);
    // Descartar depois NÃO devolve a unidade — ela foi consumida pelo fato de a
    // leitura ter sido apresentada.
    expect(await quotaToday()).toBe(1);
  });
});

describe('STK-F2-07 — os onze comandos são de LEITURA', () => {
  const commandsFor = () => {
    const spy = telegramSpy();
    return {
      spy,
      commands: createTelegramCommands(database, spy as never, config, {
        now: () => new Date('2026-09-20T12:00:00Z'),
      }),
    };
  };

  it.each(TELEGRAM_COMMANDS)('/%s responde sem escrever nada', async (command) => {
    const before = await financialState();
    const { commands, spy } = commandsFor();
    const answer = await commands.read(command);
    expect(answer.length).toBeGreaterThan(0);
    expect(await financialState()).toEqual(before);
    expect(spy.sent).toHaveLength(0);
  });

  it('todos os onze são cobertos e nenhum comando extra existe', () => {
    const { commands } = commandsFor();
    expect([...commands.commands]).toEqual([...TELEGRAM_COMMANDS]);
  });

  it('/hoje, /semana e /mes dizem o período e o N das métricas', async () => {
    const { commands } = commandsFor();
    const today = await commands.read('hoje');
    expect(today).toContain('📅 2026-09-20 a 2026-09-20');
    expect(today).toContain('🎲 Apostas:');
    // Nenhuma aposta existe ainda: o número zero e a amostra pequena precisam
    // aparecer juntos, senão o 0 parece um resultado.
    expect(today).toContain('amostra pequena');
    const week = await commands.read('semana');
    expect(week).toContain('📅 2026-09-14 a 2026-09-20');
    const month = await commands.read('mes');
    expect(month).toContain('📅 2026-09-01 a 2026-09-20');
  });

  it('/banca separa o dinheiro disponível da exposição em jogo', async () => {
    const { commands } = commandsFor();
    const answer = await commands.read('banca');
    expect(answer).toContain('💵 Disponível:');
    expect(answer).toContain('💸 Exposição em jogo:');
    // A banca inicializada é R$ 5.000 fictícios; disponível e exposição são
    // números DIFERENTES, e somá-los seria dizer que o valor bloqueado está
    // em mãos.
    const available = /Disponível: R\$ ([\d.,]+)/.exec(answer)![1]!;
    const exposure = /Exposição em jogo: R\$ ([\d.,]+)/.exec(answer)![1]!;
    expect(available).not.toBe(exposure);
  });

  it('/relatorio e /exportar entregam o caminho privado, nunca o conteúdo', async () => {
    const { commands } = commandsFor();
    const report = await commands.read('relatorio');
    expect(report).toContain('https://app.stakeframe.test');
    expect(report).toContain('página privada');
    // O card exclui PDF e e-mail: nenhum dos dois aparece como saída.
    expect(report).not.toMatch(/pdf/i);
    expect(report).not.toMatch(/e-mail|email/i);
    const exportAnswer = await commands.read('exportar');
    expect(exportAnswer).toContain('/exports');
    expect(exportAnswer).toContain('O bot não envia arquivo');
  });

  it('/fila lista o que espera decisão e /pendentes lista o que está aberto', async () => {
    const { commands } = commandsFor();
    // Os casos anteriores criaram rascunhos; a fila é exatamente isso — itens
    // que ainda NÃO viraram aposta. Ela não é "vazia por acaso" neste arquivo,
    // e o comando precisa dizer isso com a verdade, não com um "0" genérico.
    const queue = await commands.read('fila');
    expect(queue).toMatch(/FILA|Nada na fila/);
    if (queue.includes('FILA')) {
      expect(queue).toContain('aguardando decisão');
      expect(queue).toContain('passa por preview antes de virar aposta');
    }
    // Há apostas abertas (o caso de confirmação deste arquivo), então o comando
    // pendentes as lista em vez de dizer que não há.
    expect(await commands.read('pendentes')).toMatch(/ABERTO|aguardando resultado/);
  });

  it('comando desconhecido responde com a lista e não executa nada', async () => {
    const { commands, spy } = commandsFor();
    const before = await financialState();
    await commands.refuseUnknown();
    expect(spy.sent.at(-1)!.text).toContain('/hoje');
    expect(await financialState()).toEqual(before);
  });

  it('os comandos NUNCA enxergam as apostas de outra organização', async () => {
    // Uma aposta ABERTA e confirmada NA organização do outro usuário, com valor
    // que jamais pode aparecer na resposta do dono. Se a consulta escapasse do
    // contexto de organização, este valor apareceria; ela roda no contexto do
    // DONO, então não aparece.
    const finance = createFinanceService(database);
    const otherWorkspace = await finance.workspace(other);
    const house = otherWorkspace.catalog.find(
      (entry) => entry.kind === 'bookmaker' && entry.name === 'Bet365',
    )!;
    await finance.command(other, randomUUID(), {
      type: 'bankroll.initialize',
      reserve: '5000.00',
      balances: [{ bookmakerId: house.id, amount: '5000.00' }],
      unitPercent: '1.00',
      expectedVersion: otherWorkspace.version,
    });
    // A unidade é devida no mês da aposta (finance-commands.ts:56) e só o mês
    // corrente nasce sozinho, em ensureCurrentUnit. Esta aposta é de 19/09, então
    // setembro precisa da unidade declarada na MESMA organização — senão
    // allowMissingUnit:false esbarra em UNIT_REQUIRED. O valor é 1% da reserva,
    // igual à unidade inicial; nenhum assert deste arquivo lê o valor, e a
    // separação entre organizações segue intacta: a unidade é desta org só.
    await finance.command(other, randomUUID(), {
      type: 'unit.set',
      month: '2026-09',
      amount: '50.00',
      reason: 'Unidade de setembro conferida pelo cenário de isolamento',
      expectedVersion: (await finance.workspace(other)).version,
    });
    await finance.command(other, randomUUID(), {
      type: 'bet.create',
      bookmakerId: house.id,
      tipsterId: null,
      stake: '123.45',
      odds: '4.44',
      placedAt: new Date('2026-09-19T10:00:00Z').toISOString(),
      freebetId: null,
      reference: `OUTRA-${++sequence}`,
      allowMissingUnit: false,
      selections: [
        {
          event: 'Fora x Do outro',
          sport: 'Futebol',
          market: 'Vitória',
          selection: 'Fora',
          odds: null,
          eventDate: '2026-09-19',
          eventAt: null,
          dateStatus: 'confirmed',
        },
      ],
      expectedVersion: (await finance.workspace(other)).version,
    });
    const { commands } = commandsFor();
    const answer = await commands.read('pendentes');
    // 123,45 é o valor exclusivo da outra organização. A casa é a mesma
    // (Bet365 é o catálogo default das duas), então o que não pode vazar aqui
    // é justamente o valor e a referência.
    expect(answer).not.toContain('123,45');
    expect(answer).not.toContain(`OUTRA-`);
  });
});

describe('STK-F2-07 — o roteador de texto', () => {
  it('devolve false para o deep link, para que a F2-04 o receba', async () => {
    const handler = createTelegramTextHandler(database, telegramSpy() as never, config, {
      apiKey: API_KEY,
      fetchImpl: vi.fn<typeof fetch>(),
    });
    expect(
      await handler({
        text: '/start AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        messageId: 1,
        receivedAt: new Date(),
      }),
    ).toBe(false);
  });

  it('responde a um comando sem tocar no registro textual', async () => {
    const spy = telegramSpy();
    const fetchImpl = vi.fn<typeof fetch>();
    const handler = createTelegramTextHandler(database, spy as never, config, {
      apiKey: API_KEY,
      fetchImpl,
      now: () => new Date('2026-09-20T12:00:00Z'),
    });
    expect(
      await handler({ text: '/hoje', messageId: 2, receivedAt: new Date('2026-09-20T12:00:00Z') }),
    ).toBe(true);
    // Comando é comando: nenhuma chamada paga, nenhum rascunho.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('recusa texto fora da janela orientando a ação, sem vazar erro técnico', async () => {
    const spy = telegramSpy();
    const handler = createTelegramTextHandler(database, spy as never, config, {
      apiKey: API_KEY,
      fetchImpl: vi.fn<typeof fetch>(),
    });
    expect(await handler({ text: 'oi', messageId: 3, receivedAt: new Date() })).toBe(true);
    const answer = spy.sent.at(-1)!.text;
    expect(answer).toContain('Mini App');
    // O usuário vê a orientação, nunca o nome do fornecedor nem um código.
    expect(answer).not.toMatch(/openrouter|timeout|AI_|HTTP/i);
  });

  it('nenhum texto do usuário aparece na resposta de falha', async () => {
    const spy = telegramSpy();
    const secret = 'aposta secreta com a senha 1234 e o email a@b.com';
    const handler = createTelegramTextHandler(database, spy as never, config, {
      apiKey: API_KEY,
      fetchImpl: vi.fn<typeof fetch>().mockRejectedValue(new Error('rede caiu')),
    });
    await handler({ text: secret, messageId: 4, receivedAt: new Date() });
    const answer = spy.sent.at(-1)!.text;
    expect(answer).not.toContain('1234');
    expect(answer).not.toContain('a@b.com');
    expect(answer).toContain('nada foi lançado');
  });
});

describe('STK-F2-07 — isolamento por organização', () => {
  it('o registro textual de uma organização é invisível para a outra', async () => {
    const spy = telegramSpy();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(completion());
    const registration = createTelegramTextRegistration(database, spy as never, config, {
      apiKey: API_KEY,
      fetchImpl,
    });
    const outcome = await registration.register({
      context,
      text: text('isolamento'),
      chatId: Number(chatId),
      messageId: 4256,
      receivedAt: new Date('2026-09-20T10:20:00Z'),
    });
    if (outcome.kind !== 'presented') throw new Error('expected presented');
    // A RLS é a fronteira: a leitura da outra organização devolve `null`, e o
    // pedido de confirmação dela recusa — não há como registrar a partir de um
    // rascunho de outra organização.
    expect(await registration.preview(other, outcome.inboxId)).toBeNull();
    const foreign = await registration.confirm(other, outcome.inboxId, 1);
    expect(foreign.state).toBe('incomplete');
  });
});

describe('STK-F2-07 — a auditoria do texto não guarda o texto', () => {
  it('guarda a estrutura e os hashes, nunca o texto digitado', async () => {
    const spy = telegramSpy();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(completion());
    const registration = createTelegramTextRegistration(database, spy as never, config, {
      apiKey: API_KEY,
      fetchImpl,
    });
    const message = text('auditoria');
    const outcome = await registration.register({
      context,
      text: message,
      chatId: Number(chatId),
      messageId: 4257,
      receivedAt: new Date('2026-09-20T10:21:00Z'),
    });
    if (outcome.kind !== 'presented') throw new Error('expected presented');
    const audit = (
      await database.pool.query<{
        sanitized: unknown;
        prompt_sha256: string;
        response_sha256: string;
      }>(
        `select sanitized,prompt_sha256,response_sha256 from integration.extraction_audit
          where inbox_id=$1 and outcome='presented'`,
        [outcome.inboxId],
      )
    ).rows[0]!;
    expect(audit.prompt_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(audit.response_sha256).toMatch(/^[a-f0-9]{64}$/);
    // `sanitized` é null aqui: o schema da F2-06 é o da EXTRAÇÃO DE IMAGEM, e
    // uma estrutura textual não cabe nele — o que prova, mais do que qualquer
    // comentário, que a auditoria não tem onde guardar o rascunho do texto.
    expect(audit.sanitized).toBeNull();
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain(message);
  });
});
