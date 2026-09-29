import { z } from 'zod';
import { oddsSchema, positiveMoneySchema } from './finance.js';

/**
 * STK-F2-07 — o registro por texto em português do Brasil.
 *
 * Este é o ÚNICO formato que a leitura de texto livre pode produzir, e ele é
 * `strictObject`: qualquer campo fora daqui (uma casa, uma recomendação, um
 * comentário do modelo) é rejeitado na borda e nunca chega ao banco. É a mesma
 * sanitização por ausência de campo que a STK-F2-06 aplica à extração de
 * imagem, e ela é o que impede a persistirem texto do fornecedor.
 *
 * O que o texto livre NÃO carrega, e essa lista é o card inteiro:
 *
 *  - Nenhuma casa e nenhum tipster saem do modelo. A casa e o tipster são
 *    DECLARAÇÃO do usuário e chegam pelo catálogo; o preview da STK-F2-05 é a
 *    superfície onde ele escolhe. O que o texto faz é apontar um NOME, e a
 *    resolução happenes por alias no servidor — inválido é `null`, nunca um
 *    cadastro criado em silêncio.
 *  - Nenhuma origem financeira. `real`, `freebet` e `hibrida` são escolhidas no
 *    preview, e a hybrids exige um crédito compatível revalidado sob lock.
 *  - Nenhuma data. A data de envio é o instante da mensagem ORIGINAL, que o
 *    servidor já conhece; a data do evento é declaração separada.
 *  - Nenhuma recomendação, nenhum palpite, nenhuma análise. O modelo lê; ele
 *    não opina. Campos como `warnings` carregam apenas "não deu para ler" —
 *    um aviso de leitura, nunca um conselho sobre a aposta.
 *
 * Tudo que sobrar é o que o servidor pode revalidar sozinho: valor, odd,
 * referência e as seleções.
 */

/**
 * Uma seleção lida do texto. Mesma forma da extração de imagem, sem casas.
 *
 * SEM `meta({id})` de propósito: o repo só nomeia no OpenAPI os schemas que uma
 * rota expõe, e este é um contrato interno de worker — nomeá-lo colocaria um
 * componente órfão no `docs/openapi.json`, que o `api:spec:check` reprova.
 * É o mesmo motivo declarado em `extractionUsageSchema` (F2-06).
 */
export const textBetSelectionSchema = z.strictObject({
  event: z.string().trim().min(1).max(300).nullable(),
  sport: z.string().trim().min(1).max(100).nullable(),
  market: z.string().trim().min(1).max(300).nullable(),
  selection: z.string().trim().min(1).max(300).nullable(),
  odds: oddsSchema.nullable(),
});
export type TextBetSelection = z.infer<typeof textBetSelectionSchema>;

/**
 * Estrutura lida do texto livre. `strictObject` nos dois níveis: um payload com
 * `rawResponse`, `bookmaker`, `recommendation` ou qualquer campo extra é
 * REJEITADO, e o banco nunca viu a resposta do fornecedor porque não existe
 * coluna onde ela caberia.
 */
export const textBetDraftSchema = z.strictObject({
  reference: z.string().trim().max(150).nullable(),
  stake: positiveMoneySchema.nullable(),
  odds: oddsSchema.nullable(),
  /**
   * Nomes declarados no texto, resolvidos por alias contra o catálogo ATIVO da
   * organização. São NOME, não id: o servidor decide a qual cadastro pertence e
   * um nome desconhecido vira `null` (recusa), nunca cadastro novo.
   */
  bookmakerName: z.string().trim().min(1).max(100).nullable(),
  tipsterName: z.string().trim().min(1).max(100).nullable(),
  selections: z.array(textBetSelectionSchema).min(1).max(40),
  /** Apenas "não deu para ler com segurança". Nunca recomendação. */
  warnings: z.array(z.string().trim().min(1).max(200)).max(20),
});
export type TextBetDraft = z.infer<typeof textBetDraftSchema>;

/**
 * O schema estrutural enviado ao fornecedor. É o mesmo desenho da
 * `ticketExtractionJsonSchema` (STK-G0-19), e a remoção das restrições de
 * validação fica no chamador — provedores diferentes recusam JSON Schema com
 * `pattern`/`maxLength`, e a validação real acontece aqui na borda, com o
 * Zod. Sem `meta({id})` de propósito: este é um contrato de-worker, não um
 * componente de rota, e nomeá-lo o colocaria no OpenAPI como órfão.
 */
export const textBetDraftJsonSchema = z.toJSONSchema(textBetDraftSchema);

/**
 * Versão do pipeline gravada com a leitura de texto, ao lado da da imagem.
 * Ela responde "com qual regra este rascunho textual foi lido", e muda junto com
 * a política — nunca sozinha.
 */
export const TEXT_PIPELINE_VERSION = 'f2-07-v1';

/** Códigos sanitizados desta fronteira. O nome do código É a informação. */
export const TELEGRAM_TEXT_ERROR_CODES = [
  /** A leitura não satisfaz o schema: nada foi apresentado, nada foi escrito. */
  'TELEGRAM_TEXT_UNREADABLE',
  /** Resposta incerta do fornecedor: sem repetição, sem cota, ação manual. */
  'TELEGRAM_TEXT_UNCERTAIN',
  /** Teto de cota ou circuito aberto: nenhuma chamada paga foi feita. */
  'TELEGRAM_TEXT_REFUSED',
  /** Texto fora da janela de tamanho: recusado antes de qualquer chamada. */
  'TELEGRAM_TEXT_OUT_OF_BOUNDS',
  /** Confirmar sem um rascunho aberto, ou rascunho já decidido. */
  'TELEGRAM_TEXT_NOT_PENDING',
] as const;
export const telegramTextErrorCodeSchema = z.enum(TELEGRAM_TEXT_ERROR_CODES);
export type TelegramTextErrorCode = z.infer<typeof telegramTextErrorCodeSchema>;
