import { createTelegramLinkService, type Database } from '@stakeframe/db';
import { parseTelegramStartToken } from '@stakeframe/shared';
import { botUsername, createTelegramClient, type TelegramConfig } from './telegram.js';

export { botUsername };

// STK-F2-04 — deep link de uso único (Plano §8.2), pelo MESMO polling que já
// consome o bot. Nenhum webhook e nenhum serviço novo: o worker apenas observa
// que o dono abriu `https://t.me/<bot>?start=<token>` e registra a conta
// numérica de origem. A decisão de vínculo NUNCA acontece aqui — a confirmação
// é no site (API), que resolve o token pelo hash e consome o pedido.
//
// O transporte continua fail-closed: uma mensagem de deep link de um remetente
// não autorizado é ignorada sem resposta e sem tocar o banco, exatamente como
// qualquer outra mensagem fora da fronteira. Nenhum token, id de conta ou texto
// privado é registrado — só códigos sanitizados.

type Client = ReturnType<typeof createTelegramClient>;

/** Update `message` com texto `/start <token>`, do remetente autorizado. */
export function authorizedStart(update: unknown, config: TelegramConfig) {
  const root = object(update);
  if (!root || typeof root.update_id !== 'number' || !Number.isSafeInteger(root.update_id))
    return null;
  const message = object(root.message);
  if (!message) return null;
  const from = object(message.from);
  if (!from || from.is_bot !== false) return null;
  if (String(from.id) !== config.userId) return null;
  const chat = object(message.chat);
  if (!chat || String(chat.id) !== config.chatId || chat.type !== 'private') return null;
  // Recusa o resto da fronteira: grupo, encaminhamento, bot emissor.
  if (message.sender_chat !== undefined || message.via_bot !== undefined) return null;
  if (message.forward_origin !== undefined || message.business_connection_id !== undefined)
    return null;
  if (typeof message.text !== 'string') return null;
  const token = parseTelegramStartToken(message.text);
  if (!token) return null;
  return { updateId: root.update_id, token, telegramUserId: String(from.id) };
}
export type TelegramStart = NonNullable<ReturnType<typeof authorizedStart>>;

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Registra a conta observada no deep link e responde ao dono. Idempotente por
 * construção: o `claim` só avança um pedido `pending`, e repetir o mesmo update
 * (retry do polling) não abre um segundo vínculo. Falhas de banco nunca
 * respondem ao usuário com detalhe — a resposta é sempre genérica e sanitizada.
 */
export function createTelegramLinkHandler(
  database: Database,
  client: Client,
  config: TelegramConfig,
) {
  const links = createTelegramLinkService(database);
  return async function handle(start: TelegramStart): Promise<void> {
    const chatId = Number(config.chatId);
    try {
      await links.claimTelegramAccount(start.token, start.telegramUserId);
      await client.sendMessage(
        chatId,
        '✅ Conexão recebida. Volte ao site e confirme para vincular sua conta.',
      );
    } catch {
      // Deep link expirado, já consumido, revogado ou reusado por outra conta:
      // todos respondem com a mesma orientação genérica, sem revelar o estado.
      try {
        await client.sendMessage(
          chatId,
          '⚠️ Este link não está mais válido. Gere um novo no site e tente de novo.',
        );
      } catch {
        // Falha transitória de entrega: nada a fazer além de tentar no próximo poll.
      }
    }
  };
}

/**
 * Username público do bot, lido por `getMe` e gravado para a API montar o
 * deep link. Não é segredo (o Telegram publica o username do bot), mas também
 * não é digitado nem versionado: vem da própria API do bot. Falha aqui é
 * inofensiva — a API apenas segue sem conseguir emitir deep link.
 */
export async function refreshBotUsername(
  database: Database,
  config: TelegramConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const username = await botUsername(config, fetchImpl);
  if (username) await createTelegramLinkService(database).recordBotUsername(username);
}
