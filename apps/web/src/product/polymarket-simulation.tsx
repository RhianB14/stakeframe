import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  POLYMARKET_CATEGORY_LABELS,
  POLYMARKET_ORDER_LABELS,
  POLYMARKET_PERIOD_LABELS,
  polymarketSimulationSchema,
  simulationInputSchema,
  type PolymarketRankingQuery,
  type PolymarketSimulation,
} from '@stakeframe/shared';
import { Button } from '../components/ui/button.js';
import { Field } from './forms.js';
import { request } from './api.js';
import { simulationView } from './simulation-view.js';

/**
 * STK-F2-17 — a simulação MERAMENTE INDICATIVA, dentro da tela do ranking.
 *
 * A tela tem uma ordem de leitura FIXA e ela é o card inteiro:
 *
 *  1. A NATUREZA da saída, antes de qualquer campo e de qualquer número.
 *  2. A RECUSA, quando existe — com o motivo e com O QUE FAZER. Uma recusa sem
 *     remédio é uma parede; o card pede recusa, não bloqueio mudo.
 *  3. AS SETE PREMISSAS, sempre, nos dois desfechos. Elas vêm ANTES do número
 *     porque um número lido sem a ressalva que o limita já foi mal interpretado.
 *  4. O NÚMERO, e só quando apurado.
 *  5. OS AVISOS de jogo responsável (§4.9), sempre.
 *
 * NÃO HÁ BOTÃO DE APOSTAR, NEM DE ENVIAR ORDEM, NEM DE "APLICAR", e a ausência
 * é estrutural: o componente não tem nenhuma ação que saia da apuração. O
 * schema da resposta declara `executable: false` e `executed: false` como
 * literais, então nem o servidor poderia declarar o contrário.
 *
 * A stake é FIXA e é o usuário que a escolhe. A tela não sugere valor, não
 * dimensiona a banca e não compara stakes: dimensionar seria recomendação, e
 * recomendação está no escopo excluído (§9.5).
 *
 * A JANELA É A DO RANKING, e a simulação não repete os três filtros.
 *
 * A tela do ranking já tem "Período", "Categoria" e "Ordenação" no topo, e
 * duplicá-los aqui produziria DOIS `getByLabel('Período')` na mesma página —
 * o que quebraria o leitor de tela (dois controles com o mesmo nome acessível
 * não são distinguíveis) e tornaria ambíguo para o usuário qual janela a
 * simulação está usando. A simulação recebe a janela como PROP e mostra qual
 * ela é, em texto, logo acima do botão: uma seção que age sobre outra seção
 * precisa DIZER sobre o que ela age, e o filtro único é a forma de garantir
 * que as duas nunca discordem.
 *
 * As fricções (taxa, spread, slippage) e o atraso aparecem como CAMPOS
 * configuráveis e com o rótulo de origem "Escolhido por você", porque é isso
 * que eles são. Um campo de premissa rotulado como medida seria a primeira
 * versão de uma mentira, e a segunda seria o número destacado embaixo dele.
 */
export function PolymarketSimulationSection({ window }: { window: PolymarketRankingQuery }) {
  const [stake, setStake] = useState('10.00');
  const [delayMs, setDelayMs] = useState('1500');
  const [feeRate, setFeeRate] = useState('0.02');
  const [spreadRate, setSpreadRate] = useState('0.01');
  const [slippageRate, setSlippageRate] = useState('0.005');

  const run = useMutation({
    mutationFn: async () => {
      // A entrada é VALIDADA pelo mesmo schema do servidor antes de sair. A
      // validação no cliente não é redundância: ela evita gravar uma tentativa
      // que o banco recusaria, e a recusa do cliente tem a mesma forma da
      // recusa do motor.
      const input = simulationInputSchema.parse({
        window: {
          category: window.category,
          timePeriod: window.timePeriod,
          orderBy: window.orderBy,
        },
        stake,
        delayMs: Number(delayMs),
        feeRate,
        spreadRate,
        slippageRate,
      });
      return request('/api/v1/polymarket/simulation', polymarketSimulationSchema, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
    },
  });

  return (
    <section className="panel" aria-labelledby="simulacao-indicativa">
      <div className="section-heading">
        <div>
          <h3 id="simulacao-indicativa">Simulação indicativa</h3>
          <p>
            Aplicação de uma stake fixa às posições que a Polymarket já publicou, com todas as
            premissas à vista. É aritmética sobre dado público: não executa, não promete retorno e
            não indica entrada nem saída.
          </p>
        </div>
        <span className="live-label">Meramente indicativa</span>
      </div>

      {/* A JANELA, em TEXTO. Ela vem do filtro do ranking no topo da tela e
          não é repetida aqui: dois `select` com o rótulo "Período" na mesma
          página são indistinguíveis para um leitor de tela, e a ambiguidade
          sobre "qual janela a simulação está usando" é exatamente o tipo de
          dúvida que o card não pode criar. */}
      <p className="muted" data-testid="janela-da-simulacao">
        Janela: {POLYMARKET_CATEGORY_LABELS[window.category]} ·{' '}
        {POLYMARKET_PERIOD_LABELS[window.timePeriod]} · {POLYMARKET_ORDER_LABELS[window.orderBy]} (a
        mesma do ranking acima).
      </p>

      <div className="filter-grid">
        <Field label="Stake fixa por observação (US$)">
          <input value={stake} onChange={(event) => setStake(event.target.value)} />
        </Field>
      </div>

      <fieldset className="notice" style={{ border: '1px solid #23262e' }}>
        <legend>Premissas de fricção (escolhidas por você)</legend>
        <div className="filter-grid">
          <Field label="Atraso assumido (ms)">
            <input value={delayMs} onChange={(event) => setDelayMs(event.target.value)} />
          </Field>
          <Field label="Taxa">
            <input value={feeRate} onChange={(event) => setFeeRate(event.target.value)} />
          </Field>
          <Field label="Spread">
            <input value={spreadRate} onChange={(event) => setSpreadRate(event.target.value)} />
          </Field>
          <Field label="Slippage">
            <input value={slippageRate} onChange={(event) => setSlippageRate(event.target.value)} />
          </Field>
        </div>
        <p className="muted">
          Estas quatro são suposições suas, não medidas da Polymarket. A taxa de dados ausentes e a
          cobertura da janela são medidas pela coleta e aparecem sempre no resultado.
        </p>
      </fieldset>

      <Button
        onClick={() => run.mutate()}
        disabled={run.isPending}
        aria-label="Apurar simulação indicativa"
      >
        {run.isPending ? 'Apurando…' : 'Apurar simulação indicativa'}
      </Button>

      {run.isError ? (
        <div className="notice warning" role="alert">
          Não foi possível apurar a simulação. Confira a stake e as premissas informadas.
        </div>
      ) : null}

      {run.data ? <SimulationResult simulation={run.data} /> : null}
    </section>
  );
}

/**
 * O resultado, na ordem de leitura do card.
 *
 * A natureza indicativa é a PRIMEIRA coisa renderizada e ela é um `role="note"`
 * com a etiqueta em caixa alta: é a informação que muda a leitura de todo o
 * resto da tela, e nada pode vir antes dela.
 */
function SimulationResult({ simulation }: { simulation: PolymarketSimulation }) {
  const view = simulationView(simulation);
  return (
    <div data-testid="simulacao-resultado">
      <div className="notice" role="note" aria-label="Natureza da simulação">
        <strong>{view.natureLabel}</strong>
        <p>{view.nature}</p>
      </div>

      {/* A COBERTURA, e ela é o status GRAVADO pela coleta. */}
      <p className="muted">
        <strong>{view.coverageLabel}.</strong> {view.coverageDetail}
      </p>
      <p className="muted">{view.sample}</p>

      {/* A RECUSA, com o motivo e o remédio, e SEM número. */}
      {view.refusal ? (
        <div className="notice warning" role="status">
          <strong>{view.refusal.label}.</strong>
          <p>{view.refusal.reason}</p>
          <p>
            <strong>Para desbloquear:</strong> {view.refusal.remedy}
          </p>
        </div>
      ) : null}

      {/* AS SETE PREMISSAS, sempre — inclusive quando recusada. Uma recusa sem
          premissas esconderia justamente o que o usuário precisa ler para
          entender por que a recusa aconteceu. */}
      <h4>Premissas desta apuração</h4>
      <dl className="bet-detail-list">
        {view.premises.map((premise) => (
          <div key={premise.key} data-testid={`premissa-${premise.key}`}>
            <dt>
              {premise.label} <span className="muted">· {premise.origin}</span>
            </dt>
            {/* O `tabular` fica no VALOR, e não no `dd` inteiro. A classe
                traz `white-space: nowrap`, e aplicá-la ao bloco que contém a
                nota de texto transformaria a nota numa linha só — 1246px de
                largura numa coluna de 1040px, e a página inteira passaria a
                rolar na horizontal. As casas decimais continuam alinhadas
                porque é o número que tem a classe. */}
            <dd>
              <span className="tabular">{premise.value}</span>
              <p className="muted">{premise.note}</p>
            </dd>
          </div>
        ))}
      </dl>

      {/* O NÚMERO, só quando apurado. */}
      {view.indicative ? (
        <>
          <h4>Número indicativo</h4>
          <div className="table-scroll" role="region" aria-label="Número indicativo" tabIndex={0}>
            <table className="product-table">
              <caption className="sr-only">
                Número indicativo apurado, com cada premissa descontada separadamente
              </caption>
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Valor</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Stake fixa por observação</td>
                  <td className="tabular">{view.indicative.stake}</td>
                </tr>
                <tr>
                  <td>Observações usadas</td>
                  <td className="tabular">{view.indicative.observations}</td>
                </tr>
                <tr>
                  <td>Razão publicada (P&amp;L / volume)</td>
                  <td className="tabular">{view.indicative.ratio}</td>
                </tr>
                <tr>
                  <td>Bruto antes das premissas</td>
                  <td className="tabular">{view.indicative.gross}</td>
                </tr>
                <tr>
                  <td>(−) taxa</td>
                  <td className="tabular">{view.indicative.fee}</td>
                </tr>
                <tr>
                  <td>(−) spread</td>
                  <td className="tabular">{view.indicative.spread}</td>
                </tr>
                <tr>
                  <td>(−) slippage</td>
                  <td className="tabular">{view.indicative.slippage}</td>
                </tr>
                <tr>
                  <td>(−) fricção total</td>
                  <td className="tabular">{view.indicative.friction}</td>
                </tr>
                <tr>
                  <td>Líquido após as premissas</td>
                  <td className={`tabular ${view.indicative.negative ? 'negative' : ''}`}>
                    {view.indicative.net}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="muted">
            Faixa de incerteza por dados ausentes: {view.indicative.band}.{' '}
            {view.indicative.bandNote}
          </p>
        </>
      ) : (
        <div className="empty-state">
          <span aria-hidden="true">∅</span>
          <h3>{view.emptyTitle}</h3>
          <p>{view.emptyDetail}</p>
        </div>
      )}

      {/* OS AVISOS de jogo responsável (§4.9), sempre. */}
      <h4>Avisos</h4>
      <ul className="muted" data-testid="avisos-jogo-responsavel">
        {view.disclaimers.map((disclaimer) => (
          <li key={disclaimer}>{disclaimer}</li>
        ))}
      </ul>
      <p className="panel-footnote">{view.footnote}</p>
    </div>
  );
}

/**
 * STK-F3-01 — a simulação como DESTINO (`#pm-simulation`).
 *
 * Um ENVOLTÓRIO da MESMA `PolymarketSimulationSection` que o ranking
 * renderiza — nenhuma regra foi reescrita, nenhuma premissa mudou, e o
 * aviso de jogo responsável continua aparecendo nos dois desfechos.
 *
 * A diferença é a JANELA, e ela é consequência de a tela ter saído de baixo
 * do ranking: como não existe mais um `select` de período logo acima para
 * herdar, a simulação recebe a janela padrão do produto. Repetir os três
 * filtros aqui devolveria dois controles com o mesmo rótulo acessível na
 * mesma tela — que é indistinguível para um leitor de tela — e a tela
 * mostraria em texto qual janela está usando, como já fazia.
 */
export function PolymarketSimulationPage({ window }: { window: PolymarketRankingQuery }) {
  return <PolymarketSimulationSection window={window} />;
}
