import { z } from 'zod';

/**
 * Contrato do fluxo da mensagem Telegram até o bilhete (STK-F2-05).
 *
 * O servidor é a autoridade de todas as regras. O preview é ESTRUTURADO e
 * obrigatório: ele é a única coisa que existe antes da decisão do usuário, e
 * nenhuma escrita financeira acontece enquanto ele não for confirmado.
 *
 * Duas datas com semânticas distintas, e a distinção é o contrato:
 *  - `sentAt` é o instante da MENSAGEM ORIGINAL (`placedAt` da aposta). É
 *    imutável e vem do Telegram;
 *  - `eventAt` é a data do EVENTO, nasce `null` e só existe depois de uma
 *    decisão explícita. Nunca é inferida de `sentAt`.
 *
 * Nenhum campo carrega conteúdo de bilhete além do próprio preview, e o
 * preview nunca é registrado em log: os erros são códigos sanitizados.
 */

/** Uma seleção do bilhete dentro do preview. `eventAt` é sempre independente de `sentAt`. */
export const telegramPreviewSelectionSchema = z
  .object({
    event: z.string().nullable(),
    sport: z.string().nullable(),
    market: z.string().nullable(),
    selection: z.string().nullable(),
    odds: z.string().nullable(),
  })
  .meta({ id: 'TelegramPreviewSelection' });
export type TelegramPreviewSelection = z.infer<typeof telegramPreviewSelectionSchema>;

/**
 * Duplicata detectada por identidade determinística da imagem + contexto.
 * `reasons` nunca diz "mesma imagem" genérico: ele diz o que coincidiu.
 */
export const telegramPreviewDuplicateSchema = z
  .object({
    detected: z.boolean(),
    /** Importação original da MESMA organização — nunca de outro tenant. */
    ofImportId: z.uuid().nullable(),
    reasons: z.array(z.enum(['image', 'reference', 'similar'])).max(3),
  })
  .meta({ id: 'TelegramPreviewDuplicate' });
export type TelegramPreviewDuplicate = z.infer<typeof telegramPreviewDuplicateSchema>;

/** Arquivo recuperável por 30 dias. Nunca existe um prazo de resposta do bot. */
export const telegramPreviewArchiveSchema = z
  .object({
    archived: z.boolean(),
    reason: z.enum(['discarded', 'duplicate', 'superseded']).nullable(),
    /** Instante final da janela de recuperação; `null` quando não arquivado. */
    recoverableUntil: z.iso.datetime().nullable(),
    restored: z.boolean(),
  })
  .meta({ id: 'TelegramPreviewArchive' });
export type TelegramPreviewArchive = z.infer<typeof telegramPreviewArchiveSchema>;

/**
 * Preview estruturado do bilhete. É a ÚNICA superfície entre o recebimento da
 * foto e a decisão; enquanto ele existe, `finance.bet`, `finance.journal` e
 * `finance.posting` estão intocados.
 */
export const telegramTicketPreviewSchema = z
  .object({
    id: z.uuid(),
    version: z.number().int().positive(),
    /** Estado do rascunho: pending | processing | review | failed | discarded | imported. */
    state: z.enum(['pending', 'processing', 'review', 'failed', 'discarded', 'imported']),
    /** Fila do worker: uma foto por vez, do recebimento à decisão. */
    queueState: z.enum(['none', 'queued', 'admitted', 'preview', 'duplicate', 'archived']),
    /** `placedAt`: o instante da MENSAGEM ORIGINAL, imutável. */
    sentAt: z.iso.datetime().nullable(),
    /** Data do EVENTO — distinta da data de envio e nunca inferida dela. */
    eventAt: z.iso.datetime().nullable(),
    eventDateStatus: z.enum(['pending', 'confirmed']),
    bookmaker: z.string().nullable(),
    tipster: z.string().nullable(),
    stake: z.string().nullable(),
    odds: z.string().nullable(),
    reference: z.string().nullable(),
    kind: z.enum(['simple', 'multiple', 'betbuild']),
    origin: z.enum(['real', 'freebet', 'hibrida']).nullable(),
    selections: z.array(telegramPreviewSelectionSchema).max(60),
    /** Retorno potencial calculado no servidor a partir de stake × odds. */
    potentialReturn: z.string().nullable(),
    duplicate: telegramPreviewDuplicateSchema,
    archive: telegramPreviewArchiveSchema,
    /** Ações disponíveis agora. `retry` só existe quando a extração falhou. */
    actions: z.array(z.enum(['confirm', 'edit', 'discard', 'retry'])).max(4),
    /**
     * Motivo técnico da recusa, quando a extração não é confiável.
     * Sem valor = o preview está decidível (a aposta pode ser confirmada).
     */
    blockedReason: z.string().nullable(),
  })
  .meta({ id: 'TelegramTicketPreview' });
export type TelegramTicketPreview = z.infer<typeof telegramTicketPreviewSchema>;

/**
 * Decisão sobre o preview. É sempre explícita: `confirm` grava a aposta,
 * `discard` arquiva para a janela de 30 dias e `retry` repede a extração.
 * Nenhuma delas é temporizada — não existe `/undo` com prazo.
 */
export const TELEGRAM_PREVIEW_DECISIONS = ['confirm', 'discard', 'retry'] as const;
export const telegramPreviewDecisionSchema = z.enum(TELEGRAM_PREVIEW_DECISIONS);
export type TelegramPreviewDecision = z.infer<typeof telegramPreviewDecisionSchema>;

export const telegramPreviewActionSchema = z
  .strictObject({
    version: z.number().int().positive(),
    decision: telegramPreviewDecisionSchema,
  })
  .meta({ id: 'TelegramPreviewAction' });
export type TelegramPreviewAction = z.infer<typeof telegramPreviewActionSchema>;

/**
 * Resultado da decisão. `restored` só aparece na recuperação do arquivo: quem
 * restaura recebe de volta a fila, não um lançamento financeiro.
 */
export const telegramPreviewActionResultSchema = z
  .object({
    id: z.uuid(),
    version: z.number().int().positive(),
    state: z.enum(['pending', 'processing', 'review', 'failed', 'discarded', 'imported']),
    betId: z.uuid().nullable(),
    /** Preenchido ao restaurar um arquivo dentro dos 30 dias. */
    restored: z.boolean(),
    recoverableUntil: z.iso.datetime().nullable(),
  })
  .meta({ id: 'TelegramPreviewActionResult' });
export type TelegramPreviewActionResult = z.infer<typeof telegramPreviewActionResultSchema>;

/** Recuperação de um arquivo: identifica o registro pelo próprio id do arquivo. */
export const telegramArchiveRestoreSchema = z
  .strictObject({
    version: z.number().int().positive(),
  })
  .meta({ id: 'TelegramArchiveRestore' });
export type TelegramArchiveRestore = z.infer<typeof telegramArchiveRestoreSchema>;

/** Lista de arquivos recuperáveis da organização. */
export const telegramArchiveListSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            archiveId: z.uuid(),
            importId: z.uuid(),
            identity: z.string().regex(/^[a-f0-9]{64}$/),
            reason: z.enum(['discarded', 'duplicate', 'superseded']),
            archivedAt: z.iso.datetime(),
            recoverableUntil: z.iso.datetime(),
          })
          .meta({ id: 'TelegramArchiveEntry' }),
      )
      .max(200),
  })
  .meta({ id: 'TelegramArchiveList' });
export type TelegramArchiveList = z.infer<typeof telegramArchiveListSchema>;

/** Códigos sanitizados desta fronteira. A mensagem da API É o código. */
export const TELEGRAM_TICKET_ERROR_CODES = [
  'TELEGRAM_TICKET_NOT_FOUND',
  'TELEGRAM_TICKET_STATE_CONFLICT',
  'TELEGRAM_TICKET_DUPLICATE',
  'TELEGRAM_TICKET_ARCHIVED',
  'TELEGRAM_TICKET_EXPIRED',
  'TELEGRAM_TICKET_NOT_RECOVERABLE',
  'TELEGRAM_TICKET_BUSY',
] as const;
export const telegramTicketErrorCodeSchema = z.enum(TELEGRAM_TICKET_ERROR_CODES);
export type TelegramTicketErrorCode = z.infer<typeof telegramTicketErrorCodeSchema>;
