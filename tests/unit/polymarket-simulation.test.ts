import { describe, expect, it } from 'vitest';
import {
  SIMULATION_DISCLAIMERS,
  SIMULATION_MAX_DELAY_MS,
  SIMULATION_PREMISE_KEYS,
  SIMULATION_REFUSAL_CODES,
  missingDataRate,
  polymarketSimulationSchema,
  runIndicativeSimulation,
  simulationDisclaimers,
  simulationInputSchema,
  simulationRefusalPolicy,
  type PolymarketSimulation,
  type SimulationInput,
  type SimulationObservation,
} from '../../packages/shared/src/index.js';

/**
 * STK-F2-17 §15 — "Simulação recusada quando os dados necessários forem
 * incompletos", e as outras duas acceptance criteria do card.
 *
 * Três coisas são provadas aqui, e cada uma por um caminho diferente:
 *
 *  1) A RECUSA por cobertura incompleta, e a impossibilidade estrutural de
 *     apurar sobre série não completa. Não há exceção, não há flag e não há
 *     caminho de código que produza número com `truncated`, `partial`,
 *     `unknown` ou janela não coletada.
 *
 *  2) AS SETE PREMISSAS sempre, nos DOIS desfechos — inclusive na recusa, que
 *     é onde a falta de premissa esconderia o motivo.
 *
 *  3) A NATUREZA NÃO EXECUTÁVEL como decisão de TIPO: `executable` e `executed`
 *     são literais `false`, e o schema recusa qualquer payload forjado. O
 *     teste tenta os dois forjamentos e exige que os dois falhem.
 *
 * E a aritmética é testada com literais que o IEEE-754 NÃO reproduz, pelo
 * mesmo motivo da F2-14: um `Number` no meio do caminho devolveria um número
 * que ninguém mediu.
 */

/** Observações com volume e P&L que sobrevivem a `number` sem perda. */
const observation = (over: Partial<SimulationObservation> = {}): SimulationObservation => ({
  proxyWallet: '0x224a89dbe0db0d6124b335edabd15b3f877da3d5',
  vol: '2666493.7190210004',
  pnl: '792578.3948993701',
  ...over,
});

const REQUEST: SimulationInput = simulationInputSchema.parse({
  window: { category: 'OVERALL', timePeriod: 'MONTH', orderBy: 'PNL' },
  stake: '10.00',
  delayMs: 1500,
  feeRate: '0.02',
  spreadRate: '0.01',
  slippageRate: '0.005',
});

/** Uma série completa com N observações, que é o que permite apurar. */
const complete = (n = 30) => ({
  status: 'complete' as const,
  available: true,
  ingested: n,
  pages: 1,
  failedPages: 0,
});

const observations = (n: number) =>
  Array.from({ length: n }, (_, index) =>
    observation({ proxyWallet: `0x${String(index).padStart(40, '0')}` }),
  );

const simulate = (
  over: {
    series?: Parameters<typeof runIndicativeSimulation>[0]['series'];
    observations?: SimulationObservation[];
    request?: SimulationInput;
    minSample?: number;
  } = {},
): PolymarketSimulation =>
  runIndicativeSimulation({
    window: REQUEST.window,
    series: complete(30),
    observations: observations(30),
    request: REQUEST,
    minSample: 30,
    ...over,
  });

describe('STK-F2-17 §15 — a recusa por cobertura incompleta', () => {
  it('a série TRUNCADA — o estado REAL do backfill — é recusada e NÃO tem número', () => {
    const result = simulate({ series: { ...complete(30), status: 'truncated' } });
    expect(result.refusal.refused).toBe(true);
    expect(result.refusal.code).toBe('SERIES_NOT_COMPLETE');
    // A recusa não tem número NENHUM: `null`, não um objeto zerado. Um objeto
    // zerado seria lido como "a simulação deu zero", que é uma afirmação — e
    // é falsa.
    expect(result.indicative).toBeNull();
    // E a recusa diz o que fazer, não só que não pode.
    expect(result.refusal.remedy).toBeTruthy();
    expect(result.refusal.reason).toContain('cobertura');
  });

  it.each(['partial', 'unknown'] as const)('o status %s também é recusado', (status) => {
    const result = simulate({ series: { ...complete(30), status } });
    expect(result.refusal.refused).toBe(true);
    expect(result.refusal.code).toBe('SERIES_NOT_COMPLETE');
    expect(result.indicative).toBeNull();
  });

  it('a janela NUNCA coletada é recusada, e não devolve "resultado zero"', () => {
    const result = simulate({
      series: { status: 'unknown', available: false, ingested: 0, pages: 0, failedPages: 0 },
      observations: [],
    });
    expect(result.refusal.refused).toBe(true);
    expect(result.refusal.code).toBe('SERIES_NOT_COLLECTED');
    expect(result.indicative).toBeNull();
    expect(result.coverage.available).toBe(false);
  });

  it('uma categoria OFICIAL sem série gravada é recusada, e o motivo é a coleta', () => {
    // `SPORTS` é categoria oficial (verificada por probe na F2-15), mas a
    // ingestão da F2-14 cobre só `OVERALL` e o CHECK do banco (0028) aceita
    // só essa. A recusa correta é "não coletado" — e é o que impede um número
    // sobre uma janela que ninguém percorreu.
    const result = runIndicativeSimulation({
      window: { category: 'SPORTS', timePeriod: 'MONTH', orderBy: 'PNL' },
      series: { status: 'unknown', available: false, ingested: 0, pages: 0, failedPages: 0 },
      observations: [],
      request: REQUEST,
      minSample: 30,
    });
    expect(result.refusal.code).toBe('SERIES_NOT_COLLECTED');
    expect(result.indicative).toBeNull();
  });

  it('N abaixo do limiar do produto é recusado, com a MESMA regra do ranking', () => {
    const result = simulate({ observations: observations(3) });
    expect(result.refusal.refused).toBe(true);
    expect(result.refusal.code).toBe('SAMPLE_TOO_SMALL');
    expect(result.indicative).toBeNull();
    expect(result.coverage.lowSample).toBe(true);
  });

  it('volume AUSENTE é recusado — e volume ausente não é volume zero', () => {
    // As duas coisas precisam de tratamento oposto: zero significa "esse
    // trader não operou" (um dado), ausente significa "o dado não existe". A
    // razão por unidade de volume é a única ponte para o número da origem, e
    // sem volume não há ponte.
    const result = simulate({
      observations: [...observations(29), observation({ vol: '0.00' })],
    });
    expect(result.refusal.refused).toBe(true);
    expect(result.refusal.code).toBe('MISSING_DATA');
    expect(result.indicative).toBeNull();
  });

  it('a ordem de reporting é a do motivo REAL: não coletado vence amostra', () => {
    // Com a janela ausente E sem observações, relatar "amostra pequena"
    // esconderia que o motivo é a ausência de dado.
    const policy = simulationRefusalPolicy({
      series: { status: 'unknown', available: false },
      observations: [],
      minSample: 30,
    });
    expect(policy.refused).toBe(true);
    expect(policy.code).toBe('SERIES_NOT_COLLECTED');
  });

  it('NÃO EXISTE caminho que apure sobre série incompleta: o status é o único judge', () => {
    // A tentativa explícita: dar uma série truncada com N GENEROSO e volume
    // presente. A cobertura é a barreira, e ela não é contagem.
    const result = simulate({
      series: { ...complete(50), status: 'truncated' },
      observations: observations(50),
    });
    expect(result.indicative).toBeNull();
    // Cinquenta observações não compram cobertura: o status gravado decide.
    expect(result.coverage.n).toBe(50);
    expect(result.coverage.status).toBe('truncated');
  });

  it('a taxa de dados ausentes é medida sobre a primeira página oficial (50)', () => {
    // A definição é `1 − n / 50`. Uma série `complete` tem MENOS de 50 linhas
    // por construção, então a taxa é maior que zero mesmo no melhor caso — e
    // isso é honesto, porque mesmo a cobertura completa não é a totalidade do
    // leaderboard.
    expect(missingDataRate(50)).toBe('0.000000');
    expect(missingDataRate(40)).toBe('0.200000');
    expect(missingDataRate(0)).toBe('1.000000');
    const result = simulate({ observations: observations(40) });
    expect(result.coverage.missingDataRate).toBe('0.200000');
  });
});

describe('STK-F2-17 §15 — as premissas estão SEMPRE visíveis', () => {
  it('a apuração traz AS SETE premissas, na ordem da enumeração', () => {
    const result = simulate();
    expect(result.refusal.refused).toBe(false);
    expect(result.premises.map((premise) => premise.key)).toEqual([...SIMULATION_PREMISE_KEYS]);
    expect(result.premises).toHaveLength(7);
  });

  it('a RECUSA também traz as sete — esconder a premissa esconderia o motivo', () => {
    const result = simulate({ series: { ...complete(30), status: 'truncated' } });
    expect(result.refusal.refused).toBe(true);
    expect(result.premises.map((premise) => premise.key)).toEqual([...SIMULATION_PREMISE_KEYS]);
  });

  it('cada premissa tem rótulo, valor exato e uma nota que diz o que ela NÃO cobre', () => {
    for (const premise of simulate().premises) {
      expect(premise.label.length).toBeGreaterThan(0);
      expect(premise.value.length).toBeGreaterThan(0);
      expect(premise.note.length).toBeGreaterThan(30);
    }
  });

  it('a origem da premissa distingue o que é MEDIDO do que é SUPOSTO', () => {
    const byKey = Object.fromEntries(simulate().premises.map((p) => [p.key, p.kind]));
    // As fricções e a stake são escolhidas pelo usuário: aparecem assim, e
    // dizer o contrário seria uma medição que ninguém fez.
    expect(byKey.feeRate).toBe('configured');
    expect(byKey.spreadRate).toBe('configured');
    expect(byKey.slippageRate).toBe('configured');
    expect(byKey.stake).toBe('configured');
    // A cobertura e a lacuna são MEDIDAS pela coleta.
    expect(byKey.missingDataRate).toBe('measured');
    expect(byKey.completeness).toBe('measured');
    // O atraso é um limite DECLARADO por nós, não uma medição da origem.
    expect(byKey.delayMs).toBe('declared');
  });

  it('a premissa de cobertura mostra o status GRAVADO, não a contagem', () => {
    const result = simulate({ series: { ...complete(30), status: 'truncated' } });
    const completeness = result.premises.find((p) => p.key === 'completeness')!;
    expect(completeness.value).toContain('truncated');
  });
});

describe('STK-F2-17 §15 — o retorno nunca é apresentado como executável', () => {
  it('a natureza é literal: executable e executed são SEMPRE false', () => {
    for (const result of [
      simulate(),
      simulate({ series: { ...complete(30), status: 'truncated' } }),
    ]) {
      expect(result.executable).toBe(false);
      expect(result.executed).toBe(false);
      expect(result.kind).toBe('indicative');
    }
  });

  it('o schema RECUSA um payload que se declare executável', () => {
    // A tentativa: um chamador (ou um bug) que tentasse marcar a saída como
    // executável. O literal recusa — e a recusa é no PARSE, não na validação
    // de lógica, porque não existe valor intermediário que passe.
    const forged = { ...simulate(), executable: true };
    expect(polymarketSimulationSchema.safeParse(forged).success).toBe(false);
  });

  it('o schema RECUSA um payload que se declare executado', () => {
    const forged = { ...simulate(), executed: true };
    expect(polymarketSimulationSchema.safeParse(forged).success).toBe(false);
  });

  it('o schema RECUSA um número ATRÁS de uma recusa', () => {
    // A tentativa central do card: um payload que trouxesse a recusa E o
    // número. Sem o `refine`, um chamador que ignorasse o campo de recusa leria
    // um número sobre cobertura que o próprio payload declara incompleta.
    const apurada = simulate();
    const recusada = simulate({ series: { ...complete(30), status: 'truncated' } });
    const forged = { ...recusada, indicative: apurada.indicative };
    expect(polymarketSimulationSchema.safeParse(forged).success).toBe(false);
  });

  it('o schema RECUSA um número apurado sobre cobertura incompleta', () => {
    // A segunda metade da invariante: o campo de recusa diz "não recusada" e a
    // cobertura diz truncada. A contradicão é recusada na borda.
    const recusada = simulate({ series: { ...complete(30), status: 'truncated' } });
    const forged = {
      ...recusada,
      refusal: { refused: false, code: null, reason: null, remedy: null },
    };
    expect(polymarketSimulationSchema.safeParse(forged).success).toBe(false);
  });

  it('o schema RECUSA um campo a mais: um score não entraria em silêncio', () => {
    const forged = { ...simulate(), score: 98 };
    expect(polymarketSimulationSchema.safeParse(forged).success).toBe(false);
  });

  it('os avisos de jogo responsável estão SEMPRE presentes e não são vazios', () => {
    for (const result of [
      simulate(),
      simulate({ series: { ...complete(30), status: 'truncated' } }),
    ]) {
      expect(result.disclaimers.length).toBeGreaterThan(0);
      // E o conteúdo é o exigido pelo §4.9: não executável, risco e idade.
      const text = result.disclaimers.join(' ').toLowerCase();
      expect(text).toContain('não é previsão');
      expect(text).toContain('não é retorno executável');
      expect(text).toContain('risco de perda de dinheiro');
      expect(text).toContain('18 anos');
    }
    // A lista é a mesma nos dois desfechos: um aviso que muda conforme o
    // desfecho seria um aviso que some quando o número some.
    expect(simulationDisclaimers()).toEqual([...SIMULATION_DISCLAIMERS]);
  });

  it('o schema RECUSA uma saída sem aviso — o aviso não é opcional', () => {
    const forged = { ...simulate(), disclaimers: [] };
    expect(polymarketSimulationSchema.safeParse(forged).success).toBe(false);
  });

  it('não existe código de recusa que produza um número, nem motivo fora do enum', () => {
    // Todo motivo é recusa: não há um código que "não recusa".
    for (const code of SIMULATION_REFUSAL_CODES) {
      const result = simulate({ series: { ...complete(30), status: 'truncated' } });
      expect(result.refusal.refused).toBe(true);
      expect(SIMULATION_REFUSAL_CODES).toContain(code);
    }
    const forged = {
      ...simulate(),
      refusal: { refused: true, code: 'WHATEVER', reason: 'x', remedy: 'y' },
    };
    expect(polymarketSimulationSchema.safeParse(forged).success).toBe(false);
  });
});

describe('STK-F2-17 §15 — a aritmética é exata e as premissas são descontadas', () => {
  it('a razão publicada é calculada sobre as somas exatas, em texto', () => {
    // 40 observações de volume 1000,00 e P&L 100,00: razão 0,1 e o número
    // exato em escala de 6 casas. Nenhum `Number` no caminho.
    const result = runIndicativeSimulation({
      window: REQUEST.window,
      series: complete(40),
      observations: Array.from({ length: 40 }, () =>
        observation({ vol: '1000.00', pnl: '100.00' }),
      ),
      request: REQUEST,
      minSample: 30,
    });
    expect(result.refusal.refused).toBe(false);
    expect(result.indicative!.publishedPnlSum).toBe('4000.000000000000000000');
    expect(result.indicative!.publishedVolSum).toBe('40000.000000000000000000');
    expect(result.indicative!.publishedRatio).toBe('0.100000');
    // Bruto = 10,00 × 40 × 0,1 = 40,00.
    expect(result.indicative!.grossBeforePremises).toBe('40.00');
    // Fricção: 2% + 1% + 0,5% de 40,00 = 0,80 + 0,40 + 0,20 = 1,40.
    expect(result.indicative!.feeCost).toBe('0.80');
    expect(result.indicative!.spreadCost).toBe('0.40');
    expect(result.indicative!.slippageCost).toBe('0.20');
    expect(result.indicative!.totalFrictionCost).toBe('1.40');
    expect(result.indicative!.netAfterPremises).toBe('38.60');
  });

  it('a faixa de dados ausentes NÃO é subtraída do líquido', () => {
    // O sinal do dado que falta é desconhecido, então subtrair com sinal
    // presumido publicaria uma precisão que não existe. A faixa é magnitude.
    const result = runIndicativeSimulation({
      window: REQUEST.window,
      series: complete(40),
      observations: Array.from({ length: 40 }, () =>
        observation({ vol: '1000.00', pnl: '100.00' }),
      ),
      request: REQUEST,
      minSample: 30,
    });
    // 20% de 40,00 = 8,00 de incerteza, e o líquido é o MESMO dos 38,60.
    expect(result.indicative!.missingDataBand).toBe('8.00');
    expect(result.indicative!.netAfterPremises).toBe('38.60');
  });

  it('um literal que o IEEE-754 NÃO reproduz continua exato na soma', () => {
    // `Number('792578.3948993701')` já devolve um float degradado; a soma de
    // duas linhas em centavos perderia a DÉCIMA casa, que é exatamente onde a
    // tela promete exatidão. A soma sai na escala da ORIGEM (18 casas), com
    // zeros à direita — e `Number` não pode reintroduzir perda nenhuma depois
    // disso. A comparação é de TEXTO, como na F2-14.
    const result = runIndicativeSimulation({
      window: REQUEST.window,
      series: complete(2),
      observations: [
        observation({ vol: '1000000.00', pnl: '792578.3948993701' }),
        observation({
          proxyWallet: '0x51698a47f840a242abc2ca0351371c7ffac41842',
          vol: '1000000.00',
          pnl: '792578.3948993701',
        }),
      ],
      request: REQUEST,
      minSample: 2,
    });
    expect(result.indicative!.publishedPnlSum).toBe('1585156.789798740200000000');
    // E a razão derivada dela é exata: 1585156,7897987402 / 2000000 =
    // 0,7925783948993701, arredondado half-up para 6 casas. Um pipeline com
    // `Number` no meio devolveria 0,7925783948993702 ou perderia a DÉCIMA
    // casa antes da divisão — nenhum dos dois é o valor exato.
    expect(result.indicative!.publishedRatio).toBe('0.792578');
  });

  it('a stake é FIXA e entra como a única quantia da entrada', () => {
    const result = simulate();
    expect(result.indicative!.stake).toBe('10.00');
    expect(result.indicative!.observations).toBe(30);
  });

  it('o NET pode ser NEGATIVO, e a cor acompanha o sinal', () => {
    const result = runIndicativeSimulation({
      window: REQUEST.window,
      series: complete(40),
      observations: Array.from({ length: 40 }, () => observation({ vol: '1000.00', pnl: '10.00' })),
      // A taxa é uma FRAÇÃO, não um percentual: 1 é 100%. Com fricção de 1,0
      // sobre um bruto de 4,00 o líquido é 0,00; com 2,0 (200%, absurdo mas
      // aceito pelo schema) o líquido é negativo, e dizer isso é melhor do que
      // esconder o sinal.
      request: { ...REQUEST, feeRate: '2', spreadRate: '0', slippageRate: '0' },
      minSample: 30,
    });
    expect(result.indicative!.grossBeforePremises).toBe('4.00');
    expect(result.indicative!.totalFrictionCost).toBe('8.00');
    expect(result.indicative!.netAfterPremises).toBe('-4.00');
    expect(result.indicative!.negative).toBe(true);
  });
});

describe('STK-F2-17 §15 — a entrada é validada e limitada', () => {
  it('a entrada RECUSA um campo a mais: um filtro digitado que não aplica é recusado', () => {
    expect(simulationInputSchema.safeParse({ ...REQUEST, strategy: 'kelly' }).success).toBe(false);
  });

  it('a entrada RECUSA a organização: ela nunca vem do corpo', () => {
    expect(
      simulationInputSchema.safeParse({
        ...REQUEST,
        organizationId: '00000000-0000-4000-8000-000000000001',
      }).success,
    ).toBe(false);
  });

  it('a entrada RECUSA um campo de EXECUÇÃO: não existe ordem nesta rota', () => {
    for (const forbidden of ['execute', 'confirm', 'live', 'market', 'order']) {
      expect(simulationInputSchema.safeParse({ ...REQUEST, [forbidden]: true }).success).toBe(
        false,
      );
    }
  });

  it('o atraso respeita o teto declarado — acima disso a premissa muda de natureza', () => {
    expect(simulationInputSchema.safeParse({ ...REQUEST, delayMs: 0 }).success).toBe(true);
    expect(
      simulationInputSchema.safeParse({ ...REQUEST, delayMs: SIMULATION_MAX_DELAY_MS }).success,
    ).toBe(true);
    expect(
      simulationInputSchema.safeParse({ ...REQUEST, delayMs: SIMULATION_MAX_DELAY_MS + 1 }).success,
    ).toBe(false);
  });

  it('a stake precisa ser dinheiro positivo, e as taxas frações não negativas', () => {
    expect(simulationInputSchema.safeParse({ ...REQUEST, stake: '0.00' }).success).toBe(true);
    expect(simulationInputSchema.safeParse({ ...REQUEST, stake: '-10.00' }).success).toBe(false);
    expect(simulationInputSchema.safeParse({ ...REQUEST, stake: '10' }).success).toBe(true);
    expect(simulationInputSchema.safeParse({ ...REQUEST, stake: 'abc' }).success).toBe(false);
    expect(simulationInputSchema.safeParse({ ...REQUEST, feeRate: '-0.01' }).success).toBe(false);
  });
});
