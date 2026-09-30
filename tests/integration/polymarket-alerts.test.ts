import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDatabase,
  createPolymarketAlertsService,
  createPolymarketStore,
  createTenantContext,
  requireDatabaseUrl,
  systemOrganizationContext,
  type Database,
  type OrganizationContext,
  type PolymarketAlertsService,
} from '../../packages/db/src/index.js';
import { migrateLocalDatabase } from '../../packages/db/src/migrate.js';
import { outsideQuietHours } from '../../packages/db/src/notifications.js';
import {
  ALERT_LATENCY_TARGET_MS,
  ALERT_WINDOW_MINUTES,
  POLYMARKET_FAVORITES_LIMIT,
  canonicalDecimalToken,
  leaderboardSourceKey,
  type LeaderboardWindow,
} from '../../packages/shared/src/index.js';

/**
 * STK-F2-16 §15 — favoritos, alertas e score contra o BANCO DE VERDADE.
 *
 * O teste unitário prova as regras; este prova o que só o Postgres prova:
 *
 *  - O LIMITE DE DEZ É O BANCO. A função pura decide a recusa, mas o que fecha
 *    a corrida entre dois pedidos simultâneos é o trigger
 *    `polymarket_favorite_limit`. O teste grava um INSERT direto — sem passar
 *    pela aplicação — e espera `23514`: é a prova de que a garantia não depende
 *    do chamador.
 *
 *  - FAVORITAR NÃO GRAVA CONFIG DE ALERTA. A tabela de configuração é lida
 *    depois de favoritar e continua vazia, com a resposta de produto
 *    `enabled: false`.
 *
 *  - A JANELA DE 5 MIN É O QUE AGRUPA. Duas leituras na MESMA janela não
 *    produzem delta; a leitura da janela SEGUINTE produz. E a primeira leitura
 *    de um trader establish a linha de base sem alertar — é o que impede
 *    "atividade" de ser o volume acumulado desde sempre.
 *
 *  - DEDUPE E COTA DIÁRIA SÃO DO BANCO. A chave única da fila impede o segundo
 *    alerta da mesma janela, e a cota é contada no dia LOCAL do usuário.
 *
 *  - QUIET HOURS ADIAM, NÃO DESCARTAM. O alerta gravado durante o silêncio
 *    continua `pending` com a hora deslocada, e o mesmo limite de cota.
 *
 *  - A LATÊNCIA É MEDIDA ENTRE INSTANTES GRAVADOS. O job é chamado com
 *    `now` injetado, e a latência devolvida é comparada com o alvo do card.
 *
 *  - O SCORE É VERSIONADO E RECUSA SÉRIE INCOMPLETA. Duas execuções gravam
 *    versões 1 e 2 (nunca sobrescrevem), e com a série `truncated` a versão é
 *    gravada COM recusa — a avaliação aconteceu e foi recusada.
 */

const sourceUrl = requireDatabaseUrl(process.env.TEST_DATABASE_URL);
const admin = createDatabase(sourceUrl, { statementTimeoutMs: 30_000 });

const WINDOW: LeaderboardWindow = { category: 'OVERALL', timePeriod: 'MONTH', orderBy: 'PNL' };

/** A carteira do trader observado, e as de favoritos que não precisam existir. */
const OBSERVED = '0x224a89dbe0db0d6124b335edabd15b3f877da3d5';
const wallet = (index: number) => `0x${String(index).padStart(40, '0')}`;

/** Um instante no dia, para as leituras de janela. */
const at = (iso: string) => new Date(iso);

describe('STK-F2-16 §15 — favoritos e alertas no banco', () => {
  let database: Database;
  let service: PolymarketAlertsService;
  let context: OrganizationContext;
  let otherContext: OrganizationContext;
  let name: string;
  // O contexto de tenant é construído no `beforeAll`, quando o `database`
  // existe. A variável é declarada aqui para que os helpers possam usá-la.
  let tenant: ReturnType<typeof createTenantContext>;

  /**
   * Uma organização com um usuário REAL em `auth."user"`, como o registry faz.
   *
   * O usuário tem de existir na tabela de autenticação antes do
   * `ensureOrganizationMembership`: o contexto de tenant é derivado do vínculo
   * usuário↔organização, e um id que não existe é `USER_NOT_FOUND`. Criar a
   * conta aqui (em vez de usar `systemOrganizationContext` com um id fictício)
   * é o que faz `notification.recipientOf` conseguir resolver o owner no job.
   */
  async function organizationFor(label: string): Promise<OrganizationContext> {
    const userId = `f216-${label}-${randomUUID()}`;
    await database.pool.query(`insert into auth."user"(id,name,email) values($1,$2,$3)`, [
      userId,
      `F2-16 ${label}`,
      `${userId}@stk.test`,
    ]);
    return tenant.ensureOrganizationMembership(userId);
  }

  /**
   * Um INSERT DIRETO no contexto da organização.
   *
   * As três tabelas desta tarefa têm `organization_id DEFAULT
   * current_setting('app.organization_id', true)::uuid`, então um INSERT feito
   * pelo pool sem o contexto recebe `NULL` e é recusado por NOT NULL. O teste
   * que prova que o BANCO recusa o décimo primeiro tem de escrever pelo mesmo
   * caminho que a aplicação — com o contexto — para estar provando o TETO e não
   * a ausência de contexto.
   */
  async function directInsert(
    org: OrganizationContext,
    sql: string,
    values: unknown[],
  ): Promise<{ rowCount: number | null }> {
    return tenant.withOrganizationTransaction(org, (client) => client.query(sql, values));
  }

  beforeAll(async () => {
    name = `stk_f216_${randomUUID().replaceAll('-', '')}`;
    if (!/^stk_f216_[a-f0-9]{32}$/.test(name)) throw new Error('INVALID_TEST_DATABASE');
    await admin.pool.query(`CREATE DATABASE "${name}"`);
    const url = new URL(sourceUrl);
    url.pathname = `/${name}`;
    database = createDatabase(url.toString(), { statementTimeoutMs: 30_000 });
    await migrateLocalDatabase(database);
    tenant = createTenantContext(database);
    service = createPolymarketAlertsService(database);
    context = await organizationFor('owner');
    otherContext = await organizationFor('other');
  });

  afterAll(async () => {
    await database?.close();
    await admin.pool.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.close();
  });

  /**
   * Ingere uma observação do trader pela MESMA chave que a F2-14 usaria.
   *
   * O `observed_at` é PASSADO, nunca `now()`: o job ordena as leituras por
   * `observed_at`, e um relógio de teste que avança sozinho tornaria o delta
   * dependente da velocidade da máquina. Com o instante declarado, "a leitura
   * das 12:05 é mais nova que a das 12:00" é um fato do teste, não uma
   * coincidência de agendamento.
   */
  async function ingest(
    vol: string,
    pnl = '1000',
    observedAt = '2026-09-29T12:00:00.000Z',
  ): Promise<void> {
    const store = createPolymarketStore(database);
    const seriesId = await store.upsertSeries({
      window: WINDOW,
      windowFrom: at('2026-04-01T00:00:00Z'),
      windowTo: at('2026-09-29T00:00:00Z'),
      backfillFrom: '2026-04-01',
    });
    const entry = {
      rank: '1',
      proxyWallet: OBSERVED,
      userName: 'wr0ngw4yb3tt0r',
      xUsername: '',
      verifiedBadge: false,
      profileImage: '',
      vol,
      pnl,
    };
    await database.pool.query(
      `insert into integration.polymarket_trader
         (proxy_wallet,user_name,x_username,profile_image,verified_badge,
          source_key,vol,pnl,rank,category,time_period,order_by,observed_at)
       values ($1,$2,$3,$4,$5,$6,$7::numeric,$8::numeric,$9,$10,$11,$12,$13::timestamptz)
       on conflict (source_key) do nothing`,
      [
        OBSERVED,
        entry.userName,
        '',
        '',
        false,
        // A chave inclui o instante da observação: cada leitura é uma
        // observação DISTINTA, e é essa distinção que produz o delta na
        // janela seguinte. Sem o instante, dois testes que observam o MESMO
        // volume em janelas diferentes colidiriam e o segundo não existiria.
        `${leaderboardSourceKey(entry, WINDOW)}|${vol}|${observedAt}`,
        vol,
        pnl,
        '1',
        WINDOW.category,
        WINDOW.timePeriod,
        WINDOW.orderBy,
        observedAt,
      ],
    );
    await store.closeSeries({
      seriesId,
      window: WINDOW,
      status: 'complete',
      cursor: 0,
      quantity: 1,
      pages: 1,
      failedPages: 0,
      errors: [],
    });
  }

  // -------------------------------------------------------------------------
  // 1) O limite de dez é do BANCO
  // -------------------------------------------------------------------------
  it('o DÉCIMO SEGUNDO favorito é RECUSADO pelo trigger do banco', async () => {
    for (let index = 0; index < POLYMARKET_FAVORITES_LIMIT; index += 1)
      await service.addFavorite(context, context.userId, {
        proxyWallet: wallet(100 + index),
        userName: `trader_${index}`,
      });
    const list = await service.listFavorites(context, context.userId);
    expect(list.used).toBe(POLYMARKET_FAVORITES_LIMIT);
    expect(list.limit).toBe(POLYMARKET_FAVORITES_LIMIT);

    // A aplicação recusa pelo código estável.
    await expect(
      service.addFavorite(context, context.userId, {
        proxyWallet: wallet(200),
        userName: 'excedente',
      }),
    ).rejects.toMatchObject({ code: 'FAVORITES_LIMIT_REACHED' });

    // E o BANCO recusa um INSERT DIRETO, sem passar pela aplicação: é esta
    // prova que a garantia é do banco e não da disciplina do chamador.
    await expect(
      directInsert(
        context,
        `insert into integration.polymarket_favorite (user_id,proxy_wallet,user_name)
         values ($1,$2,'excedente')`,
        [context.userId, wallet(201)],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    // E a contagem NÃO mudou depois das duas recusas.
    expect((await service.listFavorites(context, context.userId)).used).toBe(
      POLYMARKET_FAVORITES_LIMIT,
    );
  });

  it('o limite é POR USUÁRIO: a outra conta tem os seus dez', async () => {
    for (let index = 0; index < POLYMARKET_FAVORITES_LIMIT; index += 1)
      await service.addFavorite(otherContext, otherContext.userId, {
        proxyWallet: wallet(300 + index),
        userName: `outro_${index}`,
      });
    const other = await service.listFavorites(otherContext, otherContext.userId);
    expect(other.used).toBe(POLYMARKET_FAVORITES_LIMIT);
    // E o usuário cheio continua cheio: as listas NÃO se misturam.
    expect((await service.listFavorites(context, context.userId)).used).toBe(
      POLYMARKET_FAVORITES_LIMIT,
    );
  });

  it('re-favoritar devolve o MESMO registro, e a lista não cresce', async () => {
    const before = await service.listFavorites(context, context.userId);
    const again = await service.addFavorite(context, context.userId, {
      proxyWallet: before.favorites[0]!.proxyWallet,
      userName: 'outro nome',
    });
    expect(again.created).toBe(false);
    expect(again.favorite.id).toBe(before.favorites[0]!.id);
    // O nome NÃO foi sobrescrito: o que a origem publicou é o que fica.
    expect(again.favorite.userName).toBe(before.favorites[0]!.userName);
    expect((await service.listFavorites(context, context.userId)).used).toBe(before.used);
  });

  it('remover o que não está nos favoritos é recusa, não sucesso silencioso', async () => {
    await expect(
      service.removeFavorite(context, context.userId, wallet(999)),
    ).rejects.toMatchObject({ code: 'FAVORITE_NOT_FOUND' });
  });

  // -------------------------------------------------------------------------
  // 2) Favoritar não ativa alerta
  // -------------------------------------------------------------------------
  it('favoritar NENHUM usuário cria configuração de alerta', async () => {
    const fresh = await organizationFor('fresh');
    await service.addFavorite(fresh, fresh.userId, {
      proxyWallet: wallet(400),
      userName: 'somente favorito',
    });
    // A configuração ausente responde o PADRÃO do produto, e o padrão é
    // DESLIGADO. A linha na tabela também não existe — nada foi criado.
    const config = await service.alertConfig(fresh, fresh.userId);
    expect(config.enabled).toBe(false);
    const rows = await database.pool.query<{ n: string }>(
      `select count(*)::text as n from integration.polymarket_alert_config
        where "organization_id"=$1 and user_id=$2`,
      [fresh.organizationId, fresh.userId],
    );
    expect(Number(rows.rows[0]!.n)).toBe(0);
  });

  it('a configuração grava é RELIDA do banco, com o limiar canônico', async () => {
    const user = await organizationFor('config');
    const saved = await service.saveAlertConfig(user, user.userId, {
      enabled: true,
      threshold: '2500.75',
      dailyLimit: 3,
    });
    expect(saved.enabled).toBe(true);
    // O `numeric(38, 18)` volta com a escala CHEIA; a leitura canonicaliza, e
    // o valor continua sendo o que foi gravado.
    expect(saved.threshold).toBe('2500.75');
    expect(saved.dailyLimit).toBe(3);
    expect(saved.windowMinutes).toBe(ALERT_WINDOW_MINUTES);
    const reread = await service.alertConfig(user, user.userId);
    expect(reread.threshold).toBe(canonicalDecimalToken('2500.750000000000000000'));
  });

  it('o CHECK do banco IMPEDE um limiar não positivo e uma janela fora do card', async () => {
    const user = await organizationFor('check');
    await expect(
      service.saveAlertConfig(user, user.userId, { enabled: true, threshold: '0' }),
    ).rejects.toMatchObject({ code: 'ALERT_CONFIG_INVALID' });
    // A janela é FIXA no banco: um INSERT direto para 15 é recusado.
    await expect(
      directInsert(
        user,
        `insert into integration.polymarket_alert_config
           (user_id,enabled,threshold,daily_limit,window_minutes)
         values ($1,false,1000,10,15)`,
        [user.userId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  // -------------------------------------------------------------------------
  // 3) A janela de 5 min, a linha de base e o líquido
  // -------------------------------------------------------------------------
  it('a PRIMEIRA leitura de um favorito é linha de base e NÃO alerta', async () => {
    const user = await organizationFor('base');
    const org = systemOrganizationContext(user.organizationId);
    await service.saveAlertConfig(user, user.userId, { enabled: true, threshold: '1' });
    await preferencesQuiet(org, user.userId);
    await service.addFavorite(user, user.userId, { proxyWallet: OBSERVED, userName: 'base' });

    await ingest('1000');
    const first = await service.runAlertsOnce(org, user.userId, at('2026-09-29T12:01:00.000Z'));
    expect(first.observed).toBe(1);
    // Limiar de 1 e mesmo assim nada: não há leitura ANTERIOR, então não há
    // delta. O volume acumulado NÃO é atividade.
    expect(first.enqueued).toBe(0);
  });

  /**
   * A preferência de silêncio do usuário, com a janela VAZIA (00:00→00:00),
   * que é a forma da F2-10 dizer "nunca silencioso".
   *
   * A escrita passa pelo contexto da organização: `notification.preference`
   * também tem `organization_id DEFAULT current_setting(...)`, então um INSERT
   * pelo pool sem contexto seria recusado por NOT NULL — e o teste estaria
   * provando a ausência de contexto em vez da regra de silêncio.
   */
  async function preferencesQuiet(org: OrganizationContext, userId: string): Promise<void> {
    await directInsert(
      org,
      `insert into notification.preference
         (user_id,timezone,quiet_hours_start,quiet_hours_end,topics)
       values ($1,'America/Sao_Paulo',0,0,'{}'::jsonb)
       on conflict ("organization_id","user_id") do update set
         quiet_hours_start=0, quiet_hours_end=0`,
      [userId],
    );
  }

  it('o DELTA da janela seguinte dispara, e a MESMA janela não', async () => {
    const user = await organizationFor('delta');
    const org = systemOrganizationContext(user.organizationId);
    await service.saveAlertConfig(user, user.userId, { enabled: true, threshold: '1000' });
    await preferencesQuiet(org, user.userId);
    await service.addFavorite(user, user.userId, { proxyWallet: OBSERVED, userName: 'delta' });

    // Janela 12:00–12:05: primeira leitura, linha de base com volume 1000.
    await ingest('1000', '1000', '2026-09-29T12:00:00.000Z');
    await service.runAlertsOnce(org, user.userId, at('2026-09-29T12:01:00.000Z'));
    // Mesmo volume na MESMA janela: delta zero, e o job é idempotente.
    await service.runAlertsOnce(org, user.userId, at('2026-09-29T12:04:00.000Z'));

    // A origem passa a publicar 2000 em 12:05. O passe das 12:06 observa a
    // janela 12:05–12:10 e o delta contra a linha de base de 12:00 é
    // exatamente 1000 — o limiar do card.
    await ingest('2000', '1000', '2026-09-29T12:05:00.000Z');
    const fired = await service.runAlertsOnce(org, user.userId, at('2026-09-29T12:06:00.000Z'));
    expect(fired.enqueued).toBe(1);
    expect(fired.maxLatencyMs).toBeLessThanOrEqual(ALERT_LATENCY_TARGET_MS);
    // A latência MEDIDA: a janela reportada é a 12:00–12:05 (a que fechou), o
    // alerta saiu às 12:06, então 60 s — o intervalo real do worker, dentro do
    // alvo de 5 min.
    expect(fired.maxLatencyMs).toBe(60_000);

    const queued = await database.pool.query<{ n: string; scheduled_for: Date }>(
      `select count(*)::text as n, max("scheduled_for") as "scheduled_for"
         from notification.outbox
        where "organization_id"=$1 and "user_id"=$2 and topic='polymarket_activity'`,
      [org.organizationId, user.userId],
    );
    expect(Number(queued.rows[0]!.n)).toBe(1);
  });

  it('o MESMO trader na MESMA janela é alertado UMA vez (dedupe do banco)', async () => {
    const user = await organizationFor('dedupe');
    const org = systemOrganizationContext(user.organizationId);
    await service.saveAlertConfig(user, user.userId, { enabled: true, threshold: '1' });
    await preferencesQuiet(org, user.userId);
    await service.addFavorite(user, user.userId, { proxyWallet: OBSERVED, userName: 'dedupe' });

    // A linha de base do trader é gravada na janela 13:00–13:05 com volume 1000.
    await ingest('1000', '1000', '2026-09-29T13:00:00.000Z');
    await service.runAlertsOnce(org, user.userId, at('2026-09-29T13:01:00.000Z'));
    // Na janela 13:05–13:10 o volume observado é 2000, e o delta contra a
    // janela 13:00 é exatamente 1000 (o limiar). Três passes dentro da MESMA
    // janela de observação produzem a MESMA chave de dedupe: o primeiro
    // dispara e os outros dois colidem com a chave única.
    await ingest('2000', '1000', '2026-09-29T13:05:00.000Z');
    const first = await service.runAlertsOnce(org, user.userId, at('2026-09-29T13:06:00.000Z'));
    const second = await service.runAlertsOnce(org, user.userId, at('2026-09-29T13:07:00.000Z'));
    const third = await service.runAlertsOnce(org, user.userId, at('2026-09-29T13:08:00.000Z'));
    expect(first.enqueued).toBe(1);
    expect(second.enqueued).toBe(0);
    expect(third.enqueued).toBe(0);
    const rows = await database.pool.query<{ n: string }>(
      `select count(*)::text as n from notification.outbox
        where "organization_id"=$1 and "user_id"=$2 and topic='polymarket_activity'`,
      [org.organizationId, user.userId],
    );
    expect(Number(rows.rows[0]!.n)).toBe(1);
  });

  it('a COTA DIÁRIA é contada no dia LOCAL e para de enfileirar', async () => {
    const user = await organizationFor('quota');
    const org = systemOrganizationContext(user.organizationId);
    // Cota de DOIS por dia, e silêncio NUNCA (00:00–00:00 = janela vazia).
    await service.saveAlertConfig(user, user.userId, {
      enabled: true,
      threshold: '1',
      dailyLimit: 2,
    });
    await preferencesQuiet(org, user.userId);
    await service.addFavorite(user, user.userId, { proxyWallet: OBSERVED, userName: 'cota' });

    // Seis janelas de 5 min com alta de 1000 em cada: só DUAS entram. Cada
    // iteração observa a janela anterior, e o volume novo é ingerido ANTES do
    // passe — o instante de observação é declarado, nunca o relógio da máquina.
    let enqueued = 0;
    let skipped = 0;
    await ingest('1000', '1000', '2026-09-29T14:00:00.000Z');
    await service.runAlertsOnce(org, user.userId, at('2026-09-29T14:01:00.000Z'));
    for (let step = 1; step <= 6; step += 1) {
      const minute = 14 * 60 + step * 5;
      const hour = String(Math.floor(minute / 60)).padStart(2, '0');
      const rest = String(minute % 60).padStart(2, '0');
      const windowStart = `2026-09-29T${hour}:${rest}:00.000Z`;
      await ingest(String(1000 * (step + 1)), '1000', windowStart);
      const result = await service.runAlertsOnce(
        org,
        user.userId,
        at(`2026-09-29T${hour}:${rest}:01.000Z`),
      );
      enqueued += result.enqueued;
      skipped += result.skipped;
    }
    expect(enqueued).toBe(2);
    expect(skipped).toBeGreaterThan(0);
    // A cota é do dia LOCAL: 14:00Z é 11:00 em São Paulo, o mesmo dia civil.
    const counted = await database.pool.query<{ n: string }>(
      `select count(*)::text as n from notification.outbox
        where "organization_id"=$1 and "user_id"=$2 and topic='polymarket_activity'
          and ("scheduled_for" at time zone 'America/Sao_Paulo')::date = '2026-09-29'`,
      [org.organizationId, user.userId],
    );
    expect(Number(counted.rows[0]!.n)).toBe(2);
  });

  it('QUIET HOURS adiam o alerta em vez de descartar', async () => {
    const user = await organizationFor('quiet');
    const org = systemOrganizationContext(user.organizationId);
    await service.saveAlertConfig(user, user.userId, { enabled: true, threshold: '1' });
    // Silêncio o dia INTEIRO: a janela circular 00:00→1439 cobre todas as
    // horas do dia, e o alerta tem de ser ADIADO, nunca descartado.
    await directInsert(
      org,
      `insert into notification.preference
         (user_id,timezone,quiet_hours_start,quiet_hours_end,topics)
       values ($1,'America/Sao_Paulo',0,1439,'{}'::jsonb)
       on conflict ("organization_id","user_id") do update set
         quiet_hours_start=0, quiet_hours_end=1439`,
      [user.userId],
    );
    await service.addFavorite(user, user.userId, { proxyWallet: OBSERVED, userName: 'quiet' });

    await ingest('1000', '1000', '2026-09-29T15:00:00.000Z');
    await service.runAlertsOnce(org, user.userId, at('2026-09-29T15:01:00.000Z'));
    await ingest('2000', '1000', '2026-09-29T15:05:00.000Z');
    // A janela reportada é 15:00–15:05 e o alerta sai às 15:06, já no silêncio:
    // ele tem de ser ADIADO, nunca descartado.
    const result = await service.runAlertsOnce(org, user.userId, at('2026-09-29T15:06:00.000Z'));
    // O alerta FOI enfileirado (descartar seria perder informação) e ficou
    // `deferred`: a decisão registra o adiamento para a auditoria.
    expect(result.enqueued).toBe(1);
    expect(result.deferred).toBe(1);
    // E ele está `pending`, nunca `delivered`: silêncio adia entrega, não marca
    // o alerta como entregue.
    const rows = await database.pool.query<{ state: string }>(
      `select state from notification.outbox
        where "organization_id"=$1 and "user_id"=$2 and topic='polymarket_activity'`,
      [org.organizationId, user.userId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.state).toBe('pending');
  });

  it('silêncio que NÃO tem saída mantém o instante: adiar para sempre seria esconder', () => {
    // Com o silêncio cobrindo o dia inteiro, `outsideQuietHours` varre 48 h e
    // não encontra minuto fora da janela. A FUNÇÃO DA F2-10 devolve o instante
    // original de propósito, e o job reavalia no passe seguinte — um alerta
    // adiado indefinidamente seria o mesmo que um alerta descartado, só mais
    // difícil de notar.
    const instant = at('2026-09-29T15:06:00.000Z');
    const outside = outsideQuietHours(instant, {
      timezone: 'America/Sao_Paulo',
      quietHoursStart: 0,
      quietHoursEnd: 1439,
    });
    expect(outside).toBe(instant);
  });

  it('alerta DESLIGADO não observa nem grava nada', async () => {
    const user = await organizationFor('off');
    const org = systemOrganizationContext(user.organizationId);
    await service.addFavorite(user, user.userId, { proxyWallet: OBSERVED, userName: 'off' });
    const result = await service.runAlertsOnce(org, user.userId, at('2026-09-29T16:01:00.000Z'));
    expect(result).toEqual({ observed: 0, enqueued: 0, skipped: 0, deferred: 0, maxLatencyMs: 0 });
    const rows = await database.pool.query<{ n: string }>(
      `select count(*)::text as n from integration.polymarket_activity_window
        where "organization_id"=$1 and user_id=$2`,
      [org.organizationId, user.userId],
    );
    expect(Number(rows.rows[0]!.n)).toBe(0);
  });

  it('o job de UM tenant não vê o favorito de OUTRO', async () => {
    const mine = await organizationFor('iso-a');
    const theirs = await organizationFor('iso-b');
    await service.saveAlertConfig(mine, mine.userId, { enabled: true, threshold: '1' });
    await preferencesQuiet(systemOrganizationContext(mine.organizationId), mine.userId);
    // O favorito de A; o job roda no contexto de B, que não o tem.
    await service.addFavorite(mine, mine.userId, { proxyWallet: OBSERVED, userName: 'iso' });
    const other = await service.runAlertsOnce(
      systemOrganizationContext(theirs.organizationId),
      theirs.userId,
      at('2026-09-29T17:01:00.000Z'),
    );
    expect(other.observed).toBe(0);
    expect((await service.listFavorites(theirs, theirs.userId)).used).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 4) O Composite Score: versão, recusa e paralelo
  // -------------------------------------------------------------------------
  it('o score é VERSIONADO: duas execuções gravam 1 e 2, sem sobrescrever', async () => {
    const first = await service.runScore(at('2026-09-29T12:00:00.000Z'));
    const second = await service.runScore(at('2026-09-29T12:05:00.000Z'));
    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    const rows = await database.pool.query<{ version: string; score: string | null }>(
      `select version::text as version, score::text as score
         from integration.polymarket_score_run order by version asc`,
    );
    // As DUAS versões coexistem: é isso que torna o histórico confiável.
    expect(rows.rows.map((row) => row.version)).toEqual(['1', '2']);
    // E a completude gravada pela F2-14 é a que a versão carrega.
    expect(rows.rows[0]!.score).not.toBeNull();
  });

  it('com a série TRUNCADA, a versão é gravada COM a recusa', async () => {
    const store = createPolymarketStore(database);
    const seriesId = await store.upsertSeries({
      window: WINDOW,
      windowFrom: at('2026-04-01T00:00:00Z'),
      windowTo: at('2026-09-29T00:00:00Z'),
      backfillFrom: '2026-04-01',
    });
    await store.closeSeries({
      seriesId,
      window: WINDOW,
      status: 'truncated',
      cursor: 0,
      quantity: 1,
      pages: 1,
      failedPages: 0,
      errors: [],
    });
    const run = await service.runScore(at('2026-09-29T12:10:00.000Z'));
    expect(run.eligible).toBe(false);
    const row = (
      await database.pool.query<{
        score: string | null;
        eligible: boolean;
        reason: string;
        series_status: string;
      }>(
        `select score::text as score,eligible,reason,"series_status"
           from integration.polymarket_score_run where version=$1`,
        [run.version],
      )
    ).rows[0]!;
    // A avaliação ACONTECEU e foi recusada: existe versão, com motivo, e o
    // score é `null` (não zero, que seria um score que ninguém calculou).
    expect(row.score).toBeNull();
    expect(row.eligible).toBe(false);
    expect(row.reason).toContain('truncada ou incompleta');
    expect(row.series_status).toBe('truncated');
    // Devolve a série para `complete` para não afetar os testes seguintes.
    await store.closeSeries({
      seriesId,
      window: WINDOW,
      status: 'complete',
      cursor: 0,
      quantity: 1,
      pages: 1,
      failedPages: 0,
      errors: [],
    });
  });

  it('o CHECK do banco RECUSA um score sem motivo de recusa', async () => {
    // A invariante é ilegível se não for o banco que a impõe: `eligible = false`
    // com `reason = null` seria um score recusado que ninguém sabe por quê.
    await expect(
      database.pool.query(
        `insert into integration.polymarket_score_run
           (category,time_period,order_by,version,series_status,score,eligible,reason,components,traders,digest,computed_at)
         values ('OVERALL','MONTH','PNL',999,'truncated',null,false,null,'[]'::jsonb,1,$1,now())`,
        ['d'.repeat(64)],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('a versão do score é ÚNICA por janela: o índice único decide', async () => {
    await expect(
      database.pool.query(
        `insert into integration.polymarket_score_run
           (category,time_period,order_by,version,series_status,score,eligible,reason,components,traders,digest,computed_at)
         values ('OVERALL','MONTH','PNL',1,'complete',0.5,true,null,'[]'::jsonb,1,$1,now())`,
        ['e'.repeat(64)],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('a 0029 é a ÚLTIMA entrada do journal e tem idx coerente', async () => {
    // O número é RESERVADO para esta tarefa: se outra branch tivesse tomado a
    // 0029, este teste falharia com a tag errada em vez de deixar a colisão
    // passar despercebida.
    const journal = JSON.parse(
      readFileSync(
        new URL('../../packages/db/migrations/meta/_journal.json', import.meta.url),
        'utf8',
      ),
    ) as { entries: { idx: number; tag: string }[] };
    const last = journal.entries[journal.entries.length - 1]!;
    expect(last.tag).toBe('0029_polymarket_favorites');
    expect(last.idx).toBe(journal.entries.length - 1);
  });
});
