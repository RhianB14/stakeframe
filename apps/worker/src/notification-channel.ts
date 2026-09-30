// STK-F2-10 — interface de entrega de notificações.
//
// O canal Telegram NÃO é entregue nesta unidade. A STK-F2-04 (vínculo Telegram)
// está em andamento em outra branch, e o §8.7 do plano master trata resultado,
// revisão pendente e expiração de freebet como notificações do mesmo canal.
//
// Decisão deliberada: a interface EXISTE, mas o envio está DESABILITADO de forma
// fail-closed. Um stub que "envia" e descarta seria pior que não enviar — o
// usuário receberia um registro marcado como entregue sem nunca ter visto a
// mensagem. Aqui, `deliver` sempre recusa com um código estável; a fila continua
// aceitando e adiando alertas, então nada se perde quando o canal chegar.
//
// O que NÃO é escopo desta unidade (e por isso não existe aqui): deep link,
// botão de abertura, vínculo de conta, edição/apagamento de mensagem e qualquer
// chamada de rede. Isso pertence à STK-F2-04.

export type NotificationDelivery = {
  /**
   * A etiqueta da entrega. STK-F2-16 acrescenta `polymarket_activity`: a
   * entrega usa a MESMA union da fila (`notificationOutboxTopicSchema` no
   * shared), e não uma lista própria. Duas listas de etiquetas divergiriam no
   * primeiro alerta gravado, e a falha apareceria como um `deliver` que não
   * compila — o que é melhor do que um envio com a etiqueta errada.
   */
  topic: 'bet_settled' | 'review_pending' | 'freebet_expiring' | 'polymarket_activity';
  subjectId: string | null;
  title: string;
  body: string;
};

export type NotificationChannel = {
  readonly name: string;
  /** `false` enquanto o canal real não existir — nenhum envio é tentado. */
  readonly enabled: boolean;
  deliver(message: NotificationDelivery): Promise<{ delivered: true }>;
};

export class NotificationChannelUnavailableError extends Error {
  constructor(public readonly channel: string) {
    super('NOTIFICATION_CHANNEL_UNAVAILABLE');
    this.name = 'NotificationChannelUnavailableError';
  }
}

/**
 * Canal indisponível: sempre falha com código estável e nunca toca a rede.
 * A fila trata a recusa como transitória e mantém o alerta pendente.
 */
export function createDisabledNotificationChannel(name = 'telegram'): NotificationChannel {
  return {
    name,
    enabled: false,
    async deliver(): Promise<{ delivered: true }> {
      throw new NotificationChannelUnavailableError(name);
    },
  };
}

/** Leitura da configuração do canal: desligado por padrão, sem chave e sem rede. */
export function readNotificationChannelConfig(env: NodeJS.ProcessEnv): {
  enabled: boolean;
  name: string;
} {
  const raw = env.NOTIFICATION_CHANNEL_ENABLED;
  if (raw !== undefined && !['true', 'false'].includes(raw))
    throw new Error('INVALID_NOTIFICATION_CHANNEL_CONFIGURATION');
  // Fail-closed: sem opt-in explícito e explícito do STK-F2-04, o canal nasce
  // desligado. `true` não habilita o stub — apenas habilita o gate de linkage.
  return { enabled: raw === 'true', name: 'telegram' };
}
