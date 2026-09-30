import { setTimeout as delay } from 'node:timers/promises';
import {
  createNotificationService,
  createPolymarketAlertsService,
  createTenantContext,
  systemOrganizationContext,
  type Database,
  type NotificationService,
  type OrganizationContext,
} from '@stakeframe/db';
import {
  createDisabledNotificationChannel,
  readNotificationChannelConfig,
  type NotificationChannel,
  type NotificationDelivery,
} from './notification-channel.js';

// STK-F2-16 — o job de alerta de atividade Polymarket e o Composite Score
// silencioso, no worker existente.
//
// São DOIS passes independentes, e a separação é deliberada:
//
//  1. O PASSE DE ALERTA itera as organizações como os demais jobs de
//     infraestrutura: cada favorito pertence a um tenant e a transação usa o
//     contexto daquela organização. O canal é o MESMO da F2-10 e nasce
//     DESABILITADO (fail-closed, ver notification-channel.ts) até a entrega
//     existir. Uma entrega que falha NÃO marca o alerta como entregue: ele
//     volta para `pending` com backoff.
//
//  2. O PASSE DE SCORE roda SEM organização e SEM usuário: ele lê a série
//     pública da F2-14, calcula e grava a versão. Ele não entrega nada, não
//     publica nada e não é lido por nenhuma rota. É o "avaliado em PARALELO" do
//     card, e o intervalo dele é o mesmo do alerta porque a cadência de um job
//     de infraestrutura não deve ser uma segunda configuração.
//
// O intervalo padrão de 60 s é o que sustenta a LATÊNCIA-ALVO de 5 min do card:
// um passe que roda a cada minuto encontra a janela de 5 min no máximo um
// minuto depois de fechar, então a latência observada é de 0 a 60 s — dentro do
// alvo com folga. O teste §15 prova isso com instantes INJETADOS, sem esperar.

export function createPolymarketAlertsJob(database: Database, channel: NotificationChannel) {
  const notifications: NotificationService = createNotificationService(database);
  const alerts = createPolymarketAlertsService(database);
  const tenant = createTenantContext(database);

  /**
   * Um passe para UMA organização. O contexto nunca vem do cliente: o worker
   * resolve a organização pela lista do registro e monta o contexto de sistema.
   */
  async function runOnce(context: OrganizationContext): Promise<number> {
    // O destinatário é o usuário da organização (a fila, a cota diária e as
    // quiet hours são dele), resolvido do registry — nunca do rótulo
    // `system:worker`, cuja preferência não existe.
    const recipientId = await notifications.recipientOf(context);
    // O job de avaliação roda ANTES da entrega: um alerta que o job nem
    // enfileirou não pode ser entregue, e a ordem inversa entregaria a fila
    // antiga antes de decidir se há algo novo.
    await alerts.runAlertsOnce(context, recipientId);
    let delivered = 0;
    // Limite por passe: um tenant com muitos alertas não pode travar o laço dos
    // demais. O restante fica na fila para o próximo ciclo.
    for (let guard = 0; guard < 20; guard += 1) {
      const due = await notifications.claimDue(context);
      if (!due) break;
      try {
        // A etiqueta entregue é a do alerta RECLAMADO, nunca uma fixa: um
        // `topic: 'freebet_expiring'` hardcoded rotularia todo alerta como
        // expiração de freebet, e o usuário receberia uma mensagem com o texto
        // errado sobre o assunto errado. O TÍTULO e o CORPO vão junto, pelo
        // mesmo motivo.
        await channel.deliver({
          topic: due.topic as NotificationDelivery['topic'],
          subjectId: due.subject_id,
          title:
            due.topic === 'polymarket_activity'
              ? 'Atividade alta de trader favorito'
              : 'Freebet próxima da expiração',
          body:
            due.topic === 'polymarket_activity'
              ? 'Um trader que você favoritou atingiu o limiar de atividade da janela de 5 min.'
              : 'Uma freebet registrada está perto de expirar.',
        });
        delivered += 1;
      } catch {
        // O claim reservou o alerta; a recusa do canal precisa devolvê-lo à
        // fila, senão ele ficaria marcado como entregue sem nunca ter chegado.
        await notifications.restore(due.id, context);
        break;
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

  /**
   * O score é global e não tem dono: uma vez por passe, sem contexto de
   * organização, porque o dado que ele avalia (a série pública da F2-14) é o
   * mesmo para qualquer conta.
   */
  async function tickScore(): Promise<{ version: number; eligible: boolean }> {
    return alerts.runScore();
  }

  return { tick, tickScore, runOnce, alerts, notifications };
}

export function startPolymarketAlerts(
  database: Database,
  env: NodeJS.ProcessEnv,
  intervalMs = 60_000,
) {
  // Flag desconhecida derruba o worker (fail-closed) em vez de enviar pela metade.
  const config = readNotificationChannelConfig(env);
  const channel = createDisabledNotificationChannel(config.name);
  const job = createPolymarketAlertsJob(database, channel);
  const controller = new AbortController();
  const task = (async () => {
    while (!controller.signal.aborted) {
      try {
        await job.tick();
      } catch {
        // Falha de um tenant não derruba o job dos outros; o log é sanitizado.
        console.warn('POLYMARKET_ALERTS_TICK_FAILED');
      }
      // O score é avaliado no MESMO laço e depois das Organizações: um erro
      // no passe de tenant não pode impedir a avaliação paralela, que é
      // justamente o que roda sem depender de nenhuma conta.
      try {
        await job.tickScore();
      } catch {
        console.warn('POLYMARKET_SCORE_TICK_FAILED');
      }
      await delay(intervalMs, undefined, { signal: controller.signal }).catch(() => undefined);
    }
  })();
  return {
    check() {
      if (controller.signal.aborted) throw new Error('POLYMARKET_ALERTS_STOPPED');
    },
    async stop() {
      controller.abort();
      await task;
    },
    config,
    channel,
  };
}
