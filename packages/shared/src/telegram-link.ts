import { z } from 'zod';

/**
 * Contrato do vínculo Telegram (STK-F2-04).
 *
 * O servidor é a autoridade de todas as regras: este contrato é a validação de
 * entrada/saída da API e a base do OpenAPI, e o navegador o usa apenas como
 * orientação. Nenhuma regra aqui pode ser contornada pelo cliente.
 */

/**
 * Estado do vínculo lido pelo site. `linked` reflete o vínculo ATIVO do próprio
 * usuário; o identificador numérico da conta Telegram nunca é devolvido (não é
 * necessário para a decisão e é dado de terceiro).
 */
export const telegramLinkStatusSchema = z
  .object({
    linked: z.boolean(),
    linkedAt: z.iso.datetime().nullable(),
    /** Deep link de uso único, presente só enquanto o pedido estiver vivo. */
    deepLink: z.url().nullable(),
    expiresAt: z.iso.datetime().nullable(),
    /** Segundos restantes até a expiração; `null` quando não há link pendente. */
    expiresInSeconds: z.number().int().min(0).max(300).nullable(),
  })
  .meta({ id: 'TelegramLinkStatus' });
export type TelegramLinkStatus = z.infer<typeof telegramLinkStatusSchema>;

/** Resposta da solicitação de um novo deep link (uso único, cinco minutos). */
export const telegramLinkRequestResultSchema = z
  .object({
    deepLink: z.url(),
    expiresAt: z.iso.datetime(),
    expiresInSeconds: z.number().int().min(1).max(300),
  })
  .meta({ id: 'TelegramLinkRequestResult' });
export type TelegramLinkRequestResult = z.infer<typeof telegramLinkRequestResultSchema>;

/**
 * Confirmação no site. O token viaja no corpo porque o deep link é trazido do
 * Telegram para o navegador (é um segredo de uso único e de vida curta) e
 * precisa chegar ao servidor; nenhum ID de conta Telegram é aceito do cliente.
 */
export const telegramLinkConfirmSchema = z
  .strictObject({
    token: z.string().min(1).max(512),
  })
  .meta({ id: 'TelegramLinkConfirm' });
export type TelegramLinkConfirm = z.infer<typeof telegramLinkConfirmSchema>;

/** Estado devolvido depois de confirmar ou revogar. */
export const telegramLinkStateResultSchema = z
  .object({
    linked: z.boolean(),
    linkedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'TelegramLinkStateResult' });
export type TelegramLinkStateResult = z.infer<typeof telegramLinkStateResultSchema>;

/** Códigos sanitizados que a API pode devolver nesta fronteira. */
export const TELEGRAM_LINK_ERROR_CODES = [
  'TELEGRAM_LINK_INVALID',
  'TELEGRAM_LINK_EXPIRED',
  'TELEGRAM_LINK_CONSUMED',
  'TELEGRAM_LINK_REVOKED',
  'TELEGRAM_LINK_NOT_CLAIMED',
  'TELEGRAM_LINK_ALREADY_LINKED',
  'TELEGRAM_LINK_IDENTITY_CONFLICT',
  'TELEGRAM_LINK_NOT_LINKED',
  'TELEGRAM_LINK_UNAVAILABLE',
] as const;
export const telegramLinkErrorCodeSchema = z.enum(TELEGRAM_LINK_ERROR_CODES);
export type TelegramLinkErrorCode = z.infer<typeof telegramLinkErrorCodeSchema>;

/**
 * Monta o deep link `https://t.me/<bot>?start=<token>`.
 *
 * O username vem do banco (resolvido por `getMe` no worker) e nunca do
 * navegador; o token é o próprio segredo de uso único. O resultado é
 * reconferido aqui para que um username adulterado nunca produza um link
 * apontando para outro host — a construção falha fechada.
 */
export function buildTelegramDeepLink(username: string, token: string): string | null {
  if (typeof username !== 'string' || !/^[A-Za-z0-9_]{5,32}$/.test(username)) return null;
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,128}$/.test(token)) return null;
  return `https://t.me/${username}?start=${token}`;
}

/**
 * Extrai o token de início de um update do Telegram.
 *
 * `t.me/<bot>?start=<token>` abre o bot com `message.text = "/start <token>"`
 * (deep link de payload), e a Telegram Web App entrega o parâmetro em
 * `startup_param` (deep link de `startApp`). As duas formas são aceitas; o
 * token é validado pelo formato antes de tocar o banco.
 */
export function parseTelegramStartToken(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const candidate = /^\/start(?:@\S+)?\s+([A-Za-z0-9_-]{20,128})$/.exec(value.trim());
  if (!candidate) return null;
  return candidate[1]!;
}
