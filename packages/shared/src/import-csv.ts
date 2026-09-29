// STK-F2-09 — o contrato da importação por CSV, na superfície pura (sem banco,
// sem rede, sem segredo).
//
// A importação por arquivo é a MESMA fronteira financeira da foto, com uma
// diferença de superfície: aqui o usuário já tem o dado escrito, e a única
// pergunta do produto é "isto aqui vira uma aposta?". Quatro garantias moram
// neste arquivo, e cada uma é uma FUNÇÃO, não um comentário:
//
//  1) DOIS CAMINHOS, UM CONTRATO. O template Stakeframe e o CSV genérico
//     produzem a MESMA linha canônica depois do mapeamento. Não existe um
//     "modo template" que pule validação: o template é o caso particular em que
//     o mapeamento é a identidade, e a origem declarada é a marcação do lote.
//
//  2) O MAPEAMENTO É DO USUÁRIO, NUNCA INFERIDO. Nenhuma coluna é escolhida
//     por posição, por fornecedor ou por semelhança silenciosa. A coluna
//     canônica vem do mapeamento DECLARADO, e a função de sugestão existe
//     justamente para o servidor não decidir: ela devolve a equivalência óbvia
//     como sugestão, e o descarte é do usuário.
//
//  3) NADA ENTRA NO BANCO ANTES DO PREVIEW. Este arquivo só PRODUZ a linha
//     validada e o veredito. A gravação é do serviço, que a faz na mesma
//     transação em que grava o recibo idempotente do lote.
//
//  4) SEM PII DE TERCEIROS. Um arquivo de histórico de outro produto traz nome
//     e casa de outra pessoa; a marcação de origem existe para que o registro
//     diga DE ONDE a linha veio, e o conteúdo da linha nunca é logado — só o
//     hash, o código e o número.
//
// Nenhuma chamada paga, nenhum parse de concorrente, nenhuma API de casa e
// nenhum resultado de aposta importado: a data e o retorno de um lançamento já
// liquidado não podem ser deduzidos de um arquivo, e o escopo excluído do
// card (parsers de concorrentes) impede que o produto aprenda o formato de outro.

import { z } from 'zod';
import { cents, money, oddsInteger } from './decimal.js';

/**
 * Colunas canônicas do Stakeframe. É o vocabulário do template e o destino de
 * qualquer mapeamento visual: o CSV genérico descreve ONDE está cada uma, e o
 * servidor decide o QUE ela significa. Uma coluna canônica fora desta lista é
 * recusada na borda, então um mapeamento inventado nunca vira aposta.
 */
export const IMPORT_COLUMNS = [
  'reference',
  'bookmaker',
  'tipster',
  'stake',
  'odds',
  'placed_at',
  'sport',
  'event',
  'market',
  'selection',
  'bet_origin',
  'freebet_id',
] as const;
export const importColumnSchema = z.enum(IMPORT_COLUMNS);
export type ImportColumn = z.infer<typeof importColumnSchema>;

/**
 * Colunas obrigatórias para a linha virar aposta: casa, valor, odd, o instante
 * do registro e ao menos uma seleção completa. `placed_at` é a data real do
 * registro — nunca inferida de outra coluna.
 *
 * `bet_origin` NÃO é obrigatória: a origem assume `real` quando a célula é
 * vazia, e qualquer outra origem precisa ser DECLARADA junto do crédito que a
 * sustenta. É essa exigência que impede a importação de expor caixa real por
 * um arquivo que o usuário preencheu às pressas.
 */
export const REQUIRED_IMPORT_COLUMNS = [
  'bookmaker',
  'stake',
  'odds',
  'placed_at',
  'event',
  'market',
  'selection',
] as const satisfies readonly ImportColumn[];
export type RequiredImportColumn = (typeof REQUIRED_IMPORT_COLUMNS)[number];

/** Quantas linhas um lote pode trazer. Teto de fila, não de memória. */
export const MAX_IMPORT_ROWS = 500;
/** Quantas colunas o cabeçalho pode declarar. */
export const MAX_IMPORT_COLUMNS = 64;
/** Quantas linhas o preview devolve no corpo da resposta. */
export const MAX_IMPORT_PREVIEW_ROWS = 200;

/** Origens declaradas: o template do produto e o CSV genérico mapeado. */
export const IMPORT_ORIGINS = ['stakeframe_template', 'csv_generic'] as const;
export const importOriginSchema = z.enum(IMPORT_ORIGINS);
export type ImportOrigin = z.infer<typeof importOriginSchema>;

/** Marcadores de cabeçalho aceitos em português e inglês, por coluna canônica. */
const HEADER_ALIASES: Record<ImportColumn, readonly string[]> = {
  reference: ['referencia', 'referência', 'reference', 'codigo', 'código', 'cod', 'id'],
  bookmaker: ['casa', 'bookmaker', 'book', 'casa_de_aposta', 'casaaposta'],
  tipster: ['tipster', 'apostador', 'analista', 'dono', 'dono_da_aposta'],
  stake: ['stake', 'valor', 'stake_brl', 'valor_apostado', 'apostado'],
  odds: ['odd', 'odds', 'cotacao', 'cotação', 'coeficiente', 'probabilidade'],
  placed_at: ['data_hora', 'datahora', 'placed_at', 'data', 'data_aposta', 'criado_em'],
  sport: ['esporte', 'sport', 'modalidade', 'categoria'],
  event: ['evento', 'event', 'jogo', 'partida', 'confronto'],
  market: ['mercado', 'market', 'tipo_aposta', 'tipo'],
  selection: ['selecao', 'seleção', 'selection', 'escolha', 'palpite'],
  bet_origin: ['origem', 'bet_origin', 'origem_aposta', 'modalidade_financeira'],
  freebet_id: ['freebet_id', 'credito_id', 'id_credito', 'freebet'],
};

/** O cabeçalho do TEMPLATE é o próprio nome canônico, sem mediações. */
const CANONICAL_HEADERS = new Set<string>(IMPORT_COLUMNS);

/** Diacríticos combinantes: removidos só para COMPARAR cabeçalhos. */
const COMBINING_MARKS = new RegExp('[\\u0300-\\u036f]', 'g');

/**
 * Reduz um cabeçalho à sua forma comparável: NFD sem diacríticos, minúsculas,
 * só letras/números. É o que faz "Stake", "STAKE" e "stake " serem a mesma
 * coluna, e o que impede que a comparação dependa da digitação.
 *
 * A redução NÃO escolhe a coluna de um CSV genérico: ela alimenta a SUGESTÃO
 * que a interface mostra e a detecção do template, e nada mais.
 */
export function canonicalizeHeader(value: string): string {
  return value
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** A coluna canônica que um cabeçalho representa, quando a equivalência é óbvia. */
export function canonicalHeaderColumn(value: string): ImportColumn | null {
  const normalized = canonicalizeHeader(value);
  if (CANONICAL_HEADERS.has(normalized)) return normalized as ImportColumn;
  for (const column of IMPORT_COLUMNS) {
    if (HEADER_ALIASES[column].some((alias) => canonicalizeHeader(alias) === normalized))
      return column;
  }
  return null;
}

/**
 * O arquivo é o TEMPLATE do Stakeframe?
 *
 * Reconhecer pelo NOME do arquivo seria aceitar `qualquer.csv` como template e
 * um template renomeado como genérico. O reconhecimento é pelo CABEÇALHO, que é
 * a parte que o servidor pode verificar: o template é o arquivo cujas colunas
 * obrigatórias estão todas presentes e reconhecidas. Colunas a mais que o
 * produto não usa são toleradas — quem exporta de um histórico externo quase
 * sempre tem colunas extras, e recusar o arquivo inteiro por causa delas seria
 * pior do que ignorá-las.
 */
export function isStakeframeTemplate(headers: readonly string[]): boolean {
  if (headers.length === 0) return false;
  const recognized = new Set(
    headers
      .map((header) => canonicalHeaderColumn(header))
      .filter((column): column is ImportColumn => column !== null),
  );
  return REQUIRED_IMPORT_COLUMNS.every((column) => recognized.has(column));
}

/** A origem financeira de uma linha, já resolvida. */
export const importRowOriginSchema = z.enum(['real', 'freebet', 'hibrida']);
export type ImportRowOrigin = z.infer<typeof importRowOriginSchema>;

/**
 * Uma linha do arquivo, já com as colunas resolvidas e os valores lidos.
 *
 * `reference` é o que AGRUPA as linhas de uma múltipla: duas linhas com a
 * mesma casa, a mesma referência e o mesmo instante são uma aposta só. Sem
 * referência, cada linha é uma aposta — e o usuário é avisado no preview de
 * que a múltipla não vai se formar.
 */
export const importRowInputSchema = z.strictObject({
  bookmaker: z.string().trim().min(1).max(100),
  tipster: z.string().trim().min(1).max(100).nullable(),
  stake: z.string().regex(/^\d{1,12}(\.\d{1,2})?$/),
  odds: z.string().regex(/^(0|[1-9]\d{0,5})(\.\d{1,4})?$/),
  placedAt: z.iso.datetime({ offset: true }),
  reference: z.string().trim().min(1).max(150).nullable(),
  sport: z.string().trim().min(1).max(100).nullable(),
  event: z.string().trim().min(1).max(300),
  market: z.string().trim().min(1).max(300),
  selection: z.string().trim().min(1).max(300),
  betOrigin: importRowOriginSchema,
  freebetId: z.uuid().nullable(),
});
export type ImportRowInput = z.infer<typeof importRowInputSchema>;

/** Códigos de erro POR LINHA. Fechados, sanitizados, sem o valor que falhou. */
export const IMPORT_ROW_ERROR_CODES = [
  'IMPORT_ROW_EMPTY',
  'IMPORT_STAKE_INVALID',
  'IMPORT_ODDS_INVALID',
  'IMPORT_PLACED_AT_INVALID',
  'IMPORT_PLACED_AT_FUTURE',
  'IMPORT_BOOKMAKER_UNRESOLVED',
  'IMPORT_TIPSTER_UNRESOLVED',
  'IMPORT_SELECTION_MISSING',
  'IMPORT_ORIGIN_INVALID',
  'IMPORT_FREEBET_REQUIRED',
  'IMPORT_FREEBET_UNRESOLVED',
  'IMPORT_ROW_INCOMPATIBLE',
  'IMPORT_DUPLICATE',
  'IMPORT_ROW_LIMIT_REACHED',
] as const;
export const importRowErrorCodeSchema = z.enum(IMPORT_ROW_ERROR_CODES);
export type ImportRowErrorCode = z.infer<typeof importRowErrorCodeSchema>;

/** Uma linha do preview: o que o usuário vê, com o motivo da recusa. */
export const importRowPreviewSchema = z
  .object({
    /** Posição 1-based dentro do arquivo, como o usuário contou. */
    line: z.number().int().positive(),
    status: z.enum(['valid', 'invalid', 'duplicate']),
    /** A linha normalizada, quando ela chegou a ser uma aposta possível. */
    bet: importRowInputSchema.nullable(),
    errors: z.array(importRowErrorCodeSchema).max(8),
  })
  .meta({ id: 'ImportRowPreview' });
export type ImportRowPreview = z.infer<typeof importRowPreviewSchema>;

/** O preview do lote: contagens explícitas e as linhas, sem o conteúdo bruto. */
export const importPreviewSchema = z
  .object({
    headers: z.array(z.string().max(200)).max(MAX_IMPORT_COLUMNS),
    /** `stakeframe_template` = cabeçalho canônico; `csv_generic` = mapeado. */
    source: importOriginSchema,
    total: z.number().int().nonnegative(),
    valid: z.number().int().nonnegative(),
    invalid: z.number().int().nonnegative(),
    duplicates: z.number().int().nonnegative(),
    rows: z.array(importRowPreviewSchema).max(MAX_IMPORT_PREVIEW_ROWS),
    /** Colunas exigidas que o mapeamento efetivo não resolve. */
    missing: z.array(importColumnSchema).max(IMPORT_COLUMNS.length),
    /** Quantas apostas as linhas válidas formam depois do agrupamento. */
    groups: z.number().int().nonnegative(),
    /** Verdadeiro quando há ao menos uma linha que pode virar aposta. */
    confirmable: z.boolean(),
  })
  .meta({ id: 'ImportPreview' });
export type ImportPreview = z.infer<typeof importPreviewSchema>;

/** O mapeamento declarado: coluna do arquivo -> coluna canônica. */
export const importMappingSchema = z.strictObject({
  headers: z.array(z.string().max(200)).min(1).max(MAX_IMPORT_COLUMNS),
  mapping: z
    .array(z.strictObject({ header: z.string().max(200), column: importColumnSchema }))
    .min(1)
    .max(MAX_IMPORT_COLUMNS),
  /** A casa/tipster/origem usados quando a linha não traz a sua. Nunca inferidos. */
  defaultBookmaker: z.string().trim().min(1).max(100).nullable(),
  defaultTipster: z.string().trim().min(1).max(100).nullable(),
  defaultBetOrigin: importRowOriginSchema.nullable(),
});
export type ImportMapping = z.infer<typeof importMappingSchema>;

/** O pedido de preview: o arquivo e o mapeamento declarado. */
export const importPreviewRequestSchema = z
  .strictObject({
    content: z.string().min(1).max(4_000_000),
    filename: z.string().max(200),
    mapping: importMappingSchema.nullable(),
  })
  .meta({ id: 'ImportPreviewRequest' });
export type ImportPreviewRequest = z.infer<typeof importPreviewRequestSchema>;

/** O estado do job de importação, lido pelo cliente para o progresso. */
export const IMPORT_BATCH_STATES = [
  'preview',
  'committed',
  'partially_committed',
  'rolled_back',
] as const;
export const importBatchStateSchema = z.enum(IMPORT_BATCH_STATES);
export type ImportBatchState = z.infer<typeof importBatchStateSchema>;

/**
 * O LOTE, e seu resultado PARCIAL explícito.
 *
 * `committed` são APOSTAS gravadas e `skipped` são LINHAS que não entraram;
 * `bets` e `skippedRows` fecham com a lista do preview linha a linha, e nunca
 * há linha que "desapareça" entre o que o usuário leu e o que foi gravado. O
 * motivo de cada `skipped` é um código fechado.
 */
export const importBatchResultSchema = z
  .object({
    batchId: z.uuid(),
    version: z.number().int().positive(),
    state: importBatchStateSchema,
    origin: importOriginSchema,
    total: z.number().int().nonnegative(),
    committed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    /** Uma entrada por linha pulada, com o código que a recusou. */
    skippedRows: z
      .array(
        z.strictObject({
          line: z.number().int().positive(),
          code: importRowErrorCodeSchema,
        }),
      )
      .max(MAX_IMPORT_ROWS),
    /** Uma aposta por grupo gravado, com as linhas que a formaram. */
    bets: z
      .array(
        z.strictObject({
          lines: z.array(z.number().int().positive()).min(1).max(MAX_IMPORT_ROWS),
          betId: z.uuid(),
        }),
      )
      .max(MAX_IMPORT_ROWS),
    /** `true` quando houve linha recusada: o resultado é PARCIAL, e o diz. */
    partial: z.boolean(),
    committedAt: z.iso.datetime({ offset: true }).nullable(),
    rolledBackAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .meta({ id: 'ImportBatchResult' });
export type ImportBatchResult = z.infer<typeof importBatchResultSchema>;

/** Confirmação do lote: as linhas escolhidas, e a chave idempotente. */
export const importBatchCommitSchema = z
  .strictObject({
    version: z.number().int().positive(),
    /** Linhas escolhidas (1-based). Ausente = todas as linhas válidas. */
    lines: z.array(z.number().int().positive()).max(MAX_IMPORT_ROWS).optional(),
    reason: z.string().trim().min(3).max(500),
  })
  .meta({ id: 'ImportBatchCommit' });
export type ImportBatchCommit = z.infer<typeof importBatchCommitSchema>;

/** Reversão do lote, disponível enquanto ele não foi confirmado. */
export const importBatchRollbackSchema = z
  .strictObject({ version: z.number().int().positive() })
  .meta({ id: 'ImportBatchRollback' });

/** Lista de lotes da organização, com o estado do job para o progresso. */
export const importBatchListSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            id: z.uuid(),
            version: z.number().int().positive(),
            state: importBatchStateSchema,
            origin: importOriginSchema,
            filename: z.string().max(200),
            total: z.number().int().nonnegative(),
            committed: z.number().int().nonnegative(),
            skipped: z.number().int().nonnegative(),
            createdAt: z.iso.datetime({ offset: true }),
          })
          .meta({ id: 'ImportBatchEntry' }),
      )
      .max(100),
  })
  .meta({ id: 'ImportBatchList' });
export type ImportBatchList = z.infer<typeof importBatchListSchema>;

/** O TEMPLATE, gerado no servidor. Nunca é um arquivo de concorrente. */
export const importTemplateSchema = z
  .object({
    filename: z.string().max(200),
    headers: z.array(importColumnSchema),
    /** Uma linha de exemplo, com dados FICTÍCIOS e valores não registráveis. */
    sample: z.string().max(2_000),
  })
  .meta({ id: 'ImportTemplate' });
export type ImportTemplate = z.infer<typeof importTemplateSchema>;

export const IMPORT_BATCH_ERROR_CODES = [
  'IMPORT_BATCH_NOT_FOUND',
  'IMPORT_BATCH_STATE_CONFLICT',
  'IMPORT_BATCH_ALREADY_COMMITTED',
  'IMPORT_TEMPLATE_UNAVAILABLE',
  'IMPORT_FILE_TOO_LARGE',
  'IMPORT_CSV_MALFORMED',
  'IMPORT_MAPPING_CONFLICT',
] as const;
export const importBatchErrorCodeSchema = z.enum(IMPORT_BATCH_ERROR_CODES);
export type ImportBatchErrorCode = z.infer<typeof importBatchErrorCodeSchema>;

/** Orientação de tela para a recusa: fixa por código, e diz o que fazer. */
export const importBatchGuidance = {
  IMPORT_BATCH_NOT_FOUND: 'Este lote não existe nesta organização.',
  IMPORT_BATCH_STATE_CONFLICT:
    'Este lote mudou de estado. Confira o resultado antes de tentar de novo.',
  IMPORT_BATCH_ALREADY_COMMITTED:
    'A confirmação deste lote já foi registrada. Reenvie com a mesma chave para ver o mesmo resultado.',
  IMPORT_TEMPLATE_UNAVAILABLE: 'O modelo de importação está indisponível agora. Tente novamente.',
  IMPORT_FILE_TOO_LARGE: 'O arquivo excede o tamanho aceito. Divida-o em lotes menores.',
  IMPORT_CSV_MALFORMED: 'O arquivo não pôde ser lido. Confira a codificação e o separador.',
  IMPORT_MAPPING_CONFLICT: 'Duas colunas do arquivo foram mapeadas para o mesmo campo.',
} as const satisfies Record<string, string>;

/**
 * Separador de CSV detectado pelo CONTEÚDO, e não pelo nome do arquivo.
 * `;` é o padrão de quebra de linha de uma planilha pt-BR, e um arquivo com
 * vírgula dentro do texto ("Casa, S.A.") não pode ser quebrado por `,`.
 */
export function detectDelimiter(line: string): ',' | ';' | '\t' {
  const commas = countOutsideQuotes(line, ',');
  const semicolons = countOutsideQuotes(line, ';');
  const tabs = countOutsideQuotes(line, '\t');
  if (tabs > commas && tabs > semicolons) return '\t';
  return semicolons > commas ? ';' : ',';
}

function countOutsideQuotes(value: string, character: string): number {
  let count = 0;
  let quoted = false;
  for (const current of value) {
    if (current === '"') quoted = !quoted;
    else if (!quoted && current === character) count += 1;
  }
  return count;
}

/**
 * Quebra o conteúdo em registros CSV, respeitando aspas e quebras de linha
 * dentro do campo. Devolve `{ rows, truncated }`: linhas acima do teto NUNCA
 * entram na memória, porque um lote sem teto é um caminho de exaustão e o erro
 * precisa ser do usuário, com o número.
 */
export function parseCsvRows(
  content: string,
  delimiter: ',' | ';' | '\t',
  limit: number,
): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let quoted = false;
  let truncated = false;
  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    // A última linha do arquivo costuma terminar em quebra; a linha vazia que
    // ela produz não é registro.
    if (row.length === 1 && row[0]!.trim() === '') {
      row = [];
      return;
    }
    if (rows.length >= limit) {
      truncated = true;
      return;
    }
    rows.push(row);
    row = [];
  };
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]!;
    if (quoted) {
      if (character === '"') {
        if (content[index + 1] === '"') {
          field += '"';
          index += 1;
        } else quoted = false;
      } else field += character;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === delimiter) pushField();
    else if (character === '\n') pushRow();
    else if (character === '\r') {
      // CR isolado é ignorado: o CRLF chega como \r\n e o \n já fecha a linha.
      if (content[index + 1] !== '\n') pushRow();
    } else field += character;
  }
  if (field !== '' || row.length > 0) pushRow();
  return { rows, truncated };
}

const ORIGIN_VALUES: Record<string, ImportRowOrigin> = {
  real: 'real',
  dinheiro: 'real',
  dinheiro_real: 'real',
  normal: 'real',
  freebet: 'freebet',
  free_bet: 'freebet',
  bonus: 'freebet',
  credito: 'freebet',
  credito_promocional: 'freebet',
  hibrida: 'hibrida',
  hibrido: 'hibrida',
  mista: 'hibrida',
};

/**
 * A origem financeira declarada na célula. Só aceita o vocabulário FECHADO, e
 * célula vazia é `null` (a origem ainda não foi declarada) — nunca um palpite.
 * Um texto fora do vocabulário é recusa, não aproximação: a origem decide se o
 * caixa é exposto, e "achatar" um texto desconhecido seria decidir sozinho.
 */
export function parseImportOrigin(value: string): ImportRowOrigin | null {
  const normalized = canonicalizeHeader(value);
  if (normalized === '') return null;
  return ORIGIN_VALUES[normalized] ?? null;
}

/**
 * A SUGESTÃO de equivalência cabeçalho -> coluna canônica.
 *
 * Ela existe para a interface mostrar ao usuário o que a equivalência óbvia
 * seria, e é justamente por isso que a função é nomeada `suggest`: o servidor
 * NUNCA a aplica sozinho. Um CSV genérico entra no commit com o mapeamento que
 * o usuário confirmou, e a sugestão que ele recusou não tem caminho de volta.
 */
export function suggestMapping(headers: readonly string[]): Partial<Record<ImportColumn, string>> {
  const suggestions: Partial<Record<ImportColumn, string>> = {};
  for (const header of headers) {
    const column = canonicalHeaderColumn(header);
    if (column && suggestions[column] === undefined) suggestions[column] = header;
  }
  return suggestions;
}

/**
 * O mapeamento EFETIVO: o declarado, ou a identidade do template.
 *
 * Duas colunas do arquivo mapeadas para o mesmo campo canônico é
 * `IMPORT_MAPPING_CONFLICT`: a aposta nasceria de um campo com dois candidatos,
 * e escolher um seria inventar dado de outra pessoa. O servidor recusa e o
 * usuário corrige — que é a direção correta para dado financeiro.
 */
export function resolveMapping(
  headers: readonly string[],
  mapping: ImportMapping | null,
): { origin: ImportOrigin; byColumn: Map<ImportColumn, number> } {
  if (mapping === null) {
    if (!isStakeframeTemplate(headers)) throw new Error('IMPORT_MAPPING_CONFLICT');
    const byColumn = new Map<ImportColumn, number>();
    headers.forEach((header, index) => {
      const column = canonicalHeaderColumn(header);
      // O template resolve por equivalência; a primeira ocorrência vence, para
      // que dois cabeçalhos equivalentes não apontem para o mesmo campo.
      if (column && !byColumn.has(column)) byColumn.set(column, index);
    });
    return { origin: 'stakeframe_template', byColumn };
  }
  if (mapping.headers.length !== headers.length) throw new Error('IMPORT_MAPPING_CONFLICT');
  const byColumn = new Map<ImportColumn, number>();
  headers.forEach((header, index) => {
    if (!mapping!.headers.includes(header)) throw new Error('IMPORT_MAPPING_CONFLICT');
    const entry = mapping!.mapping.find((candidate) => candidate.header === header);
    if (!entry) throw new Error('IMPORT_MAPPING_CONFLICT');
    // Duas colunas para o mesmo campo canônico é conflito declarado, e não
    // uma preferência: o servidor não escolhe entre dois candidatos.
    if (byColumn.has(entry.column)) throw new Error('IMPORT_MAPPING_CONFLICT');
    byColumn.set(entry.column, index);
  });
  // Uma entrada de mapeamento que aponta para um cabeçalho AUSENTE é conflito
  // pelo mesmo motivo: ela é um segundo candidato silencioso, do qual o
  // cabeçalho visível do arquivo não dá conta.
  if (mapping.mapping.length !== headers.length) throw new Error('IMPORT_MAPPING_CONFLICT');
  return { origin: 'csv_generic', byColumn };
}

/** As colunas exigidas que o mapeamento efetivo NÃO resolve. */
export function missingRequiredColumns(byColumn: Map<ImportColumn, number>): ImportColumn[] {
  return REQUIRED_IMPORT_COLUMNS.filter((column) => !byColumn.has(column));
}

/**
 * A data/hora do registro, lida de texto. Aceita ISO com offset, ISO `Z` e os
 * formatos brasileiros que o template documenta; NUNCA o `Date.parse` do
 * navegador, que depende do fuso da máquina e transforma "10/10/2026" em uma
 * data diferente em cada lugar.
 *
 * A data civil SEM hora é completada à meia-noite de São Paulo e não recusada:
 * quem exporta de um histórico externo traga data, e inventar a hora do dia seria
 * pior do que declarar a menor unidade de tempo que ele informou. Dia e mês fora
 * do calendário são recusados por construção — o construtor de Date normaliza
 * 31/02 para março, e isso aceitaria uma data que não existe.
 */
export function parseImportPlacedAt(value: string, saoPauloOffset = '-03:00'): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const iso = z.iso.datetime({ offset: true }).safeParse(trimmed);
  if (iso.success) return iso.data;
  const brDateTime = /^(\d{2})\/(\d{2})\/(\d{4})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
  if (brDateTime) {
    const [, day = '', month = '', year = '', hour = '00', minute = '00', second = '00'] =
      brDateTime;
    if (!isRealCalendarDate(Number(year), Number(month), Number(day))) return null;
    if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null;
    return `${year}-${month}-${day}T${hour}:${minute}:${second}${saoPauloOffset}`;
  }
  const brDate = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(trimmed);
  if (brDate) {
    const [, day = '', month = '', year = ''] = brDate;
    if (!isRealCalendarDate(Number(year), Number(month), Number(day))) return null;
    return `${year}-${month}-${day}T00:00:00${saoPauloOffset}`;
  }
  return null;
}

function isRealCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 2000 || year > 2200) return false;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= last;
}

/**
 * A ESTIMATIVA de retorno a partir de stake × odds, calculada no servidor e
 * usada só no PREVIEW. A aposta real calcula o seu no liquidador; este número
 * existe para o usuário comparar o que o arquivo traz com o que o produto
 * entende, e divergência é informação, não erro.
 */
export function importPotentialReturn(stake: string, odds: string): string | null {
  try {
    const price = oddsInteger(odds);
    const principal = cents(stake);
    if (principal <= 0n) return null;
    return money((principal * price) / 10_000n);
  } catch {
    return null;
  }
}

/**
 * O DESPECHO da linha, e a única decisão que decide se ela entra no lote.
 *
 * `commit` é a linha válida; `skip` é a linha recusada, com o código. Não
 * existe caminho em que uma linha inválida seja gravada: o produto registra o
 * que o usuário DECLAROU, e um valor que não passa pela regra financeira não
 * vira aposta por insistência.
 */
export function importRowDisposition(
  row: ImportRowPreview,
): { commit: true; bet: ImportRowInput } | { commit: false; code: ImportRowErrorCode } {
  if (row.status === 'valid' && row.bet) return { commit: true, bet: row.bet };
  return { commit: false, code: row.errors[0] ?? 'IMPORT_ROW_EMPTY' };
}

/**
 * A CHAVE DE AGRUPAMENTO das linhas de uma mesma aposta.
 *
 * Casa, referência e instante juntos: duas linhas com a mesma referência em
 * casas diferentes são apostas diferentes, e duas linhas com a mesma casa e o
 * mesmo instante mas referências diferentes também. Sem referência, a linha é
 * a própria aposta — e o agrupamento nunca junta duas linhas que o usuário não
 * declarou como o mesmo lançamento.
 */
export function importGroupKey(row: ImportRowInput): string | null {
  if (row.reference === null) return null;
  return `${normalizeLookup(row.bookmaker)}|${normalizeLookup(row.reference)}|${row.placedAt}`;
}

/** Normalização de busca: comparável, sem depender da digitação nem do acento. */
export function normalizeLookup(value: string): string {
  return value
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** O estado do job para o cliente: o progresso vem daqui, e não de SSE. */
export function importBatchProgress(result: ImportBatchResult): {
  percent: number;
  label: string;
} {
  if (result.total === 0) return { percent: 100, label: 'Lote vazio' };
  const percent = Math.round(((result.committed + result.skipped) / result.total) * 100);
  return {
    percent: Math.min(100, Math.max(0, percent)),
    label:
      result.state === 'preview'
        ? 'Aguardando confirmação'
        : result.state === 'rolled_back'
          ? 'Lote revertido'
          : result.partial
            ? `Registro parcial: ${result.committed} de ${result.total} linhas`
            : `${result.total} linhas registradas`,
  };
}
