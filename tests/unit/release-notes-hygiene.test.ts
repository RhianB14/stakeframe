import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// STK-REL-06-R1 — higiene das notas de release.
//
// Notas NÃO PUBLICADAS não podem fixar o SHA do commit-fonte: todo squash
// merge que avança a `main` invalida o valor e a nota passaria a registrar um
// alvo incorreto (incidente corrigido na PR #147). O campo `Commit-fonte` deve
// usar a fórmula "definido e reconfirmado no momento da autorização da tag".
// Referências HISTÓRICAS (ex.: âncora imutável da tag anterior) permanecem
// permitidas fora dos campos operacionais da tabela.

const RELEASES_DIR = fileURLToPath(new URL('../../docs/releases/', import.meta.url));
const SHA40 = /[a-f0-9]{40}/;

const tableField = (content: string, field: string): string | null =>
  content.split(/\r?\n/).find((line) => line.trimStart().startsWith(`| ${field}`)) ?? null;

const notes = readdirSync(RELEASES_DIR).filter((file) => file.endsWith('.md'));

describe('release notes hygiene (STK-REL-06-R1)', () => {
  it('discovers the release notes', () => {
    expect(notes.length).toBeGreaterThan(0);
  });

  for (const file of notes) {
    it(`${file}: unpublished notes never pin the source SHA`, () => {
      const content = readFileSync(`${RELEASES_DIR}/${file}`, 'utf8');
      const tag = tableField(content, 'Tag');
      // Notas publicadas referenciam o SHA histórico do build — permitido.
      if (!tag || !/NÃO CRIADA/i.test(tag)) return;
      const commit = tableField(content, 'Commit-fonte');
      expect(commit, 'nota não publicada precisa declarar o campo Commit-fonte').not.toBeNull();
      expect(SHA40.test(commit!)).toBe(false);
      expect(commit!).toMatch(/reconfirmado no momento da autorização/i);
    });

    it(`${file}: the Tag field never carries a SHA`, () => {
      const content = readFileSync(`${RELEASES_DIR}/${file}`, 'utf8');
      const tag = tableField(content, 'Tag');
      if (!tag) return;
      expect(SHA40.test(tag)).toBe(false);
    });
  }
});
