import { z } from 'zod';
import { isValidTimezone, minutesOfDayIn } from './freebets.js';
import type { PlanId } from './entitlements.js';
import { cents } from './decimal.js';
import { formatReportBRL, type ReportMetrics } from './reports.js';

// STK-F2-08 — relatórios como PÁGINAS HTML PRIVADAS, com cadência por plano,
// snapshot IMUTÁVEL e narrativa determinística (Plano Master 2026 §8.6, §15).
//
// Este arquivo é a superfície PURA: nenhuma consulta, nenhum envio, nenhum
// relógio próprio. Tudo aqui é FUNÇÃO, e é função porque cada uma delas é uma
// decisão que precisa ser testável sozinha:
//
//  1) A CADÊNCIA É DO PLANO, E O PLANO É DADO PELO BANCO. A F2-13 já resolve o
//     plano efetivo em `core.organization_entitlements`; este arquivo não
//     recalcula permissão, apenas traduz a CADÊNCIA que aquele plano tem. A
//     diferença entre "o plano permite" e "o que o job envia" fica explícita:
//     o catálogo abaixo é o produto, não um segundo banco de entitlement.
//
//  2) O HORÁRIO É DO USUÁRIO, NO FUSO DELE. Um relatório entregue às 21h do
//     horário de São Paulo não é "às 21h" para quem mora em Manaus. A
//     conversão usa a MESMA função que as quiet hours da F2-10
//     (`minutesOfDayIn`), então as duas superfícies concordam por construção.
//
//  3) AUSÊNCIA DE DADOS NÃO É ENVIO. Um relatório sem apostas é um relatório
//     que o usuário não pediu e que polui o canal. `reportHasData` é a
//     decisão, e ela é a MESMA no job e no comando — não há caminho que envie
//     um relatório vazio.
//
//  4) A NARRATIVA É DETERMINÍSTICA E LOCAL. O card exclui IA generativa
//     (§6.2): nada aqui chama modelo, e tudo aqui sai dos números do próprio
//     relatório mais heurísticas do produto. Um relatório gerado duas vezes com
//     os mesmos dados produz o MESMO texto — é o que torna o snapshot
//     auditável.
//
//  5) O SNAPSHOT É IMUTÁVEL POR ESTRUTURA. Nenhuma função deste arquivo altera
//     um relatório: correção é uma NOVA versão (§4 abaixo), nunca um UPDATE.

/** As três cadências do produto. `daily` só existe para o plano Pro. */
export const REPORT_PERIODS = ['daily', 'weekly', 'monthly'] as const;
export const reportPeriodSchema = z.enum(REPORT_PERIODS);
export type ReportPeriod = z.infer<typeof reportPeriodSchema>;

/**
 * Cadência por plano, na ordem de exibição do §8.6:
 *
 *  - `free`   → NENHUM envio automático. O resumo mensal é SOB DEMANDA, pelo
 *               `/relatorio` do F2-07, que aponta para a página privada.
 *  - `starter`→ semanal automático.
 *  - `pro`    → diário, semanal e mensal.
 *
 * O conjunto é FECHADO e declarado aqui, no produto. Ele não é um segundo
 * banco de entitlement: o que decide se um tenant TEM a capacidade é a
 * linha que a F2-13 devolve; o que este catálogo diz é QUAL cadência o plano
 * oferece, e a interseção das duas coisas é o que o job envia.
 */
export const REPORT_CADENCE_BY_PLAN: Readonly<Record<PlanId, readonly ReportPeriod[]>> = {
  free: ['monthly'],
  starter: ['weekly', 'monthly'],
  pro: ['daily', 'weekly', 'monthly'],
};

/**
 * O envio automático de um plano. O plano `free` NÃO envia: o card diz que o
 * Free tem resumo mensal por comando, e "por comando" é o oposto de
 * automático. Manter o Free nesta lista por engano transformaria uma escolha de
 * produto em envio unwanted, e reenvio automático está fora do escopo.
 */
export const AUTOMATIC_CADENCE_BY_PLAN: Readonly<Record<PlanId, readonly ReportPeriod[]>> = {
  free: [],
  starter: ['weekly'],
  pro: ['daily', 'weekly', 'monthly'],
};

/**
 * Horários do produto, em MINUTOS DESDE A MEIA-NOITE LOCAL do usuário. O
 * card fixa os três: diário às 21h, semanal na segunda às 9h, mensal no dia 1
 * às 9h. A escolha de 21h (e não meia-noite) é deliberada: o relatório do dia
 * só fecha depois que a última aposta do dia foi registrada, e meia-noite
 * publicaria uma janela que ainda mudaria.
 */
export const REPORT_SCHEDULE_MINUTES: Readonly<Record<ReportPeriod, number>> = {
  daily: 21 * 60,
  weekly: 9 * 60,
  monthly: 9 * 60,
};

/** Dia da semana do relatório semanal (segunda): 1 = segunda (0 = domingo). */
export const REPORT_WEEKLY_WEEKDAY = 1;

/** Dia do mês do relatório mensal (dia 1). */
export const REPORT_MONTHLY_DAY = 1;

/**
 * Minutos do dia em que uma cadência é devida, no fuso do usuário.
 *
 * `null` quando o fuso é INVÁLIDO: a recusa é explícita e o chamador não envia.
 * Um fuso desconhecido faria o job decidir por um horário que não é o do
 * usuário — a resposta certa é "não sei que horas são aí", não "21h do
 * servidor".
 */
export function reportDueMinutes(
  period: ReportPeriod,
  instant: Date,
  timezone: string,
): number | null {
  if (!isValidTimezone(timezone)) return null;
  if (period === 'weekly') {
    const weekday = dayOfWeekIn(instant, timezone);
    return weekday === REPORT_WEEKLY_WEEKDAY ? REPORT_SCHEDULE_MINUTES.weekly : null;
  }
  if (period === 'monthly') {
    const day = dayOfMonthIn(instant, timezone);
    return day === REPORT_MONTHLY_DAY ? REPORT_SCHEDULE_MINUTES.monthly : null;
  }
  return minutesOfDayIn(instant, timezone);
}

/**
 * Dia da semana no fuso do usuário (0 = domingo … 6 = sábado).
 *
 * Não existe `Intl.weekday` com número estável entre runtimes, então o dia é
 * derivado da DATA local: converter a data local para `Date.UTC` e ler
 * `getUTCDay()` dá o dia da semana SEM a distorção de fuso, porque a data já
 * está projetada no fuso do usuário.
 */
export function dayOfWeekIn(instant: Date, timezone: string): number {
  return new Date(`${civilDateIn(instant, timezone)}T00:00:00Z`).getUTCDay();
}

/** Dia do mês (1–31) no fuso do usuário. */
export function dayOfMonthIn(instant: Date, timezone: string): number {
  return Number(civilDateIn(instant, timezone).slice(8, 10));
}

/** Data civil (AAAA-MM-DD) do instante no fuso do usuário. */
export function civilDateIn(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const pick = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

/**
 * A cadência está vencida AGORA, no fuso do usuário?
 *
 * Três condições, e as três importam:
 *
 *  - o fuso é válido (senão a resposta é `false`, não uma adivinhação);
 *  - o dia da cadência é o dia certo (segunda na semanal; dia 1 na mensal);
 *  - os minutos locais já passaram do horário do produto.
 *
 * O job roda periodicamente, então `atOrAfter` (e não "exatamente às 21h")
 * é o que evita perder o envio quando o worker atrasa. A DEDUPE do job é o
 * que garante que "atravessou 21h" não vire três envios.
 */
export function reportPeriodIsDue(period: ReportPeriod, instant: Date, timezone: string): boolean {
  const minutes = reportDueMinutes(period, instant, timezone);
  return minutes !== null && minutes >= REPORT_SCHEDULE_MINUTES[period];
}

/**
 * A janela de datas do relatório, já fechada no FUSO DO USUÁRIO.
 *
 * O relatório trabalha por DATA DE EVENTO (§3.8), então a janela precisa ser
 *expressa em datas Civis do usuário. E cada cadência tem um recorte próprio:
 *
 *  - `daily`   → o próprio dia do usuário (hoje);
 *  - `weekly`  → os últimos 7 dias, terminando hoje — o mesmo "últimos 7 dias"
 *                do `/semana` da F2-07, para que o número do chat e o da
 *                página não divirjam;
 *  - `monthly` → do dia 1 do mês até hoje, no fuso dele.
 *
 * A janela mensal começa no dia 1 mesmo quando o job roda no dia 1 às 9h: o
 * relatório do dia 1 é o do dia 1, não um mês vazio — o que o torna pouco
 * informativo é o que o §3.8 diz (data de evento), e ele é honesto sobre
 * período de 1 dia.
 */
export function reportWindow(
  period: ReportPeriod,
  instant: Date,
  timezone: string,
): {
  from: string;
  to: string;
} {
  const today = isValidTimezone(timezone)
    ? civilDateIn(instant, timezone)
    : civilDateIn(instant, 'America/Sao_Paulo');
  if (period === 'daily') return { from: today, to: today };
  if (period === 'weekly') {
    const start = new Date(`${today}T12:00:00Z`);
    start.setUTCDate(start.getUTCDate() - 6);
    return {
      from: civilDateIn(start, timezone),
      to: today,
    };
  }
  return { from: `${today.slice(0, 7)}-01`, to: today };
}

/**
 * A CHAVE DE DEDUPE do envio. É o que garante que rodar o job N vezes no dia
 * envie UM relatório.
 *
 * A chave carrega a organização, a cadência, a JANELA e a VERSÃO FINANCEIRA
 * (`version`), nunca o instante de execução. Se a chave levasse `now`, cada
 * passe do job produziria uma chave nova e o relatório sairia a cada cinco
 * minutos; com a chave por janela + versão, um segundo envio do mesmo período
 * só acontece quando o financeiro MUDOU — que é a forma de "correção gera
 * versão revisada" (item 4 do card) sem reenvio automático indevido.
 */
export function reportDeliveryKey(
  organizationId: string,
  period: ReportPeriod,
  from: string,
  to: string,
  version: number,
): string {
  return `report:${period}:${from}:${to}:v${version}:${organizationId}`;
}

/**
 * Este relatório tem DADOS para ser enviado?
 *
 * Um relatório sem apostas não tem métrica nenhuma: o P&L é zero porque não
 * houve aposta, não porque o usuário perdeu. Enviar isso seria afirmar que ele
 * apostou e perdeu zero, que é uma leitura ERRADA do número. A regra do card é
 * "sem dados não envia" e ela é a MESMA função que o job e o comando usam.
 */
export function reportHasData(metrics: Pick<ReportMetrics, 'bets'>): boolean {
  return metrics.bets > 0;
}

// ------------------------------------------------------------------ narrativa

/**
 * Uma linha da narrativa. A estrutura é o contrato com a interface: `text` é
 * o que o usuário lê e `fact` é o número que o produziu, para que a página
 * mostre a origem de cada frase.
 *
 * `kind` separa o que é DESCRIÇÃO do número (fato) do que é INTERPRETAÇÃO
 * (heurística). As duas são do produto e nenhuma delas é gerada por modelo.
 */
export const reportNarrativeLineSchema = z.strictObject({
  kind: z.enum(['fact', 'heuristic']),
  text: z.string().min(1).max(300),
  /** Rótulo do número que sustenta a linha; ausente em heurística pura. */
  fact: z.string().max(120).nullable(),
});
export type ReportNarrativeLine = z.infer<typeof reportNarrativeLineSchema>;

export const reportNarrativeSchema = z.object({
  lines: z.array(reportNarrativeLineSchema).max(24),
  /** Amostra pequena: o `N` está abaixo do limiar e a leitura é indicativa. */
  lowSample: z.boolean(),
  minSample: z.number().int().nonnegative(),
});
export type ReportNarrative = z.infer<typeof reportNarrativeSchema>;

/**
 * A narrativa inicial do relatório: números e HEURÍSTICAS do produto, sem IA
 * generativa (card §6.2 e escopo excluído).
 *
 * A função é PURA e TOTALMENTE DETERMINÍSTICA: mesmas entradas, mesmo texto.
 * Isso não é detalhe estético — é o que torna o snapshot auditável (§4.1):
 * dá para recomputar a narrativa de um snapshot guardado e conferir que
 * coincide, porque a função não consultou nada além dos números.
 *
 * As heurísticas são fixas e explicáveis, e cada uma é escrita para não
 * afirmar o que o número não sustenta:
 *
 *  - abaixo do limiar de amostra, a narrativa diz que a amostra é pequena e
 *    NÃO interpreta os percentuais (o `lowSample` da F2-02 já manda mostrar
 *    só números crus);
 *  - ROI sem base (`null`) vira "sem base", nunca 0% — zero e "não há base"
 *    são afirmações diferentes e o produto escolhe a honesta;
 *  - a leitura de concentração (uma casa/um esporte respondendo pela maior
 *    parte do resultado) é descritiva, e diz qual é o número que a produz.
 */
export function buildReportNarrative(input: {
  metrics: ReportMetrics;
  minSample: number;
  periodLabel: string;
  /** Maior massa absoluta do resultado por casa; `null` quando não há casas. */
  topBookmaker: { label: string; profit: string } | null;
  /** Idem por esporte. */
  topSport: { label: string; profit: string } | null;
}): ReportNarrative {
  const { metrics, minSample, periodLabel } = input;
  const lowSample = metrics.bets < minSample;
  const lines: ReportNarrativeLine[] = [];
  const percent = (value: string | null) =>
    value === null ? 'sem base' : `${value.replace('.', ',')}%`;
  const brl = (value: string) => formatReportBRL(value);
  const positive = cents(metrics.profit) > 0n;
  const negative = cents(metrics.profit) < 0n;

  lines.push({
    kind: 'fact',
    text: `${periodLabel}: ${metrics.bets} ${metrics.bets === 1 ? 'aposta' : 'apostas'} · resultado de ${brl(metrics.profit)}.`,
    fact: 'apostas e resultado do período',
  });

  if (lowSample)
    // A F2-02 já decidiu que abaixo do limiar só se mostra número cru. A
    // narrativa acompanha: interpretar 3 apostas como tendência seria
    // inventar uma leitura que o `N` não sustenta.
    lines.push({
      kind: 'heuristic',
      text: `Amostra pequena (${metrics.bets} de ${minSample} apostas): os percentuais abaixo são indicativos e não sustentam conclusão.`,
      fact: `N abaixo de ${minSample}`,
    });

  if (metrics.roiReal !== null)
    lines.push({
      kind: 'fact',
      text: `ROI real ${percent(metrics.roiReal)} sobre principal real encerrado de ${brl(metrics.realPrincipalClosed)}.`,
      fact: 'ROI real',
    });
  else
    lines.push({
      kind: 'fact',
      text: 'ROI real sem base: nenhuma aposta real foi encerrada no período.',
      fact: 'ROI real sem base',
    });

  lines.push({
    kind: 'fact',
    text: `Retornos ${brl(metrics.realReturns)} · exposição aberta ${brl(metrics.exposure)}.`,
    fact: 'retornos e exposição',
  });

  if (metrics.settledBets > 0)
    lines.push({
      kind: 'fact',
      text: `${metrics.settledBets} ${metrics.settledBets === 1 ? 'aposta liquidada' : 'apostas liquidadas'} · ${metrics.openBets} ${metrics.openBets === 1 ? 'ainda aberta' : 'ainda abertas'}.`,
      fact: 'apostas liquidadas e abertas',
    });

  if (metrics.hitRateReal !== null)
    lines.push({
      kind: 'fact',
      text: `Taxa de acerto real ${percent(metrics.hitRateReal)} (${metrics.hitWinsReal} de ${metrics.hitEligibleReal} elegíveis, sem anulações).`,
      fact: 'taxa de acerto real',
    });

  if (input.topBookmaker && !lowSample) {
    const share = shareOf(metrics.profit, input.topBookmaker.profit);
    lines.push({
      kind: 'heuristic',
      text: `${input.topBookmaker.label} concentra ${share === null ? 'parte relevante' : share} do resultado do período.`,
      fact: `resultado por casa: ${input.topBookmaker.label} = ${brl(input.topBookmaker.profit)}`,
    });
  }

  if (input.topSport && !lowSample) {
    // O esporte repete o número em vez da participação: com duas dimensões
    // concentrando o resultado, dizer "X% e Y% do resultado" somaria mais que
    // 100% e ensinaria errado. A casa mostra a participação (é a concentração
    // que interessa); o esporte mostra o próprio valor.
    lines.push({
      kind: 'heuristic',
      text: `No esporte ${input.topSport.label} o resultado foi ${brl(input.topSport.profit)}.`,
      fact: `resultado por esporte: ${input.topSport.label} = ${brl(input.topSport.profit)}`,
    });
  }

  if (positive && !lowSample)
    lines.push({
      kind: 'heuristic',
      text: 'O período fechou positivo; confira a concentração acima antes de repetir a mesma exposição.',
      fact: 'resultado do período',
    });
  if (negative && !lowSample)
    lines.push({
      kind: 'heuristic',
      text: 'O período fechou negativo; o relatório não recomenda nada — ele apenas mostra o que foi registrado.',
      fact: 'resultado do período',
    });

  return reportNarrativeSchema.parse({ lines, lowSample, minSample });
}

/**
 * Participação de uma parcela no total, em texto, ou `null` quando não dá para
 * calcular (total zero: a divisão por zero não tem leitura honesta).
 */
function shareOf(total: string, part: string): string | null {
  const whole = cents(total);
  if (whole === 0n) return null;
  // Centavos absolutos, porque um resultado negativo e uma parcela positiva
  // dariam uma "participação" negativa que ninguém entende. A participação
  // aqui é MAGNITUDE: quanto da variação total vem daquela dimensão.
  const magnitude = (value: bigint) => (value < 0n ? -value : value);
  const ratio = (magnitude(cents(part)) * 100n) / magnitude(whole);
  return `${ratio.toString()}% do resultado`;
}

/** Rótulo humano da cadência, para a mensagem do Telegram e o título da página. */
export const REPORT_PERIOD_LABEL: Readonly<Record<ReportPeriod, string>> = {
  daily: 'Diário',
  weekly: 'Semanal',
  monthly: 'Mensal',
};

/** Título da página HTML do snapshot, derivado da janela (não do instante). */
export function reportPeriodTitle(period: ReportPeriod, from: string, to: string): string {
  const label = REPORT_PERIOD_LABEL[period];
  return from === to
    ? `${label} — ${formatDateBR(from)}`
    : `${label} — ${formatDateBR(from)} a ${formatDateBR(to)}`;
}

/** Data ISO em formato brasileiro; a entrada nunca sai da interface. */
export function formatDateBR(value: string): string {
  const [year = '', month = '', day = ''] = value.split('-');
  if (!year || !month || !day) throw new Error('INVALID_REPORT_DATE');
  return `${day}/${month}/${year}`;
}

/**
 * O resumo que o Telegram envia: NÚMEROS e um link, nunca o relatório inteiro.
 *
 * O canal de Telegram é onde o conteúdo financeiro do usuário mais se
 * espalharia (print, encaminhamento, backup do celular). A mensagem carrega o
 * RESUMO — as mesmas linhas do `/hoje` da F2-07 — e aponta para a página
 * privada. Ela nunca inclui o corpo do relatório, arquivo, PDF ou URL pública
 * temporária: o link é o endereço do produto e exige login.
 */
export function reportTelegramSummary(input: {
  period: ReportPeriod;
  from: string;
  to: string;
  metrics: ReportMetrics;
  minSample: number;
  link: string;
}): string {
  const { metrics } = input;
  const brl = (value: string) => formatReportBRL(value);
  const percent = (value: string | null) =>
    value === null ? 'sem base' : `${value.replace('.', ',')}%`;
  const low = metrics.bets < input.minSample;
  const title = REPORT_PERIOD_LABEL[input.period];
  return [
    `📊 RELATÓRIO ${title.toLocaleUpperCase('pt-BR')}`,
    `📅 ${formatDateBR(input.from)}${input.from === input.to ? '' : ` a ${formatDateBR(input.to)}`}`,
    '',
    `🎲 Apostas: ${metrics.bets}${low ? ` (amostra pequena; mínimo ${input.minSample})` : ''}`,
    `💰 Resultado: ${brl(metrics.profit)}`,
    `📉 ROI: ${percent(metrics.roiReal)}`,
    `🎯 Yield: ${percent(metrics.yieldReal)}`,
    '',
    'Relatório completo na sua conta (exige login):',
    input.link,
  ].join('\n');
}

/**
 * O link PRIVADO do relatório. É o endereço do produto + a rota da página, e
 * nada mais: sem token, sem identificador de snapshot, sem parâmetro de
 * sessão. Quem abrir precisa estar autenticado como o dono — o acesso é
 * conferido no servidor a cada leitura, e o endereço não carrega prova nenhuma.
 */
export function reportPrivateLink(baseUrl: string, route: string = 'relatorios'): string {
  const base = baseUrl.replace(/#.*$/, '').replace(/\/+$/, '');
  // O caminho nunca é lido do ambiente como HTML: é um literal do produto, e
  // um `route` com barra ou ponto Letra-número hackearia o caminho.
  if (!/^[a-z][a-z0-9-]{0,40}$/.test(route)) throw new Error('INVALID_REPORT_ROUTE');
  return `${base}/#${route}`;
}
