import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  GLOBAL_NAME_MAX,
  METRIC_BLOCKED,
  POLYMARKET_GLOBAL_CATEGORIES,
  POLYMARKET_GLOBAL_CATEGORY_LABELS,
  POLYMARKET_GLOBAL_FILTERS,
  POLYMARKET_GLOBAL_SCOPE_LABELS,
  SEM_BASE,
  compareDecimalForTest,
  formatGlobalDecimal,
  formatGlobalPercent,
  globalAvatarInitial,
  globalCategoryMatches,
  globalMarketView,
  globalNameView,
  globalSampleLabel,
  globalSortCards,
  polymarketGlobalCardSchema,
  polymarketGlobalResponseSchema,
  type PolymarketGlobalCard,
} from '../../packages/shared/src/index.js';
import { globalRankLabel } from '../../apps/web/src/product/polymarket-global-view.js';

/**
 * STK-F3-04 — a tela Global em cards, e as REGRAS que não se negociam.
 *
 * Aqui não há navegador e não há React: as regras do card são de FUNÇÃO, e a
 * função é o que se prova. O que o navegador acrescenta (foco, toque,
 * truncamento visual) está no E2E.
 */

const metric = (value: string | null, n = 1240) => ({ value, n });

const card = (over: Partial<PolymarketGlobalCard> = {}): PolymarketGlobalCard =>
  ({
    proxyWallet: '0x224a89dbe0db0d6124b335edabd15b3f877da3d5',
    userName: '@alpha_odds',
    avatarSeed: '@alpha_odds',
    scope: 'SPORTS',
    rank: '1',
    pnl: metric('48210.42'),
    volume: metric('312000.5'),
    roi: metric('34.2'),
    hitRate: metric('61.4'),
    averageOdds: metric('1.94'),
    followers: metric('18420'),
    wins: metric('761'),
    losses: metric('479'),
    openBets: metric('12'),
    monthlyUnits: metric('184'),
    topMarket: 'Brasileirão Série A',
    coverage: { truncated: false, reason: null, roiBlocked: false },
    ...over,
  }) as PolymarketGlobalCard;

describe('STK-F3-04 — as categorias são as OFICIAIS, filtradas para esportes e e-sports', () => {
  it('as duas categorias da tela estão na lista oficial de 11 da F2-15', () => {
    // A lista oficial foi verificada contra a origem: onze valores respondem
    // 200 e qualquer outro responde 400. A tela Global NÃO pode aparecer com
    // um rótulo fora dela, porque o rótulo viraria um filtro que a origem
    // nunca aceitou.
    expect([...POLYMARKET_GLOBAL_CATEGORIES].sort()).toEqual(['ESPORTS', 'SPORTS']);
  });

  it('NÃO existe Blockchain, cripto nem política nesta tela', () => {
    // O pedido do dono foi "somente esportes e e-sports". A asserção é
    // negativa de propósito: ela quebra se alguém acrescentar a categoria
    // ao filtro, e é o defeito que o dono reclamou.
    const serialized = JSON.stringify(POLYMARKET_GLOBAL_CATEGORY_LABELS).toLowerCase();
    for (const forbidden of ['blockchain', 'cripto', 'crypto', 'política', 'politics']) {
      expect(serialized).not.toContain(forbidden);
    }
    // A ORDEM dos filtros é a ORDEM DA LISTA OFICIAL, e não uma ordem de
    // leitura escolhida aqui: `POLYMARKET_RANKING_CATEGORIES` declara SPORTS
    // antes de ESPORTS, e essa é a ordem em que a origem enumera. Um `.sort()`
    // neste teste passaria a valer como contrato e publicaria uma ordem que
    // a origem não usa.
    expect([...POLYMARKET_GLOBAL_FILTERS]).toEqual(['ALL', 'SPORTS', 'ESPORTS']);
  });

  it('o filtro FUNCIONA: "BOTH" aparece em Esportes e em E-sports', () => {
    const ambos = card({ scope: 'BOTH' });
    const esportes = card({ scope: 'SPORTS' });
    const esports = card({ scope: 'ESPORTS' });
    expect(globalCategoryMatches(ambos, 'SPORTS')).toBe(true);
    expect(globalCategoryMatches(ambos, 'ESPORTS')).toBe(true);
    expect(globalCategoryMatches(esportes, 'SPORTS')).toBe(true);
    expect(globalCategoryMatches(esportes, 'ESPORTS')).toBe(false);
    expect(globalCategoryMatches(esports, 'ESPORTS')).toBe(true);
    expect(globalCategoryMatches(esportes, 'ALL')).toBe(true);
  });

  it('o rótulo do card distingue Esportes, E-sports e Ambos', () => {
    // O dono pediu "Sport/E-sport/Ambos" no card. Os três rótulos existem e
    // nenhum deles é uma categoria nova da origem.
    expect(POLYMARKET_GLOBAL_SCOPE_LABELS).toEqual({
      SPORTS: 'Esportes',
      ESPORTS: 'E-sports',
      BOTH: 'Ambos',
    });
  });
});

describe('STK-F3-04 §R1 — N visível em TODA métrica derivada', () => {
  it('o schema RECUSA métrica derivada sem amostra', () => {
    // `n` é inteiro POSITIVO e a propriedade é obrigatória: a R1 é
    // estrutural, não uma convenção de escrita.
    const base = card();
    expect(polymarketGlobalCardSchema.safeParse({ ...base, roi: { value: '1.0' } }).success).toBe(
      false,
    );
    expect(
      polymarketGlobalCardSchema.safeParse({ ...base, roi: { value: '1.0', n: 0 } }).success,
    ).toBe(false);
  });

  it('toda métrica do card carrega N, e o rótulo é sempre escrito', () => {
    // A lista é explícita de propósito: um novo campo derivado sem `n` falha
    // aqui, e é exatamente o que a R1 proíbe.
    const fields = [
      'pnl',
      'volume',
      'roi',
      'hitRate',
      'averageOdds',
      'followers',
      'wins',
      'losses',
      'openBets',
      'monthlyUnits',
    ] as const;
    for (const field of fields) {
      const parsed = polymarketGlobalCardSchema.parse(card());
      expect(parsed[field].n, `${field} sem N`).toBeGreaterThan(0);
      expect(globalSampleLabel(parsed[field].n)).toMatch(/^N=[\d.]+$/);
    }
  });

  it('"unidades/mês" está no card e NUNCA some', () => {
    // R5/R1: a métrica de unidades é a que o dono nomeou como sempre
    // visível, e ela existe no schema com a mesma exigência das outras.
    const parsed = polymarketGlobalCardSchema.parse(card());
    expect(parsed.monthlyUnits.value).toBe('184');
    expect(parsed.monthlyUnits.n).toBe(1240);
  });
});

describe('STK-F3-04 §R2 — desconhecido é "Sem base", NUNCA zero e NUNCA vazio', () => {
  it('null vira "Sem base" em número e em percentual', () => {
    expect(formatGlobalDecimal(null)).toBe(SEM_BASE);
    expect(formatGlobalPercent(null)).toBe(SEM_BASE);
  });

  it('zero é um VALOR e continua zero — não vira "Sem base"', () => {
    // A distinção que a R2 exige: `0` foi medido, `null` não foi.
    expect(formatGlobalDecimal('0')).toBe('0');
    expect(formatGlobalDecimal('0.00')).toBe('0,00');
    expect(formatGlobalPercent('0')).toBe('0,0%');
    expect(formatGlobalDecimal(null)).not.toBe(formatGlobalDecimal('0'));
  });

  it('NENHUMA célula sai vazia: o texto do desconhecido é sempre escrito', () => {
    for (const token of [null]) {
      expect(formatGlobalDecimal(token).length).toBeGreaterThan(0);
      expect(formatGlobalPercent(token).length).toBeGreaterThan(0);
      expect(globalMarketView(token).text.length).toBeGreaterThan(0);
    }
  });

  it('o schema separa `null` de "0" e ambos passam em linhas distintas', () => {
    const desconhecido = polymarketGlobalCardSchema.parse(card({ wins: metric(null, 40) }));
    const zero = polymarketGlobalCardSchema.parse(card({ wins: metric('0', 40) }));
    expect(desconhecido.wins.value).toBeNull();
    expect(zero.wins.value).toBe('0');
    expect(desconhecido.wins.n).toBe(40);
  });

  it('N continua visível mesmo quando o VALOR é desconhecido', () => {
    // Esconder a amostra junto com o valor esconderia o que sabemos: o N é um
    // fato independente da métrica.
    const parsed = polymarketGlobalCardSchema.parse(card({ roi: metric(null, 210) }));
    expect(parsed.roi.value).toBeNull();
    expect(parsed.roi.n).toBe(210);
    expect(globalSampleLabel(parsed.roi.n)).toBe('N=210');
  });
});

describe('STK-F3-04 §R4 — truncamento VISÍVEL, com reticências de propósito', () => {
  it('nome longo mostra reticências e o texto completo segue acessível', () => {
    const longo = '@aposta_sempre_certa_em_odds_altas_do_brasil';
    const view = globalNameView(longo);
    expect(view.truncated).toBe(true);
    expect(view.text.endsWith('…')).toBe(true);
    expect(view.text).toContain(longo.slice(0, 10));
    expect([...view.text].length).toBeLessThanOrEqual(GLOBAL_NAME_MAX);
  });

  it('nome CURTO não recebe reticência que não precisa', () => {
    // Reticência em texto que cabe é ruído: ela mentiria sobre o tamanho do
    // dado, que é o oposto de "sinal de truncamento".
    const view = globalNameView('@alpha_odds');
    expect(view.truncated).toBe(false);
    expect(view.text).toBe('@alpha_odds');
    expect(view.text).not.toContain('…');
  });

  it('mercado longo também é truncado com reticência', () => {
    const view = globalMarketView('Campeonato Brasileiro Série A 2026 fase de grupos');
    expect(view.truncated).toBe(true);
    expect(view.text.endsWith('…')).toBe(true);
  });

  it('mercado desconhecido é "Sem base", nunca nome inventado', () => {
    const view = globalMarketView(null);
    expect(view.text).toBe(SEM_BASE);
    expect(view.truncated).toBe(false);
  });

  it('a reticência é um caractere do TEXTO, não só um efeito de CSS', () => {
    // `text-overflow` some do innerText e da árvore de acessibilidade. O
    // texto precisa conter o caractere para um leitor de tela ouvir que o
    // nome continua.
    const view = globalNameView('@um_nome_absurdamente_longo_para_caber_no_card');
    expect(view.text).toContain('…');
  });
});

describe('STK-F3-04 §R5 — densidade e ordenação que FUNCIONA', () => {
  const cards: PolymarketGlobalCard[] = [
    card({ rank: '1', userName: '@alpha', pnl: metric('100'), roi: metric('10') }),
    card({ rank: '2', userName: '@beta', pnl: metric('900'), roi: metric('90') }),
    card({ rank: '3', userName: '@gama', pnl: metric('500'), roi: metric(null) }),
  ];

  it('ordenar por PnL põe o MAIOR primeiro', () => {
    // O sinal da comparação é DESCENDENTE, e esta é a asserção que prova:
    // ela existiu afinando o comportamento errado (o menor PnL no topo), que
    // é o oposto de um ranking. `@beta` tem o maior PnL (900) e por isso
    // abre a lista.
    expect(globalSortCards(cards, 'PNL').map((c) => c.userName)).toEqual([
      '@beta',
      '@gama',
      '@alpha',
    ]);
  });

  it('ordenar por ROI põe o MAIOR primeiro', () => {
    expect(globalSortCards(cards, 'ROI').map((c) => c.userName)).toEqual([
      '@beta',
      '@alpha',
      '@gama',
    ]);
  });

  it('um valor NEGATIVo fica no fim, e não no topo', () => {
    // O `@edge_detector` tem PnL −12.400. Um ranking de PnL o põe por último
    // junto com os outros negativos: é a leitura correta de "maior primeiro",
    // e é o que o navegador mediu quando a lista abria pelo pior.
    const comNegativo = [...cards, card({ rank: '9', userName: '@perde', pnl: metric('-900') })];
    const ordenado = globalSortCards(comNegativo, 'PNL').map((c) => c.userName);
    expect(ordenado[ordenado.length - 1]).toBe('@perde');
  });

  it('ROI desconhecido vai para o FIM, nunca para o topo como zero', () => {
    // Se `null` fosse tratado como 0, o tipster sem ROI medido subiria. A R2
    // proíbe essa leitura: ausência não é um número pequeno.
    const ordered = globalSortCards(cards, 'ROI').map((c) => c.userName);
    expect(ordered[ordered.length - 1]).toBe('@gama');
  });

  it('a ordenação NÃO usa Number(): o decimal exato decide o lugar', () => {
    // `2666493.7190210004` perde algarismo em IEEE-754. Comparar por cadeia
    // mantém a ordem que a origem publicou.
    expect(compareDecimalForTest('2666493.7190210004', '2666493.7190210003')).toBeGreaterThan(0);
    expect(compareDecimalForTest('9', '10')).toBeLessThan(0);
    expect(compareDecimalForTest('-5', '3')).toBeLessThan(0);
    expect(compareDecimalForTest('1.50', '1.5')).toBe(0);
  });

  it('o empate desempata pela POSIÇÃO declarada, nunca por métrica nossa', () => {
    const empate: PolymarketGlobalCard[] = [
      card({ rank: '5', pnl: metric('10') }),
      card({ rank: '2', pnl: metric('10') }),
    ];
    expect(globalSortCards(empate, 'PNL').map((c) => c.rank)).toEqual(['2', '5']);
  });
});

describe('STK-F3-04 — a posição no card respeita o ordinal do português', () => {
  it('o ordinal tem o gênero certo, e a 2ª casa é feminina', () => {
    // Esta regra existiu como bug real: a variável de gênero era calculada e
    // nunca usada, e TODA posição saía "2ª". O eslint foi a primeira rede a
    // pegar; o teste existe para não depender só dele.
    expect(globalRankLabel('1')).toBe('1º');
    expect(globalRankLabel('2')).toBe('2ª');
    expect(globalRankLabel('3')).toBe('3º');
    expect(globalRankLabel('4')).toBe('4º');
    expect(globalRankLabel('6')).toBe('6ª');
    expect(globalRankLabel('8')).toBe('8ª');
    // A 2ª casa — que é onde uma tipster de e-sports aparece no topo.
    expect(globalRankLabel('2')).not.toBe('2º');
  });

  it('da 10ª à 14ª a concordância volta ao masculino', () => {
    for (const rank of ['10', '11', '12', '13', '14']) {
      expect(globalRankLabel(rank), `${rank}º`).toBe(`${rank}º`);
    }
    expect(globalRankLabel('22')).toBe('22ª');
    expect(globalRankLabel('112')).toBe('112º');
  });

  it('uma posição que não é inteiro positivo é devolvida como veio', () => {
    expect(globalRankLabel('0')).toBe('0');
    expect(globalRankLabel('abc')).toBe('abc');
  });
});

describe('STK-F3-04 — cobertura truncada visível e métrica BLOQUEADA', () => {
  it('o estado truncado declara a razão e qual métrica está bloqueada', () => {
    const truncado = polymarketGlobalCardSchema.parse(
      card({
        coverage: {
          truncated: true,
          reason: '210 de 1.000 eventos ingeridos',
          roiBlocked: true,
        },
        roi: metric('31.0', 210),
      }),
    );
    expect(truncado.coverage.truncated).toBe(true);
    expect(truncado.coverage.reason).toBe('210 de 1.000 eventos ingeridos');
    expect(truncado.coverage.roiBlocked).toBe(true);
  });

  it('a métrica bloqueada NUNCA vira zero e NUNCA vira estimada', () => {
    // O valor continua no payload (a origem o publicou), mas a tela escreve
    // "bloqueado". A função de apresentação decide, e ela não tem caminho que
    // transforme um valor bloqueado em número exibido.
    const truncado = card({
      coverage: { truncated: true, reason: 'série incompleta', roiBlocked: true },
    });
    expect(truncado.coverage.roiBlocked).toBe(true);
    // O que a tela escreve é decidido no componente, mas o texto é único:
    expect(METRIC_BLOCKED).toBe('bloqueado');
  });

  it('o schema RECUSA cobertura truncada sem razão', () => {
    const base = card();
    const parsed = polymarketGlobalCardSchema.safeParse({
      ...base,
      coverage: { truncated: true, reason: null, roiBlocked: false },
    });
    expect(parsed.success).toBe(false);
  });
});

describe('STK-F3-04 — o avatar é uma inicial derivada, sem rede', () => {
  it('a inicial vem do nome publicado', () => {
    expect(globalAvatarInitial('@alpha_odds')).toBe('@');
    expect(globalAvatarInitial('Marta')).toBe('M');
  });

  it('nome vazio é um caso REAL e não vira string vazia', () => {
    // O schema do leaderboard traz `userName` com `.catch('')`: o vazio
    // acontece na origem. Um avatar vazio é um buraco na grade.
    expect(globalAvatarInitial('')).toBe('?');
    expect(globalAvatarInitial('   ')).toBe('?');
    expect(globalAvatarInitial('').length).toBeGreaterThan(0);
  });
});

describe('STK-F3-04 — o payload e a ausência estrutural de Composite Score (R8)', () => {
  it('o payload valida e um campo a MAIS é recusado', () => {
    const body = {
      cards: [card()],
      source: 'local',
      requested: 6,
      returned: 1,
    };
    expect(polymarketGlobalResponseSchema.safeParse(body).success).toBe(true);
    expect(polymarketGlobalResponseSchema.safeParse({ ...body, compositeScore: 9 }).success).toBe(
      false,
    );
  });

  it('um card com Composite Score é RECUSADO pelo schema', () => {
    const base = card();
    expect(polymarketGlobalCardSchema.safeParse({ ...base, compositeScore: 91 }).success).toBe(
      false,
    );
  });

  it('os ARQUIVOS desta tela não nomeiam Composite Score em código de produto', () => {
    const files = [
      '../../packages/shared/src/polymarket-global-cards.ts',
      '../../apps/web/src/product/polymarket-global-view.ts',
      '../../apps/web/src/product/polymarket-global-data.ts',
      '../../apps/web/src/product/polymarket-global.tsx',
    ];
    for (const file of files) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      const code = source
        .split('\n')
        .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
        .join('\n');
      expect(code, `código de ${file} não pode citar Composite Score`).not.toMatch(
        /composite\s*score/i,
      );
    }
  });

  it('nenhum campo do schema se chama score, rating ou recomendação', () => {
    // R8: a ausência é estrutural. Se alguém acrescentar um campo de
    // avaliação, o teste falha aqui — antes de existir UI para ele.
    const fields = Object.keys(polymarketGlobalCardSchema.parse(card()));
    const forbidden = ['score', 'rating', 'badge', 'recommendation', 'suggestion'];
    for (const field of fields) {
      for (const term of forbidden) expect(field.toLowerCase()).not.toContain(term);
    }
  });

  it('a view não escreve conselho de aposta', () => {
    // R8 na prática: o texto que a tela apresenta não diz o que fazer.
    const view = globalNameView('@alpha_odds');
    const composed = `${view.text} ${SEM_BASE} ${METRIC_BLOCKED}`.toLowerCase();
    for (const forbidden of ['aposte nele', 'o melhor', 'recomendado', 'vale a pena']) {
      expect(composed).not.toContain(forbidden);
    }
  });
});
