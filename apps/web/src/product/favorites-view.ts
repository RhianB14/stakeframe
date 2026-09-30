import {
  ALERT_DEFAULT_DAILY_LIMIT,
  ALERT_DEFAULT_THRESHOLD,
  ALERT_WINDOW_MINUTES,
  POLYMARKET_FAVORITES_LIMIT,
  type PolymarketAlertConfig,
  type PolymarketFavorite,
} from '@stakeframe/shared';

/**
 * STK-F2-16 — a apresentação de favoritos e do alerta de atividade.
 *
 * Este módulo é PURO e testável sem navegador, no mesmo padrão de
 * `ranking-view`: ele devolve rótulos e textos, e o componente só renderiza.
 * A separação existe por um motivo concreto — a regra do card é "favoritar não
 * ativa alerta" e "o limite de dez é recusa, não paginação" — e essas regras
 * precisam ser verificáveis em um teste de função, sem subir o stack.
 *
 * O que este módulo NÃO faz, por decisão do card (§9.3):
 *
 *  - NÃO produz score, badge, selo, avaliação, leitura, comparação ou
 *    recomendação. Não existe campo para isso na view: a ausência é
 *    estrutural, e o teste §15 varre o texto renderizado procurando os termos.
 *
 *  - NÃO escreve posição, ordenação ou comparação entre favoritos. A lista é
 *    a ordem em que o usuário escolheu guardar, e o nome é o que a origem
 *    publicou — a carteira pública é o identificador quando o nome falta.
 */

/** Uma linha de favorito pronta para a tabela. */
export type FavoriteRowView = {
  key: string;
  /** O nome publicado pela origem, ou a carteira quando não há nome. */
  trader: string;
  /** A carteira pública, sempre visível: identifica sem interpretar. */
  wallet: string;
  /** O instante em que o usuário favoritou, para a ordenação ser auditável. */
  favoritedAt: string;
};

export type FavoritesView = {
  title: string;
  subtitle: string;
  /** A Occupação do teto, no formato que a tela escreve. */
  usage: string;
  /** O que a tela escreve quando o teto foi atingido. */
  limitNotice: string | null;
  rows: FavoriteRowView[];
  emptyTitle: string;
  emptyDetail: string;
  /** O estado do alerta, separado dos favoritos e visível como tal. */
  alertTitle: string;
  alertState: string;
  alertDetail: string;
  /** A frase que diz a janela e o limiar, sem recomendar nada. */
  alertRule: string;
};

/**
 * O texto do limite de dez favoritos.
 *
 * A distinção que a função preserva é a do card: o décimo primeiro NÃO vira
 * paginação nem "carregar mais". A tela escreve que o limite foi atingido e
 * que é preciso remover um favorito antes de adicionar outro — que é a única
 * ação possível quando o teto é do produto.
 */
export function favoritesLimitNotice(used: number, limit: number): string | null {
  if (used < limit) return null;
  return (
    `Limite de ${limit} favoritos atingido (${used} de ${limit}). ` +
    'O limite é do produto e o excedente é recusado: remova um favorito para ' +
    'poder adicionar outro.'
  );
}

/** Uma linha de favorito. O nome vem da origem; sem nome, a carteira aparece. */
export function favoriteRowView(favorite: PolymarketFavorite): FavoriteRowView {
  const name = favorite.userName.trim();
  return {
    key: favorite.id,
    trader: name === '' ? '(sem nome informado)' : name,
    wallet: favorite.proxyWallet,
    favoritedAt: favorite.createdAt,
  };
}

/**
 * A frase do alerta, e ela diz TRÊS coisas que o usuário precisa antes de ligar:
 * a janela, o limiar e onde a quiet hours vem.
 *
 * O texto nomeia o FUSO DO USUÁRIO porque é lá que o silêncio é avaliado, e
 * dizer isso evita a leitura errada mais comum: alguém em São Paulo que acha
 * que o silêncio é em UTC. Nenhuma promessa de horário de entrega entra aqui —
 * o instante de entrega depende de quando a janela fecha, e prometer horário
 * seria publicar um número que ninguém mediu.
 */
export function alertRuleText(input: {
  threshold: string;
  windowMinutes: number;
  timezone: string;
}): string {
  return (
    `Alerta quando a atividade LÍQUIDA de um trader favorito alcançar ` +
    `${input.threshold} em uma janela de ${input.windowMinutes} minutos. ` +
    `Silêncio avaliado no seu fuso (${input.timezone}) e cota de um alerta por evento.`
  );
}

/**
 * A view completa: favoritos e alerta em um objeto só.
 *
 * A ordem das decisões é o que importa. O uso do teto vem PRIMEIRO (é a regra
 * que decide se a ação de favoritar está disponível), e o estado do alerta vem
 * SEPARADO — nunca fundido com a contagem, porque "3 de 10 favoritos" e
 * "alerta desligado" são duas informações que o usuário controla em lugares
 * diferentes.
 */
export function favoritesView(input: {
  favorites: PolymarketFavorite[];
  limit: number;
  config: Pick<PolymarketAlertConfig, 'enabled' | 'threshold' | 'dailyLimit' | 'windowMinutes'>;
  timezone: string;
}): FavoritesView {
  const used = input.favorites.length;
  const rows = input.favorites.map(favoriteRowView);
  return {
    title: 'Favoritos do ranking Polymarket',
    subtitle:
      'Os traders que você guardou do leaderboard público. A lista não tem ordem de ' +
      'desempenho: ela é a ordem em que você favoritou.',
    usage: `${used} de ${input.limit} favoritos`,
    limitNotice: favoritesLimitNotice(used, input.limit),
    rows,
    emptyTitle: 'Nenhum favorito ainda',
    emptyDetail:
      'Favoritar guarda o trader nesta tela. Favoritar NÃO ativa alerta: a ativação é ' +
      'uma escolha separada, abaixo, e o alerta de atividade é configurado por você.',
    alertTitle: 'Alerta de atividade',
    // O estado é escrito por extenso, e não por um interruptador sem rótulo:
    // "ligado" e "desligado" com o que significam é mais honesto que um toggle
    // que não diz sobre o que ele age.
    alertState: input.config.enabled
      ? `Ligado — cota de ${input.config.dailyLimit} alertas por dia`
      : 'Desligado — nenhum alerta de atividade é enviado',
    alertDetail: input.config.enabled
      ? 'Você recebe um aviso quando um favorito atinge o limiar na janela. ' +
        'Um alerta adiado pelo período de silêncio ainda ocupa a cota do dia.'
      : 'Nenhum favorito gera aviso enquanto o alerta estiver desligado. ' +
        'Você pode favoritar traders sem receber nenhum alerta.',
    alertRule: alertRuleText({
      threshold: input.config.threshold,
      windowMinutes: input.config.windowMinutes,
      timezone: input.timezone,
    }),
  };
}

/** Os rótulos dos campos de configuração, sem valor assumido na tela. */
export const alertFieldLabels = {
  enabled: 'Alerta de atividade',
  threshold: `Limiar por janela de ${ALERT_WINDOW_MINUTES} min (US$)`,
  dailyLimit: 'Alertas por dia',
} as const;

/** Os valores de fábrica que a tela usa como estado inicial do formulário. */
export const alertFormDefaults = {
  enabled: false,
  threshold: ALERT_DEFAULT_THRESHOLD,
  dailyLimit: ALERT_DEFAULT_DAILY_LIMIT,
  windowMinutes: ALERT_WINDOW_MINUTES,
  favoritesLimit: POLYMARKET_FAVORITES_LIMIT,
} as const;
