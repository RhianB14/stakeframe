import { z } from 'zod';

// STK-G0-19-R5 — contrato compartilhado da sincronização Telegram.
// Operações da outbox idempotente; nunca transportam segredos, tokens ou
// identificadores internos além do necessário.

export const TELEGRAM_OPERATIONS = [
  'send_processing_message',
  'send_result_message',
  'edit_result_message',
  'delete_processing_message',
  'delete_source_message',
  'delete_result_message',
] as const;
export const telegramOperationSchema = z.enum(TELEGRAM_OPERATIONS);
export type TelegramOperation = z.infer<typeof telegramOperationSchema>;

export const telegramSyncStateSchema = z.enum(['none', 'pending', 'synced', 'failed', 'deleted']);

// STK-G0-19-R6 — dados de callback dos botões da resposta final. O payload
// NUNCA carrega identificadores: a importação é resolvida no servidor por
// chat + id da mensagem de resultado.
export const TELEGRAM_CALLBACK_ACTIONS = [
  'status',
  'bookmaker',
  'delete',
  'delete_confirm',
  'delete_cancel',
] as const;
export type TelegramCallbackAction = (typeof TELEGRAM_CALLBACK_ACTIONS)[number];

export function parseTelegramCallbackData(value: string): TelegramCallbackAction | null {
  const match = /^sf:v1:(status|bookmaker|delete|delete:confirm|delete:cancel)$/.exec(value);
  if (!match || match[1] === undefined) return null;
  return match[1].replace('delete:', 'delete_') as TelegramCallbackAction;
}
export type TelegramSyncState = z.infer<typeof telegramSyncStateSchema>;

// Resultado final por caso (decisão única): would-import, review ou falha
// sanitizada. Usado na reavaliação privada e nos relatórios.
export const caseDecisionSchema = z.enum(['would-import', 'review', 'failed']);
export type CaseDecision = z.infer<typeof caseDecisionSchema>;

// Mensagem final do bot: reflete o registro canônico. Enquanto o evento está
// pendente, a data exibida é telegramReceivedAt, marcada como provisória.
export type ImportMessageInput = {
  status: string;
  statusLabel: string;
  kind: 'simple' | 'multiple';
  origin: 'real' | 'freebet' | null;
  bookmaker: string | null;
  tipster: string | null;
  stake: string | null;
  odds: string | null;
  potentialReturn: string | null;
  placedAt: string | null;
  eventAt: string | null;
  provisionalAt: string | null;
  sport: string | null;
  selections: { event: string | null; market: string | null; selection: string | null }[];
};

const displayMoney = (value: string) =>
  value.includes(',') ? value : value.replace('.', ',').replace(/,(\d)$/, ',$1');

const ORIGIN_LABEL = {
  real: 'Dinheiro real',
  freebet: 'Freebet',
} as const;

export function renderImportMessage(input: ImportMessageInput): string {
  const lines: string[] = [`${input.statusLabel}`, ''];
  const origin = input.origin ? ORIGIN_LABEL[input.origin] : 'confirmar';
  lines.push(`Origem financeira: ${origin}`);
  if (input.bookmaker) lines.push(`Casa: ${input.bookmaker}`);
  if (input.tipster) lines.push(`Tipster: ${input.tipster}`);
  lines.push(`Tipo: ${input.kind === 'multiple' ? 'múltipla' : 'simples'}`);
  const count = input.selections.length;
  for (let index = 0; index < count; index += 1) {
    const item = input.selections[index]!;
    const parts = [item.event, item.market, item.selection].filter(
      (value): value is string => !!value,
    );
    if (parts.length) lines.push(`${count > 1 ? `${index + 1}. ` : ''}${parts.join(' — ')}`);
    if (!parts.length && count > 1) lines.push(`${index + 1}. (seleção sem texto legível)`);
  }
  if (input.sport) lines.push(`Esporte: ${input.sport}`);
  if (input.stake) lines.push(`Stake: R$ ${displayMoney(input.stake)}`);
  if (input.odds) lines.push(`Odd total: ${displayMoney(input.odds)}`);
  if (input.potentialReturn)
    lines.push(`Retorno potencial: R$ ${displayMoney(input.potentialReturn)}`);
  if (input.placedAt) lines.push(`Aposta registrada em: ${input.placedAt}`);
  if (input.eventAt) lines.push(`Jogo: ${input.eventAt} (confirmado)`);
  else if (input.provisionalAt)
    lines.push(
      `Jogo: ${input.provisionalAt} — data provisória (a foto foi recebida neste horário; edite para a data real do jogo)`,
    );
  else lines.push('Jogo: confirmar data e hora (pendente)');
  return lines.join('\n');
}

// Telegram.WebApp.initData carrega o usuário como JSON dentro do
// data-check-string; a validação do hash HMAC acontece no servidor.
export const telegramWebAppUserSchema = z.object({
  id: z.number().int().positive(),
  first_name: z.string().max(200).optional(),
  username: z.string().max(200).optional(),
});
export type TelegramWebAppUser = z.infer<typeof telegramWebAppUserSchema>;
