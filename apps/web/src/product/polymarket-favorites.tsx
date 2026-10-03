import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  POLYMARKET_FAVORITES_LIMIT,
  polymarketAlertConfigInputSchema,
  polymarketAlertConfigSchema,
  polymarketFavoriteCreatedSchema,
  polymarketFavoriteRemovedSchema,
  polymarketFavoritesResponseSchema,
  type PolymarketAlertConfig,
  type PolymarketFavorite,
} from '@stakeframe/shared';
import { Button } from '../components/ui/button.js';
import { Field } from './forms.js';
import { ApiFailure, request } from './api.js';
import { alertFieldLabels, favoritesView } from './favorites-view.js';

/**
 * STK-F2-16 — a tela de favoritos e do alerta de atividade Polymarket.
 *
 * A tela tem três jobs e nenhum quarto:
 *
 *  1) MOSTRAR O QUE O USUÁRIO ESCOLHEU. A lista de favoritos com a carteira
 *     pública de cada um e o uso do teto ("3 de 10"), sem ordem de desempenho,
 *     sem comparação e sem número derivado.
 *
 *  2) DEIXAR O LIMITE VISÍVEL. O teto não é um detalhe de rodapé: quando os dez
 *     favoritos estão ocupados, a tela diz que o excedente é recusado e que é
 *     preciso remover um. Não existe botão de "carregar mais" — o card pede
 *     teto, e teto com paginação seria outro produto.
 *
 *  3) SEPARAR FAVORITAR DE ATIVAR ALERTA. O interruptor do alerta é uma seção
 *     própria, com o próprio estado gravado, e a tela escreve o que ele faz
 *     (ou deixa de fazer). Um usuário que favorita e não liga nada é um estado
 *     legítimo e visível.
 *
 * O que esta tela NÃO faz, e a ausência é estrutural: não há Composite Score,
 * badge, selo, recomendação, leitura ou qualquer métrica derivada. Nem o
 * schema da resposta nem a view têm campo para isso, e o teste §15 varre o DOM
 * em busca dos termos.
 */

/**
 * O botão de favoritar de uma linha do ranking.
 *
 * O botão fica na LINHA da tabela — a carteira que o usuário está olhando é a
 * carteira que ele pode favoritar, e pedir para colar a carteira em outro
 * formulário seria um atrito sem motivo. Quando o teto de dez já foi atingido,
 * o botão fica DESABILITADO em vez de sumir: um botão que aparece e desaparece
 * conforme o estado obriga o usuário a descobrir a regra sozinho.
 */
export function FavoriteButton({ proxyWallet }: { proxyWallet: string }) {
  const client = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const favorites = useQuery({
    queryKey: ['polymarket', 'favorites'],
    queryFn: () => request('/api/v1/polymarket/favorites', polymarketFavoritesResponseSchema),
  });
  const add = useMutation({
    mutationFn: () =>
      request('/api/v1/polymarket/favorites', polymarketFavoriteCreatedSchema, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ proxyWallet }),
      }),
    onSuccess: () => {
      setError(null);
      void client.invalidateQueries({ queryKey: ['polymarket', 'favorites'] });
    },
    onError: (cause) =>
      setError(
        cause instanceof ApiFailure && cause.code === 'FAVORITES_LIMIT_REACHED'
          ? 'Limite de dez favoritos atingido. Remova um favorito para adicionar outro.'
          : 'Não foi possível favoritar o trader.',
      ),
  });
  const isFavorite = favorites.data?.favorites.some((item) => item.proxyWallet === proxyWallet);
  const atLimit = favorites.data ? favorites.data.used >= POLYMARKET_FAVORITES_LIMIT : false;
  if (isFavorite) return <span className="muted">Favorito</span>;
  return (
    <>
      <Button
        variant="secondary"
        disabled={add.isPending || atLimit}
        onClick={() => add.mutate()}
        aria-label={`Favoritar ${proxyWallet}`}
      >
        Favoritar
      </Button>
      {error ? (
        <span className="muted" role="alert">
          {error}
        </span>
      ) : null}
    </>
  );
}

/**
 * A seção de favoritos e de configuração do alerta.
 *
 * STK-F3-01 mudou a FORMA, não o conteúdo: esta seção deixou de viver
 * exclusivamente dentro da tela de ranking e ganhou endereço próprio
 * (`#pm-favorites`), virando destino de primeira classe na navegação. O
 * argumento original — "a geometria da barra inferior é literal e um
 * destino a mais a quebraria" — continua VALENDO, e é exatamente por isso
 * que a asserção de contagem de colunas foi atualizada com a
 * justificativa escrita, em vez de relaxada.
 *
 * A tela em si NÃO foi reescrita: ela é a mesma, com o mesmo teto de dez, o
 * mesmo aviso de recusar o excedente e a mesma separação entre favoritar e
 * ligar alerta. Por isso a página abaixo é um ENVOLTÓRIO, não uma segunda
 * implementação — duas telas de favoritos divergiriam na primeira mudança
 * de regra.
 */
export function PolymarketFavoritesSection() {
  const client = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['polymarket', 'favorites'],
    queryFn: () => request('/api/v1/polymarket/favorites', polymarketFavoritesResponseSchema),
  });

  const remove = useMutation({
    mutationFn: (proxyWallet: string) =>
      request(`/api/v1/polymarket/favorites/${proxyWallet}`, polymarketFavoriteRemovedSchema, {
        method: 'DELETE',
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['polymarket', 'favorites'] }),
    onError: () => setError('Não foi possível remover o favorito.'),
  });

  const data = query.data;
  const view = data
    ? favoritesView({
        favorites: data.favorites as PolymarketFavorite[],
        limit: data.limit,
        config: {
          enabled: data.alertEnabled,
          threshold: data.alertThreshold,
          dailyLimit: data.alertDailyLimit,
          windowMinutes: data.alertWindowMinutes,
        },
        // O fuso vem da preferência de notificação do usuário, que é a mesma
        // que o job avalia; a tela exibe o padrão do produto e o texto do
        // alerta explica que o silêncio é avaliado no fuso dele.
        timezone: 'seu fuso',
      })
    : null;

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <h2>Favoritos do ranking Polymarket</h2>
          <p>
            Guarde até {POLYMARKET_FAVORITES_LIMIT} traders do leaderboard público. Favoritar não
            liga alerta: a ativação é separada, abaixo.
          </p>
        </div>
        {data ? <span className="live-label">{view?.usage}</span> : null}
      </div>
      {query.isPending ? (
        <p className="loading-note" role="status">
          Carregando os favoritos…
        </p>
      ) : null}
      {query.isError ? (
        <div className="notice warning" role="alert">
          Não foi possível carregar os favoritos.
          <Button variant="secondary" onClick={() => void query.refetch()}>
            Tentar novamente
          </Button>
        </div>
      ) : null}
      {error ? (
        <div className="notice warning" role="alert">
          {error}
        </div>
      ) : null}
      {view?.limitNotice ? (
        <div className="notice warning" role="status">
          {view.limitNotice}
        </div>
      ) : null}
      {view ? (
        <p className="panel-footnote">
          {view.usage}. O limite é de {POLYMARKET_FAVORITES_LIMIT} favoritos por conta e o excedente
          é recusado, com aviso para remover um antes de adicionar outro.
        </p>
      ) : null}
      {view ? (
        view.rows.length === 0 ? (
          <div className="empty-state">
            <span aria-hidden="true">★</span>
            <h3>{view.emptyTitle}</h3>
            <p>{view.emptyDetail}</p>
          </div>
        ) : (
          <div
            className="table-scroll"
            role="region"
            aria-label="Favoritos do ranking Polymarket"
            tabIndex={0}
          >
            <table className="product-table">
              <caption className="sr-only">
                Traders favoritos e a carteira pública de cada um
              </caption>
              <thead>
                <tr>
                  <th>Trader</th>
                  <th>Carteira pública</th>
                  <th>Favoritado em</th>
                  <th>Ação</th>
                </tr>
              </thead>
              <tbody>
                {view.rows.map((row) => (
                  <tr key={row.key}>
                    <td>
                      <strong>{row.trader}</strong>
                    </td>
                    <td className="tabular">
                      <code className="bet-id-compact">{row.wallet}</code>
                    </td>
                    <td className="tabular">{row.favoritedAt.slice(0, 19).replace('T', ' ')}</td>
                    <td>
                      <Button
                        variant="secondary"
                        onClick={() => remove.mutate(row.wallet)}
                        aria-label={`Remover ${row.trader} dos favoritos`}
                      >
                        Remover
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : null}
      {view ? (
        <AlertConfigPanel
          rule={view.alertRule}
          initial={{
            enabled: data!.alertEnabled,
            threshold: data!.alertThreshold,
            dailyLimit: data!.alertDailyLimit,
          }}
        />
      ) : null}
    </section>
  );
}

/**
 * A configuração do alerta, gravada em UMA chamada.
 *
 * O formulário tem estado PRÓPRIO e salva ativação, limiar e cota juntos
 * (`PUT`), em vez de um interruptor que dispara uma chamada só. Isso é
 * deliberado: os três formam UMA decisão, e salvá-los separados produziria um
 * estado intermediário em que o alerta está ligado com o limiar antigo — que é
 * a pior forma de um alerta do usuário.
 */
function AlertConfigPanel({
  rule,
  initial,
}: {
  rule: string;
  initial: { enabled: boolean; threshold: string; dailyLimit: number };
}) {
  const client = useQueryClient();
  // Os valores iniciais são os GRAVADOS: um formulário que abre com o padrão do
  // produto em vez da configuração do usuário faria ele salvar por cima do que
  // tinha, sem nunca ter visto o valor. A chave de estado é o próprio usuário
  // do servidor, e o `useEffect` só sincroniza quando ele muda.
  const [enabled, setEnabled] = useState<boolean>(initial.enabled);
  const [threshold, setThreshold] = useState<string>(initial.threshold);
  const [dailyLimit, setDailyLimit] = useState<number>(initial.dailyLimit);
  const [saved, setSaved] = useState(false);
  const loaded = useRef(`${initial.enabled}|${initial.threshold}|${initial.dailyLimit}`);
  useEffect(() => {
    const current = `${initial.enabled}|${initial.threshold}|${initial.dailyLimit}`;
    // Só reescreve o formulário quando o SERVIDOR devolveu outra configuração
    // (o `refetch` após salvar), nunca em cada render.
    if (loaded.current === current) return;
    loaded.current = current;
    setEnabled(initial.enabled);
    setThreshold(initial.threshold);
    setDailyLimit(initial.dailyLimit);
  }, [initial.enabled, initial.threshold, initial.dailyLimit]);

  const save = useMutation({
    mutationFn: () => {
      // O corpo é validado pelo MESMO schema do servidor antes de sair: um
      // limiar malformado seria recusado com 400 de qualquer forma, e a tela
      // pode dizer o motivo sem gastar a ida.
      const parsed = polymarketAlertConfigInputSchema.safeParse({
        enabled,
        threshold: threshold.trim(),
        dailyLimit,
      });
      if (!parsed.success) throw new Error('ALERT_CONFIG_INVALID');
      return request('/api/v1/polymarket/alerts/config', polymarketAlertConfigSchema, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(parsed.data),
      });
    },
    onSuccess: (config: PolymarketAlertConfig) => {
      // A resposta é a configuração GRAVADA (inclusive o `updatedAt` do
      // servidor): a tela reflete o banco, não o que ela tentou enviar.
      setEnabled(config.enabled);
      setThreshold(config.threshold);
      setDailyLimit(config.dailyLimit);
      setSaved(true);
      void client.invalidateQueries({ queryKey: ['polymarket', 'favorites'] });
    },
    onError: () => setSaved(false),
  });

  return (
    <div className="panel" data-testid="alert-config">
      <div className="section-heading">
        <div>
          <h3>Alerta de atividade</h3>
          <p>{rule}</p>
        </div>
        <span className="live-label">{enabled ? 'Ligado' : 'Desligado'}</span>
      </div>
      <div className="filter-grid">
        <label className="report-check">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => {
              setEnabled(event.target.checked);
              setSaved(false);
            }}
          />
          <span>{alertFieldLabels.enabled}</span>
        </label>
        <Field label={alertFieldLabels.threshold}>
          <input
            value={threshold}
            onChange={(event) => {
              setThreshold(event.target.value);
              setSaved(false);
            }}
            inputMode="decimal"
          />
        </Field>
        <Field label={alertFieldLabels.dailyLimit}>
          <input
            type="number"
            min={1}
            max={200}
            value={dailyLimit}
            onChange={(event) => {
              setDailyLimit(Number(event.target.value));
              setSaved(false);
            }}
          />
        </Field>
      </div>
      <div className="form-actions">
        <Button disabled={save.isPending} onClick={() => save.mutate()}>
          Salvar alerta
        </Button>
        {saved ? <span className="muted">Configuração gravada.</span> : null}
      </div>
      <p className="panel-footnote">
        O alerta respeita o período de silêncio e a cota diária configurados nas suas notificações.
        Um alerta adiado pelo silêncio continua ocupando a cota do dia.
      </p>
    </div>
  );
}

/**
 * STK-F3-01 — a tela de Favoritos como DESTINO (`#pm-favorites`).
 *
 * É um ENVOLTÓRIO, e não uma segunda implementação: ele monta a MESMA
 * `PolymarketFavoritesSection` que o ranking renderiza. A tela de ranking
 * continua contendo a seção — mudar isso seria tirar uma função de onde a
 * pessoa já estava — e o destino novo é o mesmo componente, promoted.
 *
 * A única coisa que a página acrescenta é o enquadramento: um cabeçalho
 * PRÓPRIO, que diz a que destino a pessoa chegou. O título do cabeçalho é
 * deliberadamente DIFERENTE do `h2` da seção abaixo (`Favoritos do
 * ranking Polymarket`): dois `heading` com o mesmo nome acessível na mesma
 * tela tornam `getByRole('heading', { name })` ambíguo, e essa ambiguidade
 * quebraria justamente o teste que prova que a tela está mostrando o teto
 * de favoritos.
 */
export function PolymarketFavoritesPage() {
  return (
    <>
      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>Seus favoritos da Polymarket</h2>
            <p>
              As carteiras públicas que você guardou do leaderboard, com o uso do teto e o alerta de
              atividade. Favoritar não liga alerta: a ativação é separada, abaixo.
            </p>
          </div>
        </div>
      </section>
      <PolymarketFavoritesSection />
    </>
  );
}
