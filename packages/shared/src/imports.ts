import { z } from 'zod';
import { pageQuerySchema } from './finance.js';

export const importStateSchema = z.enum([
  'pending',
  'processing',
  'review',
  'failed',
  'discarded',
  'imported',
]);
export const importItemSchema = z.object({
  id: z.uuid(),
  source: z.enum(['web', 'telegram']),
  caption: z.string(),
  state: importStateSchema,
  version: z.number().int().positive(),
  attempts: z.number().int().nonnegative(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  errorCode: z.string().nullable(),
  betId: z.uuid().nullable(),
  imageAvailable: z.boolean(),
});
export const importQuerySchema = pageQuerySchema.extend({
  state: importStateSchema.optional(),
  betId: z.uuid().optional(),
});
export const importPageSchema = z
  .object({
    items: z.array(importItemSchema),
    total: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
  })
  .meta({ id: 'ImportPage' });
export const uploadSchema = z.strictObject({
  image: z
    .string()
    .min(4)
    .max(11_184_812)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  caption: z.string().max(1024),
});
export const uploadResultSchema = z.object({ id: z.uuid() }).meta({ id: 'UploadResult' });

export const OPENROUTER_MODELS = [
  'google/gemini-3.8-flash',
  'qwen/qwen3-vl-32b-instruct',
  'deepseek/deepseek-v4-flash-vision-exp',
] as const;
export const OPENROUTER_MODEL = OPENROUTER_MODELS[0];
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const ticketKindSchema = z.enum(['simple', 'multiple', 'betbuild']);
export type TicketKind = z.infer<typeof ticketKindSchema>;

/**
 * Classifica a composição da aposta sem depender da IA:
 * - uma seleção = simples;
 * - várias seleções no mesmo evento = BetBuild;
 * - várias seleções em eventos diferentes (ou sem evento confiável) = múltipla.
 *
 * Um evento ausente nunca é considerado igual a outro evento: isso evita
 * transformar uma extração incompleta em BetBuild automaticamente.
 */
export function classifyTicketKind(selections: { event: string | null }[]): TicketKind {
  if (selections.length <= 1) return 'simple';
  const events = selections.map((selection) => {
    if (!selection.event?.trim()) return null;
    return selection.event
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLocaleLowerCase('pt-BR')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
      .replace(/\s+/g, ' ');
  });
  return events.every((event) => event !== null && event === events[0]) ? 'betbuild' : 'multiple';
}
const text = z.string().min(1).max(500);
const instant = z.iso.datetime({ offset: true });
const decimal = z.string().regex(/^(0|[1-9]\d{0,11})(\.\d{1,4})?$/);

// Extraction is evidence for review, never authority to create a financial entry.
export const ticketExtractionSchema = z.strictObject({
  // STK-G0-22: a extração da IA é neutra — não existe campo de casa. O
  // bookmaker é declarado exclusivamente pelo usuário (legenda/Telegram,
  // MiniApp ou Web) e resolvido no servidor; qualquer indicação de casa
  // retornada pelo modelo é rejeitada pelo strictObject.
  reference: text.nullable(),
  placedAtText: text.nullable(),
  currency: z.enum(['BRL']).nullable(),
  stake: decimal.nullable(),
  odds: decimal.nullable(),
  potentialReturn: decimal.nullable(),
  freebet: z.boolean().nullable(),
  selections: z
    .array(
      z.strictObject({
        event: text.nullable(),
        sport: text.nullable(),
        market: text.nullable(),
        selection: text.nullable(),
        odds: decimal.nullable(),
        // Reservado e depreciado (R3): a importação automática sempre envia
        // null e ignora o valor. Datas/horários de evento (inclusive período
        // ao vivo) pertencem ao enriquecimento posterior de eventos e nunca
        // decidem importação.
        eventDateText: text
          .nullable()
          .describe(
            'Reservado e depreciado: a importação automática sempre envia null e ignora o valor; datas de evento pertencem ao enriquecimento posterior.',
          ),
      }),
    )
    .min(1)
    .max(40),
  warnings: z.array(text).max(20),
});
export type TicketExtraction = z.infer<typeof ticketExtractionSchema>;
export const automaticReasonSchema = z.enum([
  'IMPORTED',
  'LAYOUT_NOT_VALIDATED',
  'EXTRACTION_UNCERTAIN',
  'CAPTION_UNRESOLVED',
  'BOOKMAKER_UNRESOLVED',
  'BOOKMAKER_REFUSED',
  'BOOKMAKER_NOT_APPROVED',
  'ORIGIN_UNRESOLVED',
  'BOOKMAKER_CONFLICT',
  'PLACED_AT_UNCERTAIN',
  'FREEBET_UNRESOLVED',
  'FREEBET_CONFLICT',
  'RETURN_MISMATCH',
  'UNIT_REQUIRED',
  'DUPLICATE_REVIEW_REQUIRED',
  'FINANCIAL_REVIEW_REQUIRED',
]);
export type AutomaticReason = z.infer<typeof automaticReasonSchema>;
export const automaticDecisionSchema = z.strictObject({
  reason: automaticReasonSchema,
  policyId: z.string().nullable(),
  policyDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  // Rastreio da casa: o bookmaker aplicado vem do contexto informado pelo
  // usuário ('context'); a classificação visual fica registrada à parte como
  // evidência do modelo, nunca como fonte de verdade.
  bookmakerOrigin: z.literal('context').nullable().optional(),
  visualLayoutId: z.string().max(200).nullable().optional(),
});
export const validatedLayoutSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
  bookmaker: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/),
  bookmakerId: z.uuid(),
  model: z.enum(OPENROUTER_MODELS),
  description: z.string().trim().min(20).max(1000),
  placedAtFormat: z.enum(['iso-offset', 'br-sao-paulo', 'br-textual-sao-paulo']),
  allowFreebet: z.boolean(),
  // Rótulos autorizados para potentialReturn — parte do digest da política
  // por casa (Bet365: ["Retorno Total"]; Superbet: ["Prêmio", "Ganho
  // Potencial"]). Obrigatório: toda política nova/aprovada declara os rótulos.
  potentialReturnLabels: z.array(z.string().trim().min(1).max(60)).min(1).max(10),
  layoutSha256: z.string().regex(/^[a-f0-9]{64}$/),
  coverage: z.strictObject({
    positive: z.number().int().min(20).max(10000),
    negative: z.number().int().min(5).max(10000),
    multiples: z.number().int().min(3).max(10000),
    missingFields: z.number().int().min(3).max(10000),
    promotional: z.number().int().min(0).max(10000),
    uniqueImages: z.number().int().min(20).max(10000),
  }),
  corpusSha256: z.string().regex(/^[a-f0-9]{64}$/),
  evaluationSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sampleCount: z.number().int().min(20).max(10000),
  essentialFieldErrors: z.literal(0),
  approvedBy: z.literal('owner'),
  approvedAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
});
export const validatedLayoutsSchema = z
  .array(validatedLayoutSchema)
  .max(5)
  .refine((layouts) => new Set(layouts.map((layout) => layout.id)).size === layouts.length);
export type ValidatedLayout = z.infer<typeof validatedLayoutSchema>;
// STK-G0-22: o wrapper { layoutId, extraction } foi removido — o modelo não
// escolhe layout nem casa; a resposta neutra é validada diretamente por
// ticketExtractionSchema (strictObject rejeita campos extras). A resolução
// determinística da casa/layout pertence ao servidor (F2).
export const duplicateSchema = z.object({
  betId: z.uuid(),
  // Automatic import creates an incomplete bet before the user fills the
  // Mini App. Those records can lack bookmaker/reference while still being a
  // useful duplicate candidate by image hash.
  reference: z.string().nullable(),
  bookmakerId: z.uuid().nullable(),
  stake: z.string().nullable(),
  placedAt: z.iso.datetime({ offset: true }).nullable(),
  reasons: z.array(z.enum(['image', 'reference', 'similar'])),
});
export const importDetailSchema = z
  .object({
    item: importItemSchema,
    extraction: ticketExtractionSchema.nullable(),
    labels: z.object({
      tipster: z.string().nullable(),
      bookmaker: z.string().nullable(),
      requiresReview: z.boolean(),
    }),
    // Origem financeira declarada pelo usuário (real|freebet|hibrida) e o crédito
    // escolhido explicitamente; null significa que ainda não foi informada e
    // nenhuma aposta financeira é criada (fail-closed).
    betOrigin: z.enum(['real', 'freebet', 'hibrida']).nullable(),
    freebetId: z.uuid().nullable(),
    // Data/hora real do evento: o rascunho nasce pendente e exibe
    // telegramReceivedAt como valor provisório editável.
    eventAt: instant.nullable(),
    eventDateStatus: z.enum(['pending', 'confirmed']),
    telegramReceivedAt: instant.nullable(),
    // Confirmação do transporte Telegram. O Mini App só anuncia sucesso e se
    // fecha depois que a versão gravada também foi processada pela outbox.
    telegramSyncState: z.enum(['none', 'pending', 'synced', 'failed', 'deleted']).optional(),
    telegramSyncedVersion: z.number().int().nonnegative().nullable().optional(),
    // Créditos de freebet disponíveis (nunca ambíguos: escolha explícita).
    credits: z.array(
      z.object({
        id: z.uuid(),
        bookmakerId: z.uuid(),
        amount: z.string(),
        expiresOn: z.string(),
        stakeReturned: z.boolean(),
      }),
    ),
    matches: z.object({
      tipsterId: z.uuid().nullable(),
      captionBookmakerId: z.uuid().nullable(),
      extractedBookmakerId: z.uuid().nullable(),
      conflict: z.boolean(),
    }),
    // STK-G0-19-R7 — casa declarada pelo usuário (seção "Alterar Casa") e o
    // catálogo ativo da organização para a escolha explícita.
    bookmakerOverrideId: z.uuid().nullable(),
    // O esporte pode vir como sugestão baseada na evidência da IA; torneio e
    // país permanecem manuais. Em todos os casos o usuário pode editar e o
    // Telegram/Web compartilham a mesma fonte canônica.
    tipsterOverrideId: z.uuid().nullable(),
    sportOverride: z.string().nullable(),
    tournamentOverride: z.string().nullable(),
    countryOverride: z.string().nullable(),
    // Campos editáveis do comprovante antes da criação da aposta financeira.
    // Permanecem separados da evidência OCR para preservar a auditoria.
    ticketKindOverride: ticketKindSchema.nullable(),
    stakeOverride: z.string().nullable(),
    oddsOverride: z.string().nullable(),
    selectionOverrides: z.array(
      z.strictObject({
        event: z.string().nullable(),
        market: z.string().nullable(),
        selection: z.string().nullable(),
      }),
    ),
    bookmakers: z.array(z.object({ id: z.uuid(), name: z.string() })),
    // STK-G0-20 B5 — tipsters ATIVOS da organização (nunca misturados às casas).
    tipsters: z.array(z.object({ id: z.uuid(), name: z.string() })),
    // Aposta vinculada (quando a importação já foi registrada): alimenta a
    // seção "Alterar Status" com o estado canônico e os valores da liquidação.
    bet: z
      .object({
        id: z.uuid(),
        state: z.enum(['open', 'settled', 'cancelled']),
        completionState: z.enum(['incomplete', 'complete']),
        stake: z.string().nullable(),
        odds: z.string().nullable(),
        remaining: z.string().nullable(),
        // R8: casa canônica da aposta (finance.bet) e seleções com datas —
        // alimentam as seções pós-importação do Mini App.
        bookmakerId: z.uuid().nullable(),
        bookmakerName: z.string().nullable(),
        // STK-G0-20 B5 — tipster canônico da aposta (seção "Alterar Tipster").
        tipsterId: z.uuid().nullable(),
        tipsterName: z.string().nullable(),
        freebetId: z.uuid().nullable(),
        // Valor do crédito atual; permite distinguir freebet pura de híbrida
        // mesmo quando um registro legado não trouxe betOrigin.
        freebetAmount: z.string().nullable().optional(),
        selections: z.array(
          z.object({
            id: z.uuid(),
            event: z.string(),
            market: z.string(),
            selection: z.string(),
            eventAt: instant.nullable(),
            dateStatus: z.enum(['confirmed', 'estimated', 'pending']),
          }),
        ),
      })
      .nullable(),
    // Estado da política automática (aviso sanitizado; nunca uma decisão do
    // cliente). 'disabled' quando AUTOMATIC_IMPORT_ENABLED=false.
    automaticPolicy: z.enum(['disabled', 'absent', 'invalid', 'approved']),
    duplicates: z.array(duplicateSchema),
    duplicateCount: z.number().int().nonnegative(),
    automatic: z.boolean(),
    automaticReason: automaticReasonSchema,
  })
  .meta({ id: 'ImportDetail' });
export type ImportDetail = z.infer<typeof importDetailSchema>;
// STK-G0-19-R5: atualização do rascunho canônico antes da confirmação — a
// origem financeira, o crédito escolhido e a data do evento são declarados
// pelo usuário; versão otimista evita sobrescrita concorrente.
export const draftUpdateSchema = z
  .strictObject({
    version: z.number().int().positive(),
    betOrigin: z.enum(['real', 'freebet', 'hibrida']).nullable().optional(),
    freebetId: z.uuid().nullable().optional(),
    eventAt: instant.nullable().optional(),
    // STK-G0-19-R7: casa declarada pelo usuário (seção "Alterar Casa"); null
    // limpa a escolha e volta à casa resolvida pela legenda/extração.
    bookmakerId: z.uuid().nullable().optional(),
    tipsterId: z.uuid().nullable().optional(),
    sport: z.string().trim().max(120).nullable().optional(),
    tournament: z.string().trim().max(200).nullable().optional(),
    country: z.string().trim().max(120).nullable().optional(),
    ticketKind: ticketKindSchema.nullable().optional(),
    stake: z
      .string()
      .trim()
      .regex(/^\d{1,12}(\.\d{1,4})?$/)
      .nullable()
      .optional(),
    odds: z
      .string()
      .trim()
      .regex(/^\d{1,12}(\.\d{1,4})?$/)
      .nullable()
      .optional(),
    selections: z
      .array(
        z.strictObject({
          event: z.string().trim().max(240).nullable(),
          market: z.string().trim().max(240).nullable(),
          selection: z.string().trim().max(240).nullable(),
        }),
      )
      .max(50)
      .optional(),
  })
  .refine(
    (value) => {
      if (value.betOrigin === 'freebet' || value.betOrigin === 'hibrida')
        return value.freebetId !== undefined && value.freebetId !== null;
      if (value.betOrigin === 'real' || value.betOrigin === null)
        return value.freebetId === undefined || value.freebetId === null;
      return true;
    },
    { message: 'INVALID_FREEBET_SELECTION' },
  );
export type DraftUpdate = z.infer<typeof draftUpdateSchema>;

// STK-G0-19-R7 — resultado da edição do rascunho: versão + avisos sanitizados
// (crédito removido por incompatibilidade de casa; estado da política
// automática — nunca uma decisão, apenas o que informar ao usuário).
export const draftUpdateResultSchema = z
  .object({
    version: z.number().int().positive(),
    freebetCleared: z.boolean(),
    automaticPolicy: z.enum(['disabled', 'absent', 'invalid', 'approved']),
  })
  .meta({ id: 'DraftUpdateResult' });
export type DraftUpdateResult = z.infer<typeof draftUpdateResultSchema>;

// Confirmação explícita feita pelo proprietário dentro do Mini App. A edição
// do rascunho continua sendo uma operação separada; esta rota apenas pede ao
// servidor que use o rascunho canônico atual para criar a aposta financeira.
export const importConfirmSchema = z
  .strictObject({ version: z.number().int().positive() })
  .meta({ id: 'ImportConfirm' });
export const importConfirmResultSchema = z
  .object({
    version: z.number().int().positive(),
    betId: z.uuid(),
    betState: z.string(),
  })
  .meta({ id: 'ImportConfirmResult' });

// STK-G0-19-R7 — transições REAIS de status disponíveis para a aposta de uma
// importação pendente no Mini App (seção "Alterar Status").
// STK-G0-20 — teclado de status (Ganha, Perdida, Meio-Ganha, Meio-Perdida,
// Reembolsada) + 'pending' (no-op informativo: mantém pendente).
export const IMPORT_STATUS_ACTIONS = [
  'win',
  'loss',
  'void',
  'half_win',
  'half_loss',
  'pending',
] as const;
// STK-G0-20 B4/B5 — cashout exige o valor de retorno informado pelo usuário
// (nunca derivado); a modalidade parcial encerra apenas parte do valor aberto.
export const IMPORT_CASHOUT_ACTIONS = ['cashout', 'partial_cashout'] as const;
const moneyAmount = z.string().regex(/^\d{1,12}(\.\d{1,2})?$/);
export const importStatusSchema = z
  .strictObject({
    version: z.number().int().positive(),
    action: z.enum([...IMPORT_STATUS_ACTIONS, ...IMPORT_CASHOUT_ACTIONS]),
    /** Obrigatório em cashout/partial_cashout: quanto foi efetivamente recebido. */
    returnAmount: moneyAmount.optional(),
    /** Obrigatório em partial_cashout: quanto do valor aberto foi encerrado. */
    closedPrincipal: moneyAmount.optional(),
  })
  .refine(
    (value) =>
      value.action === 'cashout'
        ? value.returnAmount !== undefined && value.closedPrincipal === undefined
        : value.action === 'partial_cashout'
          ? value.returnAmount !== undefined && value.closedPrincipal !== undefined
          : value.returnAmount === undefined && value.closedPrincipal === undefined,
    { message: 'CASHOUT_VALUES_INVALID' },
  )
  .meta({ id: 'ImportStatusUpdate' });
export type ImportStatusUpdate = z.infer<typeof importStatusSchema>;
export const importStatusResultSchema = z
  .object({
    version: z.number().int().positive(),
    betState: z.string(),
  })
  .meta({ id: 'ImportStatusResult' });

// STK-G0-19-R8 — ações canônicas pós/pré-importação: casa, origem e data do
// evento. As rotas roteiam rascunho (inbox) ou aposta (comandos financeiros);
// o cliente envia apenas ação + versão otimista.
export const importBookmakerActionSchema = z
  .strictObject({
    version: z.number().int().positive(),
    bookmakerId: z.uuid(),
    freebetId: z.uuid().nullable().optional(),
  })
  .meta({ id: 'ImportBookmakerAction' });
export const importBookmakerResultSchema = z
  .object({
    version: z.number().int().positive(),
    betState: z.string().nullable(),
    bookmakerId: z.uuid(),
    bookmakerName: z.string().nullable(),
    freebetCleared: z.boolean(),
  })
  .meta({ id: 'ImportBookmakerResult' });
export const importOriginActionSchema = z
  .strictObject({
    version: z.number().int().positive(),
    kind: z.enum(['real', 'freebet', 'hibrida']),
    freebetId: z.uuid().nullable().optional(),
  })
  .meta({ id: 'ImportOriginAction' });
export const importOriginResultSchema = z
  .object({
    version: z.number().int().positive(),
    betState: z.string().nullable(),
    kind: z.enum(['real', 'freebet', 'hibrida']),
    freebetCleared: z.boolean(),
  })
  .meta({ id: 'ImportOriginResult' });
// STK-G0-20 B3 — troca de tipster canônica da aposta aberta (seleção do
// Telegram/Mini App/Web com versão otimista e recibo idempotente).
export const importTipsterActionSchema = z
  .strictObject({
    version: z.number().int().positive(),
    tipsterId: z.uuid(),
  })
  .meta({ id: 'ImportTipsterAction' });
export const importTipsterResultSchema = z
  .object({
    version: z.number().int().positive(),
    betState: z.string().nullable(),
    tipsterId: z.uuid(),
    tipsterName: z.string().nullable(),
  })
  .meta({ id: 'ImportTipsterResult' });
export const importEventActionSchema = z
  .strictObject({
    version: z.number().int().positive(),
    selectionId: z.uuid(),
    eventAt: instant.nullable(),
  })
  .meta({ id: 'ImportEventAction' });
export const importEventResultSchema = z
  .object({
    version: z.number().int().positive(),
    betState: z.string().nullable(),
  })
  .meta({ id: 'ImportEventResult' });
// STK-G0-19-R9 — créditos freebet válidos PARA A CASA DE DESTINO.
export const importCreditsQuerySchema = z.object({ bookmakerId: z.uuid() });
export const importCreditsResultSchema = z
  .object({
    credits: z.array(
      z.object({
        id: z.uuid(),
        bookmakerId: z.uuid(),
        amount: z.string(),
        expiresOn: z.iso.date(),
        stakeReturned: z.boolean(),
      }),
    ),
  })
  .meta({ id: 'ImportCreditsResult' });
export const ticketExtractionJsonSchema = z.toJSONSchema(ticketExtractionSchema);

export const completionSchema = z.object({
  id: z.string().min(1).max(200),
  model: z.enum(OPENROUTER_MODELS),
  provider: z.string().min(1).max(200).optional(),
  choices: z
    .array(
      z.object({
        finish_reason: z.literal('stop'),
        message: z.object({ content: z.string().min(1).max(65_536), refusal: z.null().optional() }),
      }),
    )
    .length(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative(),
      completion_tokens: z.number().int().nonnegative(),
      cost: z.number().finite().nonnegative().optional(),
    })
    .optional(),
});

const telegramId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const telegramFileSchema = z.object({
  file_id: z.string().min(1).max(512),
  file_unique_id: z.string().min(1).max(512),
  file_size: z.number().int().positive().max(MAX_IMAGE_BYTES).optional(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export const telegramUpdateIdSchema = z.object({
  update_id: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER - 1),
});
export const telegramMessageSchema = telegramUpdateIdSchema.extend({
  message: z.object({
    message_id: telegramId,
    date: telegramId,
    from: z.object({ id: telegramId, is_bot: z.literal(false) }),
    chat: z.object({ id: telegramId, type: z.literal('private') }),
    sender_chat: z.never().optional(),
    business_connection_id: z.never().optional(),
    via_bot: z.never().optional(),
    forward_origin: z.never().optional(),
    caption: z.string().max(1024).optional(),
    photo: z.array(telegramFileSchema).min(1).max(20).optional(),
    document: z
      .object({
        file_id: z.string().min(1).max(512),
        file_unique_id: z.string().min(1).max(512),
        file_size: z.number().int().positive().max(MAX_IMAGE_BYTES).optional(),
        mime_type: z.enum(['image/png', 'image/jpeg']),
      })
      .optional(),
  }),
});

export function parseCaption(caption: string) {
  const lines = caption
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim());
  // STK-G0-19-R5: a legenda contém apenas tipster e casa. A origem financeira
  // (real|freebet), o crédito e a data do jogo são declarados pelo usuário no
  // Mini App ou na web — nunca vêm da legenda, da imagem ou da IA. Linhas
  // extras de envios antigos são toleradas e ignoradas; tipster/casa ausentes
  // ou fora do limite permanecem em revisão manual.
  const tipster = lines[0] || null;
  const bookmaker = lines[1] || null;
  return {
    tipster,
    bookmaker,
    requiresReview: !tipster || !bookmaker || tipster.length > 100 || bookmaker.length > 100,
  };
}
