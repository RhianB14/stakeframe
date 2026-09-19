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

// STK-G0-20 B3/B4 — callbacks que abrem teclados inline próprios: Casa de
// aposta, Tipster e Alterar Status carregam SOMENTE o id do cadastro ou a
// transição escolhida (revalidados no servidor contra o catálogo ativo da
// organização). A importação continua resolvida por chat + id da mensagem de
// resultado — nunca por payload. A exclusão segue em dois toques e 'back'
// restaura o teclado principal.
export const TELEGRAM_CALLBACK_ACTIONS = [
  'delete',
  'delete_confirm',
  'delete_cancel',
  'bookmaker',
  'tipster',
  'status',
  'back',
] as const;
export type TelegramCallbackAction = (typeof TELEGRAM_CALLBACK_ACTIONS)[number];

/** Transições oferecidas pelo teclado de status (nunca cashout — valor é informado no Mini App). */
export type TelegramStatusAction = 'win' | 'loss' | 'pending' | 'half_win' | 'half_loss' | 'void';

export type TelegramCallbackPayload = {
  action: TelegramCallbackAction;
  catalogId: string | null;
  /** Presente apenas em 'status': null abre o teclado; valor aplica a transição. */
  statusAction?: TelegramStatusAction | null;
};

const CALLBACK_SELECTION =
  /^sf:v1:(bookmaker|tipster):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const CALLBACK_STATUS = /^sf:v1:status:(win|loss|pending|half_win|half_loss|void)$/;

export function parseTelegramCallbackData(value: string): TelegramCallbackPayload | null {
  const selection = CALLBACK_SELECTION.exec(value);
  if (selection)
    return { action: selection[1] as TelegramCallbackAction, catalogId: selection[2]! };
  const status = CALLBACK_STATUS.exec(value);
  if (status)
    return { action: 'status', catalogId: null, statusAction: status[1] as TelegramStatusAction };
  const match = /^sf:v1:(delete|delete:confirm|delete:cancel|bookmaker|tipster|status|back)$/.exec(
    value,
  );
  if (!match || match[1] === undefined) return null;
  const action = match[1].replace('delete:', 'delete_') as TelegramCallbackAction;
  return action === 'status'
    ? { action, catalogId: null, statusAction: null }
    : { action, catalogId: null };
}
export type TelegramSyncState = z.infer<typeof telegramSyncStateSchema>;

// Resultado final por caso (decisão única): would-import, review ou falha
// sanitizada. Usado na reavaliação privada e nos relatórios.
export const caseDecisionSchema = z.enum(['would-import', 'review', 'failed']);
export type CaseDecision = z.infer<typeof caseDecisionSchema>;

// STK-G0-20 — mensagem final do bot (formato fixo com emojis por linha).
// `sentAt` é SEMPRE a data/hora original do Telegram (imutável); `eventAt` é a
// data do jogo (editável) e exibe "pendente" enquanto não confirmada.
export type ImportMessageInput = {
  /** UUID do processamento (mesmo identificador do Mini App). */
  id: string;
  statusLabel: string;
  /** true no estado pendente de processamento/aberto: exibe o topo de sucesso. */
  success: boolean;
  bonus: 'real' | 'freebet' | 'hibrida' | null;
  sport: string | null;
  event: string | null;
  country: string | null;
  /** Texto da aposta (seleção escolhida). */
  selection: string | null;
  market: string | null;
  stake: string | null;
  odds: string | null;
  potentialReturn: string | null;
  kind: 'simple' | 'multiple';
  sentAt: string | null;
  eventAt: string | null;
  bookmaker: string | null;
  tipster: string | null;
};

const displayMoney = (value: string) =>
  value.includes(',') ? value : value.replace('.', ',').replace(/,(\d)$/, ',$1');

const BONUS_LABEL = {
  real: 'Não',
  freebet: 'Freebet',
  hibrida: 'Híbrida',
} as const;

const orPending = (value: string | null) => value ?? 'pendente';

export function renderImportMessage(input: ImportMessageInput): string {
  const lines: string[] = [
    input.success ? '✅ Bilhete processado com sucesso' : input.statusLabel,
    '',
    `🆔 ID: ${input.id}`,
    '💰 Banca: Padrão',
    '',
    `⏳ Status: ${input.statusLabel}`,
  ];
  if (input.statusLabel === 'Pendente') lines.push('🔹 Sem lucro ou prejuízo.');
  lines.push(
    `🎾 Esporte: ${orPending(input.sport)}`,
    '🏆 Torneio: Definir Manualmente',
    `⚔️ Evento: ${orPending(input.event)}`,
    `🌎 País: ${orPending(input.country)}`,
    `🎰 Aposta: ${orPending(input.selection)}`,
    `🎯 Mercado: ${orPending(input.market)}`,
    `💰 Valor Apostado: ${input.stake ? `R$ ${displayMoney(input.stake)}` : 'pendente'}`,
    `🎲 Odd: ${input.odds ? displayMoney(input.odds) : 'pendente'}`,
    `💵 Retorno Potencial: ${input.potentialReturn ? `R$ ${displayMoney(input.potentialReturn)}` : 'pendente'}`,
    `📝 Tipo: ${input.kind === 'multiple' ? 'Múltipla' : 'Simples'}`,
    `📅 Enviado em: ${orPending(input.sentAt)}`,
    `🎮 Evento em: ${orPending(input.eventAt)}`,
    `🎁 Bônus: ${input.bonus ? BONUS_LABEL[input.bonus] : 'pendente'}`,
    `🏠 Casa: ${orPending(input.bookmaker)}`,
    `🗣️ Tipster: ${orPending(input.tipster)}`,
  );
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
