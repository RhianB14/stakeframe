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
//
// STK-REL-11 — a preparação da beta.3 acrescenta as garantias: a versão raiz
// tem nota correspondente; a tag candidata deriva da versão no título e no
// `Commit-fonte`; notas de preparação nunca declaram publicação; e as notas
// não carregam segredos nem PII.

const RELEASES_DIR = fileURLToPath(new URL('../../docs/releases/', import.meta.url));
const ROOT_PACKAGE = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
) as { version: string };
const SHA40 = /[a-f0-9]{40}/;
const SECRET_OR_PII = [
  /sk-[a-z0-9-]{12,}/i,
  /ghp_[A-Za-z0-9]{20,}/,
  /Bearer\s+[A-Za-z0-9._-]{20,}/,
  /-----BEGIN/,
  /password\s*[:=]\s*\S+/i,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
];

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

describe('release notes hygiene — current preparation (STK-REL-11)', () => {
  const currentNotes = `v${ROOT_PACKAGE.version}.md`;

  it('the root version has a matching release notes file', () => {
    expect(notes).toContain(currentNotes);
  });

  it('the candidate tag matches the notes title and the Commit-fonte formula', () => {
    const content = readFileSync(`${RELEASES_DIR}/${currentNotes}`, 'utf8');
    expect(content.split(/\r?\n/)[0]!.trim()).toBe(`# Stakeframe — v${ROOT_PACKAGE.version}`);
    const commit = tableField(content, 'Commit-fonte');
    expect(commit).not.toBeNull();
    expect(commit!).toContain(`\`v${ROOT_PACKAGE.version}\``);
    expect(commit!).toMatch(/reconfirmado no momento da autorização/i);
  });

  it('preparation notes never claim a published release', () => {
    const content = readFileSync(`${RELEASES_DIR}/${currentNotes}`, 'utf8');
    expect(tableField(content, 'Tag')).toMatch(/NÃO CRIADA/i);
    const state = tableField(content, 'Estado');
    expect(state).toMatch(/Preparação/);
    expect(state).toMatch(/nada publicado/i);
    expect(content).not.toMatch(/foi publicad[ao]|release publicada/i);
  });

  it('the hygiene rule allows historical anchors outside the operational fields', () => {
    const historical = [
      'Nota fictícia de higiene.',
      '',
      '| Tag | NÃO CRIADA (depende de autorização específica por tarefa) |',
      '| Commit-fonte | Será o SHA exato do commit alvo da tag `v0.1.0-beta.9`, definido e reconfirmado no momento da autorização da tag. |',
      '',
      `A tag anterior permanece apontando para \`${'e'.repeat(40)}\` (inalterada).`,
    ].join('\n');
    expect(tableField(historical, 'Tag')).toMatch(/NÃO CRIADA/i);
    const commit = tableField(historical, 'Commit-fonte');
    expect(SHA40.test(commit!)).toBe(false);
    expect(commit!).toMatch(/reconfirmado no momento da autorização/i);
    // Âncora histórica no corpo (fora dos campos operacionais) é permitida.
    expect(SHA40.test(historical)).toBe(true);
  });

  it('release notes never carry secrets or personal data', () => {
    for (const file of notes) {
      const content = readFileSync(`${RELEASES_DIR}/${file}`, 'utf8');
      for (const pattern of SECRET_OR_PII)
        expect(pattern.test(content), `${file} matches ${pattern}`).toBe(false);
    }
  });
});

// STK-REL-12 — a preparação da beta.4 acrescenta garantias escopadas à própria
// nota: o escopo do Mini App de confirmação (idempotência, sincronização,
// fechamento automático, status e edição de campos), o registro de zero
// deploy/migração/publicação, a fórmula do `Commit-fonte` sem SHA fixo e a
// âncora da beta.3 como versão anterior à PR #169 (não usar como base de
// deploy). As notas beta.1–beta.3 permanecem preservadas como histórico.
describe('release notes hygiene — beta.4 preparation (STK-REL-12)', () => {
  const BETA4_NOTES = 'v0.1.0-beta.4.md';

  it('previous beta notes stay preserved as history', () => {
    for (const previous of ['v0.1.0-beta.1.md', 'v0.1.0-beta.2.md', 'v0.1.0-beta.3.md'])
      expect(notes, `histórico ausente: ${previous}`).toContain(previous);
  });

  it('the beta.4 notes record the Mini App confirmation scope', () => {
    expect(notes).toContain(BETA4_NOTES);
    const content = readFileSync(`${RELEASES_DIR}/${BETA4_NOTES}`, 'utf8');
    for (const required of [
      /Mini ?App/i,
      /idempot/i,
      /sincroniz/i,
      /fechamento automático/i,
      /status do bilhete/i,
      /edi[çc][ãa]o dos campos/i,
    ])
      expect(content, `nota beta.4 deve registrar ${required}`).toMatch(required);
  });

  it('the beta.4 notes declare zero deploy, migration and publication', () => {
    const content = readFileSync(`${RELEASES_DIR}/${BETA4_NOTES}`, 'utf8');
    expect(content).toMatch(
      /Nenhuma tag, GitHub Release, publicação de imagem, deploy ou migração/i,
    );
    expect(content).toMatch(/nenhuma ativação foi feita/i);
  });

  it('the beta.4 notes keep the Commit-fonte formula without a fixed SHA', () => {
    const content = readFileSync(`${RELEASES_DIR}/${BETA4_NOTES}`, 'utf8');
    const commit = tableField(content, 'Commit-fonte');
    expect(commit).toContain('`v0.1.0-beta.4`');
    expect(SHA40.test(commit!)).toBe(false);
  });

  it('the beta.3 tag stays recorded as the pre-#169 anchor', () => {
    const content = readFileSync(`${RELEASES_DIR}/${BETA4_NOTES}`, 'utf8');
    expect(content).toContain('73b8dd8acf09b2508fc1dc146dd10f2a81b3f81b');
    expect(content).toMatch(/não deve ser usada como base de deploy|anterior à PR #169/i);
  });
});
