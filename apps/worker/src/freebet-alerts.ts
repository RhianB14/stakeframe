import { setTimeout as delay } from 'node:timers/promises';
import {
  createNotificationService,
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
} from './notification-channel.js';

// STK-F2-10 — job de alerta de expiração de freebet, no worker existente.
//
// O job faz duas coisas, e só duas:
//  1. ENFILEIRA os alertas devidos (dedupe por freebet + janela; quiet hours já
//     aplicados no instante de entrega);
//  2. TENTA ENTREGAR os alertas vencidos pelo canal.
//
// O canal Telegram está DESABILITADO (fail-closed, ver notification-channel.ts)
// até a STK-F2-04 existir. A entrega que falha NÃO marca o alerta como entregue:
// ele volta para `pending` com backoff, e nada se perde enquanto o canal não vem.
//
// O worker ITERA as organizações, como os demais jobs de infraestrutura: cada
// freebet pertence a um tenant e a transação usa o contexto daquela organização.

export function createFreebetAlertJob(database: Database, channel: NotificationChannel) {
  const notifications: NotificationService = createNotificationService(database);
  const tenant = createTenantContext(database);

  /**
   * Um passe para UMA organização. O contexto nunca vem do cliente: o worker
   * resolve a organização pela lista do registro e monta o contexto de sistema.
   */
  async function runOnce(context: OrganizationContext): Promise<number> {
    // O destinatário é o usuário da organização (a fila e as quiet hours são
    // dele), resolvido do registry — nunca o rótulo `system:worker`.
    const recipientId = await notifications.recipientOf(context);
    await notifications.enqueueExpiringFreebets(context, recipientId);
    let delivered = 0;
    // Limite por passe: um tenant com muitos alertas não pode travar o laço dos
    // demais. O restante fica na fila para o próximo ciclo.
    for (let guard = 0; guard < 20; guard += 1) {
      const due = await notifications.claimDue(context);
      if (!due) break;
      try {
        await channel.deliver({
          topic: 'freebet_expiring',
          subjectId: due.subject_id,
          title: 'Freebet próxima da expiração',
          body: 'Uma freebet registrada está perto de expirar.',
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

  return { tick, runOnce, notifications };
}

export function startFreebetAlerts(
  database: Database,
  env: NodeJS.ProcessEnv,
  intervalMs = 300_000,
) {
  // Flag desconhecida derruba o worker (fail-closed) em vez de enviar pela metade.
  const config = readNotificationChannelConfig(env);
  const channel = createDisabledNotificationChannel(config.name);
  const job = createFreebetAlertJob(database, channel);
  const controller = new AbortController();
  const task = (async () => {
    while (!controller.signal.aborted) {
      try {
        await job.tick();
      } catch {
        // Falha de um tenant não derruba o job dos outros; o log é sanitizado.
        console.warn('FREEBET_ALERTS_TICK_FAILED');
      }
      await delay(intervalMs, undefined, { signal: controller.signal }).catch(() => undefined);
    }
  })();
  return {
    check() {
      if (controller.signal.aborted) throw new Error('FREEBET_ALERTS_STOPPED');
    },
    async stop() {
      controller.abort();
      await task;
    },
    config,
    channel,
  };
}
