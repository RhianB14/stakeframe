import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('./ingest-corpus.mjs', import.meta.url));

function run(args) {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    return { status: error.status ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function writeArtifact(root, kind, house, number) {
  const directory = join(root, kind, house);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${number}.png`), `${kind}-${house}-${number}`);
}

function makeTicket(house, index) {
  const number = String(index).padStart(3, '0');
  const id = `${house}-${number}`;
  return {
    corpusTicketId: id,
    bookmaker: house,
    source: {
      artifactKind: 'screenshot',
      rawRelativePath: `raw/${house}/${number}.png`,
      rawSha256: sha256(`raw-${house}-${number}`),
      capturedAt: '2026-09-25T10:00:00-03:00',
      sourceUrl: null,
    },
    sanitized: {
      relativePath: `sanitized/${house}/${number}.png`,
      sha256: sha256(`sanitized-${house}-${number}`),
      piiReview: 'pass',
      reviewedAt: '2026-09-25T10:05:00-03:00',
    },
    ticket: {
      internalId: id,
      placedAt: '2026-09-25T09:00:00-03:00',
      event: {
        league: 'Liga Teste',
        homeTeam: 'Time A',
        awayTeam: 'Time B',
        startsAt: '2026-09-25T11:00:00-03:00',
      },
      selections: [{ market: 'Resultado', selection: 'Time A', oddsDecimal: '1.85' }],
      stake: { currency: 'BRL', amount: '10.00' },
      potentialReturn: { currency: 'BRL', amount: '18.50' },
      status: 'pending',
    },
    provenance: {
      transcribedBy: 'test',
      reviewedBy: 'test',
      reviewedAt: '2026-09-25T10:05:00-03:00',
    },
  };
}

function writeTicketFiles(root, house, index) {
  const number = String(index).padStart(3, '0');
  writeArtifact(root, 'raw', house, number);
  writeArtifact(root, 'sanitized', house, number);
}

function makeManifest(tickets) {
  return {
    schemaVersion: 1,
    corpusId: '7f9c2a54-1a4d-4c6e-9b3f-2f1d5e8a0b7c',
    scope: { bookmakers: ['bet365', 'superbet'], purpose: 'g0-01' },
    tickets,
  };
}

function writeManifest(root, manifest) {
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}

function freshRoot(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('--init creates the two-house tree and never a third house', () => {
  const base = freshRoot('stk-ingest-init-');
  const root = join(base, 'private');
  const result = run([root, '--init']);
  assert.equal(result.status, 0);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.ok, true);
  assert.deepEqual(summary.bookmakers, ['bet365', 'superbet']);
  assert.equal(existsSync(join(root, 'raw', 'bet365')), true);
  assert.equal(existsSync(join(root, 'raw', 'superbet')), true);
  assert.equal(existsSync(join(root, 'sanitized', 'bet365')), true);
  assert.equal(existsSync(join(root, 'sanitized', 'superbet')), true);
  assert.equal(existsSync(join(root, 'raw', 'novibet')), false);
  assert.equal(existsSync(join(root, 'sanitized', 'novibet')), false);
});

test('reports SEM_MANIFESTO when the manifest is missing', () => {
  const root = freshRoot('stk-ingest-missing-');
  const result = run([root]);
  assert.equal(result.status, 1);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.ok, false);
  assert.equal(summary.status, 'SEM_MANIFESTO');
});

test('accepts a complete two-house composition of 20 tickets', () => {
  const root = freshRoot('stk-ingest-ready-');
  const tickets = [];
  for (const house of ['bet365', 'superbet']) {
    for (let index = 1; index <= 10; index += 1) {
      writeTicketFiles(root, house, index);
      tickets.push(makeTicket(house, index));
    }
  }
  writeManifest(root, makeManifest(tickets));
  const result = run([root]);
  assert.equal(result.status, 0);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.ok, true);
  assert.equal(summary.status, 'PRONTO');
  assert.deepEqual(summary.counts, { bet365: 10, superbet: 10 });
  assert.equal(summary.artifacts.rawFound, 20);
  assert.equal(summary.artifacts.sanitizedFound, 20);
});

test('reports INCOMPLETO when one house is below the per-house minimum', () => {
  const root = freshRoot('stk-ingest-short-');
  const tickets = [];
  for (let index = 1; index <= 10; index += 1) {
    writeTicketFiles(root, 'bet365', index);
    tickets.push(makeTicket('bet365', index));
  }
  for (let index = 1; index <= 9; index += 1) {
    writeTicketFiles(root, 'superbet', index);
    tickets.push(makeTicket('superbet', index));
  }
  writeManifest(root, makeManifest(tickets));
  const result = run([root]);
  assert.equal(result.status, 0);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, 'INCOMPLETO');
  assert.equal(summary.totalMissing, 1);
  assert.equal(summary.missingPerBookmaker.bet365, 0);
  assert.equal(summary.missingPerBookmaker.superbet, 1);
});

test('rejects a house outside the ratified two-house scope', () => {
  const root = freshRoot('stk-ingest-scope-');
  const ticket = makeTicket('bet365', 1);
  ticket.bookmaker = 'novibet';
  ticket.corpusTicketId = 'novibet-001';
  ticket.ticket.internalId = 'novibet-001';
  ticket.source.rawRelativePath = 'raw/novibet/001.png';
  ticket.sanitized.relativePath = 'sanitized/novibet/001.png';
  const manifest = makeManifest([ticket]);
  manifest.scope.bookmakers = ['bet365', 'superbet', 'novibet'];
  writeManifest(root, manifest);
  const result = run([root]);
  assert.equal(result.status, 1);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, 'INVALIDO');
  assert.ok(summary.errors.some((entry) => entry.includes('bookmaker desconhecido')));
  assert.ok(
    summary.errors.some((entry) => entry.includes('scope.bookmakers contém casa desconhecida')),
  );
});

test('rejects a raw artifact whose hash does not match the file', () => {
  const root = freshRoot('stk-ingest-hash-');
  writeTicketFiles(root, 'bet365', 1);
  const ticket = makeTicket('bet365', 1);
  ticket.source.rawSha256 = '0'.repeat(64);
  writeManifest(root, makeManifest([ticket]));
  const result = run([root]);
  assert.equal(result.status, 1);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, 'INVALIDO');
  assert.ok(
    summary.errors.some((entry) => entry.includes('source.rawSha256 divergente do arquivo')),
  );
});

test('rejects paths outside the <raw|sanitized>/<house>/<NNN> convention', () => {
  const root = freshRoot('stk-ingest-path-');
  writeTicketFiles(root, 'bet365', 1);
  const ticket = makeTicket('bet365', 1);
  ticket.source.rawRelativePath = 'raw/bet365/1.png';
  writeManifest(root, makeManifest([ticket]));
  const result = run([root]);
  assert.equal(result.status, 1);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, 'INVALIDO');
  assert.ok(summary.errors.some((entry) => entry.includes('fora da convenção')));
});

test('rejects a missing-value field without a transcription note (D026-B)', () => {
  const root = freshRoot('stk-ingest-gap-missing-');
  const tickets = [];
  for (const house of ['bet365', 'superbet']) {
    for (let index = 1; index <= 10; index += 1) {
      writeTicketFiles(root, house, index);
      tickets.push(makeTicket(house, index));
    }
  }
  tickets[0].ticket.status = null;
  writeManifest(root, makeManifest(tickets));
  const result = run([root]);
  assert.equal(result.status, 1);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, 'INVALIDO');
  assert.ok(summary.errors.some((entry) => entry.includes('status ausente/nulo sem nota')));
});

test('rejects a transcription note for a field that is present', () => {
  const root = freshRoot('stk-ingest-gap-present-');
  writeTicketFiles(root, 'bet365', 1);
  const ticket = makeTicket('bet365', 1);
  ticket.transcriptionNotes = [{ field: 'placedAt', reason: 'ILEGIVEL_RECAPTURAR' }];
  writeManifest(root, makeManifest([ticket]));
  const result = run([root]);
  assert.equal(result.status, 1);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, 'INVALIDO');
  assert.ok(
    summary.errors.some((entry) => entry.includes('transcriptionNotes para campo presente')),
  );
});

test('rejects malformed transcription notes (field fora da lista e reason inválida)', () => {
  const first = freshRoot('stk-ingest-gap-field-');
  writeTicketFiles(first, 'bet365', 1);
  const ticketA = makeTicket('bet365', 1);
  ticketA.ticket.placedAt = null;
  ticketA.transcriptionNotes = [{ field: 'stake', reason: 'ILEGIVEL_RECAPTURAR' }];
  writeManifest(first, makeManifest([ticketA]));
  const resultA = run([first]);
  assert.equal(resultA.status, 1);
  const summaryA = JSON.parse(resultA.stdout);
  assert.equal(summaryA.status, 'INVALIDO');
  assert.ok(summaryA.errors.some((entry) => entry.includes('field fora da lista D026-B')));
  assert.ok(summaryA.errors.some((entry) => entry.includes('placedAt ausente/nulo sem nota')));

  const second = freshRoot('stk-ingest-gap-reason-');
  writeTicketFiles(second, 'bet365', 1);
  const ticketB = makeTicket('bet365', 1);
  ticketB.ticket.placedAt = null;
  ticketB.transcriptionNotes = [{ field: 'placedAt', reason: 'DIVERGENTE' }];
  writeManifest(second, makeManifest([ticketB]));
  const resultB = run([second]);
  assert.equal(resultB.status, 1);
  const summaryB = JSON.parse(resultB.stdout);
  assert.equal(summaryB.status, 'INVALIDO');
  assert.ok(summaryB.errors.some((entry) => entry.includes('reason deve ser ILEGIVEL_RECAPTURAR')));
});

test('accepts null-proper fields with notes as PRONTO_COM_GAP (D026-B)', () => {
  const root = freshRoot('stk-ingest-gap-ok-');
  const tickets = [];
  for (const house of ['bet365', 'superbet']) {
    for (let index = 1; index <= 10; index += 1) {
      writeTicketFiles(root, house, index);
      tickets.push(makeTicket(house, index));
    }
  }
  tickets[0].ticket.placedAt = null;
  tickets[0].transcriptionNotes = [{ field: 'placedAt', reason: 'ILEGIVEL_RECAPTURAR' }];
  tickets[1].ticket.status = null;
  tickets[1].transcriptionNotes = [{ field: 'status', reason: 'ILEGIVEL_RECAPTURAR' }];
  tickets[2].ticket.event.awayTeam = null;
  tickets[2].transcriptionNotes = [{ field: 'event.awayTeam', reason: 'ILEGIVEL_RECAPTURAR' }];
  delete tickets[3].ticket.potentialReturn;
  tickets[3].transcriptionNotes = [{ field: 'potentialReturn', reason: 'ILEGIVEL_RECAPTURAR' }];
  tickets[4].ticket.selections[0].selection = null;
  tickets[4].transcriptionNotes = [
    { field: 'selections[0].selection', reason: 'ILEGIVEL_RECAPTURAR' },
  ];
  writeManifest(root, makeManifest(tickets));
  const result = run([root]);
  assert.equal(result.status, 0);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.ok, true);
  assert.equal(summary.status, 'PRONTO_COM_GAP');
  assert.equal(summary.gaps.notes, 5);
  assert.deepEqual(summary.gaps.fields, [
    'event.awayTeam',
    'placedAt',
    'potentialReturn',
    'selections[0].selection',
    'status',
  ]);
});

test('keeps INCOMPLETO ahead of PRONTO_COM_GAP when composition is short', () => {
  const root = freshRoot('stk-ingest-gap-short-');
  const tickets = [];
  for (let index = 1; index <= 10; index += 1) {
    writeTicketFiles(root, 'bet365', index);
    tickets.push(makeTicket('bet365', index));
  }
  for (let index = 1; index <= 9; index += 1) {
    writeTicketFiles(root, 'superbet', index);
    tickets.push(makeTicket('superbet', index));
  }
  tickets[0].ticket.status = null;
  tickets[0].transcriptionNotes = [{ field: 'status', reason: 'ILEGIVEL_RECAPTURAR' }];
  writeManifest(root, makeManifest(tickets));
  const result = run([root]);
  assert.equal(result.status, 0);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, 'INCOMPLETO');
});
