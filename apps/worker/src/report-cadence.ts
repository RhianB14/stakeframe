import { setTimeout as delay } from 'node:timers/promises';
import {
  createEntitlementService,
  createNotificationService,
  createReportSnapshotService,
  createTenantContext,
  reportTimezoneOf,
  sanitizeReportDeliveryError,
  systemOrganizationContext,
  type Database,
  type NotificationService,
  type OrganizationContext,
} from '@stakeframe/db';
import {
  AUTOMATIC_CADENCE_BY_PLAN,
  DEFAULT_PLAN_ID,
  reportPeriodIsDue,
  reportPrivateLink,
  reportTelegramSummary,
  type PlanId,
} from '@stakeframe/shared';
import { TelegramOperationError, createTelegramClient, type TelegramConfig } from './telegram.js';

// STK-F2-08 — o job de CADÊNCIA do relatório, no worker existente.
//
// O job faz quatro coisas, e a ordem delas é a garantia:
//
//  1) DESCobre o PLANO pelo banco. A F2-13 resolve o plano efetivo em
//     `core.organization_entitlements`, e o catálogo `AUTOMATIC_CADENCE_BY_PLAN`
//     diz o que aquele plano envia. Nada aqui presume plano: organização sem
//     atribuição cai em `free`, que não envia nada — a resposta mais restritiva
//     é a que um tenant novo recebe.
//
//  2) Verifica o FUSO E O HORÁRIO do usuário. O job roda a cada 5 minutos e
//     compara o relógio local dele com o horário do produto (diário 21h,
//     semanal segunda 9h, mensal dia 1 9h). O "já passou" em vez de "exatamente
//     às" evita perder o envio quando o worker atrasa, e a DEDUPE é o que
//     impede que "atravessou 21h" vire três envios.
//
//  3) SEM DADOS NÃO ENVIA. O serviço devolve `null` para uma janela sem apostas
//     e o job segue para a próxima cadência. Um relatório de R$ 0,00 seria a
//     afirmação falsa de que o usuário apostou e não perdeu nada.
//
//  4) RESERVA ANTES DE ENVIAR. A reserva é um INSERT com chave única
//     (janela × versão financeira); se ela colide, outro passe já reservou e
//     este não envia. A reserva vem ANTES da chamada ao Telegram porque o
//     inverso permitiria dois envios quando dois workers rodassem juntos.
//
// Nenhuma chamada de IA: a narrativa do relatório é determinística (§6.2).

type Client = ReturnType<typeof createTelegramClient>;

/** Intervalo do laço. Cinco minutos resolvem a granularidade do "já passou". */
const DEFAULT_INTERVAL_MS = 300_000;

export function createReportCadenceJob(
  database: Database,
  client: Client,
  config: TelegramConfig,
  deps: { now?: () => Date } = {},
) {
  const tenant = createTenantContext(database);
  const snapshots = createReportSnapshotService(database);
  const entitlements = createEntitlementService(database);
  const notifications: NotificationService = createNotificationService(database);

  /** O plano efetivo do tenant, resolvido pelo BANCO (F2-13), nunca presumido. */
  async function planOf(organizationId: string): Promise<PlanId> {
    const list = await entitlements.entitlements(organizationId);
    // A função do banco devolve uma linha por recurso do plano, todas com o
    // mesmo `plan`. Uma lista vazia é organização inexistente — que a F2-13
    // trata como "nada", e que aqui vira o plano mais restritivo, nunca um
    // plano inventado.
    return (list[0]?.plan ?? DEFAULT_PLAN_ID) as PlanId;
  }

  /**
   * O fuso do RECEBE, não o do servidor. O destinatário é o `owner` mais
   * antigo da organização (o mesmo que a F2-10 usa para as quiet hours): o job
   * envia para o dono, e é o fuso dele que decide a hora.
   *
   * A preferência do usuário é a FONTE do fuso — a MESMA tabela que a F2-10 lê,
   * e a mesma função `reportTimezoneOf`. Sem preferência gravada, vale o padrão
   * explícito do produto (São Paulo), e um fuso INVÁLIDO gravado é tratado como
   * ausente: `reportPeriodIsDue` devolve `false` para fuso inválido, então o
   * job não envia em vez de enviar no horário errado.
   */
  async function timezoneOf(context: OrganizationContext): Promise<{
    userId: string;
    timezone: string;
  }> {
    const userId = await notifications.recipientOf(context);
    return { userId, timezone: await reportTimezoneOf(database, context, userId) };
  }

  /**
   * Um passe para UMA organização.
   *
   * Devolve quantos relatórios foram ENTREGES (não quantos foram gerados): o
   * número de um job de entrega é o que o operador precisa ver, e um snapshot
   * gerado sem envio por falta de dados não é entrega nenhuma.
   */
  async function runOnce(context: OrganizationContext): Promise<number> {
    const now = deps.now ? deps.now() : new Date();
    const plan = await planOf(context.organizationId);
    const periods = AUTOMATIC_CADENCE_BY_PLAN[plan];
    // Plano sem cadência automática (o `free`): o job não gera, não reserva e
    // não envia. O resumo mensal do Free é SOB DEMANDA, pelo `/relatorio`.
    if (!periods.length) return 0;
    const { userId, timezone } = await timezoneOf(context);
    const due = periods.filter((period) => reportPeriodIsDue(period, now, timezone));
    if (!due.length) return 0;

    const pending = await snapshots.due(context, { periods: due, timezone, now });
    if (!pending.length) return 0;
    // O link é a ROTA PRIVADA do produto: exige sessão, não carrega token e
    // não é uma URL pública temporária (§4.3, D020). Ele é o MESMO para todas
    // as cadências — é o endereço da página, não do documento — e por isso é
    // calculado uma vez por passe.
    const link = reportPrivateLink(config.miniAppUrl);
    let delivered = 0;
    for (const item of pending) {
      const reserved = await snapshots.reserveDelivery(context, {
        snapshot: item.snapshot,
        userId,
        scheduledFor: now,
      });
      // `null` = a dedupe já reservou: outro passe já resolveu esta janela.
      if (!reserved) continue;
      try {
        await client.sendMessage(
          Number(config.chatId),
          reportTelegramSummary({
            period: item.snapshot.period,
            from: item.snapshot.from,
            to: item.snapshot.to,
            metrics: item.snapshot.metrics,
            minSample: item.snapshot.narrative.minSample,
            link,
          }),
        );
        await snapshots.completeDelivery(context, reserved.id, { delivered: true });
        delivered += 1;
      } catch (error) {
        // A falha do canal devolve a reserva para a fila com backoff: o
        // relatório continua pendente e será reenviado, e NUNCA é marcado
        // como entregue sem ter chegado.
        await snapshots.completeDelivery(context, reserved.id, {
          failed: sanitizeReportDeliveryError(
            error instanceof TelegramOperationError ? error.code : error,
          ),
        });
      }
    }
    return delivered;
  }

  /** Infraestrutura: um passe por todas as organizações. */
  async function tick(): Promise<number> {
    let delivered = 0;
    for (const context of await tenant.listOrganizations()) {
      delivered += await runOnce(systemOrganizationContext(context.organizationId));
    }
    return delivered;
  }

  return { tick, runOnce, planOf, timezoneOf, snapshots, entitlements };
}

export function startReportCadence(
  database: Database,
  config: TelegramConfig,
  intervalMs = DEFAULT_INTERVAL_MS,
) {
  const client = createTelegramClient(config);
  const job = createReportCadenceJob(database, client, config);
  const controller = new AbortController();
  const task = (async () => {
    while (!controller.signal.aborted) {
      try {
        await job.tick();
      } catch {
        // Falha de um tenant não derruba o job dos outros; o log é sanitizado
        // e nenhum conteúdo de relatório aparece.
        console.warn('REPORT_CADENCE_TICK_FAILED');
      }
      await delay(intervalMs, undefined, { signal: controller.signal }).catch(() => undefined);
    }
  })();
  return {
    check() {
      if (controller.signal.aborted) throw new Error('REPORT_CADENCE_STOPPED');
    },
    async stop() {
      controller.abort();
      await task;
    },
    config,
    job,
  };
}
