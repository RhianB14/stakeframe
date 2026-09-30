import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  LEADERBOARD_ORDER_BY,
  LEADERBOARD_TIME_PERIODS,
  POLYMARKET_CATEGORY_LABELS,
  POLYMARKET_DEFAULT_WINDOW,
  POLYMARKET_ORDER_LABELS,
  POLYMARKET_PERIOD_LABELS,
  POLYMARKET_RANKING_CATEGORIES,
  POLYMARKET_RANKING_LIMIT,
  canonicalDecimalToken,
  formatExactDecimal,
  polymarketRankingQuerySchema,
  polymarketRankingRowSchema,
  polymarketRankingSchema,
  rankingAggregatePolicy,
  rankingCompleteness,
  rankingSample,
  rankingStatusLabel,
  type BackfillStatus,
  type PolymarketRanking,
} from '../../packages/shared/src/index.js';
import {
  rankingRowView,
  rankingSampleViews,
  rankingView,
} from '../../apps/web/src/product/ranking-view.js';

/**
 * STK-F2-15 §15 — "Ranking oficial e Composite Score oculto".
 *
 * Este arquivo é o teste que o card pede, e ele tem TRÊS partes que precisam
 * ser provadas por vias diferentes:
 *
 *  1) O RANKING É O OFICIAL. Os enums são os que a origem aceitou, os valores
 *     são os decimais exatos que ela publicou, e a posição é a que ela
 *     declarou. Nada aqui arredonda, reordena ou deriva.
 *
 *  2) A SÉRIE TRUNCADA É VISÍVEL, e ela vem do status GRAVADO. Este é o
 *     ponto em que a interface pode mentir com muita naturalidade: mil
 *     traders na tela com a série truncada parecem um ranking inteiro. O
 *     teste monta as DUAS situações — 100 linhas com status `truncated` e 3
 *     linhas com status `complete` — e exige o aviso em uma e não na outra.
 *
 *  3) O COMPOSITE SCORE ESTÁ AUSENTE DA UI. E esta parte é verificada de três
 *     formas, porque "não achei o termo no grep" não é prova: o schema
 *     RECUSA um campo de pontuação (§1), a função pura não produz texto de
 *     score (§2), e o RENDER não escreve score nem badge nem recomendação (§3,
 *     no e2e).
 */

/** Uma linha observada, com os literais que a origem publicou. */
const row = (over: Partial<PolymarketRanking['rows'][number]> = {}) => ({
  rank: '2',
  proxyWallet: '0x224a89dbe0db0d6124b335edabd15b3f877da3d5',
  userName: 'wr0ngw4yb3tt0r',
  pnl: '792578.3948993701',
  vol: '2666493.7190210004',
  ...over,
});

/** O payload com um estado de série explícito. */
const ranking = (over: Partial<PolymarketRanking> = {}): PolymarketRanking =>
  polymarketRankingSchema.parse({
    window: { category: 'OVERALL', timePeriod: 'MONTH', orderBy: 'PNL' },
    series: {
      status: 'complete',
      available: true,
      ingested: 100,
      backfillFrom: '2026-04-01',
      pages: 2,
      failedPages: 0,
    },
    completeness: rankingCompleteness({
      series: { status: 'complete', available: true, ingested: 100, pages: 2, failedPages: 0 },
    }),
    sample: rankingSample({ n: 1, minSample: 30 }),
    aggregate: { blocked: false, reason: null },
    requested: POLYMARKET_RANKING_LIMIT,
    returned: 1,
    rows: [row()],
    ...over,
  });

/** As N linhas de um top truncado, com posições e carteiras distintas. */
const manyRows = (n: number) =>
  Array.from({ length: n }, (_, index) =>
    row({
      rank: String(index + 1),
      proxyWallet: `0x${String(index).padStart(40, '0')}`,
    }),
  );

describe('STK-F2-15 §15 — os enums são os OFICIAIS da API', () => {
  it('as categorias são exatamente as onze que a documentação declara', () => {
    // A lista veio da documentação oficial de /v1/leaderboard CRUZADA com o
    // comportamento observado: os onze respondem 200 e rótulos fora da lista
    // respondem 400. A F2-14 afirmava que só `OVERALL` era aceito, e o CHECK
    // do banco ainda impõe isso — a divergência está registrada e a interface
    // a trata como "janela ainda não coletada", nunca como lista vazia.
    expect(POLYMARKET_RANKING_CATEGORIES).toEqual([
      'OVERALL',
      'POLITICS',
      'SPORTS',
      'ESPORTS',
      'CRYPTO',
      'CULTURE',
      'MENTIONS',
      'WEATHER',
      'ECONOMICS',
      'TECH',
      'FINANCE',
    ]);
  });

  it('toda categoria tem rótulo e nenhum rótulo sobra ou falta', () => {
    // Um `Record` com `satisfies` já impede o esquecimento em tempo de
    // compilação; o teste garante que a troca do rótulo não acontece em
    // silêncio e que o rótulo nunca fica vazio (uma opção sem texto na tela).
    expect(Object.keys(POLYMARKET_CATEGORY_LABELS).sort()).toEqual(
      [...POLYMARKET_RANKING_CATEGORIES].sort(),
    );
    for (const category of POLYMARKET_RANKING_CATEGORIES)
      expect(POLYMARKET_CATEGORY_LABELS[category]).toMatch(/\S/);
  });

  it('períodos e ordenações são os da F2-14, e nenhum valor novo é aceito', () => {
    // Os períodos e a ordenação NÃO são redefinidos aqui: são os mesmos
    // valores que a F2-14 provou e gravou no CHECK do banco. Se esta lista
    // crescesse, a F2-14 gravaria uma janela que o banco recusa.
    expect(Object.keys(POLYMARKET_PERIOD_LABELS)).toEqual([...LEADERBOARD_TIME_PERIODS]);
    expect(Object.keys(POLYMARKET_ORDER_LABELS)).toEqual([...LEADERBOARD_ORDER_BY]);
  });

  it('a consulta recusa categoria, período e ordenação fora do enum oficial', () => {
    // Um parâmetro INVÁLIDO é 400, não ignorado: um filtro digitado que não
    // aplica é pior do que um filtro recusado.
    const valid = polymarketRankingQuerySchema.parse({});
    expect(valid).toEqual({
      category: 'OVERALL',
      timePeriod: 'MONTH',
      orderBy: 'PNL',
      limit: 100,
    });
    expect(polymarketRankingQuerySchema.safeParse({ category: 'SCIENCE' }).success).toBe(false);
    expect(polymarketRankingQuerySchema.safeParse({ timePeriod: '30d' }).success).toBe(false);
    expect(polymarketRankingQuerySchema.safeParse({ orderBy: 'VOLUME' }).success).toBe(false);
    // Parâmetro a mais é recusado, e não ignorado em silêncio.
    expect(polymarketRankingQuerySchema.safeParse({ score: 10 }).success).toBe(false);
  });

  it('o ranking padrão é o do card: PnL oficial de 30 dias', () => {
    // "30d" não existe no enum da API: o valor oficial é `MONTH`, e é ele que
    // vai para a query. O rótulo é que diz 30 dias.
    expect(POLYMARKET_DEFAULT_WINDOW).toEqual({
      category: 'OVERALL',
      timePeriod: 'MONTH',
      orderBy: 'PNL',
    });
    expect(POLYMARKET_PERIOD_LABELS.MONTH).toBe('30 dias');
  });

  it('o top 100 é o teto e não um DEFAULT silencioso', () => {
    expect(POLYMARKET_RANKING_LIMIT).toBe(100);
    expect(polymarketRankingQuerySchema.parse({}).limit).toBe(100);
    // Acima do top 100 é recusado: a tela não oferece um "top 500" que a
    // origem paginaria de cinco em cinco sem nunca declarar o fim.
    expect(polymarketRankingQuerySchema.safeParse({ limit: 500 }).success).toBe(false);
  });
});

describe('STK-F2-15 §15 — os valores são os OFICIAIS e exatos', () => {
  it('P&L e volume chegam como decimal literal, sem float', () => {
    // O valor real observado na origem (`2666493.7190210004`) NÃO sobrevive a
    // um `number` do JavaScript. O schema exige o literal, e um float no
    // caminho é recusado em vez de ser aceito com perda silenciosa.
    const parsed = polymarketRankingRowSchema.parse(row());
    expect(parsed.pnl).toBe('792578.3948993701');
    expect(parsed.vol).toBe('2666493.7190210004');
    // Notação científica e `null` não são decimais: a origem saiu do contrato.
    expect(polymarketRankingRowSchema.safeParse(row({ pnl: '1e5' })).success).toBe(false);
    expect(polymarketRankingRowSchema.safeParse(row({ vol: 'NaN' })).success).toBe(false);
  });

  it('a exibição não arredonda: o literal volta inteiro na formatação', () => {
    // A regra é verificável: tirar a máscara da saída devolve, caractere a
    // caractere, o que a origem publicou. Um arredondamento quebraria isso.
    expect(formatExactDecimal('3654334.788786006')).toBe('US$ 3.654.334,788786006');
    expect(formatExactDecimal('-1234.5')).toBe('−US$ 1.234,5');
    expect(formatExactDecimal('0')).toBe('US$ 0');
    expect(formatExactDecimal('1000')).toBe('US$ 1.000');
    const shown = formatExactDecimal('792578.3948993701').replace(/[^\d]/g, '');
    expect(shown).toBe('7925783948993701');
  });

  it('a carteira fora do formato é recusada: identidade não é adivinhada', () => {
    expect(polymarketRankingRowSchema.safeParse(row({ proxyWallet: '0x123' })).success).toBe(false);
    expect(
      polymarketRankingRowSchema.safeParse(
        row({ proxyWallet: '0xZZ4a89dbe0db0d6124b335edabd15b3f877da3d5' }),
      ).success,
    ).toBe(false);
  });

  it('o padding de escala do banco volta à grafia da origem, sem perder dígito', () => {
    // O `numeric(38, 18)` do Postgres devolve a escala CHEIA. Sem esta
    // normalização o schema da tela recusaria a linha inteira — e, se não
    // recusasse, a tela mostraria um texto que a Polymarket nunca publicou.
    // Remover zeros à DIREITA nunca muda o valor; remover à esquerda mudaria,
    // e por isso a função é testada nos dois sentidos.
    expect(canonicalDecimalToken('792578.394899370100000000')).toBe('792578.3948993701');
    expect(canonicalDecimalToken('2666493.719021000400000000')).toBe('2666493.7190210004');
    expect(canonicalDecimalToken('100.000000000000000000')).toBe('100');
    expect(canonicalDecimalToken('0.000000000000000001')).toBe('0.000000000000000001');
    expect(canonicalDecimalToken('-0.500000000000000000')).toBe('-0.5');
    // Idempotente: canonicalizar duas vezes devolve o mesmo texto.
    expect(canonicalDecimalToken(canonicalDecimalToken('792578.394899370100000000'))).toBe(
      '792578.3948993701',
    );
    // Um token que não é decimal é recusado, e não "corrigido" por dedução.
    expect(() => canonicalDecimalToken('1e5')).toThrow('NOT_A_DECIMAL_TOKEN');
    expect(() => canonicalDecimalToken('NaN')).toThrow('NOT_A_DECIMAL_TOKEN');
    // A escala que importa é a do banco (18); o texto canônico cabe no schema
    // da resposta, que é o que a tela valida.
    expect(
      polymarketRankingRowSchema.safeParse(
        row({ pnl: canonicalDecimalToken('792578.394899370100000000') }),
      ).success,
    ).toBe(true);
  });
});

describe('STK-F2-15 §15 — série TRUNCADA é visível, e vem do status gravado', () => {
  it('cem linhas com a série truncada AINDA exibem o aviso', () => {
    // Este é o caso perigoso, e é o que o card pede para evitar: mil traders
    // na tela parecem o ranking inteiro. A contagem de linhas não muda nada —
    // quem decide é o status GRAVADO pela ingestão.
    const series = {
      status: 'truncated' as BackfillStatus,
      available: true,
      ingested: 1800,
      backfillFrom: '2026-04-01',
      pages: 36,
      failedPages: 0,
    };
    const view = rankingView(
      ranking({
        series,
        completeness: rankingCompleteness({ series }),
        aggregate: { blocked: true, reason: rankingAggregatePolicy(series).reason },
        requested: 100,
        returned: 100,
        rows: manyRows(100),
        sample: rankingSample({ n: 100, minSample: 30 }),
      }),
    );
    expect(view.completeness.truncated).toBe(true);
    expect(view.rows).toHaveLength(100);
    // O texto visível diz TRUNCADA e diz que não é o ranking inteiro.
    expect(view.completeness.label).toBe('Série truncada');
    expect(view.completeness.detail).toContain('TRUNCADA');
    expect(view.completeness.detail).toContain('NÃO representa o ranking inteiro');
    // E a métrica dependente da série completa aparece BLOQUEADA.
    expect(view.completeness.aggregate).toContain('bloqueados');
  });

  it('a completude NUNCA é inferida da contagem: 3 linhas com `complete` não avisam', () => {
    // O contraponto do teste anterior. Uma série completa e curta é uma
    // resposta legítima (o fim foi observado), e tratá-la como truncada seria
    // um aviso falso — que também é uma mentira, do outro lado.
    const series = {
      status: 'complete' as BackfillStatus,
      available: true,
      ingested: 3,
      backfillFrom: '2026-04-01',
      pages: 1,
      failedPages: 0,
    };
    const view = rankingView(
      ranking({
        series,
        completeness: rankingCompleteness({ series }),
        aggregate: { blocked: false, reason: null },
        requested: 100,
        returned: 3,
        rows: manyRows(3),
        sample: rankingSample({ n: 3, minSample: 30 }),
      }),
    );
    expect(view.completeness.truncated).toBe(false);
    expect(view.completeness.label).toBe('Cobertura completa');
  });

  it('cada estado gravado produz um rótulo DISTINTO, e nenhum se confunde com completo', () => {
    const statuses: BackfillStatus[] = ['truncated', 'partial', 'unknown'];
    const labels = statuses.map((status) =>
      rankingCompleteness({
        series: { status, available: true, ingested: 10, pages: 1, failedPages: 0 },
      }),
    );
    // Três estados, três rótulos: nenhum se repete, e nenhum é o de completo.
    expect(new Set(labels.map((item) => item.label)).size).toBe(3);
    for (const item of labels) {
      expect(item.truncated).toBe(true);
      expect(item.label).not.toBe('Cobertura completa');
    }
    // `partial` carrega o motivo a mais: páginas que falharam.
    const partial = rankingCompleteness({
      series: { status: 'partial', available: true, ingested: 10, pages: 3, failedPages: 2 },
    });
    expect(partial.detail).toContain('2 páginas falharam');
  });

  it('janela NUNCA ingerida é "não coletada", nunca lista vazia sem aviso', () => {
    // `available: false` é a diferença entre "a série está truncada" e "a série
    // não existe". As duas apareceriam como lista vazia, e significam coisas
    // opostas — esta é a divergência entre o enum oficial (onze categorias) e
    // a ingestão da F2-14 (uma).
    const series = {
      status: 'unknown' as BackfillStatus,
      available: false,
      ingested: 0,
      backfillFrom: '0001-01-01',
      pages: 0,
      failedPages: 0,
    };
    const view = rankingView(
      ranking({
        series,
        completeness: rankingCompleteness({ series }),
        aggregate: { blocked: true, reason: rankingAggregatePolicy(series).reason },
        requested: 100,
        returned: 0,
        rows: [],
        sample: rankingSample({ n: 0, minSample: 30 }),
      }),
    );
    expect(view.emptyTitle).toBe('Janela ainda não coletada');
    expect(view.completeness.truncated).toBe(true);
    expect(view.completeness.detail).toContain('ainda não publicizou');
    // E a lista vazia carrega a explicação, e não um "0 trader" mudo.
    expect(view.emptyDetail).toContain('ainda não publicizou');
  });
});

describe('STK-F2-15 §15 — a métrica dependente de série completa é BLOQUEADA', () => {
  it('o agregado do tabuleiro é recusado em toda série que não seja `complete`', () => {
    for (const status of ['truncated', 'partial', 'unknown'] as const) {
      const decision = rankingAggregatePolicy({ status, available: true });
      expect(decision.allowed).toBe(false);
      expect(decision.allowed === false && decision.reason).toContain('bloqueados');
    }
    // Janela ausente também bloqueia, com o motivo dela.
    const absent = rankingAggregatePolicy({ status: 'unknown', available: false });
    expect(absent.allowed).toBe(false);
    expect(absent.allowed === false && absent.reason).toContain('ainda não foi coletada');
  });

  it('o agregado só é liberado com a série `complete`', () => {
    expect(rankingAggregatePolicy({ status: 'complete', available: true })).toEqual({
      allowed: true,
      reason: null,
    });
  });

  it('o nome de cada estado é escrito em português, sem estado cru na tela', () => {
    expect(rankingStatusLabel('complete')).toBe('completa');
    expect(rankingStatusLabel('truncated')).toBe('truncada');
    expect(rankingStatusLabel('partial')).toBe('parcial');
    expect(rankingStatusLabel('unknown')).toBe('de completude desconhecida');
  });
});

describe('STK-F2-15 §15 — a amostra é a que o produto já usa', () => {
  it('N é o número EXIBIDO, não o ingerido nem o estimado', () => {
    // A tela mostra 100 linhas; a ingestão gravou 1.800. O `N` honesto é o que
    // o usuário pode conferir — o outro é um número que ele não vê.
    const view = rankingSampleViews(ranking({ sample: rankingSample({ n: 100, minSample: 30 }) }));
    expect(view.sample).toBe('N = 100 traders');
  });

  it('abaixo do limiar, o aviso cita a regra e promete nenhum número derivado', () => {
    const view = rankingSampleViews(ranking({ sample: rankingSample({ n: 12, minSample: 30 }) }));
    expect(view.lowSampleNotice).toContain('Baixa amostra');
    expect(view.lowSampleNotice).toContain('sem interpretação, comparação ou recomendação');
    // No limiar ou acima, não há aviso: a regra é a mesma do dashboard.
    expect(
      rankingSampleViews(ranking({ sample: rankingSample({ n: 30, minSample: 30 }) }))
        .lowSampleNotice,
    ).toBeNull();
  });

  it('um limiar inválido é recusado, e não tratado como zero', () => {
    // `minSample: 0` transformaria toda janela em amostra suficiente.
    expect(() => rankingSample({ n: 5, minSample: 0 })).toThrow('INVALID_RANKING_MIN_SAMPLE');
  });
});

describe('STK-F2-15 §15 — Composite Score AUSENTE da UI', () => {
  it('o schema da RESPOSTA recusa um campo de pontuação (invariante estrutural)', () => {
    // Esta é a prova mais forte, porque não depende de grep: um campo a mais
    // no payload quebra o parse. Um Composite Score acrescentado no servidor
    // apareceria como erro de tela, e não como um número na tabela.
    const withScore = {
      ...ranking(),
      rows: [{ ...row(), compositeScore: 87.4 }],
    };
    expect(polymarketRankingSchema.safeParse(withScore).success).toBe(false);
    // Nem no nível do ranking inteiro.
    expect(polymarketRankingSchema.safeParse({ ...ranking(), compositeScore: 87.4 }).success).toBe(
      false,
    );
    // Nem um "score" dentro da linha da série.
    expect(
      polymarketRankingSchema.safeParse({
        ...ranking(),
        series: { ...ranking().series, score: 1 },
      }).success,
    ).toBe(false);
  });

  it('a linha da tabela não produz texto de score, badge nem recomendação', () => {
    const view = rankingRowView(row());
    const text = Object.values(view).join(' ');
    for (const forbidden of ['score', 'Score', 'badge', 'Badge', 'recomend', 'selo', 'rating'])
      expect(text).not.toContain(forbidden);
    // E o que ela carrega é só o que a origem publicou.
    expect(Object.keys(view).sort()).toEqual(
      ['key', 'negative', 'pnl', 'rank', 'trader', 'vol', 'wallet'].sort(),
    );
  });

  it('a view completa não escreve score, badge, recomendação nem leitura', () => {
    const view = rankingView(ranking({ sample: rankingSample({ n: 100, minSample: 30 }) }));
    const text = JSON.stringify(view);
    for (const forbidden of [
      'compositeScore',
      'composite',
      'score',
      'badge',
      'recomend',
      'recomendaç',
      'selo',
      'rating',
      'melhor',
      'pior',
      'destaque',
    ])
      expect(text).not.toContain(forbidden);
  });

  it('os ARQUIVOS desta tarefa não nomeiam Composite Score em código de produto', () => {
    // Complemento de leitura: os arquivos de PRODUTO (schema, leitura, rota e
    // componente) não podem conter o termo fora de comentário. Eles o citam
    // apenas nas frases que explicam a AUSÊNCIA — e o teste garante que a
    // citação está no comentário, nunca em código executável, procurando
    // uso como identificador ou como texto renderizado.
    const files = [
      '../../packages/shared/src/polymarket-ranking.ts',
      '../../packages/db/src/polymarket-ranking.ts',
      '../../apps/api/src/polymarket-ranking-routes.ts',
      '../../apps/api/src/openapi.ts',
      '../../apps/web/src/product/ranking-view.ts',
      '../../apps/web/src/product/polymarket-ranking.tsx',
    ];
    for (const file of files) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      // O código SEM comentários não pode conter o termo em nenhuma caixa.
      const code = source
        .split('\n')
        .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
        .join('\n');
      expect(code, `código de ${file} não pode citar Composite Score`).not.toMatch(
        /composite\s*score/i,
      );
    }
  });

  it('a rota NÃO aceita usuário, organização nem tenant', () => {
    // O ranking é público. Uma rota que aceitasse um id de destino permitiria
    // impersonação, e o escopo do card não abre nenhuma superfície de conta.
    const source = readFileSync(
      new URL('../../apps/api/src/polymarket-ranking-routes.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/organizationId|userId|tenantId/);
  });
});

describe('STK-F2-15 §15 — a tela não calcula o que a origem não publicou', () => {
  it('a view mostra P&L e volume crus, sem ROI, razão ou variação', () => {
    // Um "índice de desempenho" derivado de `pnl / vol` seria uma métrica
    // nossa apresentada como da Polymarket. Não existe campo para isso.
    const view = rankingRowView(row());
    expect(Object.keys(view)).not.toContain('roi');
    expect(Object.keys(view)).not.toContain('ratio');
    // Os valores exibidos são os literais, apenas com separador de milhar.
    expect(view.pnl).toBe('US$ 792.578,3948993701');
    expect(view.vol).toBe('US$ 2.666.493,7190210004');
  });

  it('um trader sem nome mostra a carteira, nunca um nome inventado', () => {
    const view = rankingRowView(row({ userName: '   ' }));
    expect(view.trader).toBe('(sem nome informado)');
    expect(view.wallet).toBe('0x224a89dbe0db0d6124b335edabd15b3f877da3d5');
  });

  it('P&L negativo é marcado como negativo, com o sinal da origem', () => {
    const view = rankingRowView(row({ pnl: '-4200.5' }));
    expect(view.negative).toBe(true);
    expect(view.pnl).toContain('−');
  });
});
