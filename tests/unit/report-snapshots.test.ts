import { describe, expect, it } from 'vitest';
import {
  AUTOMATIC_CADENCE_BY_PLAN,
  REPORT_CADENCE_BY_PLAN,
  REPORT_PERIODS,
  REPORT_SCHEDULE_MINUTES,
  buildReportNarrative,
  civilDateIn,
  dayOfMonthIn,
  dayOfWeekIn,
  reportDeliveryKey,
  reportDueMinutes,
  reportHasData,
  reportHeadline,
  reportPeriodIsDue,
  reportPeriodTitle,
  reportPrivateLink,
  reportTelegramSummary,
  reportWindow,
  type ReportMetrics,
} from '../../packages/shared/src/index.js';

/**
 * STK-F2-08 §15 — Relatórios, camada pura: cadência por plano, fuso do
 * usuário, ausência de dados, link autenticado, narrativa determinística e
 * deduplicação.
 *
 * Nada aqui toca banco, rede ou relógio do sistema: o instante é INJETADO em
 * todas as funções que dependem de hora, e o fuso é explícito. É por isso que
 * o fuso do usuário é testável de verdade — a única forma de provar que "21h
 * no fuso dele" e não "21h do servidor" é comparar o mesmo instante em dois
 * fusos e ver resultados diferentes.
 */

const metrics = (over: Partial<ReportMetrics> = {}): ReportMetrics => ({
  bets: 12,
  settledBets: 10,
  openBets: 2,
  realStake: '1000.00',
  freebetStake: '0.00',
  realPrincipalClosed: '600.00',
  realReturns: '720.00',
  freebetReturns: '0.00',
  realProfit: '120.00',
  freebetProfit: '0.00',
  profit: '120.00',
  profitUnits: '1.200000',
  knownProfitUnits: '1.200000',
  missingUnitBets: 0,
  exposure: '40.00',
  roiReal: '20.00',
  yieldReal: '18.00',
  hitRateReal: '60.00',
  hitWinsReal: 6,
  hitEligibleReal: 10,
  ...over,
});

describe('STK-F2-08 §15 — a cadência é do plano, e o plano é dado pelo banco', () => {
  it('o plano Free não tem envio automático: o resumo mensal é sob demanda', () => {
    expect(AUTOMATIC_CADENCE_BY_PLAN.free).toEqual([]);
    // O catálogo do produto ainda oferece a cadência mensal ao Free — é o
    // `/relatorio` (F2-07) que a dispara, sob demanda, e não o job.
    expect(REPORT_CADENCE_BY_PLAN.free).toEqual(['monthly']);
  });

  it('Starter recebe semanal; Pro recebe diário, semanal e mensal', () => {
    expect(AUTOMATIC_CADENCE_BY_PLAN.starter).toEqual(['weekly']);
    expect(AUTOMATIC_CADENCE_BY_PLAN.pro).toEqual(['daily', 'weekly', 'monthly']);
  });

  it('nenhum plano recebe uma cadência fora do conjunto fechado', () => {
    for (const periods of Object.values(AUTOMATIC_CADENCE_BY_PLAN))
      for (const period of periods) expect(REPORT_PERIODS).toContain(period);
  });

  it('o catálogo do produto é SUBSET do que qualquer plano pode oferecer', () => {
    // Um plano não pode ter uma cadência que o produto não conhece: a
    // intersection das duas listas é o que o job envia, e um item só no
    // catálogo seria uma promessa sem entrega.
    for (const plan of Object.keys(
      AUTOMATIC_CADENCE_BY_PLAN,
    ) as (keyof typeof REPORT_CADENCE_BY_PLAN)[])
      for (const period of AUTOMATIC_CADENCE_BY_PLAN[plan])
        expect(REPORT_CADENCE_BY_PLAN[plan]).toContain(period);
  });
});

describe('STK-F2-08 §15 — o horário é do usuário, no fuso DELE', () => {
  // 2026-09-29T23:30:00Z = 29/09 20:30 em São Paulo, 19:30 em Manaus.
  const instant = new Date('2026-09-29T23:30:00Z');

  it('o mesmo instante é 20:30 em São Paulo e 19:30 em Manaus', () => {
    expect(reportDueMinutes('daily', instant, 'America/Sao_Paulo')).toBe(20 * 60 + 30);
    expect(reportDueMinutes('daily', instant, 'America/Manaus')).toBe(19 * 60 + 30);
  });

  it('21h no fuso do usuário: vence em São Paulo e ainda não em Manaus', () => {
    expect(reportPeriodIsDue('daily', instant, 'America/Sao_Paulo')).toBe(false);
    expect(reportPeriodIsDue('daily', instant, 'America/Manaus')).toBe(false);
    // 21h30 em São Paulo: já passou das 21h. O mesmo instante são 20:30 em
    // Manaus, que ainda NÃO passou. A diferença é exatamente o fuso.
    const later = new Date('2026-09-30T00:30:00Z');
    expect(reportPeriodIsDue('daily', later, 'America/Sao_Paulo')).toBe(true);
    expect(reportPeriodIsDue('daily', later, 'America/Manaus')).toBe(false);
  });

  it('a cadência só vence no dia certo: semana na segunda, mês no dia 1', () => {
    // 2026-09-28 é segunda-feira; 2026-10-01 é quinta; 2026-10-05 é segunda.
    const monday = new Date('2026-09-28T12:00:00Z');
    const thursday = new Date('2026-10-01T12:00:00Z');
    const nextMonday = new Date('2026-10-05T12:00:00Z');
    expect(dayOfWeekIn(monday, 'America/Sao_Paulo')).toBe(1);
    expect(dayOfWeekIn(thursday, 'America/Sao_Paulo')).toBe(4);
    // Terça às 23h: a semanal NÃO vence, mesmo com o horário passado.
    const tuesdayLate = new Date('2026-09-29T23:59:00Z');
    expect(reportPeriodIsDue('weekly', tuesdayLate, 'America/Sao_Paulo')).toBe(false);
    // Segunda às 10h: vence.
    expect(reportPeriodIsDue('weekly', new Date('2026-09-28T13:00:00Z'), 'America/Sao_Paulo')).toBe(
      true,
    );
    expect(nextMonday.getTime()).toBeGreaterThan(monday.getTime());
  });

  it('mensal vence só no dia 1, e 9h é o horário do produto', () => {
    // A regra é "A PARTIR DE" 9h, não "exatamente às" 9h: o job roda a cada
    // cinco minutos e pode atrasar, e um igual-exatamente perderia o envio do
    // dia. A dedupe é o que impede que atravessar as 9h vire vários envios.
    const dayBefore = new Date('2026-09-30T13:00:00Z');
    expect(dayOfMonthIn(dayBefore, 'America/Sao_Paulo')).toBe(30);
    expect(reportPeriodIsDue('monthly', dayBefore, 'America/Sao_Paulo')).toBe(false);
    // 2026-10-01T12:00:00Z = 09:00 em São Paulo (UTC-3, sem horário de verão
    // em outubro): o instante exato do produto já vence.
    const first = new Date('2026-10-01T12:00:00Z');
    expect(dayOfMonthIn(first, 'America/Sao_Paulo')).toBe(1);
    expect(reportPeriodIsDue('monthly', first, 'America/Sao_Paulo')).toBe(true);
    // E continua vencendo ao longo do dia, porque o job pode rodar tarde.
    expect(
      reportPeriodIsDue('monthly', new Date('2026-10-01T18:00:00Z'), 'America/Sao_Paulo'),
    ).toBe(true);
    // Dia 5 não vence, mesmo com o horário bem passado.
    expect(
      reportPeriodIsDue('monthly', new Date('2026-10-05T20:00:00Z'), 'America/Sao_Paulo'),
    ).toBe(false);
    expect(REPORT_SCHEDULE_MINUTES).toEqual({ daily: 1260, weekly: 540, monthly: 540 });
  });

  it('fuso INVÁLIDO nunca envia: a resposta é "não sei que horas são aí"', () => {
    // Um fuso desconhecido faria o job decidir por um horário que não é do
    // usuário. A recusa é explícita, e nenhum caminho a transforma em "21h".
    expect(reportDueMinutes('daily', instant, 'Mars/Olympus')).toBeNull();
    expect(reportPeriodIsDue('daily', instant, 'Mars/Olympus')).toBe(false);
    expect(reportPeriodIsDue('weekly', instant, '')).toBe(false);
  });

  it('a meia-noite local é resolvida pela data, sem distorção de fuso', () => {
    // 2026-10-01T02:00:00Z: em São Paulo (UTC-3) ainda é 30/09 23:00; em Tóquio
    // (UTC+9) já é 01/10 11:00. A MESMA INSTANTE produz duas datas diferentes,
    // e é a data do USUÁRIO que decide a janela — nunca a do servidor.
    const edge = new Date('2026-10-01T02:00:00Z');
    expect(civilDateIn(edge, 'America/Sao_Paulo')).toBe('2026-09-30');
    expect(civilDateIn(edge, 'Asia/Tokyo')).toBe('2026-10-01');
  });
});

describe('STK-F2-08 §15 — a janela de cada cadência, no fuso do usuário', () => {
  const instant = new Date('2026-09-29T23:30:00Z');

  it('diário é o próprio dia; semanal são 7 dias; mensal vai do dia 1', () => {
    expect(reportWindow('daily', instant, 'America/Sao_Paulo')).toEqual({
      from: '2026-09-29',
      to: '2026-09-29',
    });
    expect(reportWindow('weekly', instant, 'America/Sao_Paulo')).toEqual({
      from: '2026-09-23',
      to: '2026-09-29',
    });
    expect(reportWindow('monthly', instant, 'America/Sao_Paulo')).toEqual({
      from: '2026-09-01',
      to: '2026-09-29',
    });
  });

  it('a janela semanal é a MESMA do /semana da F2-07, para os números não divergirem', async () => {
    const { telegramPeriod } = await import('../../packages/shared/src/index.js');
    const command = telegramPeriod('semana', instant);
    const automatic = reportWindow('weekly', instant, 'America/Sao_Paulo');
    expect(automatic.from).toBe(command.from);
    expect(automatic.to).toBe(command.to);
  });

  it('o fuso do usuário desloca a janela, não o servidor', () => {
    // 2026-10-01T02:00:00Z: São Paulo ainda está em 30/09 e Tóquio já está em
    // 01/10 — o mesmo instante, duas janelas diferentes. É isso que "no fuso do
    // usuário" significa, e o erro clássico (usar a data do servidor) entregaria
    // ao usuário de Tóquio o relatório do mês anterior.
    const edge = new Date('2026-10-01T02:00:00Z');
    expect(reportWindow('monthly', edge, 'America/Sao_Paulo').from).toBe('2026-09-01');
    expect(reportWindow('monthly', edge, 'Asia/Tokyo').from).toBe('2026-10-01');
  });
});

describe('STK-F2-08 §15 — ausência de dados NÃO é envio', () => {
  it('relatório sem apostas não tem dado para publicar', () => {
    expect(reportHasData(metrics({ bets: 0 }))).toBe(false);
    expect(reportHasData(metrics({ bets: 1 }))).toBe(true);
  });

  it('a regra é a MESMA função para o job e para a página', () => {
    // Uma única função decide: se o job e a página usassem decisões
    // diferentes, uma delas enviaria o relatório vazio que a outra escondeu.
    expect(reportHasData({ bets: 0 })).toBe(false);
  });
});

describe('STK-F2-08 §15 — a dedupe é por janela e versão financeira, não por instante', () => {
  it('a chave não muda quando o job roda de novo na mesma janela', () => {
    const first = reportDeliveryKey('org-1', 'daily', '2026-09-29', '2026-09-29', 7);
    const second = reportDeliveryKey('org-1', 'daily', '2026-09-29', '2026-09-29', 7);
    expect(second).toBe(first);
  });

  it('a chave muda quando o FINANCEIRO muda: é a forma da versão revisada', () => {
    // Uma correção de aposta incrementa `finance.settings.version`; o mesmo
    // relatório passa a ser um documento novo, e não um reenvio do antigo.
    expect(reportDeliveryKey('org-1', 'daily', '2026-09-29', '2026-09-29', 8)).not.toBe(
      reportDeliveryKey('org-1', 'daily', '2026-09-29', '2026-09-29', 7),
    );
  });

  it('a chave muda com a organização e com a janela: dois tenants não colidem', () => {
    expect(reportDeliveryKey('org-1', 'daily', '2026-09-29', '2026-09-29', 7)).not.toBe(
      reportDeliveryKey('org-2', 'daily', '2026-09-29', '2026-09-29', 7),
    );
    expect(reportDeliveryKey('org-1', 'daily', '2026-09-28', '2026-09-28', 7)).not.toBe(
      reportDeliveryKey('org-1', 'daily', '2026-09-29', '2026-09-29', 7),
    );
  });

  it('a chave não contém instante, id de snapshot nem nada que mude a cada passe', () => {
    const key = reportDeliveryKey('org-1', 'weekly', '2026-09-23', '2026-09-29', 7);
    expect(key).toBe('report:weekly:2026-09-23:2026-09-29:v7:org-1');
    expect(key).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});

describe('STK-F2-08 §15 — o link é privado, do produto, e sem credencial', () => {
  it('o link é a rota do produto com o fragmento da tela', () => {
    expect(reportPrivateLink('https://app.stakeframe.test')).toBe(
      'https://app.stakeframe.test/#relatorios',
    );
  });

  it('o link nunca carrega token, id de snapshot ou parâmetro de sessão', () => {
    const link = reportPrivateLink('https://app.stakeframe.test/');
    // Sem `?` (nada de query), sem `=` (nada de credencial), e o único
    // fragmento é a rota da página.
    expect(link).not.toContain('?');
    expect(link).not.toContain('=');
    expect(link).not.toMatch(/token|snapshot|key|session/i);
  });

  it('a URL base já com fragmento é limpa antes de receber a rota', () => {
    expect(reportPrivateLink('https://app.stakeframe.test/#analytics')).toBe(
      'https://app.stakeframe.test/#relatorios',
    );
  });

  it('uma rota fora do formato do produto é recusada, não interpolada', () => {
    // Um `route` lido do ambiente com barra ou `..` Reescreveria o caminho;
    // o conjunto é fechado e validado.
    expect(() => reportPrivateLink('https://a.test', 'relatorios/../admin')).toThrow();
    expect(() => reportPrivateLink('https://a.test', 'https://outro.test')).toThrow();
    expect(() => reportPrivateLink('https://a.test', '')).toThrow();
  });
});

describe('STK-F2-08 §15 — a narrativa é determinística e sem IA generativa', () => {
  // 40 apostas: acima do limiar de 30, para que a narrativa inteira (incluindo
  // as concentrações) seja exercitada. A versão de amostra pequena tem teste
  // próprio, logo abaixo.
  const input = {
    metrics: metrics({ bets: 40, settledBets: 36, openBets: 4 }),
    minSample: 30,
    periodLabel: 'Semanal — 23/09 a 29/09',
    topBookmaker: { label: 'Bet365', profit: '100.00' },
    topSport: { label: 'Futebol', profit: '120.00' },
  };

  it('mesmos números, mesmo texto: é o que torna o snapshot auditável', () => {
    const first = buildReportNarrative(input);
    const second = buildReportNarrative({ ...input });
    expect(second).toEqual(first);
  });

  it('cada linha carrega o número que a produziu', () => {
    const narrative = buildReportNarrative(input);
    for (const line of narrative.lines)
      expect(line.fact === null || line.fact.length > 0).toBe(true);
    // O número do resultado aparece e é rastreável.
    expect(narrative.lines.some((line) => line.fact === 'ROI real')).toBe(true);
  });

  it('abaixo do limiar, a narrativa AVISA e não interpreta o percentual', () => {
    const narrative = buildReportNarrative({ ...input, metrics: metrics({ bets: 4 }) });
    expect(narrative.lowSample).toBe(true);
    expect(
      narrative.lines.some(
        (line) => line.kind === 'heuristic' && /amostra pequena/i.test(line.text),
      ),
    ).toBe(true);
    // Nenhuma concentração é afirmada com amostra pequena: 4 apostas não
    // dizem qual casa concentrou o resultado.
    expect(narrative.lines.some((line) => line.fact?.startsWith('resultado por casa'))).toBe(false);
  });

  it('ROI sem base vira "sem base", nunca 0%', () => {
    const narrative = buildReportNarrative({
      ...input,
      metrics: metrics({ bets: 40, roiReal: null, realPrincipalClosed: '0.00' }),
    });
    const line = narrative.lines.find((item) => item.fact === 'ROI real sem base');
    expect(line?.text).toMatch(/sem base/i);
    // Nenhum percentual é afirmado quando não há principal encerrado: dizer
    // "0%" seria afirmar retorno zero quando o fato é que não existe base.
    // "0,00%" é o zero FORMATADO (o caso seguinte), que é uma leitura diferente.
    expect(narrative.lines.some((item) => /ROI real 0%/.test(item.text))).toBe(false);
    expect(narrative.lines.some((item) => /yield real 0%/.test(item.text))).toBe(false);
  });

  it('percentual zero legítimo continua sendo mostrado como 0,00%', () => {
    // O oposto do teste anterior: quando a base EXISTE e o retorno foi zero, o
    // número é zero e precisa aparecer. Esconder zero por medo de confusão
    // seria esconder um dado verdadeiro.
    const narrative = buildReportNarrative({
      ...input,
      metrics: metrics({ bets: 40, roiReal: '0.00', yieldReal: '0.00' }),
    });
    expect(narrative.lines.some((item) => item.text.includes('ROI real 0,00%'))).toBe(true);
  });

  it('a participação é calculada em MAGNITUDE, e não vira número impossível', () => {
    // Resultado total negativo: 50% de um total negativo apareceria como
    // "-50%" se a divisão respeitasse o sinal, e a frase ensinaria que a casa
    // "concentrou menos do que o todo", que é leitura impossível.
    const narrative = buildReportNarrative({
      ...input,
      metrics: metrics({ bets: 40, profit: '-120.00', realProfit: '-120.00' }),
      topBookmaker: { label: 'Bet365', profit: '-60.00' },
      topSport: { label: 'Futebol', profit: '-120.00' },
    });
    const line = narrative.lines.find((item) => item.fact?.startsWith('resultado por casa'));
    expect(line?.text).toContain('50% do resultado');
    expect(line?.text).not.toContain('-50%');
  });

  it('resultado zero não produz participação inventada', () => {
    const narrative = buildReportNarrative({
      ...input,
      metrics: metrics({ bets: 40, profit: '0.00', realProfit: '0.00' }),
      topBookmaker: { label: 'Bet365', profit: '0.00' },
    });
    const line = narrative.lines.find((item) => item.fact?.startsWith('resultado por casa'));
    // Sem total, não há participação: a frase diz "parte relevante" em vez de
    // dividir por zero.
    expect(line?.text).toContain('parte relevante');
  });

  it('o período negativo diz o que aconteceu e não recomenda nada', () => {
    const narrative = buildReportNarrative({
      ...input,
      metrics: metrics({ bets: 40, profit: '-120.00', realProfit: '-120.00' }),
    });
    const closing = narrative.lines.filter((line) => line.fact === 'resultado do período');
    expect(closing).toHaveLength(1);
    expect(closing[0]!.text).toMatch(/não recomenda nada/i);
  });
});

describe('STK-F2-08 §15 — o resumo do Telegram é número e link, nunca o relatório', () => {
  const summary = reportTelegramSummary({
    period: 'weekly',
    from: '2026-09-23',
    to: '2026-09-29',
    metrics: metrics(),
    minSample: 30,
    link: reportPrivateLink('https://app.stakeframe.test'),
  });

  it('leva o período, os números e o link privado', () => {
    expect(summary).toContain('SEMANAL');
    expect(summary).toContain('23/09/2026 a 29/09/2026');
    expect(summary).toContain('R$ 120,00');
    expect(summary).toContain('https://app.stakeframe.test/#relatorios');
  });

  it('NÃO contém arquivo, PDF, PNG, e-mail nem URL temporária', () => {
    // O card rejeita os três (§6.2). A mensagem é o único lugar onde o
    // conteúdo do usuário sairia do controle de acesso da conta, então a
    // ausência é verificada por texto, não por confiança.
    expect(summary).not.toMatch(/pdf|png|jpeg|imagem/i);
    expect(summary).not.toMatch(/@|e-?mail/i);
    expect(summary).not.toMatch(/token=|sig=|exp=/i);
  });

  it('amostra pequena aparece junto do N, como no /hoje da F2-07', () => {
    const small = reportTelegramSummary({
      period: 'daily',
      from: '2026-09-29',
      to: '2026-09-29',
      metrics: metrics({ bets: 3 }),
      minSample: 30,
      link: 'https://app.stakeframe.test/#relatorios',
    });
    expect(small).toContain('amostra pequena');
    expect(small).toContain('mínimo 30');
  });

  it('o resumo é determinístico', () => {
    const again = reportTelegramSummary({
      period: 'weekly',
      from: '2026-09-23',
      to: '2026-09-29',
      metrics: metrics(),
      minSample: 30,
      link: 'https://app.stakeframe.test/#relatorios',
    });
    expect(again).toBe(summary);
  });
});

describe('STK-F2-08 §15 — os quatro blocos de número da página', () => {
  it('o resultado assume o tom do sinal e os demais são neutros', () => {
    const positive = reportHeadline(metrics({ profit: '120.00' }));
    expect(positive[0]!.tone).toBe('positive');
    const negative = reportHeadline(metrics({ profit: '-120.00', realProfit: '-120.00' }));
    expect(negative[0]!.tone).toBe('negative');
    expect(negative[0]!.value).toContain('−');
    const zero = reportHeadline(metrics({ profit: '0.00' }));
    expect(zero[0]!.tone).toBe('neutral');
  });

  it('percentual sem base é escrito como ausência, não como zero', () => {
    const blocks = reportHeadline(metrics({ roiReal: null, yieldReal: null }));
    expect(blocks.find((block) => block.label === 'ROI real')?.value).toBe('Sem base');
  });
});

describe('STK-F2-08 §15 — o título da página vem da janela, não do instante', () => {
  it('dia único mostra a data só uma vez', () => {
    expect(reportPeriodTitle('daily', '2026-09-29', '2026-09-29')).toBe('Diário — 29/09/2026');
  });

  it('janela de vários dias mostra as duas extremidades', () => {
    expect(reportPeriodTitle('weekly', '2026-09-23', '2026-09-29')).toBe(
      'Semanal — 23/09/2026 a 29/09/2026',
    );
  });
});
