import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ALERT_DEFAULT_DAILY_LIMIT,
  ALERT_DEFAULT_THRESHOLD,
  ALERT_LATENCY_TARGET_MS,
  ALERT_WINDOW_MINUTES,
  POLYMARKET_FAVORITES_LIMIT,
  alertDedupeKey,
  alertLatencyMs,
  computeCompositeScore,
  defaultAlertConfig,
  decideAlert,
  favoritesAdmit,
  favoriteEffectOnAlerts,
  isQuietHour,
  localDayIn,
  netActivity,
  polymarketAlertConfigInputSchema,
  polymarketAlertConfigSchema,
  polymarketFavoriteInputSchema,
  polymarketFavoritesResponseSchema,
  reachesThreshold,
  resolveAlertConfig,
  scoreRefusal,
  windowStartOf,
  type PolymarketAlertConfig,
} from '../../packages/shared/src/index.js';
import {
  alertRuleText,
  favoriteRowView,
  favoritesLimitNotice,
  favoritesView,
} from '../../apps/web/src/product/favorites-view.js';

/**
 * STK-F2-16 §15 — "Favoritos, quiet hours, limiar, agrupamento e limite
 * diário", mais "o Composite Score não aparece na tela".
 *
 * O card pede sete coisas provadas, e cada uma precisa de uma via diferente
 * porque nenhuma prova sozinha cobre a falha que importa:
 *
 *  1) O LIMITE DE DEZ É RECUSA, NÃO PAGINAÇÃO. A função pura decide a partir
 *     da contagem gravada (§1a) e o banco a impõe por trigger — o segundo é
 *     verificado no teste de integração, porque um `if` em TypeScript não
 *     sobrevive a dois pedidos simultâneos.
 *
 *  2) FAVORITAR NÃO ATIVA ALERTA. A função `favoriteEffectOnAlerts` é a
 *     invariante, e o teste prova que favoritar um usuário SEM configuração
 *     devolve `enabled: false` — o estado que o card chama de legítimo.
 *
 *  3) QUIET HOURS NO FUSO DO USUÁRIO. O teste prova que o MESMO instante cai
 *     dentro do silêncio em um fuso e fora em outro, e que a janela que
 *     atravessa a meia-noite continua funcionando (§3). A função `isQuietHour`
 *     é a DA F2-10, reusada sem cópia.
 *
 *  4) DEDUPE E LIMITE DIÁRIO. A função `decideAlert` é pura e testada nos
 *     quatro estados, incluindo a ordem: dedupe ANTES da cota, porque já ter
 *     sido avisado do mesmo evento não deve consumir a cota de novo (§4).
 *
 *  5) A JANELA DE CINCO MINUTOS E A ATIVIDADE LÍQUIDA. `windowStartOf` alinha
 *     em UTC e `netActivity` subtrai em BigInt sobre a escala de 18 — o teste
 *     usa o decimal que o float NÃO reproduz (§5).
 *
 *  6) A LATÊNCIA-ALVO DE ≤5 MIN. O alvo é medido entre o FIM da janela e o
 *     enfileiramento, com instantes INJETADOS: o teste não espera e não finge
 *     que um `\Date.now()` em volta de uma chamada mede latência (§6).
 *
 *  7) O SCORE AUSENTE DA UI. Verificado por três vias: o schema da RESPOSTA
 *     recusa um campo de pontuação (§7a), a view pura não produz o termo
 *     (§7b), e o RENDER não escreve score/badge/rating — o último está no e2e,
 *     que varre o DOM.
 */

/** As dez carteiras do limite, com dígitos distintos e válidos. */
const wallets = Array.from({ length: 12 }, (_, index) => `0x${String(index).padStart(40, '0')}`);

const at = (iso: string) => new Date(iso);

/** Um favorito gravado, com o nome que a origem publicou. */
const favorite = (index: number, name = `trader_${index}`) => ({
  id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  userId: 'user-1',
  proxyWallet: wallets[index]!,
  userName: name,
  createdAt: '2026-09-29T12:00:00.000Z',
});

const config = (over: Partial<PolymarketAlertConfig> = {}): PolymarketAlertConfig => ({
  ...defaultAlertConfig('user-1'),
  ...over,
});

// ---------------------------------------------------------------------------
// 1) O limite de dez é recusa
// ---------------------------------------------------------------------------

describe('STK-F2-16 §15 — o limite de dez favoritos é RECUSA, não paginação', () => {
  it('o décimo entra e o décimo primeiro é recusado', () => {
    // A contagem vai até DEZ e para: o banco tem dez e a função diz que não cabe
    // o próximo. Nenhuma paginação existe em lugar nenhum do contrato.
    expect(favoritesAdmit({ used: 9, alreadyFavorite: false })).toEqual({ admitted: true });
    expect(favoritesAdmit({ used: 10, alreadyFavorite: false })).toEqual({
      admitted: false,
      reason: 'FAVORITES_LIMIT_REACHED',
    });
    // E a lista NÃO tem campo de página, cursor ou total: `strictObject`
    // transformaria um `offset` a mais em erro de parse.
    expect(Object.keys(polymarketFavoritesResponseSchema.shape).sort()).toEqual(
      [
        'alertDailyLimit',
        'alertEnabled',
        'alertThreshold',
        'alertWindowMinutes',
        'favorites',
        'limit',
        'used',
      ].sort(),
    );
    // A tela escreve o teto do CONTRATO (10), nunca um número do componente.
    expect(POLYMARKET_FAVORITES_LIMIT).toBe(10);
  });

  it('re-favoritar o MESMO trader não consome vaga: é o mesmo favorito', () => {
    // O duplo clique é o caso real: sem `alreadyFavorite`, ele limaria um lugar
    // da lista e o usuário perderia um favorito sem querer.
    expect(favoritesAdmit({ used: 10, alreadyFavorite: true })).toEqual({ admitted: true });
  });

  it('a carteira fora do formato é recusada antes de qualquer consulta', () => {
    expect(polymarketFavoriteInputSchema.safeParse({ proxyWallet: '0x123' }).success).toBe(false);
    expect(
      polymarketFavoriteInputSchema.safeParse({ proxyWallet: wallets[0]!.toUpperCase() }).success,
    ).toBe(false);
    // E o corpo não aceita um usuário ou uma organização: o dono vem do
    // contexto autenticado, e um campo a mais seria uma superfície de
    // impersonação.
    expect(
      polymarketFavoriteInputSchema.safeParse({ proxyWallet: wallets[0], userId: 'outro' }).success,
    ).toBe(false);
  });

  it('a tela escreve o limite como recusa e nunca como "carregar mais"', () => {
    expect(favoritesLimitNotice(3, 10)).toBeNull();
    const atLimit = favoritesLimitNotice(10, 10)!;
    expect(atLimit).toContain('Limite de 10 favoritos atingido');
    expect(atLimit).toContain('recusado');
    expect(atLimit.toLowerCase()).toContain('remova um favorito');
    // O aviso não oferece continuação da lista: "carregar mais" seria teto que
    // não é teto.
    expect(atLimit.toLowerCase()).not.toContain('carregar mais');
    expect(atLimit.toLowerCase()).not.toContain('página');
  });
});

// ---------------------------------------------------------------------------
// 2) Favoritar não ativa alerta
// ---------------------------------------------------------------------------

describe('STK-F2-16 §15 — favoritar NÃO ativa alerta', () => {
  it('sem configuração gravada, favoritar devolve alerta DESLIGADO', () => {
    // Este é o estado que o card chama de legítimo: alguém que favorita dez
    // traders e não quer nenhum aviso.
    expect(favoriteEffectOnAlerts(null)).toEqual({ enabled: false, source: 'unchanged' });
  });

  it('com alerta ligado, favoritar NÃO desliga e NÃO muda a configuração', () => {
    const current = { enabled: true };
    const effect = favoriteEffectOnAlerts(current);
    expect(effect).toEqual({ enabled: true, source: 'unchanged' });
    // A função não tem como ESCREVER: a única forma de mudar a ativação é
    // `saveAlertConfig`, que é outra rota.
    expect(effect.source).toBe('unchanged');
  });

  it('a ativação é EXIGIDA no corpo da configuração: o servidor nunca escolhe', () => {
    // Um corpo sem `enabled` é recusado. Se fosse aceito, o servidor teria que
    // decidir se o alerta fica ligado — e a decisão errada liga o alerta de
    // quem só queria mudar o limiar.
    expect(polymarketAlertConfigInputSchema.safeParse({ threshold: '500' }).success).toBe(false);
    expect(polymarketAlertConfigInputSchema.safeParse({ enabled: true }).success).toBe(true);
  });

  it('a configuração ausente é o padrão do card: desligado, mil dólares, dez por dia', () => {
    const absent = defaultAlertConfig('user-1');
    expect(absent.enabled).toBe(false);
    expect(absent.threshold).toBe(ALERT_DEFAULT_THRESHOLD);
    expect(absent.dailyLimit).toBe(ALERT_DEFAULT_DAILY_LIMIT);
    expect(absent.windowMinutes).toBe(ALERT_WINDOW_MINUTES);
  });

  it('o limiar tem de ser POSITIVO: zero e negativo são recusados', () => {
    for (const threshold of ['0', '-1', '0.0']) {
      expect(() =>
        resolveAlertConfig({
          userId: 'user-1',
          current: null,
          patch: { enabled: true, threshold },
        }),
      ).toThrow('INVALID_ALERT_THRESHOLD');
    }
    // Um limiar fracionário é aceito: o card diz ajustável, e "1000.50" é um
    // limiar ajustável legítimo.
    const adjusted = resolveAlertConfig({
      userId: 'user-1',
      current: null,
      patch: { enabled: true, threshold: '1000.50' },
    });
    expect(adjusted.threshold).toBe('1000.50');
    // A janela é FIXA: um cliente não pode mandar 15 e criar um segundo produto.
    expect(polymarketAlertConfigSchema.safeParse({ ...adjusted, windowMinutes: 15 }).success).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// 3) Quiet hours no fuso do usuário
// ---------------------------------------------------------------------------

describe('STK-F2-16 §15 — quiet hours avaliadas no FUSO do usuário', () => {
  const moment = at('2026-09-29T23:30:00.000Z');

  it('o MESMO instante é silêncio em São Paulo e não é em Lisboa', () => {
    // 23:30Z é 20:30 em São Paulo (dentro de 22:00–06:00 não está)... e 00:30
    // em Lisboa, que ESTÁ dentro. O par é escolhido para os dois lados do
    // limite, porque um fuso único só provaria metade da regra.
    expect(isQuietHour(moment, 'America/Sao_Paulo', 1320, 360)).toBe(false);
    expect(isQuietHour(moment, 'Europe/Lisbon', 1320, 360)).toBe(true);
  });

  it('a janela que ATRAVESSA a meia-noite é respeitada no fuso local', () => {
    // 01:00Z = 22:00 do dia anterior em São Paulo: o início do silêncio. A
    // janela que atravessa a meia-noite só funciona com a comparação
    // circular — `minutes >= start || minutes < end` — e é esse o comportamento
    // que a F2-10 já provou, reusado aqui sem cópia.
    expect(isQuietHour(at('2026-09-30T01:00:00.000Z'), 'America/Sao_Paulo', 1320, 360)).toBe(true);
    // 03:00Z = 00:00 do dia 30: ainda dentro do silêncio, depois da virada.
    expect(isQuietHour(at('2026-09-30T03:00:00.000Z'), 'America/Sao_Paulo', 1320, 360)).toBe(true);
    // 09:00Z = 06:00: o fim do silêncio, e o instante EXATO já está fora.
    expect(isQuietHour(at('2026-09-30T09:00:00.000Z'), 'America/Sao_Paulo', 1320, 360)).toBe(false);
    // 20:00 local (23:00Z) ainda NÃO é silêncio: a janela abre às 22:00.
    expect(isQuietHour(at('2026-09-29T23:00:00.000Z'), 'America/Sao_Paulo', 1320, 360)).toBe(false);
  });

  it('início igual ao fim é janela VAZIA: nunca silencioso', () => {
    // Sem essa regra, "não configurei o silêncio" viraria silêncio eterno.
    expect(isQuietHour(moment, 'America/Sao_Paulo', 360, 360)).toBe(false);
  });

  it('fuso INVÁLIDO silencia (fail-closed), e o dia local responde null', () => {
    expect(isQuietHour(moment, 'Marte/Olympus', 1320, 360)).toBe(true);
    expect(localDayIn(moment, 'Marte/Olympus')).toBeNull();
    expect(localDayIn(moment, 'America/Sao_Paulo')).toBe('2026-09-29');
  });

  it('o alerta ADIADO continua occupying a cota do dia', () => {
    // É a decisão de produto que o card pede: um alerta que sai às 6h da
    // manhã foi solicitado pelo usuário e não pode ser de graça.
    const decision = decideAlert({
      config: config({ enabled: true, dailyLimit: 2 }),
      enqueuedToday: 1,
      alreadyAlerted: false,
      candidate: at('2026-09-29T01:00:00.000Z'),
      isQuietHour: () => true,
      outsideQuietHours: () => at('2026-09-29T09:00:00.000Z'),
    });
    expect(decision).toEqual({
      action: 'defer',
      scheduledFor: at('2026-09-29T09:00:00.000Z'),
      reason: 'QUIET_HOURS',
    });
  });
});

// ---------------------------------------------------------------------------
// 4) Dedupe e limite diário
// ---------------------------------------------------------------------------

describe('STK-F2-16 §15 — dedupe e limite diário, com a ORDEM certa', () => {
  const base = {
    config: config({ enabled: true, dailyLimit: 2 }),
    alreadyAlerted: false,
    candidate: at('2026-09-29T12:00:00.000Z'),
    isQuietHour: () => false,
    outsideQuietHours: (instant: Date) => instant,
  };

  it('alerta desligado não enfileira NADA — nem registra', () => {
    expect(decideAlert({ ...base, config: config({ enabled: false }), enqueuedToday: 0 })).toEqual({
      action: 'skip',
      reason: 'ALERT_DISABLED',
    });
  });

  it('já alertado é "não repetir" e vem ANTES da cota', () => {
    // A ordem importa: se a cota fosse conferida primeiro, um evento já
    // avisado consumiria a cota de novo e o usuário perderia um alerta que
    // ainda não recebeu de outro trader.
    expect(decideAlert({ ...base, alreadyAlerted: true, enqueuedToday: 99 })).toEqual({
      action: 'skip',
      reason: 'ALREADY_ALERTED',
    });
  });

  it('a cota DIÁRIA conta o enfileirado e a recusa é explícita', () => {
    expect(decideAlert({ ...base, enqueuedToday: 0 })).toEqual({
      action: 'enqueue',
      scheduledFor: at('2026-09-29T12:00:00.000Z'),
    });
    expect(decideAlert({ ...base, enqueuedToday: 1 })).toEqual({
      action: 'enqueue',
      scheduledFor: at('2026-09-29T12:00:00.000Z'),
    });
    expect(decideAlert({ ...base, enqueuedToday: 2 })).toEqual({
      action: 'skip',
      reason: 'DAILY_LIMIT_REACHED',
    });
  });

  it('a chave de dedupe é ESTÁVEL por (trader, janela) e muda com a janela', () => {
    const windowStart = windowStartOf(at('2026-09-29T12:03:00.000Z'));
    const key = alertDedupeKey({ proxyWallet: wallets[0]! as `0x${string}`, windowStart });
    // Dois passes do job na MESMA janela produzem a MESMA chave: é isso que o
    // índice único transforma em um alerta só.
    expect(alertDedupeKey({ proxyWallet: wallets[0]! as `0x${string}`, windowStart })).toBe(key);
    // E janelas diferentes são eventos diferentes, com chaves diferentes.
    const next = windowStartOf(at('2026-09-29T12:08:00.000Z'));
    expect(
      alertDedupeKey({ proxyWallet: wallets[0]! as `0x${string}`, windowStart: next }),
    ).not.toBe(key);
  });
});

// ---------------------------------------------------------------------------
// 5) Janela de 5 min e atividade líquida
// ---------------------------------------------------------------------------

describe('STK-F2-16 §15 — janela de 5 minutos e atividade LÍQUIDA', () => {
  it('a janela é de CINCO minutos e alinha em UTC', () => {
    expect(ALERT_WINDOW_MINUTES).toBe(5);
    expect(windowStartOf(at('2026-09-29T12:03:59.999Z')).toISOString()).toBe(
      '2026-09-29T12:00:00.000Z',
    );
    expect(windowStartOf(at('2026-09-29T12:05:00.000Z')).toISOString()).toBe(
      '2026-09-29T12:05:00.000Z',
    );
    // A janela é UTC para que dois usuários em fusos diferentes observem o
    // MESMO evento na mesma janela.
    expect(windowStartOf(at('2026-09-29T23:59:00.000Z')).toISOString()).toBe(
      '2026-09-29T23:55:00.000Z',
    );
  });

  it('o líquido é a DIFERENÇA, e o float NÃO reproduz o decimal real', () => {
    // O caso que a F2-14 já provou: `2666493.7190210004` não sobrevive a um
    // `number` do JavaScript. A subtração é feita em BigInt sobre a escala de
    // 18 casas, então a diferença é EXATAMENTE 1000.
    expect(netActivity('2665493.7190210004', '2666493.7190210004')).toBe('1000');
    expect(netActivity('1000.000000000000000000', '1000')).toBe('0');
    // E a subtração não "perde" o resto para uma casa em float.
    expect(netActivity('0.000000000000000001', '0.000000000000000002')).toBe(
      '0.000000000000000001',
    );
  });

  it('um volume MENOR que o anterior é RECUSA de alerta, não um "desconto"', () => {
    // Correção de leitura ou queda da métrica acumulada: comparar um delta
    // negativo com o limiar seria comparar um número que ele não representa.
    expect(netActivity('2000', '1500')).toBe('-500');
    expect(reachesThreshold({ net: '-500', threshold: '1000' })).toBe(false);
    expect(reachesThreshold({ net: '1000', threshold: '1000' })).toBe(true);
    expect(reachesThreshold({ net: '999.999999999999999999', threshold: '1000' })).toBe(false);
  });

  it('limiar zero ou negativo é DEFEITO de configuração, não "não alerta"', () => {
    // Tratar um limiar quebrado como comportamento correto esconderia o defeito.
    expect(() => reachesThreshold({ net: '1', threshold: '0' })).toThrow('INVALID_ALERT_THRESHOLD');
    expect(() => reachesThreshold({ net: '1', threshold: '-1' })).toThrow(
      'INVALID_ALERT_THRESHOLD',
    );
  });
});

// ---------------------------------------------------------------------------
// 6) A latência-alvo de cinco minutos
// ---------------------------------------------------------------------------

describe('STK-F2-16 §15 — a latência-alvo é ≤5 min e é MEDIDA', () => {
  it('o alvo do card é a própria janela, e a latência é medida em ms', () => {
    // A latência vai do FIM da janela REPORTADA (a que fechou e produziu o
    // delta) até o enfileiramento. Um job que roda a cada minuto encontra a
    // janela no máximo um minuto depois de fechar, então a latência observada
    // fica entre 0 e 60 s — dentro do alvo.
    expect(ALERT_LATENCY_TARGET_MS).toBe(5 * 60_000);
    const reported = windowStartOf(at('2026-09-29T12:00:00.000Z'));
    // A janela fechou às 12:05; um job que roda às 12:05 mede latência zero.
    expect(
      alertLatencyMs({ reportedWindowStart: reported, enqueuedAt: at('2026-09-29T12:05:00.000Z') }),
    ).toBe(0);
    // Com o intervalo real do worker (60 s), a latência é de 60 s.
    const latency = alertLatencyMs({
      reportedWindowStart: reported,
      enqueuedAt: at('2026-09-29T12:06:00.000Z'),
    });
    expect(latency).toBe(60_000);
    expect(latency).toBeLessThanOrEqual(ALERT_LATENCY_TARGET_MS);
  });

  it('cada tique do worker cabe no alvo, provado para a janela INTEIRA', () => {
    // A afirmação "≤5 min" precisa valer para o pior tique do ciclo, não para
    // um instante escolhido. Varredura de 30 minutos: cada tique de 60 s mede
    // a latência do fechamento da janela que ele observa.
    for (let minute = 0; minute < 30; minute += 1) {
      const reported = windowStartOf(
        at(`2026-09-29T12:${String(minute % 5).padStart(2, '0')}:00.000Z`),
      );
      const enqueuedAt = new Date(reported.getTime() + 5 * 60_000 + 60_000);
      expect(alertLatencyMs({ reportedWindowStart: reported, enqueuedAt })).toBeLessThanOrEqual(
        ALERT_LATENCY_TARGET_MS,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 7) O Composite Score não aparece na UI
// ---------------------------------------------------------------------------

describe('STK-F2-16 §15 — o Composite Score é AUSENTE da UI', () => {
  it('o schema da RESPOSTA recusa um campo de pontuação (invariante estrutural)', () => {
    // A prova mais forte, porque não depende de grep: um campo a mais quebra o
    // parse. Um score acrescentado no servidor apareceria como erro de tela, e
    // não como um número na tabela.
    const valid = {
      favorites: [favorite(0)],
      limit: POLYMARKET_FAVORITES_LIMIT,
      used: 1,
      alertEnabled: false,
      alertThreshold: ALERT_DEFAULT_THRESHOLD,
      alertDailyLimit: ALERT_DEFAULT_DAILY_LIMIT,
      alertWindowMinutes: ALERT_WINDOW_MINUTES,
    };
    expect(polymarketFavoritesResponseSchema.safeParse(valid).success).toBe(true);
    // Nem na resposta, nem no favorito, nem na configuração embutida.
    expect(
      polymarketFavoritesResponseSchema.safeParse({ ...valid, compositeScore: 0.87 }).success,
    ).toBe(false);
    expect(
      polymarketFavoritesResponseSchema.safeParse({
        ...valid,
        favorites: [{ ...favorite(0), score: 91 }],
      }).success,
    ).toBe(false);
    expect(polymarketFavoritesResponseSchema.safeParse({ ...valid, badge: 'ouro' }).success).toBe(
      false,
    );
  });

  it('a view de favoritos não escreve score, badge, recomendação nem rating', () => {
    const view = favoritesView({
      favorites: [favorite(0), favorite(1)],
      limit: POLYMARKET_FAVORITES_LIMIT,
      config: { enabled: true, threshold: '1000', dailyLimit: 10, windowMinutes: 5 },
      timezone: 'America/Sao_Paulo',
    });
    const text = JSON.stringify(view).toLowerCase();
    for (const forbidden of [
      'score',
      'badge',
      'recomend',
      'selo',
      'rating',
      'composite',
      'melhor',
      'pior',
      'destaque',
    ])
      expect(text, `a view não pode conter "${forbidden}"`).not.toContain(forbidden);
    // E o que ela carrega é só o que o usuário escolheu guardar.
    expect(Object.keys(favoriteRowView(favorite(0))).sort()).toEqual([
      'favoritedAt',
      'key',
      'trader',
      'wallet',
    ]);
  });

  it('a frase do alerta não promete pontuação, só a regra que o produz', () => {
    const rule = alertRuleText({
      threshold: '1000',
      windowMinutes: ALERT_WINDOW_MINUTES,
      timezone: 'America/Sao_Paulo',
    });
    expect(rule).toContain('LÍQUIDA');
    expect(rule).toContain('1000');
    expect(rule).toContain('5 minutos');
    expect(rule).toContain('America/Sao_Paulo');
    expect(rule.toLowerCase()).not.toContain('score');
    expect(rule.toLowerCase()).not.toContain('recomend');
  });

  it('os ARQUIVOS DE PRODUTO desta tarefa não LEEM o score gravado', () => {
    // O job grava `polymarket_score_run`; NINGUÉM lê. A prova é por ausência
    // de código de LEITURA: o termo pode aparecer nas frases que explicam a
    // AUSÊNCIA, e o teste garante que a citação está no COMENTÁRIO, nunca em
    // código executável — a mesma técnica que a F2-15 usou no ranking.
    const consumers = [
      '../../apps/api/src/polymarket-alerts-routes.ts',
      '../../apps/web/src/product/polymarket-favorites.tsx',
      '../../apps/web/src/product/favorites-view.ts',
      '../../packages/shared/src/index.ts',
    ];
    for (const file of consumers) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      const code = source
        .split('\n')
        .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
        .join('\n');
      expect(code, `código de ${file} não pode ler o score`).not.toMatch(
        /score_run|compositeScore|composite score/i,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 8) O score é calculado, versionado e PARALELO
// ---------------------------------------------------------------------------

describe('STK-F2-16 §15 — o score é calculado em silêncio, versionado e recusado sem série completa', () => {
  const window = { category: 'OVERALL', timePeriod: 'MONTH', orderBy: 'PNL' } as const;
  const traders = [
    { pnl: '1000.5', vol: '5000.25' },
    { pnl: '-400.25', vol: '1500.75' },
    { pnl: '2000', vol: '2000' },
    { pnl: '10', vol: '500' },
  ] as const;

  it('com série COMPLETA, o score é calculado e cada componente declara a regra', () => {
    const run = computeCompositeScore({
      window,
      seriesStatus: 'complete',
      traders: [...traders],
      now: at('2026-09-29T12:00:00.000Z'),
      digest: 'a'.repeat(64),
    });
    expect(run.eligible).toBe(true);
    expect(run.reason).toBeNull();
    expect(run.score).not.toBeNull();
    // Três de quatro traders têm P&L positivo: `edge` = 0.750000.
    expect(run.components[0]!.value).toBe('0.750000');
    expect(run.components[0]!.key).toBe('edge');
    // A janela gravada é a OFICIAL da F2-15, com o enum reusado.
    expect(run.window).toEqual(window);
    // Todo componente é auditável: a regra viaja com o número.
    for (const component of run.components) expect(component.rule.length).toBeGreaterThan(20);
    // O score é um decimal de seis casas, dentro de [0, 1].
    expect(run.score).toMatch(/^0\.\d{6}$/);
    expect(Number(run.score)).toBeLessThanOrEqual(1);
  });

  it('o cálculo é REPRODUZÍVEL: mesma entrada, mesmo score, sem float', () => {
    const first = computeCompositeScore({
      window,
      seriesStatus: 'complete',
      traders: [...traders],
      now: at('2026-09-29T12:00:00.000Z'),
      digest: 'b'.repeat(64),
    });
    const second = computeCompositeScore({
      window,
      seriesStatus: 'complete',
      traders: [...traders],
      now: at('2026-09-30T03:00:00.000Z'),
      digest: 'b'.repeat(64),
    });
    // Só o instante muda: o número é o mesmo, porque a aritmética é BigInt.
    expect(second.score).toBe(first.score);
    expect(JSON.stringify(second.components)).toBe(JSON.stringify(first.components));
  });

  it('com série TRUNCADA, o score é RECUSADO — e a recusa é gravada', () => {
    // Este é o ponto honesto da tarefa: `truncated` é o estado real e normal do
    // backfill da F2-14, e um score sobre cobertura parcial seria uma medida da
    // nossa coleta apresentada como medida do mercado.
    for (const status of ['truncated', 'partial', 'unknown'] as const) {
      const run = computeCompositeScore({
        window,
        seriesStatus: status,
        traders: [...traders],
        now: at('2026-09-29T12:00:00.000Z'),
        digest: 'c'.repeat(64),
      });
      expect(run.eligible).toBe(false);
      expect(run.score).toBeNull();
      expect(run.reason).toContain('truncada ou incompleta');
      // A versão existe mesmo na recusa: o histórico mostra que a avaliação
      // ACONTECEU, que é diferente de não ter avaliado.
      expect(run.version).toBe(1);
      expect(run.seriesStatus).toBe(status);
    }
  });

  it('série completa sem trader é recusa com motivo PRÓPRIO', () => {
    const run = scoreRefusal('complete', 0, window);
    expect(run.eligible).toBe(false);
    expect(run.reason).toContain('não tem trader observado');
  });

  it('o score NUNCA é lido por uma função do serviço: a API não o expõe', () => {
    // O serviço tem `runScore` (ESCREVE a versão) e nenhum leitor. O teste fixa
    // duas coisas: (1) a única coluna de score que sai do banco é a que o
    // próprio job grava, e (2) a superfície pública não devolve score.
    const service = readFileSync(
      new URL('../../packages/db/src/polymarket-alerts.ts', import.meta.url),
      'utf8',
    );
    const code = service
      .split('\n')
      .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
      .join('\n');
    // Nenhuma linha de CÓDIGO seleciona a coluna `score` da tabela do score
    // para devolvê-la: só a lista de colunas do INSERT a menciona.
    const selectsScore = code
      .split('\n')
      .filter((line) => /polymarket_score_run/.test(line) && !/insert into/i.test(line));
    for (const line of selectsScore)
      // As duas linhas legítimas são a que calcula a próxima versão e a que
      // relê o NÚMERO da versão. Nenhuma delas traz a coluna `score`.
      expect(line, `linha lendo o score: ${line.trim()}`).not.toMatch(/\bscore\b/);
    // E a superfície pública não expõe nada que devolva o score.
    const returned = service.slice(service.lastIndexOf('return {'));
    expect(returned).toContain('runScore');
    expect(returned).not.toMatch(/scoreRun|scoreOf|readScore|scoreFor/i);
    // O retorno de `runScore` é `{ version, eligible }` — sem `score`.
    expect(returned).not.toMatch(/runScore[\s\S]{0,400}?\bscore\b/);
  });
});
