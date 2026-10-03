import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { reportSchema, saoPauloDate, formatReportBRL } from '@stakeframe/shared';
import { request } from './api.js';
import { Button } from '../components/ui/button.js';
import { readChartTokens } from './chart-tokens.js';
import { axisTick, chartHasSample, lowChartSampleMessage, resultDomain } from './chart-domain.js';

/**
 * STK-F2-18 (Fase 4) — resultado realizado do mês na Visão geral.
 *
 * Três decisões que o layout antigo não tinha e o produto exige:
 *
 * 1. **Toda cifra tem período.** A tela é o ponto de entrada e as três
 *    families de dinheiro — saldo, exposição, lucro — precisam ser lidas como
 *    números DIFERENTES. Saldo e exposição são posição; lucro é resultado.
 *    Uma carteira de apostas que mostra os três com a mesma tratamento
 *    visual é uma tela que convida a somar coisas que não se somam.
 * 2. **Evolução preenchida, não contorno.** A área é preenchida porque o
 *    que importa é o ACÚMULO — a distância entre zero e a linha é o
 *    resultado. `sparse` (poucos dias observados) cai para linha: preencher
 *    uma área com 3 pontos fabrica uma forma que não existe.
 * 3. **Uma fonte de dado.** Esta tela, a do painel e a de Análises leem o
 *    mesmo endpoint com o mesmo recorte. Duas telas que contam histórias
 *    diferentes sobre o mesmo número é a classe de defeito mais cara num
 *    produto de contabilidade.
 */
export function OverviewReport({ version }: { version: number }) {
  const today = saoPauloDate(new Date());
  const month = today.slice(0, 7);
  const query = useQuery({
    queryKey: ['product', 'overview-report', month, version],
    queryFn: () => request(`/api/v1/reports?from=${month}-01&to=${today}`, reportSchema),
  });
  const chart = readChartTokens();
  // Acumulado em CENTAVOS (BigInt) e só convertido no fim: somar `Number`
  // ponto flutuante em dinheiro é o defeito que o resto do produto evita.
  const series = useMemo(() => {
    if (!query.data) return [];
    let running = 0n;
    return query.data.timeline.map((bucket) => {
      running +=
        BigInt(bucket.metrics.profit.replace('.', '').replace('-', '')) *
        (bucket.metrics.profit.startsWith('-') ? -1n : 1n);
      return {
        date: bucket.date,
        accumulated: Number(running) / 100,
        period: Number(bucket.metrics.profit),
        bets: bucket.metrics.bets,
      };
    });
  }, [query.data]);
  const observed = series.filter((row) => row.bets > 0);
  /* STK-F3-03 — o PISO DE AMOSTRA manda neste gráfico, e ele não é
     negociável. Abaixo do piso o produto NÃO desenha e diz por quê: um
     gráfico com 1 ou 2 pontos é uma forma interpolada a partir de nada, e a
     biblioteca desenha isso com a mesma confiança com que desenha 30 pontos
     reais. Números crus no lugar do desenho é a resposta honesta. */
  const drawable = chartHasSample(observed.length);
  /* A escala inclui o zero quando a série é negativa — ver `resultDomain`.
     Aplicar o mínimo automático aqui inverteria o sinal do resultado, que é
     o defeito mais caro que um gráfico de dinheiro pode ter. */
  const domain = resultDomain(series.map((row) => row.accumulated));

  return (
    <div className="panel">
      <div className="section-heading">
        <div>
          <h2>Resultado realizado do mês</h2>
          <p>
            01/{month.slice(5)} a {today.split('-').reverse().join('/')} · por data de evento ·{' '}
            atualizado pela última aposta liquidada
          </p>
        </div>
        <a className="text-link" href="#analytics">
          Ver análises
        </a>
      </div>
      {query.isError ? (
        <p role="alert">
          Não foi possível carregar o resultado.{' '}
          <Button variant="ghost" onClick={() => void query.refetch()}>
            Tentar novamente
          </Button>
        </p>
      ) : !query.data ? (
        <p role="status">Calculando resultado…</p>
      ) : (
        <>
          <div className="metric-grid report-metrics">
            <Metric
              label="Resultado realizado"
              value={formatReportBRL(query.data.metrics.profit)}
              detail={`${query.data.metrics.settledBets} liquidadas · ${query.data.metrics.openBets} em aberto`}
              tone={signTone(query.data.metrics.profit)}
              featured
            />
            <Metric
              label="Dinheiro real"
              value={formatReportBRL(query.data.metrics.realProfit)}
              detail={`Freebets: ${formatReportBRL(query.data.metrics.freebetProfit)}`}
              tone={signTone(query.data.metrics.realProfit)}
            />
            <Metric
              label="Freebets"
              value={formatReportBRL(query.data.metrics.freebetProfit)}
              detail={`${formatReportBRL(query.data.metrics.freebetStake)} em crédito promocional`}
              tone={signTone(query.data.metrics.freebetProfit)}
            />
            <Metric
              label="Unidades do mês"
              value={
                query.data.metrics.profitUnits === null
                  ? 'A conferir'
                  : unitsLabel(query.data.metrics.profitUnits)
              }
              detail={
                query.data.metrics.missingUnitBets > 0
                  ? `${query.data.metrics.missingUnitBets} aposta(s) sem unidade aplicável`
                  : 'Unidade congelada durante o mês'
              }
            />
          </div>
          {drawable ? (
            <div
              className="report-chart"
              role="img"
              aria-label={`Resultado acumulado do mês. Fecha em ${formatReportBRL(query.data.metrics.profit)} em ${query.data.metrics.settledBets} apostas liquidadas. Valores exatos no painel abaixo.`}
            >
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={series} margin={{ left: 12, right: 12, top: 12, bottom: 8 }}>
                  <defs>
                    {/* O degradê é alfa do token de sinal, não uma cor nova.
                        0,34 no topo e 0,02 na base é o que dá à área o peso de
                        "volume acumulado" sem competir com a linha, que é o
                        dado. */}
                    <linearGradient id="overview-accumulated" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={chart['--pos']} stopOpacity={0.34} />
                      <stop offset="100%" stopColor={chart['--pos']} stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  {/* Grade só HORIZONTAL e tracejada: a vertical seria uma
                      parede atrás de cada dia, e a horizontal é a régua que
                      permite ler a altura contra um valor. */}
                  <CartesianGrid
                    stroke={chart['--border']}
                    strokeDasharray="3 3"
                    vertical={false}
                  />
                  <XAxis
                    dataKey="date"
                    minTickGap={45}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(date: string) => date.split('-').reverse().join('/')}
                    stroke={chart['--text-tertiary']}
                    tick={{ fill: chart['--text-tertiary'], fontSize: 12 }}
                  />
                  {/* `domain` inclui o zero quando a série é negativa. Sem `domain`
                      explícito o Recharts escolhe o mínimo pelos dados, e uma
                      série toda negativa sai desenhada como se subisse. */}
                  <YAxis
                    stroke={chart['--text-tertiary']}
                    width={72}
                    domain={domain}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={axisTick}
                    tick={{ fill: chart['--text-tertiary'], fontSize: 12 }}
                  />
                  <ReferenceLine y={0} stroke={chart['--border-strong']} />
                  <Tooltip
                    cursor={{ stroke: chart['--border-strong'] }}
                    content={({ active, payload }) =>
                      active && payload?.[0] ? (
                        <div className="report-tooltip">
                          {String(payload[0].payload.date).split('-').reverse().join('/')}
                          <br />
                          No dia: {formatReportBRL(String(payload[0].payload.period))}
                          <br />
                          Acumulado: {formatReportBRL(String(payload[0].payload.accumulated))}
                        </div>
                      ) : null
                    }
                  />
                  {/* Legenda embaixo, com a cor e o rótulo da série: o leitor
                      não precisa adivinhar a qual linha a área pertence. */}
                  <Legend
                    verticalAlign="bottom"
                    height={24}
                    iconType="plainline"
                    wrapperStyle={{ color: chart['--text-secondary'] }}
                  />
                  <Area
                    type="monotone"
                    dataKey="accumulated"
                    name="Resultado acumulado"
                    stroke={chart['--pos']}
                    strokeWidth={2}
                    fill="url(#overview-accumulated)"
                    dot={false}
                    activeDot={{ r: 3 }}
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <p className="panel-footnote">
              {observed.length === 0
                ? 'Nenhuma aposta com data de evento elegível neste mês.'
                : lowChartSampleMessage(observed.length)}
            </p>
          )}
          {query.data.exclusions.unknownDateBets + query.data.exclusions.estimatedDateBets > 0 ? (
            <p className="pending-label">
              {query.data.exclusions.unknownDateBets} apostas com datas incompletas em todos os
              períodos; {query.data.exclusions.estimatedDateBets} com datas estimadas no mês.{' '}
              <a className="text-link" href="#calendar">
                Conferir datas
              </a>
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  detail,
  tone = 'neutral',
  featured = false,
}: {
  label: string;
  value: string;
  detail: string;
  tone?: 'neutral' | 'positive' | 'negative';
  featured?: boolean;
}) {
  return (
    <div className={`metric-card metric-tone-${tone}${featured ? ' featured' : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

/**
 * O sinal de resultado é lido do PRÓPRIO VALOR, nunca de um campo paralelo.
 * Um `tone` vindo do servidor aceitaria 'positive' com valor negativo; aqui os
 * dois não podem divergir porque há uma única fonte.
 */
export function signTone(value: string): 'neutral' | 'positive' | 'negative' {
  if (value.startsWith('-')) return 'negative';
  return Number(value) === 0 ? 'neutral' : 'positive';
}

export function unitsLabel(value: string): string {
  return `${value.replace(/0+$/, '').replace(/\.$/, '').replace('.', ',')} un`;
}
