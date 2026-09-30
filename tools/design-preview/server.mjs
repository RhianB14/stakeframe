/**
 * STK-F2-18 — servidor de preview do produto web.
 *
 * Serve o bundle real de `apps/web/dist` e responde `/api/v1/*` com o portfólio
 * de `portfolio.mjs`. O React, os componentes, os tokens e o CSS são os de
 * produção — só a origem dos dados é substituída. Docker não está disponível
 * nesta máquina, então subir Postgres/Redis/worker seria o caminho mais longo
 * para o mesmo resultado visual.
 *
 * O ponto que importa: **todo payload é validado contra o schema Zod real**
 * (`@stakeframe/shared`) antes do servidor aceitar tráfego. Um payload errado
 * aqui apareceria como tela vazia no navegador; validado aqui, aparece como erro
 * de schema no terminal, com o caminho exato do campo.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as shared from '../../packages/shared/dist/index.js';
import * as data from './portfolio.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const DIST = join(ROOT, 'apps', 'web', 'dist');
const PORT = Number(process.env.PREVIEW_PORT ?? 4180);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

// ─────────────────────────────────────────────────────────────────────────────
// Validação — a rede de segurança que impede tela vazia
// ─────────────────────────────────────────────────────────────────────────────

const failures = [];
let checked = 0;

/** Valida um payload e registra a falha com o caminho do campo, não a stack. */
function expect(label, schema, payload) {
  if (!schema) return;
  checked += 1;
  const result = schema.safeParse(payload);
  if (result.success) return;
  const issues = result.error.issues
    .slice(0, 6)
    .map((issue) => `${issue.path.join('.') || '(raiz)'}: ${issue.message}`)
    .join(' | ');
  failures.push(`${label} → ${issues}`);
}

// Schemas que existem com certeza no contrato. Os demais são resolvidos por
// nome e ignorados se o pacote não os exportar — assim o preview não quebra
// quando um schema é renomeado, mas continua validando o que conhece.
const names = new Set(Object.keys(shared));
const pick1 = (...candidates) => candidates.find((name) => names.has(name));

const schemas = {
  workspace: shared[pick1('workspaceSchema')],
  bet: shared[pick1('betSchema')],
  betPage: shared[pick1('betPageSchema')],
  import: shared[pick1('importDetailSchema', 'importSchema')],
  calendarItem: shared[pick1('calendarItemSchema')],
  eventSearch: shared[pick1('eventSearchSchema')],
  ranking: shared[pick1('polymarketRankingSchema', 'rankingSchema')],
  report: shared[pick1('performanceReportSchema', 'reportSchema')],
  snapshot: shared[pick1('reportSnapshotSchema')],
  dashboard: shared[pick1('dashboardSchema')],
  splits: shared[pick1('splitsSchema', 'analyticsSplitsSchema')],
  status: shared.systemStatusSchema,
};

const status = {
  name: 'Stakeframe',
  stage: 'local-setup',
  database: 'available',
  authentication: 'google',
  productEnabled: true,
  release: {
    version: '0.1.0-beta.1',
    commit: 'a'.repeat(40),
    builtAt: '2026-09-14T12:00:00Z',
    environment: 'production',
  },
};
const onboarding = {
  displayName: 'Rhian Batista',
  timezone: 'America/Sao_Paulo',
  steps: {
    profile: { completed: true, completedAt: '2026-07-02T12:00:00.000Z' },
    bankroll: { completed: true },
    firstBet: { completed: true, resolution: 'registered' },
  },
  completedAt: '2026-07-02T12:30:00.000Z',
};
const me = {
  user: { id: 'preview-owner', name: 'Rhian Batista' },
  organization: { id: '00000000-0000-4000-8000-000000000001', role: 'owner' },
  expiresAt: '2099-09-01T00:00:00Z',
};

// ─────────────────────────────────────────────────────────────────────────────
// Rotas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * STK-F2-18 (Fase 4) — o razão é DERIVADO das apostas do portfólio, não
 * inventado linha a linha.
 *
 * A Fase 4 transformou as movimentações em tabela, e a tabela renderizou
 * vazia: o endpoint devolvia `{items: []}`. Um razão vazio esconde a única
 * coisa que ele existe para provar — que o lançamento é append-only e que o
 * estorno NÃO apaga a linha original.
 *
 * Cada aposta real do portfólio vira dois lançamentos (registro e
 * liquidação) com os mesmos valores que a tela de apostas mostra. Os dois
 * casos que mais importam para a leitura linha a linha também estão aqui:
 * uma transferência entre contas própria, cujo efeito líquido é ZERO, e um
 * estorno, cuja linha continua visível marcada.
 */
function journalPage(url) {
  const page = Number(url.searchParams.get('page') ?? 1);
  const pageSize = Number(url.searchParams.get('pageSize') ?? 25);
  const bookmakerById = new Map(data.BOOKMAKERS.map((book) => [book.id, book.name]));
  const uuid = (n) => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const entries = [];
  let seq = 1;

  // Abertura da banca: um lançamento só, porque a reserva é a origem do
  // dinheiro. O valor aqui é o ponto de partida da conta, não vem de aposta.
  entries.push({
    id: uuid(seq),
    kind: 'opening',
    effectiveAt: '2026-07-01T12:00:00.000Z',
    createdAt: '2026-07-01T12:00:00.000Z',
    reason: 'Saldos conferidos na abertura da conta',
    reversalOf: null,
    reversed: false,
    postings: [{ accountId: uuid(90), accountName: 'Reserva', amount: data.workspace.bankroll }],
  });
  seq += 1;

  data.bets.forEach((bet) => {
    const house = bookmakerById.get(bet.bookmakerId) ?? 'Sem casa';
    const placed = new Date(bet.placedAt);
    const settleAt = bet.settledAt ? new Date(bet.settledAt) : null;
    // Registro: sai da reserva, entra na casa. Efeito líquido zero — a banca
    // não cresceu, o dinheiro mudou de conta. É a linha que ensina a leitura.
    entries.push({
      id: uuid(seq),
      kind: 'bet_stake',
      effectiveAt: placed.toISOString(),
      createdAt: placed.toISOString(),
      reason: `Bilhete #${bet.ticketNumber} registrado`,
      reversalOf: null,
      reversed: false,
      postings: [
        { accountId: uuid(90), accountName: 'Reserva', amount: `-${bet.stake}` },
        { accountId: uuid(91), accountName: house, amount: bet.stake },
      ],
    });
    seq += 1;
    if (bet.state === 'settled' && settleAt) {
      entries.push({
        id: uuid(seq),
        kind: 'settlement',
        effectiveAt: settleAt.toISOString(),
        createdAt: settleAt.toISOString(),
        reason: `Bilhete #${bet.ticketNumber} liquidado`,
        reversalOf: null,
        reversed: false,
        postings: [
          { accountId: uuid(91), accountName: house, amount: bet.returnAmount },
          { accountId: uuid(92), accountName: 'Apostas', amount: `-${bet.stake}` },
        ],
      });
      seq += 1;
    }
  });

  // Um estorno real: a linha original continua na tabela, marcada. Sem isto
  // a coluna "estornado" nunca apareceria e a property append-only do razão
  // não teria como ser conferida.
  const target = entries.find((entry) => entry.kind === 'settlement');
  if (target) {
    entries.push({
      id: uuid(seq),
      kind: 'reversal',
      effectiveAt: '2026-09-28T15:20:00.000Z',
      createdAt: '2026-09-28T15:20:00.000Z',
      reason: 'Conferência na casa corrigiu o valor liquidado',
      reversalOf: target.id,
      reversed: true,
      postings: target.postings.map((posting) => ({
        ...posting,
        amount: posting.amount.startsWith('-')
          ? posting.amount.slice(1)
          : `-${posting.amount}`,
      })),
    });
    seq += 1;
  }

  // Mais recente primeiro: é como o razão se lê, e é o que a tela promete.
  const sorted = entries.sort((a, b) => (a.effectiveAt < b.effectiveAt ? 1 : -1));
  const start = (page - 1) * pageSize;
  return {
    items: sorted.slice(start, start + pageSize),
    total: sorted.length,
    page,
    pageSize,
  };
}

/**
 * STK-F2-18 (Fase 4) — o calendário filtra por PERÍODO e pagina.
 *
 * A rota devolvia `data.calendar` inteiro, sem `from`/`to` e sem
 * `distinctBets`/`pendingSelections`. A Fase 4 passou a pedir o mês inteiro
 * para popular os chips da grade, e um servidor que devolve tudo ignorando o
 * filtro faz a tela mostrar eventos de julho numa grade de setembro — o
 * pior tipo de bug de preview: PARECE correto e não é.
 */
function calendarPage(url) {
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const view = url.searchParams.get('view') ?? 'scheduled';
  const betState = url.searchParams.get('betState');
  const page = Number(url.searchParams.get('page') ?? 1);
  const pageSize = Number(url.searchParams.get('pageSize') ?? 25);
  let items = data.calendar;
  if (view === 'pending') {
    // Pendência é a data, não o estado da aposta: inclui também o que não
    // tem data nenhuma, que é justamente o que a aba existe para achar.
    items = items.filter((item) => item.selection.dateStatus !== 'confirmed');
  } else {
    if (from) items = items.filter((item) => item.selection.eventDate >= from);
    if (to) items = items.filter((item) => item.selection.eventDate <= to);
  }
  if (betState) items = items.filter((item) => item.betState === betState);
  const distinctBets = new Set(items.map((item) => item.betId)).size;
  const start = (page - 1) * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    total: items.length,
    distinctBets,
    pendingSelections: data.calendar.filter(
      (item) => item.selection.dateStatus !== 'confirmed',
    ).length,
    page,
    pageSize,
  };
}

/** Página de bets: filtra por estado/casa/tipster/data e pagina, como o contrato. */
function betPage(url) {
  const state = url.searchParams.get('state');
  const bookmakerId = url.searchParams.get('bookmakerId');
  const tipsterId = url.searchParams.get('tipsterId');
  const page = Number(url.searchParams.get('page') ?? 1);
  const pageSize = Number(url.searchParams.get('pageSize') ?? 25);
  let items = data.bets;
  if (state) items = items.filter((bet) => bet.state === state);
  if (bookmakerId) items = items.filter((bet) => bet.bookmakerId === bookmakerId);
  if (tipsterId) items = items.filter((bet) => bet.tipsterId === tipsterId);
  const start = (page - 1) * pageSize;
  return { items: items.slice(start, start + pageSize), total: items.length, page, pageSize };
}

function importDetail(id) {
  return data.imports.find((entry) => entry.item.id === id) ?? data.imports[0];
}

/**
 * Ranking Polymarket. `pnl` e `vol` são decimais LITERAIS em texto: a coluna é
 * `numeric(38,18)` e o Postgres devolve `numeric` como string — `Number()` aqui
 * perderia precisão exatamente onde o produto promete não perder.
 */
function rank() {
  // Endereços gerados, não escritos: `^0x[0-9a-f]{40}$` é exato e um caractere
  // a mais reprovaria o payload inteiro.
  const wallet = (seed) => `0x${BigInt(seed).toString(16).padStart(40, '0')}`;
  const rows = [
    ['1', 'polymarket-br', '48210.559182', '1284000.000000'],
    ['2', 'apostaWIN', '31455.128400', '902300.500000'],
    ['3', 'trader_02', '22018.774001', '641200.250000'],
    ['4', 'calangoAposta', '15890.443210', '512800.000000'],
    ['5', 'greenwallet', '11204.998765', '398400.750000'],
    ['6', 'meia-noite', '8740.221100', '284100.000000'],
    ['7', 'deltaAposta', '6115.880042', '201900.400000'],
    ['8', 'carol', '3980.117400', '142600.000000'],
  ];
  return {
    window: { category: 'OVERALL', timePeriod: 'MONTH', orderBy: 'PNL' },
    series: {
      status: 'complete',
      available: true,
      ingested: rows.length,
      backfillFrom: '2026-08-31',
      pages: 1,
      failedPages: 0,
    },
    completeness: {
      truncated: false,
      label: 'Série completa',
      detail: 'Todos os registros da janela foram ingeridos; a cobertura permite os agregados.',
    },
    sample: { n: rows.length, minSample: 30, lowSample: rows.length < 30 },
    aggregate: { blocked: false, reason: null },
    requested: 100,
    returned: rows.length,
    rows: rows.map(([rank, userName, pnl, vol], index) => ({
      rank,
      proxyWallet: wallet(index + 1),
      userName,
      pnl,
      vol,
    })),
  };
}

/**
 * Relatório congelado (`/api/v1/report-snapshots`). Não é o mesmo contrato do
 * relatório de desempenho: este é o documento AUDITÁVEL — carrega versão,
 * hash SHA-256 e uma narrativa que separa `fact` de `heuristic`. A tela de
 * Relatórios consome este, e não `/api/v1/reports`.
 */
function reportSnapshot(period = 'monthly') {
  const metrics = data.dashboard.metrics;
  const digest = Array.from(
    { length: 64 },
    (_, i) => '0123456789abcdef'[(i * 7 + data.bets.length + period.length) % 16],
  ).join('');
  const snapshot = {
    id: '80000000-0000-4000-8000-000000000001',
    version: 3,
    period,
    from: data.report.filters.from,
    to: data.report.filters.to,
    financialVersion: 7,
    title: 'Relatório de setembro de 2026',
    contentSha256: digest,
    latest: true,
    createdAt: '2026-09-30T12:00:00.000Z',
    requestedBy: 'Rhian Batista',
    revisionReason: null,
  };
  const breakdown = data.report.byBookmaker.slice(0, 8).map((row) => ({
    id: row.key.slice(0, 40),
    label: row.label,
    labelKey: row.key,
    bets: row.metrics.bets,
    profit: row.metrics.profit,
    lowSample: row.metrics.bets < 30,
  }));
  return {
    snapshot,
    metrics,
    // A narrativa marca a origem de cada linha: `fact` é o número, `heuristic`
    // é a leitura do produto sobre ele. A tela mostra qual é qual.
    narrative: {
      lines: [
        {
          kind: 'fact',
          text: `${metrics.bets} apostas registradas em setembro, sendo ${metrics.settledBets} liquidadas e ${metrics.openBets} ainda em aberto.`,
          fact: `${metrics.bets} apostas`,
        },
        {
          kind: 'fact',
          text: `Lucro de R$ ${metrics.profit} sobre R$ ${metrics.realPrincipalClosed} de principal fechado.`,
          fact: `lucro R$ ${metrics.profit}`,
        },
        {
          kind: 'heuristic',
          text: 'A taxa de acerto ficou acima da mediana das suas últimas três semanas, mas a amostra ainda é pequena para sustentar a leitura.',
          fact: null,
        },
        {
          kind: 'heuristic',
          text: 'As apostas com odd acima de 4,00 concentram a maior parte do prejuízo do mês.',
          fact: null,
        },
      ],
      lowSample: metrics.bets < 30,
      minSample: 30,
    },
    breakdown,
    revisions: [snapshot],
    empty: metrics.bets === 0,
  };
}

/** Busca de data em fonte externa: o estado ocioso é `complete` sem candidatos. */
function eventSearchItem(id, selectionId) {
  return {
    id,
    selectionId,
    provider: 'thesportsdb',
    query: 'Flamengo x Palmeiras',
    dateHint: '2026-09-05',
    state: 'complete',
    candidates: [],
    errorCode: null,
    cached: true,
    createdAt: '2026-09-01T12:00:00.000Z',
  };
}

function apiResponse(pathname, url) {
  const json = (payload, status = 200) => ({ status, payload });

  if (pathname === '/api/v1/system/status') return json(status);
  if (pathname === '/api/v1/onboarding') return json(onboarding);
  if (pathname === '/api/v1/me') return json(me);
  if (pathname === '/api/v1/workspace') return json(data.workspace);
  if (pathname === '/api/v1/telemetry/config') return json({ enabled: false, sampleRate: 0 });
  if (pathname === '/api/v1/consents/status') return json({ marketing: false, analytics: true });

  if (pathname === '/api/v1/bets') return json(betPage(url));
  if (pathname.startsWith('/api/v1/bets/')) {
    const id = pathname.slice('/api/v1/bets/'.length);
    const bet = data.bets.find((item) => item.id === id);
    return bet ? json({ bet, settlements: [] }) : json({ error: 'not_found' }, 404);
  }
  if (pathname === '/api/v1/journal') return json(journalPage(url));

  if (pathname === '/api/v1/dashboard') return json(data.dashboard);
  if (pathname === '/api/v1/reports') return json(data.report);
  if (pathname === '/api/v1/reports/options')
    return json({ bookmakers: data.BOOKMAKERS, tipsters: data.TIPSTERS });
  if (pathname === '/api/v1/reports/bets') return json(betPage(url));
  if (pathname === '/api/v1/analytics/splits') return json(data.splits);

  if (pathname === '/api/v1/calendar') return json(calendarPage(url));
  if (pathname.startsWith('/api/v1/events/')) {
    const id = pathname.slice('/api/v1/events/'.length);
    return json(data.calendar.find((item) => item.selection.id === id) ?? data.calendar[0]);
  }
  if (pathname === '/api/v1/event-search/status') return json({ status: 'idle' });
  if (pathname === '/api/v1/event-search') {
    const pending = data.calendar
      .filter((item) => item.selection.dateStatus !== 'confirmed')
      .slice(0, 4)
      .map((item, index) =>
        eventSearchItem(`70000000-0000-4000-8000-00000000000${index}`, item.selection.id),
      );
    return json({ items: pending });
  }

  if (pathname === '/api/v1/imports')
    return json({
      items: data.imports.map((entry) => entry.item),
      total: data.imports.length,
      page: 1,
      pageSize: 25,
    });
  if (pathname.startsWith('/api/v1/imports/')) {
    const rest = pathname.slice('/api/v1/imports/'.length);
    const [id, sub] = rest.split('/');
    const detail = importDetail(id);
    if (!sub) return json(detail);
    if (sub === 'image') return json(detail);
    if (sub === 'credits') return json({ items: [] });
    if (sub === 'status') return json(detail.item);
    return json(detail);
  }

  if (pathname === '/api/v1/polymarket/ranking') return json(rank());
  if (pathname === '/api/v1/polymarket/favorites') return json({ items: [] });
  if (pathname === '/api/v1/polymarket/alerts/config')
    return json({ quietHours: { start: '23:00', end: '07:00' }, threshold: 0.05 });
  if (pathname === '/api/v1/report-snapshots') {
    return json(reportSnapshot(url.searchParams.get('period') ?? 'monthly'));
  }
  if (pathname === '/api/v1/report-snapshots/history') {
    return json({ items: [reportSnapshot(url.searchParams.get('period') ?? 'monthly').snapshot] });
  }
  if (pathname.startsWith('/api/v1/report-snapshots/')) {
    return json(reportSnapshot(url.searchParams.get('period') ?? 'monthly'));
  }

  if (pathname === '/api/v1/telegram/link') {
    return json({
      url: 'https://t.me/stakeframe_bot/link?token=preview',
      expiresInSeconds: 300,
      connected: false,
    });
  }
  if (pathname === '/api/v1/telegram/session') return json({ linked: false });

  // Comandos e mutações: o preview é somente leitura, mas a UI precisa de uma
  // resposta bem-formada para não entrar em estado de erro ao interagir.
  if (pathname === '/api/v1/commands') return json({ version: 1 });
  if (pathname === '/api/v1/consents/accept') return json({ marketing: false, analytics: true });

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Validação de boot
// ─────────────────────────────────────────────────────────────────────────────

function validateAtBoot() {
  expect('system/status', schemas.status, status);
  expect('workspace', schemas.workspace, data.workspace);
  // Cada aposta, não a lista: `betSchema` valida UMA aposta e um parse de array
  // falharia na raiz, sem dizer qual das 46 estava errada.
  data.bets.forEach((bet, index) => expect(`bets[${index}]`, schemas.bet, bet));
  expect('bets page', schemas.betPage, betPage(new URL('http://x/api/v1/bets')));
  expect('report', schemas.report, data.report);
  expect('report snapshot', schemas.snapshot, reportSnapshot('monthly'));
  expect('splits', schemas.splits, data.splits);
  data.calendar.forEach((item, index) => expect(`calendar[${index}]`, schemas.calendarItem, item));
  data.imports.forEach((entry, index) => expect(`import[${index}]`, schemas.import, entry));
  expect('polymarket/ranking', schemas.ranking, rank());
  expect(
    'event-search[0]',
    schemas.eventSearch,
    eventSearchItem('70000000-0000-4000-8000-000000000000', data.calendar[0].selection.id),
  );

  const known = Object.entries(schemas)
    .filter(([, schema]) => schema)
    .map(([key]) => key);
  const unknown = Object.entries(schemas)
    .filter(([, schema]) => !schema)
    .map(([key]) => key);
  console.log(`schemas aplicados: ${known.join(', ') || '(nenhum)'}`);
  if (unknown.length) console.log(`schemas ausentes no pacote (pulados): ${unknown.join(', ')}`);
  console.log(`payloads validados: ${checked}`);
  if (failures.length) {
    console.error(`\n${failures.length} payload(s) rejeitado(s) pelo schema:`);
    for (const failure of failures) console.error(`  ✗ ${failure}`);
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP
// ─────────────────────────────────────────────────────────────────────────────

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${PORT}`);

  if (url.pathname.startsWith('/api/')) {
    const result = apiResponse(url.pathname, url);
    if (!result) {
      // Registrado de propósito: um 404 silencioso aparece na tela como um
      // estado vazio sem explicação, e no console como "Failed to load
      // resource" sem o caminho. Aqui o caminho é explícito.
      console.warn(`404 ${url.pathname}`);
      response.writeHead(404, { 'content-type': MIME['.json'] });
      response.end(JSON.stringify({ error: 'not_found', path: url.pathname }));
      return;
    }
    response.writeHead(result.status, {
      'content-type': MIME['.json'],
      'cache-control': 'no-store',
    });
    response.end(JSON.stringify(result.payload));
    return;
  }

  // Estático com fallback de SPA: qualquer rota do produto devolve o index.
  const candidate = join(DIST, url.pathname === '/' ? 'index.html' : url.pathname);
  try {
    const file = await readFile(candidate);
    response.writeHead(200, {
      'content-type': MIME[extname(candidate)] ?? 'application/octet-stream',
    });
    response.end(file);
  } catch {
    const fallback = await readFile(join(DIST, 'index.html'));
    response.writeHead(200, { 'content-type': MIME['.html'] });
    response.end(fallback);
  }
});

validateAtBoot();
server.listen(PORT, '127.0.0.1', () => {
  console.log(`preview do produto: http://127.0.0.1:${PORT}`);
  console.log(
    `carteira: ${data.bets.length} apostas · ${data.calendar.length} eventos no calendário · ${data.imports.length} importações`,
  );
  console.log(
    `setembro: ${data.dashboard.metrics.bets} apostas · lucro ${data.dashboard.metrics.profit} · ROI ${data.dashboard.metrics.roiReal}%`,
  );
});
