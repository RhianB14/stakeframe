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

// STK-MINIAPP-STATUS-ALWAYS — beta.7 documents the always-visible editor
// status, audited correction path, and re-entry-preserving Telegram behavior.
describe('release notes hygiene — beta.7 status correction', () => {
  it('documents always-available status and audited correction behavior', () => {
    const content = readFileSync(`${RELEASES_DIR}/v0.1.0-beta.7.md`, 'utf8');
    expect(content).toMatch(/Status da aposta.*permanece acessível/s);
    expect(content).toMatch(/estorno contábil auditável/i);
    expect(content).toMatch(/mensagem final do Telegram.*mantida como ponto de reentrada/s);
    expect(content).toMatch(/aposta incompleta.*não aceita transição financeira/is);
  });

  it('prepares beta.7 without claiming publication or changing production configuration', () => {
    const content = readFileSync(`${RELEASES_DIR}/v0.1.0-beta.7.md`, 'utf8');
    expect(tableField(content, 'Tag')).toMatch(/NÃO CRIADA/i);
    expect(tableField(content, 'Commit-fonte')).toMatch(/reconfirmado no momento da autorização/i);
    expect(content).toMatch(/nenhuma migração de banco foi adicionada/i);
    expect(content).toMatch(
      /nenhuma tag beta\.7, GitHub Release, publicação de imagem, deploy ou migração/i,
    );
  });
});

// STK-REL-14 — beta.8 registra a apresentação financeira (sem recalcular) e
// as melhorias de acessibilidade/ergonomia móvel das PRs UX-03 e UX-04.
describe('release notes hygiene — beta.8 UX preparation (STK-REL-14)', () => {
  const BETA8_NOTES = 'v0.1.0-beta.8.md';

  it('documents unrealized values separately from realized partial cashouts', () => {
    expect(notes).toContain(BETA8_NOTES);
    const content = readFileSync(`${RELEASES_DIR}/${BETA8_NOTES}`, 'utf8');
    expect(content).toMatch(/apostas abertas sem retorno realizado.*Não liquidado/is);
    expect(content).toMatch(/Cashout parcial.*Realizado parcialmente/is);
    expect(content).toMatch(/sem recalcular valores no cliente/i);
    expect(content).toMatch(/resultado realizado/i);
  });

  it('records the mobile accessibility targets and WCAG distinction accurately', () => {
    const content = readFileSync(`${RELEASES_DIR}/${BETA8_NOTES}`, 'utf8');
    expect(content).toMatch(/pelo menos 12 px/i);
    expect(content).toMatch(/contraste mínimo\s+4\.5:1/i);
    expect(content).toMatch(/não (?:é )?um requisito WCAG\s+2\.2 AA/i);
    expect(content).toMatch(/Configurações.*rolar horizontalmente/s);
  });

  it('keeps beta.8 as preparation and declares no production-side changes', () => {
    const content = readFileSync(`${RELEASES_DIR}/${BETA8_NOTES}`, 'utf8');
    expect(tableField(content, 'Tag')).toMatch(/NÃO CRIADA/i);
    expect(tableField(content, 'Commit-fonte')).toContain('`v0.1.0-beta.8`');
    expect(tableField(content, 'Commit-fonte')).toMatch(/reconfirmado no momento da autorização/i);
    expect(tableField(content, 'Estado')).toMatch(/Preparação/);
    expect(content).toMatch(/Nenhuma migração de banco foi adicionada/i);
    expect(content).toMatch(
      /Nenhuma tag beta\.8, GitHub Release, publicação de imagem, deploy ou migração/is,
    );
    expect(content).toMatch(/não altera regras de cálculo, ledger, liquidação/i);
  });
});

// STK-REL-15 — beta.9 records the detailed bets list and Telegram cleanup after
// terminal settlement, including the visible outcome/status column.
describe('release notes hygiene — beta.9 bets list and Telegram cleanup', () => {
  const BETA9_NOTES = 'v0.1.0-beta.9.md';

  it('documents the bets list columns and separates status, type and market', () => {
    expect(notes).toContain(BETA9_NOTES);
    const content = readFileSync(`${RELEASES_DIR}/${BETA9_NOTES}`, 'utf8').replace(/\s+/g, ' ');
    expect(content).toMatch(/data e hora do jogo.*evento.*\*\*Status da aposta\*\*/is);
    expect(content).toMatch(/Simples.*mercado.*Múltipla.*BetBuild/is);
    expect(content).toMatch(/Pendente, Ganha, Perdida, Reembolso, Meio-Ganha/is);
    expect(content).toMatch(/coluna aparece logo após Evento/is);
  });

  it('documents all three Telegram deletions only for terminal settlement', () => {
    const content = readFileSync(`${RELEASES_DIR}/${BETA9_NOTES}`, 'utf8').replace(/\s+/g, ' ');
    expect(content).toMatch(
      /liquidação total.*Telegram.*foto original.*mensagem temporária.*resposta final/is,
    );
    expect(content).toMatch(/resposta final deixa de servir como ponto de reentrada/i);
    expect(content).toMatch(/cashout parcial.*continua aberto.*não aciona essa limpeza/i);
    expect(content).toMatch(/edições comuns continuam atualizando a mensagem final/i);
  });

  it('keeps beta.9 a preparation with no migration or production actions', () => {
    const content = readFileSync(`${RELEASES_DIR}/${BETA9_NOTES}`, 'utf8');
    expect(tableField(content, 'Tag')).toMatch(/NÃO CRIADA/i);
    expect(tableField(content, 'Commit-fonte')).toContain('`v0.1.0-beta.9`');
    expect(tableField(content, 'Commit-fonte')).toMatch(/reconfirmado no momento da autorização/i);
    expect(tableField(content, 'Estado')).toMatch(/Preparação/);
    expect(content).toMatch(/Nenhuma migração de banco foi adicionada/i);
    expect(content).toMatch(
      /Nenhuma tag beta\.9, GitHub Release, publicação de imagem, deploy ou migração/is,
    );
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
