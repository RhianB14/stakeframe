import { z } from 'zod';
import {
  LEADERBOARD_ORDER_BY,
  LEADERBOARD_TIME_PERIODS,
  decimalTokenSchema,
  type BackfillStatus,
  type DecimalToken,
} from './polymarket.js';
import { polymarketRankingCategorySchema } from './polymarket-ranking.js';

/**
 * STK-F2-16 — o CONTRATO de favoritos, alertas de atividade e Composite Score
 * silencioso.
 *
 * Este arquivo é o lugar onde as REGRAS moram em forma de funções puras, e cada
 * regra existe porque o card a pede e porque uma versão só dela seria mentira:
 * o limite de 10 sem uma função testada é um `if` que alguém esquece, e o
 * agrupamento de 5 minutos sem aritmética exata é um `Math.floor` sobre float.
 *
 * Cinco decisões, e cada uma é uma função testada:
 *
 *  1) DEZ FAVORITOS É TETO DURO, E O EXCEDENTE É ERRO. Não existe paginação,
 *     não existe "carregar mais" e não existe warning: o décimo primeiro
 *     favorito é uma RECUSA. A função `favoritesAdmit` decide a partir da
 *     contagem já gravada, e o banco reforça o mesmo limite com um trigger
 *     (ver `polymarket_favorite_limit_trigger` na 0029) — o erro do Postgres
 *     é o que impede dois requests simultâneos de passar ao mesmo tempo.
 *
 *  2) FAVORITAR NÃO ATIVA ALERTA. As duas coisas são configuradas em tabelas
 *     diferentes e a função `favoriteEffectOnAlerts` existe para tornar essa
 *     separação uma INVARIANTE testada, não uma coincidência de implementação.
 *     Um usuário que favorita dez traders e não quer nenhum alerta é um
 *     estado legítimo, e o produto precisa saber dizer "nenhum alerta ativo".
 *
 *  3) A ATIVIDADE É LÍQUIDA E POR JANELA. O que o alerta mede é a variação de
 *     volume observada entre duas leituras do MESMO trader na MESMA janela
 *     oficial, agrupada em janelas fixas de 5 minutos. "Líquido" quer dizer
 *     delta, e delta exige uma observação ANTERIOR: a primeira leitura de um
 *     trader estabelece a linha de base e NÃO gera alerta, porque atribuir a
 *     ela o volume acumulado desde sempre seria a maiorACTIVITY falsa do
 *     sistema. `windowStartOf` e `netActivityOf` são as duas funções que
 *     tornam isso verificável sem banco.
 *
 *  4) O LIMIAR É AJUSTÁVEL E PADRÃO É US$ 1.000. Ele vive na configuração do
 *     usuário, é lido do banco a cada avaliação e nunca é assumido em código.
 *
 *  5) O COMPOSITE SCORE É SILENCIOSO, VERSIONADO E PARALELO. A função
 *     `computeCompositeScore` existe, é testada e grava versão — e NÃO é
 *     exportada por nenhuma rota, chamada por nenhum componente e lida por
 *     nenhuma tela. Ela reusa o enum oficial de categoria da F2-15 e a
 *     completude GRAVADA pela F2-14 (`BackfillStatus`), e se recusa a calcular
 *     quando a série não é `complete`, com o mesmo critério de
 *     `rankingAggregatePolicy`. Inferir completude aqui seria criar uma
 *     segunda verdade sobre a mesma série.
 *
 * O que este arquivo NÃO faz, por decisão do card (§9.3, escopo excluído):
 * recomendar, ler, comparar, avaliar, escolher, executes trade ou produzir
 * qualquer texto de leitura. Não existe campo para isso, e a ausência é
 * estrutural: os schemas de resposta são `strictObject`.
 */

// ---------------------------------------------------------------------------
// Os números do produto, declarados antes de qualquer schema
// ---------------------------------------------------------------------------

/**
 * O teto de favoritos por usuário. É o número do card, não um padrão: a
 * ausência de um teto transformaria "favoritos" numa lista sem fim, e a
 * atividade que ela observa é justamente a que o usuário acompanha de perto.
 */
export const POLYMARKET_FAVORITES_LIMIT = 10;

/** A janela de agrupamento do card: cinco minutos, e não é configurável. */
export const ALERT_WINDOW_MINUTES = 5;

/** O limiar padrão do card, em US$ por janela de 5 min. */
export const ALERT_DEFAULT_THRESHOLD = '1000';

/** O teto de alertas por dia local do usuário; configurável, como o limiar. */
export const ALERT_DEFAULT_DAILY_LIMIT = 10;

// ---------------------------------------------------------------------------
// Favoritos — o teto de 10
// ---------------------------------------------------------------------------

/** A carteira pública observada pela F2-14, na mesma forma canônica. */
export const polymarketWalletSchema = z.string().regex(/^0x[0-9a-f]{40}$/, 'INVALID_PROXY_WALLET');
export type PolymarketWallet = z.infer<typeof polymarketWalletSchema>;

/**
 * Um favorito gravado, e nada além do que o usuário escolheu guardar.
 *
 * `strictObject` de propósito: um campo a mais — um `score`, um `badge`, um
 * `rating` — faria o parse FALHAR em vez de passar em silêncio para a tela.
 * A ausência de pontuação é estrutural, e é por isso que o teste §15 pode
 * tratá-la como invariante e não como promessa.
 */
export const polymarketFavoriteSchema = z
  .strictObject({
    id: z.uuid(),
    userId: z.string().min(1),
    /** A carteira pública do trader, em minúsculas (identidade canônica). */
    proxyWallet: polymarketWalletSchema,
    /** O nome que a origem publicou no momento do favored — nunca um alias nosso. */
    userName: z.string().max(200),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .meta({ id: 'PolymarketFavorite' });
export type PolymarketFavorite = z.infer<typeof polymarketFavoriteSchema>;

/** O pedido de favoritar: só a carteira. A ativação de alerta NÃO vem aqui. */
export const polymarketFavoriteInputSchema = z
  .strictObject({ proxyWallet: polymarketWalletSchema })
  .meta({ id: 'PolymarketFavoriteRequest' });
export type PolymarketFavoriteInput = z.infer<typeof polymarketFavoriteInputSchema>;

/** A lista de favoritos com o uso do teto, para a tela escrever "3 de 10". */
export const polymarketFavoriteListSchema = z
  .strictObject({
    favorites: z.array(polymarketFavoriteSchema),
    /** O teto do card, sempre devolvido: a tela não escreve um número próprio. */
    limit: z.number().int().positive(),
    used: z.number().int().nonnegative(),
  })
  .meta({ id: 'PolymarketFavoriteList' });
export type PolymarketFavoriteList = z.infer<typeof polymarketFavoriteListSchema>;

/**
 * A RESPOSTA da lista de favoritos: a lista MAIS o estado do alerta.
 *
 * A ativação viaja na mesma resposta de propósito. A pergunta que a tela
 * precisa responder é "estou seguindo alguém E estou recebendo aviso?", e duas
 * chamadas produziriam um estado intermediário em que a resposta seria falsa —
 * a lista poderia já estar Favoritada quando a config ainda não voltou.
 */
export const polymarketFavoritesResponseSchema = z
  .strictObject({
    favorites: z.array(polymarketFavoriteSchema),
    limit: z.number().int().positive(),
    used: z.number().int().nonnegative(),
    alertEnabled: z.boolean(),
    /** O limiar gravado, como decimal exato (canônico, sem padding de escala). */
    alertThreshold: decimalTokenSchema,
    alertDailyLimit: z.number().int().positive(),
    alertWindowMinutes: z.literal(ALERT_WINDOW_MINUTES),
  })
  .meta({ id: 'PolymarketFavoritesResponse' });
export type PolymarketFavoritesResponse = z.infer<typeof polymarketFavoritesResponseSchema>;

/**
 * A resposta de quem FAVORITA: a lista inteira mais `created` e a ativação.
 *
 * `created: false` é o reenvio idempotente — o mesmo trader favoritado de novo
 * devolve o MESMO registro —, e a lista completa é o que importa para a tela
 * depois da ação: o que o usuário quer saber é quantos favoritos tem agora.
 */
export const polymarketFavoriteCreatedSchema = polymarketFavoritesResponseSchema.extend({
  created: z.boolean(),
});
export type PolymarketFavoriteCreated = z.infer<typeof polymarketFavoriteCreatedSchema>;

/** A confirmação de remoção: literal, para o cliente não aceitar um "ok" vago. */
export const polymarketFavoriteRemovedSchema = z
  .strictObject({ removed: z.literal(true) })
  .meta({ id: 'PolymarketFavoriteRemoved' });
export type PolymarketFavoriteRemoved = z.infer<typeof polymarketFavoriteRemovedSchema>;

/** Os limites do produto, lidos pela tela em vez de digitados nela. */
export const polymarketAlertLimitsSchema = z
  .strictObject({
    favoritesLimit: z.literal(POLYMARKET_FAVORITES_LIMIT),
    windowMinutes: z.literal(ALERT_WINDOW_MINUTES),
    defaultThreshold: decimalTokenSchema,
  })
  .meta({ id: 'PolymarketAlertLimits' });
export type PolymarketAlertLimits = z.infer<typeof polymarketAlertLimitsSchema>;

/**
 * Ofavorite é ADMITIDO?
 *
 * A função é pura e recebe a contagem JÁ GRAVADA, e é isso que a torna
 * honesta: ela não confia em um contador de memória que possa estar velho,
 * ela lê o que o banco tem. A resposta carrega os dois lados porque o produto
 * precisa distinguir "cabem" de "não cabem" sem traduzir erro em linguagem
 * genérica na camada de cima.
 *
 * `already` existe para o reenvio idempotente: favoritar o MESMO trader que já
 * é favorito não é excedente, é o mesmo favorito. Sem essa distinção, um
 * duplo clique limaria um lugar na lista em vez de devolver o mesmo registro.
 */
export function favoritesAdmit(input: {
  used: number;
  alreadyFavorite: boolean;
}): { admitted: true } | { admitted: false; reason: 'FAVORITES_LIMIT_REACHED' } {
  if (input.alreadyFavorite) return { admitted: true };
  if (input.used >= POLYMARKET_FAVORITES_LIMIT)
    return { admitted: false, reason: 'FAVORITES_LIMIT_REACHED' };
  return { admitted: true };
}

/**
 * O efeito de favoritar sobre a configuração de alerta: NENHUM.
 *
 * A função existe para ser testada como invariante, e ela é a tradução
 * executável de "favoritar não ativa alerta automaticamente". Ela devolve
 * explicitamente `enabled: false` para a situação em que não havia
 * configuração — a resposta honesta para um usuário que acabou de favoritar e
 * não pediu alerta nenhum.
 */
export function favoriteEffectOnAlerts(config: { enabled: boolean } | null): {
  enabled: boolean;
  source: 'unchanged';
} {
  // `config` é lido, não escrito: favoritar não pode virar o interruptor do
  // alerta em nenhum sentido (nem ligar, nem desligar, nem criar config).
  return { enabled: config?.enabled ?? false, source: 'unchanged' };
}

// ---------------------------------------------------------------------------
// Alertas — configuração por usuário
// ---------------------------------------------------------------------------

/**
 * A configuração de alerta de UM usuário. É uma linha por usuário, separada da
 * lista de favoritos, e é ela que guarda a ativação.
 *
 * `windowMinutes` é LITERAL `5` e não um campo livre: a janela é a definição
 * do card e um campo editável permitiria dois produtos com janelas diferentes
 * disputando o mesmo limiar. Um `z.literal` transforma essa decisão em erro de
 * parse em vez de um valor default silencioso.
 */
export const polymarketAlertConfigSchema = z
  .object({
    userId: z.string().min(1),
    /** Ativação SEPARADA do favorito. Ausente = desligado (fail-closed). */
    enabled: z.boolean(),
    /** Limiar de atividade LÍQUIDA por janela, como decimal exato. */
    threshold: decimalTokenSchema,
    /** Teto de alertas por dia local do usuário. */
    dailyLimit: z.number().int().min(1).max(200),
    /** A janela do card, fixa. */
    windowMinutes: z.literal(ALERT_WINDOW_MINUTES),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .meta({ id: 'PolymarketAlertConfig' });
export type PolymarketAlertConfig = z.infer<typeof polymarketAlertConfigSchema>;

/** O que a tela pode gravar. `strictObject`: um campo a mais é 400. */
export const polymarketAlertConfigInputSchema = z
  .strictObject({
    enabled: z.boolean(),
    threshold: decimalTokenSchema.optional(),
    dailyLimit: z.number().int().min(1).max(200).optional(),
  })
  .meta({ id: 'PolymarketAlertConfigRequest' });
export type PolymarketAlertConfigInput = z.infer<typeof polymarketAlertConfigInputSchema>;

/**
 * A configuração ABSENTE, com o padrão do card e a ativação desligada.
 *
 * O padrão de `enabled` é `false` e isso é uma decisão, não um detalhe: um
 * usuário que nunca falou de alerta não deve começar a receber notificações
 * porque favoritou um trader. A ativação é sempre explícita.
 */
export function defaultAlertConfig(userId: string): PolymarketAlertConfig {
  return {
    userId,
    enabled: false,
    threshold: ALERT_DEFAULT_THRESHOLD,
    dailyLimit: ALERT_DEFAULT_DAILY_LIMIT,
    windowMinutes: ALERT_WINDOW_MINUTES,
    updatedAt: new Date(0).toISOString(),
  };
}

/**
 * A configuração final depois de aplicar o que o usuário mandou.
 *
 * O limiar tem de ser POSITIVO: um limiar zero alertaria de toda janela com
 * qualquer atividade, inclusive a linha de base, e um limiar negativo alertaria
 * de janela nenhuma. A recusa é explícita porque "valor fora do contrato"
 * tratado como zero é exatamente o tipo de default silencioso que transforma
 * um limite em ausência de limite.
 */
export function resolveAlertConfig(input: {
  userId: string;
  current: PolymarketAlertConfig | null;
  patch: PolymarketAlertConfigInput;
}): PolymarketAlertConfig {
  const base = input.current ?? defaultAlertConfig(input.userId);
  const threshold = input.patch.threshold ?? base.threshold;
  if (!/^[1-9]\d{0,17}(\.\d{1,18})?$/.test(threshold)) throw new Error('INVALID_ALERT_THRESHOLD');
  return {
    userId: input.userId,
    enabled: input.patch.enabled,
    threshold,
    dailyLimit: input.patch.dailyLimit ?? base.dailyLimit,
    windowMinutes: ALERT_WINDOW_MINUTES,
    updatedAt: new Date(0).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// A atividade: janela de 5 min e líquido
// ---------------------------------------------------------------------------

const MINUTE_MS = 60_000;

/**
 * O início da janela de `instant`, em UTC.
 *
 * A janela é um dado de AGRUPAMENTO, não de exibição, e por isso ela é
 * alinhada em UTC: duas contas em fusos diferentes que observam o mesmo
 * instante precisam cair na MESMA janela, senão o mesmo evento contaria duas
 * vezes em dois limites diferentes. A conversão para o fuso do usuário existe
 * na hora de decidir se o alerta sai ou é adiado (quiet hours), e é ali que o
 * fuso dele entra — não aqui.
 *
 * A função é pura e não usa relógio: dado o mesmo instante, a mesma janela.
 */
export function windowStartOf(instant: Date, minutes = ALERT_WINDOW_MINUTES): Date {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) throw new Error('INVALID_WINDOW');
  const size = minutes * MINUTE_MS;
  return new Date(Math.floor(instant.getTime() / size) * size);
}

const DECIMAL_SCALE = 18;
const SCALE_FACTOR = 10n ** BigInt(DECIMAL_SCALE);

/** O decimal exato como inteiro escalado — `numeric(38, 18)` sem perder dígito. */
function scaled(token: string): bigint {
  if (!/^-?(?:0|[1-9]\d{0,17})(?:\.\d{1,18})?$/.test(token)) throw new Error('NOT_A_DECIMAL_TOKEN');
  const negative = token.startsWith('-');
  const [whole = '0', fraction = ''] = token.replace(/^-/, '').split('.');
  const value = BigInt(whole) * SCALE_FACTOR + BigInt(fraction.padEnd(DECIMAL_SCALE, '0'));
  return negative ? -value : value;
}

/** O inteiro escalado de volta para decimal, sem notação científica. */
function unscaled(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / SCALE_FACTOR;
  const fraction = String(absolute % SCALE_FACTOR)
    .padStart(DECIMAL_SCALE, '0')
    .replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction === '' ? '' : `.${fraction}`}`;
}

/**
 * A atividade LÍQUIDA entre duas observações: a diferença de volume, exata.
 *
 * A subtração é feita em BigInt sobre a escala de 18 casas do `numeric` do
 * banco, então `2666493.7190210004` menos `2665493.7190210004` é exatamente
 * `1000`, e não `999.999999999943`. Um `parseFloat` aqui viraria um alerta
 * disparado ou não por erro de arredondamento, que é a pior falha possível
 * num limiar.
 *
 * O sinal é preservado e é SIGNIFICATIVO: um volume observado MENOR que o
 * anterior é uma correção de leitura ou uma queda na métrica acumulada, e
 * `netActivity` negativo é o que impede que o limiar seja comparado com um
 * número que ele não representa. A comparação com o limiar é do chamador
 * (`reachesThreshold`), e ela recusa o negativo.
 */
export function netActivity(previous: DecimalToken, current: DecimalToken): DecimalToken {
  return unscaled(scaled(current) - scaled(previous)) as DecimalToken;
}

/**
 * O net alcança o limiar do usuário?
 *
 * Comparação em BigInt escalado, com recusa do valor negativo e do limiar não
 * positivo. Recusar aqui (lançar) em vez de devolver `false` é deliberado: um
 * limiar `0` ou `-1` gravado por um bug é um defeito de configuração, e tratá-lo
 * como "não alerta" esconderia o defeito dentro de um comportamento correto.
 */
export function reachesThreshold(input: { net: DecimalToken; threshold: DecimalToken }): boolean {
  const limit = scaled(input.threshold);
  if (limit <= 0n) throw new Error('INVALID_ALERT_THRESHOLD');
  const net = scaled(input.net);
  if (net < 0n) return false;
  return net >= limit;
}

/**
 * A chave de DEDUPE do alerta: mesmo trader, mesma janela, uma linha só.
 *
 * A chave carrega o instante da janela em ISO, e não um contador: dois passes
 * do job na mesma janela produzem a MESMA chave e o índice único recusa o
 * segundo. É o mesmo mecanismo que a F2-10 usa para o alerta de expiração, e a
 * razão é a mesma — disciplina do chamador não sobrevive a um segundo chamador.
 */
export function alertDedupeKey(input: {
  proxyWallet: PolymarketWallet;
  windowStart: Date;
}): string {
  return `polymarket_activity:${input.proxyWallet}:${input.windowStart.toISOString()}`;
}

/**
 * A etiqueta de JANELA que vai para a coluna `outbox.window`, dentro dos 16
 * caracteres que o CHECK da F2-10 impõe.
 *
 * O instante ISO completo (`2026-09-29T12:00:00.000Z`) tem 24 caracteres e
 * seria RECUSADO pela fila. A etiqueta usa os minutos em UTC, em `mm` + `hh:mm`
 * — que é a própria janela, e é o que o auditor precisa ler para saber de que
 * janela se trata. O valor continua vindo de `windowStartOf`, nunca escrito à
 * mão pelo chamador.
 */
export function alertWindowLabel(windowStart: Date): string {
  const iso = windowStart.toISOString();
  // `2026-09-29T12:00:00.000Z` → `2026-09-29T1200`, catorze caracteres.
  return `${iso.slice(0, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}`;
}

// ---------------------------------------------------------------------------
// Quiet hours, limite diário e a decisão de entrega
// ---------------------------------------------------------------------------

/**
 * A data civil do instante no fuso do usuário, como `YYYY-MM-DD`.
 *
 * O limite diário é do DIA DO USUÁRIO, não do dia UTC: um limite que zera às
 * 00:00 UTC cortaria o dia de quem mora em São Paulo (21:00 local) e estouraria
 * duas vezes na mesma tarde. O fuso vem da preferência da F2-10, e é o mesmo
 * que a job usa para as quiet hours.
 */
export function localDayIn(instant: Date, timezone: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(instant);
    const pick = (type: string) => parts.find((part) => part.type === type)!.value;
    return `${pick('year')}-${pick('month')}-${pick('day')}`;
  } catch {
    return null;
  }
}

/** A decisão do job para um candidato a alerta. Cada estado é observável. */
export type AlertDecision =
  | { action: 'enqueue'; scheduledFor: Date }
  | { action: 'skip'; reason: 'ALERT_DISABLED' | 'DAILY_LIMIT_REACHED' | 'ALREADY_ALERTED' }
  | { action: 'defer'; scheduledFor: Date; reason: 'QUIET_HOURS' };

/**
 * O que fazer com um candidato a alerta — a função que o card pede, e ela é
 * pura: o job, o teste e a tela podem chamá-la com os mesmos dados e obtener a
 * mesma decisão.
 *
 * A ORDEM das regras é o que importa, e ela não é arbitrária:
 *
 *  1. Desligado não enfileira NADA. Não existe alerta gravado e depois
 *     descartado: a ausência é a resposta para "não quero alertas".
 *  2. Dedupe ANTES do limite diário. Já alertado é "não repetir", e a pergunta
 *     "quanto já mandei hoje" não deve consumir a cota de quem já recebeu o
 *     mesmo evento.
 *  3. O limite diário conta o que foi ENFILEIRADO no dia local, então um
 *     alerta adiado por quiet hours ainda ocupa a cota: ele vai sair mais tarde
 *     e, se fosse de graça, o usuário receberia o dobro do que pediu.
 *  4. Quiet hours ADIAM, nunca descartam. O silêncio é do usuário e o dado
 *     existe; a resposta é mandá-lo no primeiro minuto fora da janela, que é o
 *     que a F2-10 já faz com o alerta de freebet.
 */
export function decideAlert(input: {
  config: Pick<PolymarketAlertConfig, 'enabled' | 'dailyLimit'>;
  /** Quantos alertas deste usuário JÁ FORAM ENFILEIRADOS no dia local. */
  enqueuedToday: number;
  /** A chave deste candidato já existe na fila? */
  alreadyAlerted: boolean;
  /** O instante de entrega pretendido, já no fuso do usuário. */
  candidate: Date;
  /** Avalia quiet hours no fuso do usuário (mesma função da F2-10). */
  isQuietHour: (instant: Date) => boolean;
  /** O primeiro instante fora do silêncio a partir do candidato (F2-10). */
  outsideQuietHours: (instant: Date) => Date;
}): AlertDecision {
  if (!input.config.enabled) return { action: 'skip', reason: 'ALERT_DISABLED' };
  if (input.alreadyAlerted) return { action: 'skip', reason: 'ALREADY_ALERTED' };
  if (input.enqueuedToday >= input.config.dailyLimit)
    return { action: 'skip', reason: 'DAILY_LIMIT_REACHED' };
  if (input.isQuietHour(input.candidate))
    return {
      action: 'defer',
      scheduledFor: input.outsideQuietHours(input.candidate),
      reason: 'QUIET_HOURS',
    };
  return { action: 'enqueue', scheduledFor: input.candidate };
}

/**
 * A latência de um alerta: quanto tempo passou entre o FIM da janela REPORTADA
 * e o instante em que o alerta foi enfileirado.
 *
 * A janela reportada é a ANTERIOR à observação, e é ela que fechou antes do
 * delta ser conhecido. Medir contra a janela corrente daria um número NEGATIVO
 * (o alerta sai enquanto a janela corrente ainda está aberta), e um alvo de
 * latência negativo não é uma medição — é um número que não pode ser
 * comparado com nada.
 *
 * É a diferença entre dois instantes GRAVADOS, nunca um `\Date.now()` medido
 * em volta de uma chamada. O alvo do card é `ALERT_LATENCY_TARGET_MS`, e a
 * função devolve o número real para que o teste compare o valor com o alvo em
 * vez de afirmar que a latência "deve ser boa".
 */
export const ALERT_LATENCY_TARGET_MS = ALERT_WINDOW_MINUTES * MINUTE_MS;

/**
 * A latência, em milissegundos, entre o fim da janela reportada e o
 * enfileiramento.
 *
 * `reportedWindowStart` é o início da janela ANTERIOR (a que fechou e produziu
 * o delta); o fim dela é `reportedWindowStart + 5 min`, que é exatamente o
 * início da janela de observação. Com o job de 60 s, a latência observada fica
 * entre 0 e 60 s — dentro do alvo de 5 min com folga.
 */
export function alertLatencyMs(input: { reportedWindowStart: Date; enqueuedAt: Date }): number {
  const windowEnd = input.reportedWindowStart.getTime() + ALERT_WINDOW_MINUTES * MINUTE_MS;
  return input.enqueuedAt.getTime() - windowEnd;
}

// ---------------------------------------------------------------------------
// Composite Score — silencioso, versionado, paralelo
// ---------------------------------------------------------------------------

/** A escala do score: seis casas, em BigInt, sem float em lugar nenhum. */
export const SCORE_SCALE_DECIMALS = 6;
const SCORE_FACTOR = 1_000_000n;

/** Um componente do score, com a medida que o produziu. */
export const compositeScoreComponentSchema = z.strictObject({
  key: z.enum(['edge', 'turnover']),
  /** A medida normalizada em [0, 1], com seis casas. */
  value: decimalTokenSchema,
  /** A regra que produziu o número, em português — o score é auditável. */
  rule: z.string().min(1),
});
export type CompositeScoreComponent = z.infer<typeof compositeScoreComponentSchema>;

/**
 * O score de uma versão, com tudo que o torna auditável e nada que o exponha.
 *
 * SEM `meta({ id })`, e isso é uma EXIGÊNCIA do card e não um esquecimento: o
 * `jsonSchemaTransform` da API registra no `docs/openapi.json` TODO schema com
 * id, mesmo que nenhuma rota o use. Um `CompositeScoreRun` publicado ali seria
 * um contrato de leitura para um número que o card proíbe expor — a primeira
 * coisa que alguém ligaria depois. O schema é interno do job e da auditoria do
 * banco, e ele não tem consumidor de API.
 */
export const compositeScoreRunSchema = z.object({
  /** A versão, monótona por janela: reprocessar grava uma versão nova. */
  version: z.number().int().positive(),
  /**
   * A janela, com os ENUMS OFICIAIS da F2-15 — os mesmos valores que a
   * origem aceitou nos probes e os mesmos que o CHECK do banco gravou na
   * F2-14. O score não define rótulo de categoria: um enum próprio aqui
   * acabaria divergindo do enum da tela sem que nada percebesse.
   */
  window: z.strictObject({
    category: polymarketRankingCategorySchema,
    timePeriod: z.enum(LEADERBOARD_TIME_PERIODS),
    orderBy: z.enum(LEADERBOARD_ORDER_BY),
  }),
  /** A completude GRAVADA pela F2-14; nunca inferida da contagem. */
  seriesStatus: z.enum(['complete', 'truncated', 'partial', 'unknown']),
  /** O score: `null` quando a série não sustenta o cálculo. */
  score: decimalTokenSchema.nullable(),
  /** Houve cálculo? Sem série completa, a recusa é a resposta correta. */
  eligible: z.boolean(),
  /** O motivo da recusa, ou `null` quando o score existe. */
  reason: z.string().min(1).nullable(),
  components: z.array(compositeScoreComponentSchema),
  /** Quantos traders entraram no cálculo. */
  traders: z.number().int().nonnegative(),
  /** O hash do conteúdo avaliado: mesma entrada, mesmo digest. */
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  computedAt: z.iso.datetime({ offset: true }),
});
export type CompositeScoreRun = z.infer<typeof compositeScoreRunSchema>;

/**
 * O RECUSA do score, e ela é a parte honesta da função.
 *
 * Uma série `truncated` é o estado real e normal do backfill da F2-14. Um
 * score calculado sobre cobertura parcial seria uma medida da nossa coleta
 * apresentada como medida do mercado — a mesma mentira que o
 * `rankingAggregatePolicy` da F2-15 já recusa. Então a função devolve
 * `eligible: false` com o motivo, e o banco grava a versão do mesmo jeito: o
 * histórico mostra que a avaliação ACONTECEU e foi recusada, que é diferente
 * de não ter avaliado.
 */
export function scoreRefusal(
  status: BackfillStatus,
  traders: number,
  window: CompositeScoreRun['window'],
): CompositeScoreRun {
  const reason =
    status !== 'complete'
      ? 'Composite Score não calculado: a série desta janela está truncada ou incompleta, ' +
        'e um score sobre cobertura parcial seria apresentado como medida do mercado.'
      : 'Composite Score não calculado: a série completa não tem trader observado para avaliar.';
  return {
    version: 1,
    window,
    seriesStatus: status,
    score: null,
    eligible: false,
    reason,
    components: [],
    traders,
    digest: '0'.repeat(64),
    computedAt: new Date(0).toISOString(),
  };
}

/**
 * O COMPOSITE SCORE, calculado em paralelo e nunca exposto.
 *
 * Os componentes saem dos NÚMEROS QUE A ORIGEM PUBLICOU (`pnl` e `vol` da F2-14)
 * e nada mais: não entra preferência do usuário, não entra carteira de
 * terceiro, não entra aposta, não entra contrato. São dois componentes com
 * pesos explícitos, e cada um declara a regra que o produziu, porque um score
 * que não explica a própria conta é um número que ninguém pode auditar.
 *
 *  - `edge` (peso 1/2): a proporção de traders com P&L POSITIVO publicado pela
 *    origem. É uma contagem sobre dado declarado, não uma previsão.
 *  - `turnover` (peso 1/2): o volume médio por trader em relação ao maior
 *    volume observado na janela. Mede escala relativa, e é por isso que a
 *    comparação é com o MAIOR da janela e não com um número arbitrário.
 *
 * A aritmética é toda em BigInt com seis casas: a proporção sai de
 * `roundedDivide` (arredondamento meio-para-cima explícito, o mesmo do
 * dinheiro no repositório) e o resultado final é um decimal de seis casas.
 * Nenhum `number` toca o score, o que torna a mesma versão reproduzível em
 * qualquer máquina.
 *
 * `version` NÃO é calculado aqui: a versão é do BANCO (o máximo gravado na
 * janela, mais um), porque a unicidade é o que torna o histórico confiável e
 * um contador em memória repetiria versão depois de um restart.
 */
export function computeCompositeScore(input: {
  window: CompositeScoreRun['window'];
  seriesStatus: BackfillStatus;
  traders: Array<{ pnl: DecimalToken; vol: DecimalToken }>;
  now: Date;
  digest: string;
}): CompositeScoreRun {
  if (input.seriesStatus !== 'complete')
    return scoreRefusal(input.seriesStatus, input.traders.length, input.window);
  if (input.traders.length === 0) return scoreRefusal(input.seriesStatus, 0, input.window);

  const n = BigInt(input.traders.length);
  let positive = 0n;
  for (const trader of input.traders) if (scaled(trader.pnl) > 0n) positive += 1n;
  // `positive / n` na escala de seis casas: o arredondamento é meio-para-cima e
  // acontece UMA vez, na divisão — dividir duas vezes arredondaria o mesmo
  // número em dois lugares e tornaria o score dependente da ordem das contas.
  const edge = roundedHalfUp(positive * SCORE_FACTOR, n);

  // `turnover` é a média dos volumes relativos ao MAIOR observado. Comparar com
  // o máximo da janela mantém o componente em [0, 1] sem constante arbitrária:
  // um teto fixo (1.000.000) seria um número inventado que envelheceria mal.
  let largest = 0n;
  for (const trader of input.traders) {
    const vol = scaled(trader.vol);
    if (vol > largest) largest = vol;
  }
  let relative = 0n;
  for (const trader of input.traders)
    relative +=
      largest === 0n ? SCORE_FACTOR : roundedHalfUp(scaled(trader.vol) * SCORE_FACTOR, largest);
  const turnover = roundedHalfUp(relative, n);

  // A média dos dois componentes, na MESMA escala, para que a interpolação não
  // divida um inteiro dezoito casas por dois e perca o resto.
  const score = roundedHalfUp(edge + turnover, 2n);
  return {
    version: 1,
    window: input.window,
    seriesStatus: input.seriesStatus,
    score: unscaledFixed(score),
    eligible: true,
    reason: null,
    components: [
      {
        key: 'edge',
        value: unscaledFixed(edge),
        rule: 'Proporção de traders com P&L positivo publicado pela origem (peso 1/2).',
      },
      {
        key: 'turnover',
        value: unscaledFixed(turnover),
        rule: 'Volume médio por trader em relação ao maior volume observado na janela (peso 1/2).',
      },
    ],
    traders: input.traders.length,
    digest: input.digest,
    computedAt: input.now.toISOString(),
  };
}

/** Divisão meio-para-cima em BigInt: o score não depende do arredondamento do IEEE. */
function roundedHalfUp(numerator: bigint, denominator: bigint = SCORE_FACTOR): bigint {
  if (denominator <= 0n) throw new Error('INVALID_SCORE_DIVISOR');
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  const value = (absolute + denominator / 2n) / denominator;
  return negative ? -value : value;
}

/** O inteiro escalado como decimal de seis casas — a grafia do banco. */
function unscaledFixed(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / SCORE_FACTOR;
  const fraction = String(absolute % SCORE_FACTOR).padStart(SCORE_SCALE_DECIMALS, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}
