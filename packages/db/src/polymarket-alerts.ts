import {
  ALERT_LATENCY_TARGET_MS,
  ALERT_WINDOW_MINUTES,
  POLYMARKET_FAVORITES_LIMIT,
  alertDedupeKey,
  alertLatencyMs,
  alertWindowLabel,
  canonicalDecimalToken,
  computeCompositeScore,
  defaultAlertConfig,
  decideAlert,
  favoritesAdmit,
  isQuietHour,
  localDayIn,
  netActivity,
  reachesThreshold,
  resolveAlertConfig,
  windowStartOf,
  type AlertDecision,
  type CompositeScoreRun,
  type PolymarketAlertConfig,
  type PolymarketAlertConfigInput,
  type PolymarketFavorite,
  type PolymarketWallet,
} from '@stakeframe/shared';
import type { PoolClient } from 'pg';
import { createTenantContext, type OrganizationContext } from './tenant-context.js';
import { outsideQuietHours } from './notifications.js';
import { sha256Hex, type Database } from './index.js';

/**
 * STK-F2-16 — favoritos, alertas de atividade e o Composite Score silencioso.
 *
 * Quatro garantias vivem aqui, e todas as quatro são do BANCO, não da
 * disciplina do chamador:
 *
 *  1) O TETO DE 10 É RECUSA, E A RECUSA É DO POSTGRES. A função `favoritesAdmit`
 *     decide a partir da contagem gravada e dá uma mensagem boa; o trigger
 *     `polymarket_favorite_limit` é o que fecha a corrida entre dois pedidos
 *     simultâneos. Um décimo primeiro favorito é um erro, nunca uma paginação e
 *     nunca um "carregar mais".
 *
 *  2) FAVORITAR NÃO ATIVA ALERTA. As duas gravações são independentes e o
 *     caminho de `add()` não toca `polymarket_alert_config`: um usuário com dez
 *     favoritos e `enabled: false` é um estado que o banco permite e que a
 *     listagem precisa descrever.
 *
 *  3) A ATIVIDADE É LÍQUIDA E A LINHA DE BASE É GRAVADA. Cada job grava a
 *     leitura da janela corrente e compara com a ANTERIOR do mesmo trader: sem
 *     anterior não há delta, e o alerta não nasce. O que é medido é a diferença
 *     de volume publicado pela origem, nunca volume acumulado desde sempre.
 *
 *  4) O SCORE NÃO É LIDO POR NINGUÉM. Não existe método público de leitura de
 *     `polymarket_score_run`: a tabela é escrita por `runScore` e só isso. A
 *     versão é o MÁXIMO gravado na janela mais um, então reprocessar a mesma
 *     janela cria a versão seguinte em vez de sobrescrever, e o índice único
 *     impede duas versões iguais.
 *
 * Isolamento: todo acesso leva o predicado explícito
 * `organization_id = current_setting($app.organization_id$, true)::uuid` dentro
 * de `withOrganizationTransaction`, o mesmo padrão da F2-10. O RLS não é a
 * defesa (o papel de conexão é dono do banco e o ignora); o predicado explícito
 * é.
 */

const ORG = `current_setting($$app.organization_id$$, true)::uuid`;

export type PolymarketAlertsErrorCode =
  'FAVORITE_NOT_FOUND' | 'FAVORITES_LIMIT_REACHED' | 'FAVORITE_INVALID' | 'ALERT_CONFIG_INVALID';

export class PolymarketAlertsError extends Error {
  constructor(public readonly code: PolymarketAlertsErrorCode) {
    super(code);
    this.name = 'PolymarketAlertsError';
  }
}

type FavoriteRow = {
  id: string;
  user_id: string;
  proxy_wallet: string;
  user_name: string;
  created_at: Date;
};

function favoriteOf(row: FavoriteRow): PolymarketFavorite {
  return {
    id: row.id,
    userId: row.user_id,
    proxyWallet: row.proxy_wallet as PolymarketWallet,
    userName: row.user_name,
    createdAt: row.created_at.toISOString(),
  };
}

export function createPolymarketAlertsService(database: Database) {
  const tenant = createTenantContext(database);
  const read = <T>(context: OrganizationContext, action: (client: PoolClient) => Promise<T>) =>
    tenant.withOrganizationTransaction(context, action, { isolation: 'repeatable read' });
  const write = <T>(context: OrganizationContext, action: (client: PoolClient) => Promise<T>) =>
    tenant.withOrganizationTransaction(context, action);

  /**
   * Os favoritos do usuário, com o uso do teto.
   *
   * A lista é o que o usuário escolheu guardar e nada mais: não há métrica
   * derivada, não há posição, não há comparação entre os favoritos. O `limit`
   * viaja na resposta para que a tela escreva um número do contrato em vez de
   * um número digitado no componente.
   */
  async function listFavorites(
    context: OrganizationContext,
    userId: string,
  ): Promise<{ favorites: PolymarketFavorite[]; limit: number; used: number }> {
    return read(context, async (client) => {
      const rows = (
        await client.query<FavoriteRow>(
          `select id,user_id,proxy_wallet,user_name,created_at
             from integration.polymarket_favorite
            where organization_id=${ORG} and user_id=$1
            order by created_at asc, id asc`,
          [userId],
        )
      ).rows;
      return {
        favorites: rows.map(favoriteOf),
        limit: POLYMARKET_FAVORITES_LIMIT,
        used: rows.length,
      };
    });
  }

  /**
   * Adiciona um favorito. O limite é conferido ANTES, pela função pura, para
   * dar a recusa com mensagem boa; e o trigger do banco fecha a corrida.
   *
   * O `ON CONFLICT DO NOTHING` + releitura torna o reenvio idempotente: favoritar
   * o mesmo trader duas vezes devolve o MESMO registro, e `created: false`
   * diz que nada foi criado. Sem o `alreadyFavorite` da função pura, um duplo
   * clique consumiria um lugar da lista.
   */
  async function addFavorite(
    context: OrganizationContext,
    userId: string,
    input: { proxyWallet: string; userName: string },
  ): Promise<{ favorite: PolymarketFavorite; created: boolean }> {
    // A carteira é canônica em minúsculas ANTES de qualquer consulta: `0xAB` e
    // `0xab` são o mesmo trader, e a chave de dedup depende disso.
    const wallet = input.proxyWallet.toLowerCase();
    return write(context, async (client) => {
      const existing = (
        await client.query<FavoriteRow>(
          `select id,user_id,proxy_wallet,user_name,created_at
             from integration.polymarket_favorite
            where organization_id=${ORG} and user_id=$1 and proxy_wallet=$2
            for update`,
          [userId, wallet],
        )
      ).rows[0];
      const used = (
        await client.query<{ n: string }>(
          `select count(*)::text as n from integration.polymarket_favorite
            where organization_id=${ORG} and user_id=$1`,
          [userId],
        )
      ).rows[0]!.n;
      const decision = favoritesAdmit({ used: Number(used), alreadyFavorite: Boolean(existing) });
      if (!decision.admitted) throw new PolymarketAlertsError('FAVORITES_LIMIT_REACHED');
      if (existing) return { favorite: favoriteOf(existing), created: false };
      const inserted = (
        await client.query<{ id: string }>(
          `insert into integration.polymarket_favorite (user_id,proxy_wallet,user_name)
           values($1,$2,$3)
           on conflict (organization_id,user_id,proxy_wallet) do nothing
           returning id`,
          [userId, wallet, input.userName.slice(0, 200)],
        )
      ).rows[0];
      if (!inserted) {
        // A corrida ganhou: outro pedido gravou entre a contagem e o INSERT.
        // A releitura devolve o registro real em vez de inventar um erro.
        const row = (
          await client.query<FavoriteRow>(
            `select id,user_id,proxy_wallet,user_name,created_at
               from integration.polymarket_favorite
              where organization_id=${ORG} and user_id=$1 and proxy_wallet=$2`,
            [userId, wallet],
          )
        ).rows[0]!;
        return { favorite: favoriteOf(row), created: false };
      }
      const row = (
        await client.query<FavoriteRow>(
          `select id,user_id,proxy_wallet,user_name,created_at
             from integration.polymarket_favorite
            where organization_id=${ORG} and user_id=$1 and proxy_wallet=$2`,
          [userId, wallet],
        )
      ).rows[0]!;
      return { favorite: favoriteOf(row), created: true };
    });
  }

  /** Remove um favorito. Não toca a configuração de alerta — as duas coisas são
   * independentes, e remover um favorito não pode desligar o alerta de outro. */
  async function removeFavorite(
    context: OrganizationContext,
    userId: string,
    proxyWallet: string,
  ): Promise<void> {
    await write(context, async (client) => {
      const deleted = await client.query(
        `delete from integration.polymarket_favorite
          where organization_id=${ORG} and user_id=$1 and proxy_wallet=$2`,
        [userId, proxyWallet.toLowerCase()],
      );
      // Remover o que não existe é a resposta honesta (`FAVORITE_NOT_FOUND`),
      // e não um sucesso silencioso que a tela contaria como remoção.
      if (deleted.rowCount === 0) throw new PolymarketAlertsError('FAVORITE_NOT_FOUND');
    });
  }

  // ------------------------------------------------------------ configuração

  /**
   * A configuração de alerta do usuário, ou o padrão do card quando ausente.
   *
   * A ausência NÃO é um erro e NÃO é um default silencioso dentro do cálculo: a
   * função `defaultAlertConfig` diz explicitamente `enabled: false`, e é esse
   * `false` que impede um usuário que nunca pediu alerta de começar a recebê-lo.
   */
  async function alertConfig(
    context: OrganizationContext,
    userId: string,
  ): Promise<PolymarketAlertConfig> {
    return read(context, async (client) => {
      const row = (
        await client.query<{
          enabled: boolean;
          threshold: string;
          daily_limit: number;
          window_minutes: number;
          updated_at: Date;
        }>(
          `select enabled,threshold::text as threshold,daily_limit,window_minutes,updated_at
             from integration.polymarket_alert_config
            where organization_id=${ORG} and user_id=$1`,
          [userId],
        )
      ).rows[0];
      if (!row) return defaultAlertConfig(userId);
      return {
        userId,
        enabled: row.enabled,
        // O `numeric` volta como texto e é canonicalizado antes do schema: o
        // Postgres devolve a escala CHEIA (`1000.000000000000000000`) e o
        // `decimalToken` de borda recusa o padding. `canonicalDecimalToken`
        // remove só os zeros à direita, então nenhum dígito significativo muda.
        threshold: canonicalDecimalToken(row.threshold) as PolymarketAlertConfig['threshold'],
        dailyLimit: row.daily_limit,
        windowMinutes: ALERT_WINDOW_MINUTES,
        updatedAt: row.updated_at.toISOString(),
      };
    });
  }

  /**
   * Grava a configuração. O limiar é validado pela função pura ANTES de tocar o
   * banco: um limiar zero ou negativo é defeito de configuração, e gravá-lo
   * deixaria o comportamento de "alerta tudo" ou "alerta nada" depender de um
   * `if` em outro arquivo.
   */
  async function saveAlertConfig(
    context: OrganizationContext,
    userId: string,
    patch: PolymarketAlertConfigInput,
  ): Promise<PolymarketAlertConfig> {
    const current = await alertConfig(context, userId);
    let resolved: PolymarketAlertConfig;
    try {
      resolved = resolveAlertConfig({ userId, current, patch });
    } catch {
      throw new PolymarketAlertsError('ALERT_CONFIG_INVALID');
    }
    await write(context, async (client) => {
      const row = (
        await client.query<{ updated_at: Date }>(
          `insert into integration.polymarket_alert_config
             (user_id,enabled,threshold,daily_limit,window_minutes)
           values($1,$2,$3::numeric,$4,$5)
           on conflict (organization_id,user_id) do update set
             enabled=excluded.enabled,threshold=excluded.threshold,
             daily_limit=excluded.daily_limit,window_minutes=excluded.window_minutes,
             updated_at=now()
           returning updated_at`,
          [userId, resolved.enabled, resolved.threshold, resolved.dailyLimit, ALERT_WINDOW_MINUTES],
        )
      ).rows[0]!;
      return { ...resolved, updatedAt: row.updated_at.toISOString() };
    });
    // A escrita acima é a garantia; a leitura de confirmação abaixo devolve o
    // que o BANCO gravou (inclusive o `updated_at` do servidor), em vez do
    // instante do cliente. Um `return` do resultado do write sem releitura
    // devolveria um `updatedAt` sintético que o banco nunca gravou.
    return alertConfig(context, userId);
  }

  // -------------------------------------------------------------- o job

  /**
   * Um passe de alerta para UM usuário de UMA organização.
   *
   * Tudo acontece em UMA transação com o contexto da organização, e isso é o
   * que dá ao job as três propriedades que o card pede:
   *
   *  1. ISOLAMENTO. Toda consulta carrega o predicado de organização. Um job que
   *     processasse o favorito de outra organização dentro do contexto errado
   *     alertaria sobre a carteira de outra conta, e a cota diária de um
   *     usuário seria consumida pela atividade de outro.
   *
   *  2. PERCURSO. Para cada favorito: grava a leitura da janela corrente
   *     (`windowStartOf(now)`, a MESMA para todos), compara com a leitura
   *     ANTERIOR do mesmo trader e, se o delta líquido alcança o limiar,
   *     decide. Sem leitura anterior, a linha de base foi gravada e NADA é
   *     alertado — é o que impede "atividade" de ser o volume acumulado.
   *
   *  3. DEDUPE E COTA NO BANCO. A chave `(organization_id, dedupe_key)` é
   *     única e a cota conta o que foi ENFILEIRADO no dia local do usuário. A
   *     função pura `decideAlert` decide a intenção; o `ON CONFLICT DO NOTHING`
   *     decide quem grava, e é ele que sobrevive a dois workers rodando o
   *     mesmo passe ao mesmo tempo.
   */
  async function runAlertsOnce(
    context: OrganizationContext,
    userId: string,
    now = new Date(),
  ): Promise<{
    observed: number;
    enqueued: number;
    skipped: number;
    deferred: number;
    maxLatencyMs: number;
  }> {
    const config = await alertConfig(context, userId);
    const favorites = await listFavorites(context, userId);
    const empty = { observed: 0, enqueued: 0, skipped: 0, deferred: 0, maxLatencyMs: 0 };
    // Alerta desligado ou nenhum favorito: NADA é observado nem gravado. Um
    // job que registrasse linha de base de um usuário que não quer alerta
    // deixaria a primeira leitura pronta para disparar quando ele ligasse.
    if (!config.enabled || favorites.favorites.length === 0) return empty;

    // O fuso e o silêncio vêm da preferência da F2-10 — a mesma linha, a mesma
    // função `isQuietHour`, e o mesmo `outsideQuietHours` que adia o alerta de
    // expiração. Nenhuma regra de silêncio duplicada aqui.
    const preferences = (
      await read(context, (client) =>
        client.query<{ timezone: string; quiet_hours_start: number; quiet_hours_end: number }>(
          `select timezone,quiet_hours_start,quiet_hours_end
             from notification.preference
            where organization_id=${ORG} and user_id=$1`,
          [userId],
        ),
      )
    ).rows[0];
    const timezone = preferences?.timezone ?? 'America/Sao_Paulo';
    const quietStart = preferences?.quiet_hours_start ?? 1320;
    const quietEnd = preferences?.quiet_hours_end ?? 360;
    const isQuiet = (instant: Date) => isQuietHour(instant, timezone, quietStart, quietEnd);
    const outside = (instant: Date) =>
      outsideQuietHours(instant, {
        timezone,
        quietHoursStart: quietStart,
        quietHoursEnd: quietEnd,
      });

    const windowStart = windowStartOf(now);
    const day = localDayIn(now, timezone);

    return write(context, async (client) => {
      let observed = 0;
      let enqueued = 0;
      let skipped = 0;
      let deferred = 0;
      let maxLatencyMs = 0;

      // A cota do dia é lida UMA vez e incrementada localmente: recountar a
      // cada candidato daria o mesmo número para todos e o segundo alerta do
      // dia passaria. O valor local é o que a função pura compara.
      let enqueuedToday = 0;
      if (day) {
        enqueuedToday = Number(
          (
            await client.query<{ n: string }>(
              `select count(*)::text as n from notification.outbox
                where organization_id=${ORG} and user_id=$1
                  and topic='polymarket_activity'
                  and (scheduled_for at time zone $2::text)::date = $3::date`,
              [userId, timezone, day],
            )
          ).rows[0]!.n,
        );
      }

      for (const favorite of favorites.favorites) {
        // O volume acumulado publicado pela origem para este trader, lido das
        // MESMAS tabelas que a tela de ranking lê: nada é derivado aqui.
        //
        // `integration.polymarket_trader` é dado PÚBLICO de integração externa
        // (decisão da F2-14): não tem `organization_id` e não leva RLS. Por isso
        // o predicado de organização NÃO aparece aqui — ele apareceria como
        // `column "organization_id" does not exist`. O isolamento do job está
        // nas tabelas DELE (`polymarket_favorite`, `activity_window`,
        // `alert_config`), que são configuração do usuário.
        //
        // A leitura mais recente é a de MAIOR `observed_at`, com `id` como
        // desempate. Ordenar só por `id` seria arbitrário — a chave é um UUID
        // aleatório, e a ordem física da inserção não é a ordem do valor. Como
        // a F2-14 grava `observed_at DEFAULT now()` por transação, duas
        // paginações em transações diferentes têm instantes distintos, e o
        // desempate por `id` só entra quando o instante é o mesmo.
        const current = (
          await client.query<{ vol: string }>(
            `select vol::text as vol from integration.polymarket_trader
              where category='OVERALL' and time_period='MONTH' and order_by='PNL'
                and proxy_wallet=$1
              order by observed_at desc, id desc limit 1`,
            [favorite.proxyWallet],
          )
        ).rows[0];
        if (!current) continue;
        observed += 1;

        // A leitura ANTERIOR é a última janela ESTRITAMENTE anterior: a janela
        // corrente pode já ter sido gravada por um passe anterior do mesmo
        // minuto, e usá-la como "anterior" produziria delta zero.
        const previous = (
          await client.query<{ volume_observed: string; window_start: Date }>(
            `select volume_observed::text as volume_observed,"window_start"
               from integration.polymarket_activity_window
              where organization_id=${ORG} and user_id=$1 and proxy_wallet=$2
                and window_start < $3
              order by window_start desc limit 1`,
            [userId, favorite.proxyWallet, windowStart],
          )
        ).rows[0];
        await client.query(
          `insert into integration.polymarket_activity_window
             (user_id,proxy_wallet,window_start,volume_observed,observed_at)
           values($1,$2,$3,$4::numeric,$5)
           on conflict (organization_id,user_id,proxy_wallet,window_start) do update
             set volume_observed=excluded.volume_observed,observed_at=excluded.observed_at`,
          [userId, favorite.proxyWallet, windowStart, current.vol, now],
        );

        // Sem leitura anterior, a linha de base foi gravada e não há delta: o
        // volume acumulado desde sempre NÃO é atividade, é herança da
        // observação. Pular aqui é o que mantém a promessa do card.
        if (!previous) continue;
        const net = netActivity(previous.volume_observed, current.vol);
        if (!reachesThreshold({ net, threshold: config.threshold })) continue;

        // A janela REPORTADA é a ANTERIOR: é ela que fechou e produziu o
        // delta, e é dela que a latência é medida. A chave de dedupe também
        // vem dela, porque a resposta que o usuário não quer repetir é "o
        // alerta desta janela", não "o alerta desta execução".
        const reportedWindowStart = new Date(previous.window_start as unknown as string);
        const dedupeKey = alertDedupeKey({
          proxyWallet: favorite.proxyWallet,
          windowStart: reportedWindowStart,
        });
        const alreadyAlerted =
          (
            await client.query(
              `select 1 from notification.outbox
              where organization_id=${ORG} and dedupe_key=$1 limit 1`,
              [dedupeKey],
            )
          ).rows.length > 0;

        const decision: AlertDecision = decideAlert({
          config,
          enqueuedToday,
          alreadyAlerted,
          candidate: now,
          isQuietHour: isQuiet,
          outsideQuietHours: outside,
        });
        if (decision.action === 'skip') {
          skipped += 1;
          continue;
        }
        if (decision.action === 'defer') deferred += 1;

        const written =
          (
            await client.query(
              `insert into notification.outbox
               ("organization_id","user_id","topic","subject_id","window","dedupe_key","title","body","scheduled_for")
             values(${ORG},$1,'polymarket_activity',null,$2,$3,$4,$5,$6)
             on conflict ("organization_id","dedupe_key") do nothing
             returning id`,
              [
                userId,
                // A etiqueta da janela cabe nos 16 caracteres do CHECK da F2-10; o
                // instante ISO completo seria recusado pela fila. É a janela
                // REPORTADA (a que produziu o delta) que identifica o alerta.
                alertWindowLabel(reportedWindowStart),
                dedupeKey,
                'Atividade alta de trader favorito',
                `A atividade líquida do trader ${favorite.proxyWallet} na janela de 5 min ` +
                  `atingiu o limiar configurado.`,
                decision.scheduledFor,
              ],
            )
          ).rows.length > 0;
        if (!written) {
          // A corrida ganhou (outro worker gravou a mesma chave): não é erro,
          // e o alerta não é contado duas vezes na cota do dia.
          skipped += 1;
          continue;
        }
        enqueued += 1;
        enqueuedToday += 1;
        // A latência é medida contra o fim da janela REPORTADA, que é o
        // instante a partir do qual o delta era conhecido.
        const latency = alertLatencyMs({ reportedWindowStart, enqueuedAt: now });
        if (latency > maxLatencyMs) maxLatencyMs = latency;
      }

      return { observed, enqueued, skipped, deferred, maxLatencyMs };
    });
  }

  // --------------------------------------------------------- Composite Score

  /**
   * O job SILENCIOSO do Composite Score.
   *
   * Ele lê a série gravada pela F2-14, calcula o score e grava a VERSÃO — e
   * não há nada mais. Nenhuma função deste serviço devolve o score, nenhuma
   * rota o expõe e nenhum componente o consome: a avaliação corre em PARALELO
   * com o produto, e o resultado fica no banco até que uma revisão posterior
   * decida o que fazer com ele. É por isso que o método se chama `runScore` e
   * não `score`: o nome já diz que é um job, não uma leitura.
   *
   * A recusa é gravada como versão, e não pulada: o histórico mostra que a
   * avaliação ACONTECEU e foi recusada por causa da completude, que é uma
   * informação diferente de "não avaliado".
   */
  async function runScore(now = new Date()): Promise<{ version: number; eligible: boolean }> {
    const window = { category: 'OVERALL', timePeriod: 'MONTH', orderBy: 'PNL' } as const;
    const series = (
      await database.pool.query<{ status: string }>(
        `select status from integration.polymarket_series
          where category=$1 and time_period=$2 and order_by=$3`,
        [window.category, window.timePeriod, window.orderBy],
      )
    ).rows[0];
    const traders = (
      await database.pool.query<{ pnl: string; vol: string }>(
        `select pnl::text as pnl, vol::text as vol
           from integration.polymarket_trader
          where category=$1 and time_period=$2 and order_by=$3
          order by rank::bigint asc`,
        [window.category, window.timePeriod, window.orderBy],
      )
    ).rows;
    const run: CompositeScoreRun = computeCompositeScore({
      window,
      seriesStatus: (series?.status ?? 'unknown') as CompositeScoreRun['seriesStatus'],
      traders,
      now,
      digest: sha256Hex(
        traders
          .map((row) => `${row.pnl}|${row.vol}`)
          .sort()
          .join('\n'),
      ),
    });
    // A versão é o MÁXIMO gravado na janela mais um, calculado no próprio
    // INSERT: dois jobs concorrentes que leiam o mesmo máximo tentam a mesma
    // versão, e o índice único recusa o segundo.
    await database.pool.query(
      `insert into integration.polymarket_score_run
         (category,time_period,order_by,version,series_status,score,eligible,reason,components,traders,digest,computed_at)
       select $1,$2,$3,coalesce((select max(version)+1 from integration.polymarket_score_run
                                   where category=$1 and time_period=$2 and order_by=$3),1),
         $4,$5::numeric,$6,$7,$8::jsonb,$9,$10,$11
       on conflict (category,time_period,order_by,version) do nothing`,
      [
        window.category,
        window.timePeriod,
        window.orderBy,
        run.seriesStatus,
        run.score,
        run.eligible,
        run.reason,
        JSON.stringify(run.components),
        run.traders,
        run.digest,
        now,
      ],
    );
    const version = (
      await database.pool.query<{ version: string }>(
        `select max(version)::text as version from integration.polymarket_score_run
          where category=$1 and time_period=$2 and order_by=$3`,
        [window.category, window.timePeriod, window.orderBy],
      )
    ).rows[0]!.version;
    return { version: Number(version), eligible: run.eligible };
  }

  return {
    listFavorites,
    addFavorite,
    removeFavorite,
    alertConfig,
    saveAlertConfig,
    runAlertsOnce,
    runScore,
  };
}

export type PolymarketAlertsService = ReturnType<typeof createPolymarketAlertsService>;
export { ALERT_LATENCY_TARGET_MS, POLYMARKET_FAVORITES_LIMIT };
