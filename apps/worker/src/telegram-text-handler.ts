import { createTenantContext, systemOrganizationContext, type Database } from '@stakeframe/db';
import { parseTelegramIntent } from '@stakeframe/shared';
import { createTelegramClient, type TelegramConfig } from './telegram.js';
import { createTelegramCommands } from './telegram-commands.js';
import {
  createTelegramTextRegistration,
  type TextRegistration,
} from './telegram-text-registration.js';

/**
 * STK-F2-07 — a fronteira de TEXTO do polling do bot.
 *
 * A foto da F2-2-06 e o callback da F2-2-05 já ocupam quase todo o tráfego. O
 * que este módulo acrescenta é uma quarta rota — a mensagem de TEXTO — e ela é
 * inserida no MESMO polling, sem webhook e sem serviço novo. É a mesma decisão
 * de transporte que a F2-04 tomou para o deep link: o bot não abre um canal
 * novo, ele escuta o que já escutava.
 *
 * A classificação é feita por `parseTelegramIntent`, que é puro e testável
 * sozinho. Este módulo só decide O QUE FAZER com cada resultado, e a ordem das
 * regras é a regra:
 *
 *  1. `/start ...` NÃO É TEXTO. Devolve `null` e a mensagem segue para a
 *     STK-F2-04, dona do deep link. Tratar o deep link como texto livre seria
 *     tentar ler um token de uso único como se fosse uma aposta.
 *  2. Texto que começa com `/` e não é dos onze é `unknown-command`: a
 *     resposta é a lista do que existe, e NUNCA texto livre. O usuário disse
 *     "comando", não "registre isto".
 *  3. Texto livre vai para o registro textual — que NUNCA escreve: publica
 *     preview e espera confirmação.
 *  4. `/preview` não é comando: é o que o bot responde a uma foto quando o
 *     dono pergunta o que aconteceu. Ele devolve a lista, porque a única forma
 *     honesta de dizer "não tenho um comando para isso" é dizer quais existem.
 *
 * A decisão é sempre respondida. Uma mensagem de texto do dono que não vira
 * Bet NENHECA vira silêncio: silêncio é indistinguível de falha, e o dono não
 * tem como saber se o bot leu.
 */

type Client = ReturnType<typeof createTelegramClient>;

export function createTelegramTextHandler(
  database: Database,
  client: Client,
  config: TelegramConfig,
  deps: {
    apiKey: string | null;
    fetchImpl?: typeof fetch;
    now?: () => Date;
  },
) {
  const tenant = createTenantContext(database);
  const commands = createTelegramCommands(database, client, config, {
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });
  const text = createTelegramTextRegistration(database, client, config, {
    apiKey: deps.apiKey,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });

  /**
   * Trata uma mensagem de TEXTO do remetente autorizado. Devolve `true`
   * quando a mensagem foi consumida por esta fronteira — e, como a foto e o
   * callback, o texto nunca é gravado por este caminho: ele só responde.
   */
  return async function handle(input: {
    text: string;
    messageId: number;
    receivedAt: Date;
  }): Promise<boolean> {
    const intent = parseTelegramIntent(input.text);
    if (intent === null) return false; // deep link da F2-04 (ou mensagem vazia)

    const founder = await tenant.founderOrganizationId();
    if (!founder) {
      // Sem organização não há dado a servir; a orientação é|linkar no site, e
      // ela é a mesma do vínculo da F2-04 — uma regra de acesso, não um erro.
      await client.sendMessage(
        Number(config.chatId),
        '⚠️ Nenhuma conta vinculada. Vincule sua conta no site para usar os comandos.',
      );
      return true;
    }
    const context = systemOrganizationContext(founder);

    if (intent.kind === 'unknown-command') {
      await commands.refuseUnknown();
      return true;
    }

    if (intent.kind === 'command') {
      await commands.run(intent.command);
      return true;
    }

    // Texto livre. O registro NUNCA escreve: o serviço devolve o desfecho e a
    // resposta fala do desfecho, nunca do conteúdo.
    const outcome = await text.register({
      context,
      text: input.text,
      chatId: Number(config.chatId),
      messageId: input.messageId,
      receivedAt: input.receivedAt,
    });
    await respond(outcome);
    return true;
  };

  /**
   * A resposta do registro textual. NENHUMA delas carrega o texto lido, o
   * rascunho ou o erro técnico: o usuário já viu o que foi lido no PREVIEW,
   * e uma falha vira orientação para a mão — nunca detalhe de fornecedor.
   */
  async function respond(outcome: TextRegistration) {
    if (outcome.kind === 'presented') {
      // O preview já foi enviado. Só se a entrega falhou há algo a dizer: a
      // rascunho existe e continua decidível pelo Mini App.
      if (!outcome.delivered)
        await client.sendMessage(
          Number(config.chatId),
          '⚠️ Não consegui entregar o preview agora. Abra o Mini App para revisar o que li.',
        );
      return;
    }
    if (outcome.kind === 'duplicate') {
      await client.sendMessage(
        Number(config.chatId),
        'ℹ️ Este registro é igual a um que já existe. Abra o Mini App para ver o original.',
      );
      return;
    }
    if (outcome.kind === 'refused') {
      await client.sendMessage(
        Number(config.chatId),
        outcome.reason === 'bounds'
          ? 'ℹ️ Descreva a aposta com um pouco mais de detalhe (entre 12 e 1024 caracteres), ou use Editar no Mini App.'
          : '⏳ A leitura automática está pausada por agora. Registre a aposta pelo Mini App, que funciona sem ela.',
      );
      return;
    }
    // Falha técnica: cota não consumida e ação manual. O usuário não vê
    // "timeout", "fornecedor" ou "circuito" — ele vê o que fazer.
    await client.sendMessage(
      Number(config.chatId),
      '⚠️ Não consegui ler esse texto agora. Registre a aposta pelo Mini App — nada foi lançado.',
    );
  }
}
