import { describe, expect, it } from 'vitest';
import {
  IMPORT_COLUMNS,
  MAX_IMPORT_ROWS,
  REQUIRED_IMPORT_COLUMNS,
  canonicalHeaderColumn,
  detectDelimiter,
  importBatchProgress,
  importGroupKey,
  importMappingSchema,
  importPotentialReturn,
  importRowDisposition,
  importRowInputSchema,
  isStakeframeTemplate,
  missingRequiredColumns,
  parseCsvRows,
  parseImportOrigin,
  parseImportPlacedAt,
  resolveMapping,
  suggestMapping,
  type ImportBatchResult,
  type ImportRowInput,
} from '../../packages/shared/src/index.js';

// STK-F2-09 §15 — a superfície pura da importação por arquivo: template,
// mapeamento declarado, quebra do CSV, validação por linha e o estado do job.
// Sem banco, sem rede e sem conteúdo de arquivo em log.

const templateHeaders = [
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
];

const validRow: ImportRowInput = {
  bookmaker: 'Bet365',
  tipster: null,
  stake: '50.00',
  odds: '1.85',
  placedAt: '2026-10-10T20:30:00-03:00',
  reference: 'ABC-1',
  sport: 'Futebol',
  event: 'Alfa x Beta',
  market: 'Resultado da partida',
  selection: 'Alfa',
  betOrigin: 'real',
  freebetId: null,
};

describe('STK-F2-09 §15 — o template do Stakeframe é reconhecido pelo cabeçalho', () => {
  it('reconhece o cabeçalho canônico e tolera colunas extras', () => {
    expect(isStakeframeTemplate(templateHeaders)).toBe(true);
    expect(isStakeframeTemplate([...templateHeaders, 'coluna_do_terceiro'])).toBe(true);
  });

  it('NÃO reconhece um CSV genérico sem mapeamento declarado', () => {
    expect(
      isStakeframeTemplate(['data', 'valor apostado', 'cotacao', 'time', 'mercado', 'palpite']),
    ).toBe(false);
  });

  it('o nome do arquivo não decide: só o cabeçalho', () => {
    // Um template renomeado continua template, e um genérico com as colunas
    // canônicas continua genérico-reconhecível. O que muda é o CONTEÚDO.
    expect(isStakeframeTemplate(templateHeaders)).toBe(true);
    expect(canonicalHeaderColumn('STAKE')).toBe('stake');
    expect(canonicalHeaderColumn('Selecao')).toBe('selection');
    expect(canonicalHeaderColumn('coluna_desconhecida')).toBeNull();
  });

  it('as colunas exigidas são exatamente as que a aposta precisa', () => {
    expect(REQUIRED_IMPORT_COLUMNS).toEqual([
      'bookmaker',
      'stake',
      'odds',
      'placed_at',
      'event',
      'market',
      'selection',
    ]);
    for (const column of REQUIRED_IMPORT_COLUMNS) expect(IMPORT_COLUMNS).toContain(column);
  });
});

describe('STK-F2-09 §15 — o mapeamento é declarado, nunca inferido', () => {
  const genericHeaders = ['data', 'valor apostado', 'cotacao', 'time', 'mercado', 'palpite'];

  it('sem mapeamento e sem cabeçalho canônico, o arquivo é recusado', () => {
    expect(() => resolveMapping(genericHeaders, null)).toThrow('IMPORT_MAPPING_CONFLICT');
  });

  it('o mapeamento declarado resolve por cabeçalho, não por posição', () => {
    const mapping = importMappingSchema.parse({
      headers: genericHeaders,
      mapping: [
        { header: 'data', column: 'placed_at' },
        { header: 'valor apostado', column: 'stake' },
        { header: 'cotacao', column: 'odds' },
        { header: 'time', column: 'bookmaker' },
        { header: 'mercado', column: 'market' },
        { header: 'palpite', column: 'selection' },
      ],
      defaultBookmaker: null,
      defaultTipster: null,
      defaultBetOrigin: null,
    });
    const { origin, byColumn } = resolveMapping(genericHeaders, mapping);
    expect(origin).toBe('csv_generic');
    // `stake` está na POSIÇÃO 1 do arquivo, e o mapeamento o resolveu.
    expect(byColumn.get('stake')).toBe(1);
    expect(missingRequiredColumns(byColumn)).toEqual(['event']);
  });

  it('duas colunas para o mesmo campo é conflito, e o servidor NÃO escolhe', () => {
    const mapping = importMappingSchema.parse({
      headers: genericHeaders,
      mapping: [
        { header: 'data', column: 'stake' },
        { header: 'valor apostado', column: 'stake' },
      ],
      defaultBookmaker: null,
      defaultTipster: null,
      defaultBetOrigin: null,
    });
    expect(() => resolveMapping(genericHeaders, mapping)).toThrow('IMPORT_MAPPING_CONFLICT');
  });

  it('a sugestão existe para a INTERFACE, e é por coluna canônica', () => {
    const suggestions = suggestMapping(['casa', 'Stake', 'desconhecida']);
    // A chave é a coluna canônica e o valor é o cabeçalho do arquivo: é o que
    // a tela de mapeamento mostra pré-preenchido para o usuário confirmar.
    expect(suggestions).toEqual({ bookmaker: 'casa', stake: 'Stake' });
  });
});

describe('STK-F2-09 §15 — a quebra do CSV respeita o arquivo, não o nome', () => {
  it('detecta `;` de planilha pt-BR e `,` de exportação comum', () => {
    expect(detectDelimiter('a;b;c')).toBe(';');
    expect(detectDelimiter('a,b,c')).toBe(',');
    expect(detectDelimiter('a\tb\tc')).toBe('\t');
  });

  it('uma vírgula dentro do texto não vira separador', () => {
    expect(detectDelimiter('"casa, s.a.";stake;odd')).toBe(';');
  });

  it('aspas, escape e quebra de linha dentro do campo', () => {
    const parsed = parseCsvRows('a,b\n"x,1","diz ""oi"""\n"linha\nquebrada",2\n', ',', 10);
    expect(parsed.truncated).toBe(false);
    expect(parsed.rows).toEqual([
      ['a', 'b'],
      ['x,1', 'diz "oi"'],
      ['linha\nquebrada', '2'],
    ]);
  });

  it('acima do teto, a linha NÃO entra na memória e o usuário é avisado', () => {
    const content = `a,b\n${'x,y\n'.repeat(MAX_IMPORT_ROWS + 5)}`;
    const parsed = parseCsvRows(content, ',', MAX_IMPORT_ROWS);
    expect(parsed.truncated).toBe(true);
    expect(parsed.rows).toHaveLength(MAX_IMPORT_ROWS);
  });
});

describe('STK-F2-09 §15 — a data do registro é lida, nunca adivinhada', () => {
  it('aceita ISO com offset, ISO Z e os formatos brasileiros', () => {
    expect(parseImportPlacedAt('2026-10-10T20:30:00-03:00')).toBe('2026-10-10T20:30:00-03:00');
    expect(parseImportPlacedAt('2026-10-10T23:30:00Z')).toBe('2026-10-10T23:30:00Z');
    expect(parseImportPlacedAt('10/10/2026 20:30')).toBe('2026-10-10T20:30:00-03:00');
    expect(parseImportPlacedAt('10/10/2026 20:30:15')).toBe('2026-10-10T20:30:15-03:00');
    // Data sem hora vira a MENOR unidade declarada, não um chute de meio-dia.
    expect(parseImportPlacedAt('10/10/2026')).toBe('2026-10-10T00:00:00-03:00');
  });

  it('recusa data que não existe, em vez de normalizar para o mês seguinte', () => {
    // `new Date('31/02/2026')` viraria março; recusar é o comportamento certo.
    expect(parseImportPlacedAt('31/02/2026 10:00')).toBeNull();
    expect(parseImportPlacedAt('10/13/2026 10:00')).toBeNull();
    expect(parseImportPlacedAt('25:00')).toBeNull();
    expect(parseImportPlacedAt('ontem à tarde')).toBeNull();
    expect(parseImportPlacedAt('')).toBeNull();
  });
});

describe('STK-F2-09 §15 — a origem financeira é declarada, nunca achatada', () => {
  it('o vocabulário fechado é aceito e o resto é recusa', () => {
    expect(parseImportOrigin('real')).toBe('real');
    expect(parseImportOrigin('dinheiro real')).toBe('real');
    expect(parseImportOrigin('FreeBet')).toBe('freebet');
    expect(parseImportOrigin('crédito')).toBe('freebet');
    expect(parseImportOrigin('mista')).toBe('hibrida');
    expect(parseImportOrigin('')).toBeNull();
    // Um texto desconhecido decide se o caixa é exposto: não pode virar palpite.
    expect(parseImportOrigin('talvez promo')).toBeNull();
  });
});

describe('STK-F2-09 §15 — a linha só vira aposta passando pelo schema', () => {
  it('recusa valor, odd e data fora do formato do produto', () => {
    expect(importRowInputSchema.safeParse({ ...validRow, stake: '50,00' }).success).toBe(false);
    expect(importRowInputSchema.safeParse({ ...validRow, stake: '-1.00' }).success).toBe(false);
    expect(importRowInputSchema.safeParse({ ...validRow, odds: '0.50' }).success).toBe(true);
    expect(importRowInputSchema.safeParse({ ...validRow, odds: 'abc' }).success).toBe(false);
    expect(importRowInputSchema.safeParse({ ...validRow, placedAt: '2026-10-10' }).success).toBe(
      false,
    );
  });

  it('a linha válida é despachada para commit; a recusada, para skip', () => {
    expect(importRowDisposition({ line: 2, status: 'valid', bet: validRow, errors: [] })).toEqual({
      commit: true,
      bet: validRow,
    });
    expect(
      importRowDisposition({
        line: 3,
        status: 'invalid',
        bet: null,
        errors: ['IMPORT_BOOKMAKER_UNRESOLVED'],
      }),
    ).toEqual({ commit: false, code: 'IMPORT_BOOKMAKER_UNRESOLVED' });
    // A duplicata é válida como linha, mas não entra: o arquivo já tem o
    // registro, e registrá-lo duas vezes dobraria a exposição.
    expect(
      importRowDisposition({
        line: 4,
        status: 'duplicate',
        bet: validRow,
        errors: ['IMPORT_DUPLICATE'],
      }),
    ).toEqual({ commit: false, code: 'IMPORT_DUPLICATE' });
  });

  it('sem código, a recusa é a linha vazia — nunca um "commit" implícito', () => {
    expect(importRowDisposition({ line: 5, status: 'invalid', bet: null, errors: [] })).toEqual({
      commit: false,
      code: 'IMPORT_ROW_EMPTY',
    });
  });
});

describe('STK-F2-09 §15 — o agrupamento da múltipla é por referência declarada', () => {
  it('mesma casa, mesma referência e mesmo instante = uma aposta só', () => {
    expect(importGroupKey(validRow)).toBe(importGroupKey({ ...validRow, selection: 'Empate' }));
  });

  it('casa, referência ou instante diferentes = apostas diferentes', () => {
    const key = importGroupKey(validRow);
    expect(importGroupKey({ ...validRow, bookmaker: 'Superbet' })).not.toBe(key);
    expect(importGroupKey({ ...validRow, reference: 'ABC-2' })).not.toBe(key);
    expect(importGroupKey({ ...validRow, placedAt: '2026-10-10T21:30:00-03:00' })).not.toBe(key);
  });

  it('sem referência, a linha é a própria aposta', () => {
    expect(importGroupKey({ ...validRow, reference: null })).toBeNull();
  });
});

describe('STK-F2-09 §15 — o retorno estimado é cálculo do servidor, do preview', () => {
  it('stake × odds em microreais, sem float', () => {
    expect(importPotentialReturn('50.00', '1.85')).toBe('92.50');
    expect(importPotentialReturn('10.00', '2.00')).toBe('20.00');
    // Valor ou odd fora do que o produto aceita devolve `null`, nunca 0,00:
    // um zero pareceria um retorno de zero.
    expect(importPotentialReturn('abc', '1.85')).toBeNull();
    expect(importPotentialReturn('10.00', '0.10')).toBeNull();
  });
});

describe('STK-F2-09 §15 — o progresso vem do estado do job, não de SSE', () => {
  const base: ImportBatchResult = {
    batchId: '00000000-0000-4000-8000-000000000001',
    version: 1,
    state: 'preview',
    origin: 'csv_generic',
    total: 4,
    committed: 0,
    skipped: 0,
    skippedRows: [],
    bets: [],
    partial: false,
    committedAt: null,
    rolledBackAt: null,
  };

  it('o lote em preview aguarda confirmação a 0%', () => {
    expect(importBatchProgress(base)).toEqual({
      percent: 0,
      label: 'Aguardando confirmação',
    });
  });

  it('o resultado parcial é EXPLICITO no rótulo, não escondido', () => {
    const partial = importBatchProgress({
      ...base,
      state: 'partially_committed',
      committed: 2,
      skipped: 2,
      partial: true,
    });
    expect(partial.percent).toBe(100);
    expect(partial.label).toMatch(/parcial/i);
    expect(partial.label).toMatch(/2 de 4/);
  });

  it('o revertido diz que foi revertido, e o vazio não divide por zero', () => {
    expect(importBatchProgress({ ...base, state: 'rolled_back' }).label).toBe('Lote revertido');
    expect(importBatchProgress({ ...base, total: 0 }).percent).toBe(100);
  });
});
