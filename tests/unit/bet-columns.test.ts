import { describe, expect, it } from 'vitest';
import {
  ALL_BET_COLUMNS,
  DEFAULT_BET_COLUMNS,
  REQUIRED_BET_COLUMNS,
  readBetColumns,
  writeBetColumns,
} from '../../apps/web/src/product/bet-columns.js';
import { betTableColumns } from '../../packages/shared/src/index.js';

/** localStorage em memória — o suficiente para Preference e para as bordas. */
function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    map,
  };
}

const KEYS = ALL_BET_COLUMNS.map((column) => column.key);

describe('painel de colunas da tabela de apostas (STK-F2-18, Fase 3)', () => {
  it('o conjunto padrão cabe na largura útil sem rolagem horizontal', () => {
    /* A tabela completa tem 14 colunas e min-width 1640px; a área útil com
       a sidebar de 248px é ~1100px. O padrão precisa caber — é o motivo de
       o padrão existir. O piso de 6 colunas é o mínimo que mostra
       situação, valor e resultado. */
    expect(DEFAULT_BET_COLUMNS.length).toBeLessThanOrEqual(10);
    expect(DEFAULT_BET_COLUMNS.length).toBeGreaterThanOrEqual(6);
    // Todo o dinheiro que decide fica visível sem rolar: valor, odd, retorno, resultado.
    for (const key of ['stake', 'odds', 'return', 'result'] as const) {
      expect(DEFAULT_BET_COLUMNS).toContain(key);
    }
  });

  it('as colunas obrigatórias são o bilhete e o resultado, e sempre ficam', () => {
    expect([...REQUIRED_BET_COLUMNS]).toEqual(['ticket', 'result']);
    const semObrigatoria = readBetColumns(
      'owner-1',
      memoryStorage({ 'stakeframe.bet-columns.v1.owner-1': '["gameDate"]' }),
    );
    expect(semObrigatoria).toContain('ticket');
    expect(semObrigatoria).toContain('result');
  });

  it('toda coluna padrão pertence ao catálogo aprovado pelo proprietário', () => {
    for (const key of DEFAULT_BET_COLUMNS) {
      expect(KEYS).toContain(key);
    }
  });

  it('a ordem devolvida é a aprovada, nunca a ordem do painel', () => {
    /* Guardar ["result","ticket","stake"] não pode inverter a tabela: a
       ordem de exibição é decisão do produto (STK-BETS-02). */
    const storage = memoryStorage({
      'stakeframe.bet-columns.v1.owner-1': JSON.stringify(['result', 'stake', 'id']),
    });
    const columns = readBetColumns('owner-1', storage);
    const expected = betTableColumns
      .map((column) => column.key)
      .filter((key) => columns.includes(key));
    expect(columns).toEqual([...expected]);
    expect(columns.indexOf('ticket')).toBeLessThan(columns.indexOf('result'));
  });

  it('estado inválido cai no padrão em vez de quebrar a tela', () => {
    const casos = [
      'nao-e-json',
      '"string"',
      '{"a":1}',
      '[]',
      '["coluna-que-nao-existe"]',
      'null',
      '[null, 3, true]',
    ];
    for (const raw of casos) {
      const columns = readBetColumns(
        'owner-1',
        memoryStorage({ 'stakeframe.bet-columns.v1.owner-1': raw }),
      );
      expect([...columns], `entrada ${raw} deveria cair no padrão`).toEqual([
        ...DEFAULT_BET_COLUMNS,
      ]);
    }
  });

  it('sem storage — e sem localStorage no servidor — devolve o padrão', () => {
    expect(readBetColumns('owner-1', null)).toEqual([...DEFAULT_BET_COLUMNS]);
    expect(readBetColumns('owner-1', undefined)).toEqual([...DEFAULT_BET_COLUMNS]);
    expect(() => writeBetColumns('owner-1', ['stake'], null)).not.toThrow();
  });

  it('a preferência é isolada por usuário e sobrevive à escrita', () => {
    const storage = memoryStorage();
    writeBetColumns('owner-1', ['ticket', 'result', 'id'], storage);
    // Outro usuário não herda a preferência alheia.
    expect(readBetColumns('owner-2', storage)).toEqual([...DEFAULT_BET_COLUMNS]);
    expect(readBetColumns('owner-1', storage)).toEqual(['ticket', 'result', 'id']);
  });

  it('escrita que falha por cota não derruba a tela', () => {
    const storage = {
      setItem: () => {
        throw new DOMException('quota', 'QuotaExceededError');
      },
    };
    expect(() => writeBetColumns('owner-1', ['stake'], storage)).not.toThrow();
  });

  it('esconder todas as opcionais volta ao conjunto completo, nunca a zero', () => {
    const storage = memoryStorage();
    writeBetColumns('owner-1', [...REQUIRED_BET_COLUMNS], storage);
    // Estado limite: só as obrigatórias. É válido e o painel mostra 2.
    expect(readBetColumns('owner-1', storage)).toEqual(['ticket', 'result']);
  });
});
